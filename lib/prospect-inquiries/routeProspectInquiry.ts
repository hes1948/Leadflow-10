// lib/prospect-inquiries/routeProspectInquiry.ts
//
// Tiny integration boundary for Gmail routing.
//
// This helper is intentionally called only AFTER the existing
// customer_booking_reply branch has had first right of refusal.
//
// It never changes the existing Gmail classification. It merely decides
// whether a non-active-booking message belongs to the isolated prospect lane.

import { supabase } from "@/lib/supabase";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import {
  classifyProspectInquiry,
  type ProspectInquiryResult,
} from "./classifyProspectInquiry";

type ExistingProspectConversation = {
  id: string;
  status: string | null;
  promoted_lead_id: string | null;
  customer_email: string | null;
};

export type ProspectRouteResult = {
  routed: boolean;
  reason:
    | "existing_prospect_conversation"
    | "new_pure_prospect_inquiry"
    | "not_prospect_inquiry";
  jobId: string | null;
  conversationId: string | null;
  classification: ProspectInquiryResult | null;
};

function normalizeEmail(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);

  return (match?.[1] ?? raw).trim().toLowerCase();
}

/*
 * Routing-boundary admission projection.
 *
 * The outer inbox classifier answers a broader question: whether the sender is
 * acting like a real customer versus vendor/system/noise. Its positive labels
 * such as "customer_service_request" and "seeking_service" are intentionally
 * coarse and MUST NOT decide whether a legitimate customer turn is
 * informational versus an actual service/booking action.
 *
 * The prospect arbiter therefore receives only the hard anti-noise safety
 * signals from that upstream classifier. It must independently decide from the
 * customer's actual message whether this turn is information or direct action.
 *
 * This is generic: no service names, phrases, dates, test values, or customer
 * wording are encoded here.
 */
function projectAdmissionForProspectArbiter(
  admission?: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!admission) return null;

  return {
    isAutomatedOrBulk: Boolean(admission.isAutomatedOrBulk),
    isVendorOrSolicitation: Boolean(admission.isVendorOrSolicitation),
    isAccountOrSystemNotice: Boolean(admission.isAccountOrSystemNotice),
  };
}

async function findExistingProspectConversation(params: {
  companyId: string;
  provider: string;
  providerThreadId: string;
  customerEmail: string;
}): Promise<ExistingProspectConversation | null> {
  const { data, error } = await supabase
    .from("prospect_conversations")
    .select("id, status, promoted_lead_id, customer_email")
    .eq("company_id", params.companyId)
    .eq("provider", params.provider)
    .eq("provider_thread_id", params.providerThreadId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const conversation = data as ExistingProspectConversation;
  const expectedEmail = normalizeEmail(params.customerEmail);
  const actualEmail = normalizeEmail(conversation.customer_email);

  if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
    return null;
  }

  return conversation;
}

function isExistingProspectConversationRoutable(
  conversation: ExistingProspectConversation | null
) {
  if (!conversation) {
    return false;
  }

  return (
    conversation.status !== "promoted_to_booking" &&
    conversation.status !== "closed" &&
    !conversation.promoted_lead_id
  );
}

export async function routeProspectInquiryIfApplicable(params: {
  companyId: string;
  existingClassification: string;
  existingAdmission?: Record<string, unknown> | null;
  hasActiveBookingConversation: boolean;
  provider?: string;
  providerEventId: string;
  providerThreadId: string;
  providerEmailId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  cleanTextBody: string;
  rawTextBody: string;
}): Promise<ProspectRouteResult> {
  /*
   * Absolute firewall:
   * if the existing booking system owns the conversation, prospect routing is
   * unreachable.
   */
  if (params.hasActiveBookingConversation) {
    return {
      routed: false,
      reason: "not_prospect_inquiry",
      jobId: null,
      conversationId: null,
      classification: null,
    };
  }

  if (
    !params.companyId ||
    !params.providerEventId ||
    !params.providerThreadId ||
    !params.fromEmail
  ) {
    return {
      routed: false,
      reason: "not_prospect_inquiry",
      jobId: null,
      conversationId: null,
      classification: null,
    };
  }

  const provider = params.provider || "gmail_pubsub";
  const message =
    String(params.cleanTextBody ?? "").trim() ||
    String(params.rawTextBody ?? "").trim();

  if (!message) {
    return {
      routed: false,
      reason: "not_prospect_inquiry",
      jobId: null,
      conversationId: null,
      classification: null,
    };
  }

  /*
   * Exact prospect-thread continuity is stronger than a fresh standalone
   * classification. Once a real prospect inquiry conversation exists, short
   * replies such as "yes", "no", "how much?", etc. stay in this isolated lane
   * until promotion creates a canonical Lead.
   */
  const existingConversation = await findExistingProspectConversation({
    companyId: params.companyId,
    provider,
    providerThreadId: params.providerThreadId,
    customerEmail: params.fromEmail,
  });

  if (isExistingProspectConversationRoutable(existingConversation)) {
    const jobId =
      `process_prospect_inquiry:${params.companyId}:${params.providerEventId}`;

    const job = await enqueueBackgroundJob({
      name: "process_prospect_inquiry",
      jobId,
      data: {
        companyId: params.companyId,
        provider,
        providerEventId: params.providerEventId,
        providerThreadId: params.providerThreadId,
        providerEmailId: params.providerEmailId ?? null,
        fromEmail: params.fromEmail,
        toEmail: params.toEmail ?? null,
        subject: params.subject ?? null,
        textBody: message,
        prospectClassification: null,
      },
      priority: 8,
    });

    return {
      routed: true,
      reason: "existing_prospect_conversation",
      jobId: job.id ?? jobId,
      conversationId: existingConversation?.id ?? null,
      classification: null,
    };
  }

  /*
   * TWO-GATE ADMISSION INVARIANT.
   *
   * Every non-active-booking customer turn gets the semantic prospect arbiter
   * before a brand-new Lead is created. Do not use a cheap phrase/question
   * surface gate here: slang, preambles, typos, fragments, or conversational
   * wording must not hide a genuine informational/capability question from the
   * information gate.
   *
   * The outer admission classifier is used only for its hard anti-noise safety
   * signals. Its coarse positive "customer service request" direction is not
   * allowed to pre-answer the separate information-vs-action question.
   *
   * This remains safe because classifyProspectInquiry itself rejects
   * vendor/system/non-customer mail and marks actual service/scheduling requests
   * as directServiceRequest. Only the high-confidence pure-information result
   * below is diverted; direct service still falls through to booking unchanged.
   */
  const classification = await classifyProspectInquiry({
    subject: params.subject,
    body: message,
    fromEmail: params.fromEmail,
    hasExistingProspectConversation: false,
    existingAdmission: projectAdmissionForProspectArbiter(
      params.existingAdmission
    ),
  });

  /*
   * Fail closed.
   * A direct service request NEVER gets diverted out of the existing booking
   * pipeline. Low-confidence prospect classifications are not answered.
   */
  const safePureInquiry =
    classification.isProspectInquiry &&
    !classification.directServiceRequest &&
    classification.confidence >= 0.8;

  if (!safePureInquiry) {
    return {
      routed: false,
      reason: "not_prospect_inquiry",
      jobId: null,
      conversationId: null,
      classification,
    };
  }

  const jobId =
    `process_prospect_inquiry:${params.companyId}:${params.providerEventId}`;

  const job = await enqueueBackgroundJob({
    name: "process_prospect_inquiry",
    jobId,
    data: {
      companyId: params.companyId,
      provider,
      providerEventId: params.providerEventId,
      providerThreadId: params.providerThreadId,
      providerEmailId: params.providerEmailId ?? null,
      fromEmail: params.fromEmail,
      toEmail: params.toEmail ?? null,
      subject: params.subject ?? null,
      textBody: message,
      prospectClassification: classification,
    },
    priority: 8,
  });

  return {
    routed: true,
    reason: "new_pure_prospect_inquiry",
    jobId: job.id ?? jobId,
    conversationId: null,
    classification,
  };
}