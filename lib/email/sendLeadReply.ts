// lib/email/sendLeadReply.ts

import { supabase } from "@/lib/supabase";
import { randomUUID } from "node:crypto";
import { withCompanyExecution } from "@/lib/background-jobs/companyExecution";
import { requireCompany } from "@/lib/company/resolveCompany";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";

type SendLeadReplyInput = {
  companyId: string | null;
  leadId: string;
  to: string;
  subject?: string;
  body: string;
  isFollowUp?: boolean;
  idempotencyKey?: string;
};

function shouldAwaitCustomer(message: string) {
  return message.includes("?");
}

function getNextFollowUpAt(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function calculateResponseSeconds(createdAt?: string | null) {
  if (!createdAt) return null;

  const normalizedCreatedAt =
    createdAt.endsWith("Z") || createdAt.includes("+")
      ? createdAt
      : `${createdAt}Z`;

  const created = new Date(normalizedCreatedAt).getTime();
  const now = Date.now();

  if (!Number.isFinite(created)) return null;

  return Math.max(0, Math.round((now - created) / 1000));
}

function normalizeSignatureBlock(value?: string | null) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .trim();
}

function normalizeBodyForComparison(value: string) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appendSignature(body: string, signature?: string | null) {
  const cleanBody = String(body ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .trim();

  const cleanSignature = normalizeSignatureBlock(signature);

  if (!cleanSignature) return cleanBody;

  const normalizedBody = normalizeBodyForComparison(cleanBody).toLowerCase();
  const normalizedSignature = normalizeBodyForComparison(cleanSignature).toLowerCase();

  if (normalizedBody.endsWith(normalizedSignature)) {
    return cleanBody;
  }

  return `${cleanBody}\n\n${cleanSignature}`;
}

function normalizeHeaderValue(value: string) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeSubject(subject: string) {
  /*
   * Preserve an intentionally empty subject when replying inside a real Gmail
   * no-subject thread. sendLeadReply still supplies its normal product default
   * when there is no verified parent thread context.
   */
  const cleanSubject = normalizeHeaderValue(subject);

  if (/^[\x00-\x7F]*$/.test(cleanSubject)) return cleanSubject;

  return `=?UTF-8?B?${Buffer.from(cleanSubject, "utf8").toString("base64")}?=`;
}

function encodeEmailRaw(params: {
  to: string;
  from?: string | null;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}) {
  const to = normalizeHeaderValue(params.to);
  const from = params.from ? normalizeHeaderValue(params.from) : "";
  const subject = encodeSubject(params.subject);
  const body = String(params.body ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  const headers = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    params.inReplyTo
      ? `In-Reply-To: ${normalizeHeaderValue(params.inReplyTo)}`
      : null,
    params.references
      ? `References: ${normalizeHeaderValue(params.references)}`
      : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);

  const bodyBase64 = Buffer.from(body, "utf8").toString("base64");
  const wrappedBody = bodyBase64.match(/.{1,76}/g)?.join("\r\n") ?? bodyBase64;
  const message = `${headers.join("\r\n")}\r\n\r\n${wrappedBody}`;

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertBodyWasNotCollapsed(originalBody: string, finalBody: string) {
  const original = normalizeBodyForComparison(originalBody);
  const final = normalizeBodyForComparison(finalBody);

  if (!original) throw new Error("missing_message");

  const originalFirstLine = original.split("\n")[0]?.trim();

  if (!originalFirstLine) throw new Error("missing_message_first_line");

  if (!final.includes(originalFirstLine)) {
    throw new Error("email_body_lost_first_line_before_send");
  }
}

function normalizeThreadSubject(value?: string | null) {
  return String(value ?? "")
    .replace(/^(re|fwd):\s*/gi, "")
    .trim()
    .toLowerCase();
}

function getMessageHeader(headers: any[] | undefined, name: string) {
  return (
    headers?.find(
      (header) =>
        String(header?.name ?? "").toLowerCase() ===
        name.toLowerCase()
    )?.value ?? null
  );
}

async function getGmailReplyThreadContext(params: {
  gmail: any;
  leadId: string;
  companyId: string;
  outgoingSubject: string;
  currentLead: any;
}) {
  const { data: recentInboundRows, error: inboundError } = await supabase
    .from("inbound_emails")
    .select(
      "provider_email_id, provider_event_id, subject, created_at"
    )
    .eq("company_id", params.companyId)
    .eq("lead_id", params.leadId)
    .order("created_at", {
      ascending: false,
    })
    .limit(8);

  if (inboundError) {
    console.warn(
      "[sendLeadReply] latest inbound thread context unavailable",
      {
        leadId: params.leadId,
        error: inboundError.message,
      }
    );
  }

  type ParentCandidate = {
    messageId: string;
    storedSubject: string | null;
    source: string;
  };

  const candidates: ParentCandidate[] = [];
  const seenCandidateIds = new Set<string>();

  const addCandidate = (
    value: unknown,
    storedSubject: unknown,
    source: string
  ) => {
    const messageId = String(value ?? "").trim();
    if (!messageId || seenCandidateIds.has(messageId)) return;

    seenCandidateIds.add(messageId);
    candidates.push({
      messageId,
      storedSubject:
        typeof storedSubject === "string" ? storedSubject : null,
      source,
    });
  };

  /*
   * The Lead's inbound_email_id is the best direct pointer to the customer
   * message currently being answered. Prospect -> booking handoffs can create
   * a newer INTERNAL inbound_emails ledger row whose provider ids are synthetic
   * idempotency keys rather than Gmail message ids, so never let one failed
   * candidate terminate thread discovery.
   */
  addCandidate(
    params.currentLead?.inbound_email_id,
    null,
    "lead_inbound_email_id"
  );

  for (const row of recentInboundRows ?? []) {
    addCandidate(
      row?.provider_email_id,
      row?.subject,
      "inbound_provider_email_id"
    );
    addCandidate(
      row?.provider_event_id,
      row?.subject,
      "inbound_provider_event_id"
    );
  }

  addCandidate(
    params.currentLead?.outbound_email_id,
    params.outgoingSubject,
    "lead_outbound_email_id"
  );

  if (candidates.length === 0) return null;

  const candidateFailures: Array<{
    messageId: string;
    source: string;
    error: string;
  }> = [];

  for (const candidate of candidates) {
    try {
      const parent = await params.gmail.users.messages.get({
        userId: "me",
        id: candidate.messageId,
        format: "metadata",
        metadataHeaders: [
          "Message-ID",
          "References",
          "Subject",
        ],
      });

      const headers = parent.data?.payload?.headers ?? [];

      const rfcMessageId = String(
        getMessageHeader(headers, "Message-ID") ?? ""
      ).trim();

      const parentSubject = String(
        getMessageHeader(headers, "Subject") ??
          candidate.storedSubject ??
          ""
      ).trim();

      const threadId = String(
        parent.data?.threadId ??
          params.currentLead?.outbound_thread_id ??
          params.currentLead?.inbound_thread_id ??
          ""
      ).trim();

      if (!rfcMessageId || !threadId) {
        candidateFailures.push({
          messageId: candidate.messageId,
          source: candidate.source,
          error: "missing_rfc_message_id_or_thread_id",
        });
        continue;
      }

      const normalizedParentSubject = normalizeThreadSubject(parentSubject);
      const normalizedOutgoingSubject = normalizeThreadSubject(
        params.outgoingSubject
      );

      /*
       * Gmail requires reply-thread subjects to match. Normal messages keep the
       * existing subject-equality guard. The one legitimate mismatch created by
       * our own product is a customer message with NO subject followed by the
       * product fallback subject. In that case preserve the real empty parent
       * subject so Gmail can keep the reply in the customer's existing thread.
       */
      const parentHadNoSubject = parentSubject.length === 0;
      const outgoingUsesProductFallbackSubject =
        normalizedOutgoingSubject ===
        normalizeThreadSubject("Re: Your HVAC Request");

      if (
        normalizedParentSubject !== normalizedOutgoingSubject &&
        !(parentHadNoSubject && outgoingUsesProductFallbackSubject)
      ) {
        candidateFailures.push({
          messageId: candidate.messageId,
          source: candidate.source,
          error: "subject_mismatch",
        });
        continue;
      }

      const existingReferences = String(
        getMessageHeader(headers, "References") ?? ""
      ).trim();

      const references = [existingReferences, rfcMessageId]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        threadId,
        inReplyTo: rfcMessageId,
        references,
        subject: parentHadNoSubject ? "" : params.outgoingSubject,
        parentMessageId: candidate.messageId,
        parentSource: candidate.source,
      };
    } catch (error: any) {
      candidateFailures.push({
        messageId: candidate.messageId,
        source: candidate.source,
        error: String(error?.message ?? error),
      });
    }
  }

  console.warn(
    "[sendLeadReply] Gmail reply-thread metadata unavailable; sending safely without thread binding",
    {
      leadId: params.leadId,
      attemptedParentCandidates: candidateFailures,
    }
  );

  return null;
}

export async function sendLeadReply(input: SendLeadReplyInput) {
  if (!input.companyId) throw new Error("missing_company_id");
  return withCompanyExecution(input.companyId,
    `manual_reply:${input.leadId}:${input.idempotencyKey ?? randomUUID()}`,
    () => sendLeadReplyUnlocked(input));
}

async function sendLeadReplyUnlocked({
  companyId,
  leadId,
  to,
  subject = "Re: Your HVAC Request",
  body,
  isFollowUp = false,
}: SendLeadReplyInput) {
  const company = await requireCompany(companyId);

  if (!leadId) throw new Error("missing_lead_id");
  if (!to || typeof to !== "string") throw new Error("missing_recipient");
  if (!body || typeof body !== "string") throw new Error("missing_message");

  const { data: currentLead, error: readError } = await supabase
    .from("leads")
    .select(
      "id, company_id, status, appointment_time, calendar_event_id, created_at, first_response_at, follow_up_count, inbound_thread_id, outbound_thread_id, inbound_email_id, outbound_email_id"
    )
    .eq("id", leadId)
    .eq("company_id", company.id)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (!currentLead) throw new Error("lead_not_found_for_company");

  const gmail = await getCompanyGmailClient(company.id);

  const { data: connection, error: connectionError } = await supabase
    .from("google_connections")
    .select("google_account_email")
    .eq("company_id", company.id)
    .maybeSingle();

  if (connectionError) throw new Error(connectionError.message);

  const fromEmail = connection?.google_account_email || company.email || "me";
  const nowIso = new Date().toISOString();
  const firstResponseAt = currentLead.first_response_at ?? nowIso;
  const responseTimeSeconds = currentLead.first_response_at
    ? null
    : calculateResponseSeconds(currentLead.created_at);

  const nextFollowUpCount = isFollowUp
    ? Number(currentLead.follow_up_count ?? 0) + 1
    : Number(currentLead.follow_up_count ?? 0);

  const followUpDelayHours = Number(company.follow_up_delay_hours ?? 24);
  const bodyWithSignature = appendSignature(body, company.email_signature);

  assertBodyWasNotCollapsed(body, bodyWithSignature);

  const replyThreadContext =
    await getGmailReplyThreadContext({
      gmail,
      leadId,
      companyId: company.id,
      outgoingSubject: subject,
      currentLead,
    });

  const effectiveSubject = replyThreadContext
    ? replyThreadContext.subject
    : subject;

  const raw = encodeEmailRaw({
    to,
    from: fromEmail,
    subject: effectiveSubject,
    body: bodyWithSignature,
    inReplyTo:
      replyThreadContext?.inReplyTo ?? null,
    references:
      replyThreadContext?.references ?? null,
  });

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(replyThreadContext?.threadId
        ? {
            threadId:
              replyThreadContext.threadId,
          }
        : {}),
    },
  });

  const actualSentBody = (sent as any).leadflowBody ?? bodyWithSignature;
  const outboundEmailId = sent.data.id ?? null;
  const outboundThreadId = sent.data.threadId ?? outboundEmailId;

  /*
   * Booking truth outranks outbound-email engagement status.
   * A confirmation/reschedule/status email must never demote a real booked
   * Lead to contacted/awaiting_customer while its canonical appointment and
   * Google Calendar event still exist.
   *
   * Cancellation clears appointment_time/calendar_event_id BEFORE calling
   * sendLeadReply, so cancellation confirmations still transition normally.
   */
  const hasCanonicalBookingTruth =
    currentLead.status === "booked" &&
    Boolean(currentLead.appointment_time) &&
    Boolean(currentLead.calendar_event_id);

  const nextStatus = hasCanonicalBookingTruth
    ? "booked"
    : shouldAwaitCustomer(actualSentBody)
      ? "awaiting_customer"
      : "contacted";

  const updatePayload: Record<string, any> = {
    status: nextStatus,
    sent_at: nowIso,
    last_contacted_at: nowIso,
    follow_up_count: nextFollowUpCount,
    last_follow_up_at: isFollowUp ? nowIso : null,
    next_follow_up_at: hasCanonicalBookingTruth
      ? null
      : shouldAwaitCustomer(actualSentBody)
        ? getNextFollowUpAt(followUpDelayHours)
        : null,
    outbound_email_id: outboundEmailId,
    outbound_thread_id: outboundThreadId,
    last_email_subject: effectiveSubject,
    last_email_to: to,
    last_email_from: fromEmail,
    first_response_at: firstResponseAt,
  };

  if (responseTimeSeconds !== null) {
    updatePayload.response_time_seconds = responseTimeSeconds;
  }

  const { data: updatedLead, error: updateError } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", leadId)
    .eq("company_id", company.id)
    .select("id, company_id, status, appointment_time, calendar_event_id")
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updatedLead) throw new Error("lead_update_scope_violation");

  if (hasCanonicalBookingTruth) {
    if (
      updatedLead.status !== "booked" ||
      !updatedLead.appointment_time ||
      !updatedLead.calendar_event_id
    ) {
      throw new Error("send_reply_damaged_canonical_booking_truth");
    }
  }

  return {
    sent: true,
    status: nextStatus,
    companyId: company.id,
    leadId,
    messageId: outboundEmailId,
    threadId: outboundThreadId,
    firstResponseAt,
    responseTimeSeconds,
    followUpCount: nextFollowUpCount,
    nextFollowUpAt: updatePayload.next_follow_up_at,
    provider: "gmail",
    from: fromEmail,
    to,
    bodyPreview: actualSentBody.slice(0, 500),
    data: sent.data,
  };
}