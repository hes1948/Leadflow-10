// lib/prospect-inquiries/promoteProspectToBooking.ts
//
// ONE-WAY HANDOFF:
// prospect conversation -> ordinary Lead row -> existing booking pipeline.
//
// This file does not resolve scheduling language, generate slots, or book.
// It creates canonical Gmail-thread ownership for the existing booking system
// and asks the customer for the desired day/time.

import { supabase } from "@/lib/supabase";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";
import { extractLeadData } from "@/lib/ai/extractLeadData";
import {
  extractLeadMetadataFromText,
  mergeLeadMetadata,
} from "@/lib/leads/leadMetadata";

type ProspectConversation = {
  id: string;
  company_id: string;
  provider: string;
  provider_thread_id: string;
  customer_email: string;
  subject: string | null;
  status: string;
  original_message: string | null;
  last_customer_message: string | null;
  last_answer: string | null;
  booking_opt_in: boolean | null;
  promoted_lead_id: string | null;
  history: any[];
  created_at?: string | null;
  updated_at?: string | null;
};

function cleanHeader(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function normalizeSubject(subject?: string | null) {
  const value = cleanHeader(subject) || "Your HVAC Question";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

function encodeEmailRaw(params: {
  to: string;
  subject: string;
  body: string;
}) {
  const raw = [
    `To: ${cleanHeader(params.to)}`,
    `Subject: ${normalizeSubject(params.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    params.body,
  ].join("\r\n");

  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getCompanySignature(companyId: string) {
  const { data, error } = await supabase
    .from("companies")
    .select("email_signature")
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const signature = String(data?.email_signature ?? "").trim();
  return signature || null;
}

function appendSignature(body: string, signature?: string | null) {
  const cleanBody = String(body ?? "").trim();
  const cleanSignature = String(signature ?? "").trim();

  if (!cleanSignature) return cleanBody;
  if (cleanBody.includes(cleanSignature)) return cleanBody;

  return `${cleanBody}\n\n${cleanSignature}`;
}

async function sendProspectGmailReply(params: {
  companyId: string;
  to: string;
  subject?: string | null;
  body: string;
  providerThreadId: string;
}) {
  if (!params.companyId) throw new Error("missing_company_id");
  if (!params.to) throw new Error("missing_customer_email");
  if (!params.body?.trim()) throw new Error("missing_reply_body");
  if (!params.providerThreadId) throw new Error("missing_provider_thread_id");

  const [gmail, signature] = await Promise.all([
    getCompanyGmailClient(params.companyId),
    getCompanySignature(params.companyId),
  ]);

  const bodyWithSignature = appendSignature(params.body, signature);

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodeEmailRaw({
        to: params.to,
        subject: params.subject ?? "Your HVAC Question",
        body: bodyWithSignature,
      }),
      threadId: params.providerThreadId,
    },
  });

  if (!sent.data.id) {
    throw new Error("prospect_gmail_send_missing_message_id");
  }

  return {
    sent: true,
    providerEmailId: sent.data.id,
    providerThreadId: sent.data.threadId ?? params.providerThreadId,
    body: (sent as any).leadflowBody ?? bodyWithSignature,
  };
}

function normalizeHistory(value: unknown) {
  return Array.isArray(value) ? value.slice(-40) : [];
}

async function markProspectConversationPromoted(params: {
  conversation: ProspectConversation;
  promotedLeadId: string;
  customerMessage: string;
  assistantMessage?: string | null;
}) {
  const history = normalizeHistory(params.conversation.history);
  const now = new Date().toISOString();

  if (params.customerMessage) {
    history.push({
      role: "customer",
      content: params.customerMessage,
      at: now,
      metadata: {
        transition: "promoted_to_existing_booking_pipeline",
        leadId: params.promotedLeadId,
      },
    });
  }

  if (params.assistantMessage) {
    history.push({
      role: "assistant",
      content: params.assistantMessage,
      at: now,
      metadata: {
        transition: "promoted_to_existing_booking_pipeline",
        leadId: params.promotedLeadId,
      },
    });
  }

  const { data, error } = await supabase
    .from("prospect_conversations")
    .update({
      status: "promoted_to_booking",
      booking_opt_in: true,
      promoted_lead_id: params.promotedLeadId,
      last_customer_message: params.customerMessage,
      last_answer:
        params.assistantMessage ?? params.conversation.last_answer ?? null,
      history: history.slice(-40),
      updated_at: now,
    })
    .eq("id", params.conversation.id)
    .eq("company_id", params.conversation.company_id)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data?.id) {
    throw new Error("prospect_conversation_update_scope_violation");
  }
}

function isUniqueViolation(error: any) {
  return String(error?.code ?? "") === "23505";
}

async function findExistingPromotedLead(params: {
  companyId: string;
  providerThreadId: string;
  providerEventId: string;
}) {
  const byThread = await supabase
    .from("leads")
    .select(
      "id, company_id, status, qualification, inbound_thread_id, outbound_thread_id, outbound_email_id"
    )
    .eq("company_id", params.companyId)
    .eq("inbound_thread_id", params.providerThreadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byThread.error) throw new Error(byThread.error.message);
  if (byThread.data?.id) return byThread.data;

  const byEvent = await supabase
    .from("leads")
    .select(
      "id, company_id, status, qualification, inbound_thread_id, outbound_thread_id, outbound_email_id"
    )
    .eq("company_id", params.companyId)
    .eq("inbound_email_id", params.providerEventId)
    .maybeSingle();

  if (byEvent.error) throw new Error(byEvent.error.message);
  return byEvent.data ?? null;
}

export async function promoteProspectToBooking(params: {
  conversation: ProspectConversation;
  providerEventId: string;
  newestCustomerMessage: string;
  toEmail: string;
  subject?: string | null;
}) {
  const conversation = params.conversation;

  if (conversation.promoted_lead_id) {
    return {
      leadId: conversation.promoted_lead_id,
      alreadyPromoted: true,
      bookingPromptSent: false,
    };
  }

  const existingLead = await findExistingPromotedLead({
    companyId: conversation.company_id,
    providerThreadId: conversation.provider_thread_id,
    providerEventId: params.providerEventId,
  });

  let lead: any = existingLead;

  if (!lead) {
    const sourceText = [
      conversation.original_message,
      conversation.last_customer_message,
      params.newestCustomerMessage,
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    const qualification = (await extractLeadData(sourceText)) as Record<
      string,
      any
    >;

    const extractedMetadata = extractLeadMetadataFromText(
      sourceText,
      params.toEmail
    );

    const leadMetadata = mergeLeadMetadata({
      qualification,
      metadata: extractedMetadata,
      fallbackEmail: params.toEmail,
    });

    const now = new Date().toISOString();

    const inserted = await supabase
      .from("leads")
      .insert({
        company_id: conversation.company_id,
        input: sourceText,
        message: sourceText,
        status: "awaiting_customer",
        priority:
          qualification.urgency === "emergency" ||
          qualification.urgency === "high"
            ? "high"
            : "normal",
        type: qualification.serviceType ?? "hvac",
        email: leadMetadata.email ?? params.toEmail,
        phone: leadMetadata.phone,
        customer_name: leadMetadata.customerName,
        preferred_time: null,
        issue_summary:
          qualification.issueSummary ??
          conversation.original_message ??
          "Prospect requested help booking service.",
        address: leadMetadata.address,
        city: leadMetadata.city,
        state: leadMetadata.state,
        zip: leadMetadata.zip,
        source: "gmail",
        inbound_email_id: params.providerEventId,
        inbound_thread_id: conversation.provider_thread_id,
        last_email_subject: params.subject ?? conversation.subject ?? null,
        last_contacted_at: now,
        qualification: {
          ...qualification,
          customerName: leadMetadata.customerName,
          email: leadMetadata.email ?? params.toEmail,
          phone: leadMetadata.phone,
          address: leadMetadata.address,
          city: leadMetadata.city,
          state: leadMetadata.state,
          zip: leadMetadata.zip,
          serviceArea: leadMetadata.serviceArea,
          /*
           * Deliberately NO pendingSlotSuggestion and NO
           * activeSchedulingYearContext here.
           */
          prospectInquiryPromotion: {
            conversationId: conversation.id,
            promotedAt: now,
            providerEventId: params.providerEventId,
            bookingPromptSentAt: null,
          },
        },
      })
      .select(
        "id, company_id, status, qualification, inbound_thread_id, outbound_thread_id, outbound_email_id"
      )
      .maybeSingle();

    if (inserted.data?.id) {
      lead = inserted.data;
    } else if (isUniqueViolation(inserted.error)) {
      lead = await findExistingPromotedLead({
        companyId: conversation.company_id,
        providerThreadId: conversation.provider_thread_id,
        providerEventId: params.providerEventId,
      });

      if (!lead?.id) {
        throw new Error("prospect_promotion_unique_conflict_without_lead");
      }
    } else {
      throw new Error(
        inserted.error?.message ?? "prospect_promotion_lead_insert_failed"
      );
    }
  }

  const currentQualification =
    lead.qualification && typeof lead.qualification === "object"
      ? lead.qualification
      : {};

  const alreadyPrompted = Boolean(
    currentQualification?.prospectInquiryPromotion?.bookingPromptSentAt
  );

  let bookingPromptSent = false;

  if (!alreadyPrompted) {
    const promptBody =
      "Absolutely — what day and time works best for you?";

    const sent = await sendProspectGmailReply({
      companyId: conversation.company_id,
      to: params.toEmail,
      subject: params.subject ?? conversation.subject,
      body: promptBody,
      providerThreadId: conversation.provider_thread_id,
    });

    const now = new Date().toISOString();

    const nextQualification = {
      ...currentQualification,
      prospectInquiryPromotion: {
        ...(currentQualification.prospectInquiryPromotion ?? {}),
        conversationId: conversation.id,
        providerEventId: params.providerEventId,
        bookingPromptSentAt: now,
        bookingPromptProviderEmailId: sent.providerEmailId,
      },
    };

    const updatedLead = await supabase
      .from("leads")
      .update({
        status: "awaiting_customer",
        qualification: nextQualification,
        outbound_email_id: sent.providerEmailId,
        outbound_thread_id: sent.providerThreadId,
        sent_at: now,
        last_contacted_at: now,
        last_email_subject:
          params.subject ?? conversation.subject ?? "Your HVAC Question",
      })
      .eq("id", lead.id)
      .eq("company_id", conversation.company_id)
      .select("id")
      .maybeSingle();

    if (updatedLead.error) {
      throw new Error(updatedLead.error.message);
    }

    if (!updatedLead.data?.id) {
      throw new Error("prospect_promoted_lead_update_scope_violation");
    }

    bookingPromptSent = true;
  }

  await markProspectConversationPromoted({
    conversation,
    promotedLeadId: lead.id,
    customerMessage: params.newestCustomerMessage,
    assistantMessage: bookingPromptSent
      ? "Absolutely — what day and time works best for you?"
      : null,
  });

  return {
    leadId: lead.id as string,
    alreadyPromoted: Boolean(existingLead),
    bookingPromptSent,
  };
}
