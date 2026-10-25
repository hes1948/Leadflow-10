// lib/jobs/processProspectInquiryJob.ts
/// lib/jobs/processProspectInquiryJob.ts
//
// Worker for the isolated customer-intelligence / prospect inquiry lane.
// Existing booking/scheduling code is never called until promotion creates a
// canonical Lead and the CUSTOMER'S NEXT REPLY enters the existing pipeline.
//
// IMPORTANT FIREWALL:
// This file never books appointments. It may resolve ONLY the newest customer's
// explicit date/time read-only when needed to answer an informational availability
// question, and it may READ canonical availability. It never writes booking state,
// pending-slot state, calendar events, or persistent scheduling/year context.
// Promotion only creates canonical Lead ownership on the same Gmail thread.
// The existing booking pipeline exclusively owns booking mutations.

import OpenAI from "openai";
import { supabase } from "@/lib/supabase";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";
import { extractLeadData } from "@/lib/ai/extractLeadData";
import {
  extractLeadMetadataFromText,
  mergeLeadMetadata,
} from "@/lib/leads/leadMetadata";
import {
  classifyProspectInquiry,
  type ProspectInquiryResult,
} from "@/lib/prospect-inquiries/classifyProspectInquiry";
import {
  checkAvailability,
  suggestAlternativeSlots,
} from "@/lib/availability/checkAvailability";
import { resolveSchedulingIntent } from "@/lib/ai/resolveSchedulingIntent";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import type { BookingCommandResult } from "@/lib/booking/resolveBookingCommand";
import {
  addDaysToLocalDate,
  getNowInTimezone,
  getWeekdayIndexForLocalDate,
  zonedTimeToUtc,
} from "@/lib/time/companyTime";

type ProcessProspectInquiryJobData = {
  companyId: string;
  provider: string;
  providerEventId: string;
  providerThreadId: string;
  providerEmailId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  textBody: string;
  prospectClassification?: ProspectInquiryResult | null;
};


type ProspectConversationStatus =
  | "open"
  | "awaiting_booking_decision"
  | "promoted_to_booking"
  | "declined_booking"
  | "closed";

type ProspectConversation = {
  id: string;
  company_id: string;
  provider: string;
  provider_thread_id: string;
  customer_email: string;
  subject: string | null;
  status: ProspectConversationStatus;
  original_message: string | null;
  last_customer_message: string | null;
  last_answer: string | null;
  booking_opt_in: boolean | null;
  promoted_lead_id: string | null;
  history: any[];
  created_at: string;
  updated_at: string;
};

function normalizeProspectEmail(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function normalizeProspectHistory(value: unknown) {
  return Array.isArray(value) ? value.slice(-40) : [];
}

function isProspectConversationUniqueViolation(error: any) {
  return String(error?.code ?? "") === "23505";
}

async function findProspectConversationByThread(params: {
  companyId: string;
  provider?: string;
  providerThreadId: string;
  customerEmail?: string | null;
}) {
  if (!params.companyId || !params.providerThreadId) return null;

  const provider = params.provider || "gmail_pubsub";

  const { data, error } = await supabase
    .from("prospect_conversations")
    .select("*")
    .eq("company_id", params.companyId)
    .eq("provider", provider)
    .eq("provider_thread_id", params.providerThreadId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const conversation = data as ProspectConversation;
  const expectedEmail = normalizeProspectEmail(params.customerEmail);
  const actualEmail = normalizeProspectEmail(conversation.customer_email);

  if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
    return null;
  }

  return {
    ...conversation,
    history: normalizeProspectHistory(conversation.history),
  } as ProspectConversation;
}

async function getOrCreateProspectConversation(params: {
  companyId: string;
  provider?: string;
  providerThreadId: string;
  customerEmail: string;
  subject?: string | null;
  originalMessage: string;
}) {
  const provider = params.provider || "gmail_pubsub";

  const existing = await findProspectConversationByThread({
    companyId: params.companyId,
    provider,
    providerThreadId: params.providerThreadId,
    customerEmail: params.customerEmail,
  });

  if (existing) return existing;

  const now = new Date().toISOString();

  const inserted = await supabase
    .from("prospect_conversations")
    .insert({
      company_id: params.companyId,
      provider,
      provider_thread_id: params.providerThreadId,
      customer_email: normalizeProspectEmail(params.customerEmail),
      subject: params.subject ?? null,
      status: "open",
      original_message: params.originalMessage,
      last_customer_message: params.originalMessage,
      history: [
        {
          role: "customer",
          content: params.originalMessage,
          at: now,
        },
      ],
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .maybeSingle();

  if (inserted.data) {
    return {
      ...(inserted.data as ProspectConversation),
      history: normalizeProspectHistory((inserted.data as any).history),
    } as ProspectConversation;
  }

  if (!isProspectConversationUniqueViolation(inserted.error)) {
    throw new Error(
      inserted.error?.message ?? "prospect_conversation_insert_failed"
    );
  }

  const raced = await findProspectConversationByThread({
    companyId: params.companyId,
    provider,
    providerThreadId: params.providerThreadId,
    customerEmail: params.customerEmail,
  });

  if (!raced) {
    throw new Error("prospect_conversation_unique_conflict_without_row");
  }

  return raced;
}

async function reserveProspectInboundEvent(params: {
  conversationId: string;
  companyId: string;
  providerEventId: string;
  body: string;
  metadata?: Record<string, any> | null;
}) {
  const now = new Date().toISOString();

  const inserted = await supabase
    .from("prospect_message_events")
    .insert({
      conversation_id: params.conversationId,
      company_id: params.companyId,
      provider_event_id: params.providerEventId,
      direction: "inbound",
      status: "processing",
      body: params.body,
      metadata: params.metadata ?? {},
      created_at: now,
      updated_at: now,
    })
    .select("id, status")
    .maybeSingle();

  if (inserted.data?.id) {
    return {
      eventId: inserted.data.id as string,
      duplicateCompleted: false,
      duplicateInFlight: false,
    };
  }

  if (!isProspectConversationUniqueViolation(inserted.error)) {
    throw new Error(
      inserted.error?.message ?? "prospect_event_reservation_failed"
    );
  }

  const existing = await supabase
    .from("prospect_message_events")
    .select("id, status, updated_at")
    .eq("company_id", params.companyId)
    .eq("provider_event_id", params.providerEventId)
    .eq("direction", "inbound")
    .maybeSingle();

  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data?.id) {
    throw new Error("prospect_event_unique_conflict_without_row");
  }

  if (existing.data.status === "completed") {
    return {
      eventId: existing.data.id as string,
      duplicateCompleted: true,
      duplicateInFlight: false,
    };
  }

  if (existing.data.status === "processing") {
    const updatedAtMs = new Date(String(existing.data.updated_at ?? "")).getTime();
    const processingIsFresh =
      Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < 10 * 60 * 1000;

    if (processingIsFresh) {
      return {
        eventId: existing.data.id as string,
        duplicateCompleted: false,
        duplicateInFlight: true,
      };
    }
  }

  const retried = await supabase
    .from("prospect_message_events")
    .update({
      status: "processing",
      error: null,
      updated_at: now,
    })
    .eq("id", existing.data.id)
    .eq("company_id", params.companyId)
    .select("id")
    .maybeSingle();

  if (retried.error) throw new Error(retried.error.message);
  if (!retried.data?.id) throw new Error("prospect_event_retry_claim_failed");

  return {
    eventId: existing.data.id as string,
    duplicateCompleted: false,
    duplicateInFlight: false,
  };
}

async function markProspectEventCompleted(params: {
  eventId: string;
  companyId: string;
  metadata?: Record<string, any> | null;
}) {
  const { error } = await supabase
    .from("prospect_message_events")
    .update({
      status: "completed",
      metadata: params.metadata ?? {},
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.eventId)
    .eq("company_id", params.companyId);

  if (error) throw new Error(error.message);
}

async function markProspectEventFailed(params: {
  eventId: string;
  companyId: string;
  error: string;
}) {
  const { error } = await supabase
    .from("prospect_message_events")
    .update({
      status: "failed",
      error: params.error.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.eventId)
    .eq("company_id", params.companyId);

  if (error) {
    console.error("[prospect-inquiry] failed to mark event failure", {
      eventId: params.eventId,
      companyId: params.companyId,
      error: error.message,
    });
  }
}

async function updateProspectConversation(params: {
  conversation: ProspectConversation;
  status?: ProspectConversationStatus;
  bookingOptIn?: boolean | null;
  promotedLeadId?: string | null;
  customerMessage?: string | null;
  assistantMessage?: string | null;
  lastAnswer?: string | null;
  historyMetadata?: Record<string, any> | null;
}) {
  const history = normalizeProspectHistory(params.conversation.history);

  if (params.customerMessage) {
    history.push({
      role: "customer",
      content: params.customerMessage,
      at: new Date().toISOString(),
      ...(params.historyMetadata
        ? { metadata: params.historyMetadata }
        : {}),
    });
  }

  if (params.assistantMessage) {
    history.push({
      role: "assistant",
      content: params.assistantMessage,
      at: new Date().toISOString(),
      ...(params.historyMetadata
        ? { metadata: params.historyMetadata }
        : {}),
    });
  }

  const payload: Record<string, any> = {
    history: history.slice(-40),
    updated_at: new Date().toISOString(),
  };

  if (params.status !== undefined) payload.status = params.status;
  if (params.bookingOptIn !== undefined) {
    payload.booking_opt_in = params.bookingOptIn;
  }
  if (params.promotedLeadId !== undefined) {
    payload.promoted_lead_id = params.promotedLeadId;
  }
  if (params.customerMessage !== undefined) {
    payload.last_customer_message = params.customerMessage;
  }
  if (params.lastAnswer !== undefined) {
    payload.last_answer = params.lastAnswer;
  }

  const { data, error } = await supabase
    .from("prospect_conversations")
    .update(payload)
    .eq("id", params.conversation.id)
    .eq("company_id", params.conversation.company_id)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("prospect_conversation_update_scope_violation");

  return {
    ...(data as ProspectConversation),
    history: normalizeProspectHistory((data as any).history),
  } as ProspectConversation;
}

function formatProspectConversationContext(
  conversation: ProspectConversation
) {
  return normalizeProspectHistory(conversation.history)
    .slice(-12)
    .map((item: any) => {
      const role =
        item?.role === "assistant" ? "Company" : "Customer";
      return `${role}: ${String(item?.content ?? "").trim()}`;
    })
    .filter(Boolean)
    .join("\n");
}

type CompanyKnowledgeItem = {
  id: string;
  topic: string;
  content: string;
  sourceType: string;
  sourceUrl: string | null;
  updatedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  metadata: Record<string, unknown> | null;
};

type ProspectInquiryContext = {
  companyFacts: Record<string, unknown>;
  companyKnowledge: CompanyKnowledgeItem[];
  retrievedAt: string;
};

type ProspectAnswerResult = {
  answer: string;
  confidence: number;
  usedFreshWeb: boolean;
  sourceUrls: string[];
  evidenceMode:
    | "company_grounded"
    | "stable_general"
    | "fresh_web"
    | "insufficient_verified_information";
};

type ProspectTurnDecision =
  | "booking_yes"
  | "booking_no"
  | "availability_question"
  | "question"
  | "unclear";

type ProspectTurnResult = {
  decision: ProspectTurnDecision;
  confidence: number;
  reason: string;
  source: "deterministic" | "semantic_model";
};

let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampConfidence(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function classificationFromJob(
  data: ProcessProspectInquiryJobData
): ProspectInquiryResult | null {
  if (!data.prospectClassification) return null;

  const rawClassification =
    data.prospectClassification as ProspectInquiryResult;

  return {
    isProspectInquiry: Boolean(rawClassification.isProspectInquiry),
    directServiceRequest: Boolean(rawClassification.directServiceRequest),
    confidence: Number(rawClassification.confidence ?? 0),
    category:
      rawClassification.category ?? "other_prospect_question",
    requiresCompanyFacts: Boolean(rawClassification.requiresCompanyFacts),
    requiresFreshExternalData: Boolean(
      rawClassification.requiresFreshExternalData
    ),
    reason:
      rawClassification.reason ??
      "prospect_classification_from_router",
    source:
      rawClassification.source === "deterministic_fallback"
        ? "deterministic_fallback"
        : "semantic_model",
    serviceDomainFit: rawClassification.serviceDomainFit ?? "not_applicable",
    capabilityQuestion: Boolean(rawClassification.capabilityQuestion),
  };
}

/* -------------------------------------------------------------------------- */
/* Verified company context — exact grounding contract, inlined locally.       */
/* -------------------------------------------------------------------------- */

function keepDefined(
  source: Record<string, any>,
  keys: string[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const key of keys) {
    const value = source?.[key];

    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      output[key] = value;
    }
  }

  return output;
}

function isKnowledgeCurrentlyValid(item: any, nowMs: number) {
  const validFromMs = item?.valid_from
    ? new Date(item.valid_from).getTime()
    : Number.NEGATIVE_INFINITY;

  const validUntilMs = item?.valid_until
    ? new Date(item.valid_until).getTime()
    : Number.POSITIVE_INFINITY;

  return validFromMs <= nowMs && validUntilMs > nowMs;
}

async function getProspectInquiryContext(
  companyId: string
): Promise<ProspectInquiryContext> {
  if (!companyId) throw new Error("missing_company_id");

  const companyResult = await supabase
    .from("companies")
    .select("*")
    .eq("id", companyId)
    .maybeSingle();

  if (companyResult.error) {
    throw new Error(companyResult.error.message);
  }

  if (!companyResult.data) {
    throw new Error("company_not_found");
  }

  const company = companyResult.data as Record<string, any>;

  // Deliberately whitelist business-facing facts only.
  const companyFacts = keepDefined(company, [
    "name",
    "business_name",
    "phone",
    "email",
    "website",
    "timezone",
    "business_hours",
    "default_appointment_minutes",
    "dispatch_radius_miles",
    "service_area",
    "service_area_state",
    "service_area_cities",
    "service_area_zips",
    "services",
    "service_types",
    "brands",
    "financing",
    "warranty",
    "warranties",
    "maintenance_plans",
    "emergency_service",
    "diagnostic_fee",
    "trip_fee",
    "promotions",

    // Additional business-facing truth if these fields exist on this company's
    // account row. Missing fields are ignored by keepDefined().
    "pricing",
    "prices",
    "service_pricing",
    "service_prices",
    "service_catalog",
    "price_book",
    "pricing_rules",
    "policies",
    "company_policies",
    "booking_policy",
    "cancellation_policy",
    "refund_policy",
    "payment_methods",
    "after_hours_policy",
    "same_day_policy",
    "faq",
    "faqs",
  ]);

  const knowledgeResult = await supabase
    .from("company_knowledge")
    .select(
      "id, topic, content, source_type, source_url, updated_at, valid_from, valid_until, metadata"
    )
    .eq("company_id", companyId)
    .eq("active", true)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (knowledgeResult.error) {
    throw new Error(knowledgeResult.error.message);
  }

  const nowMs = Date.now();

  const companyKnowledge: CompanyKnowledgeItem[] = (
    knowledgeResult.data ?? []
  )
    .filter((item: any) => isKnowledgeCurrentlyValid(item, nowMs))
    .map((item: any) => ({
      id: String(item.id),
      topic: String(item.topic ?? ""),
      content: String(item.content ?? ""),
      sourceType: String(item.source_type ?? "owner"),
      sourceUrl: item.source_url ? String(item.source_url) : null,
      updatedAt: item.updated_at ? String(item.updated_at) : null,
      validFrom: item.valid_from ? String(item.valid_from) : null,
      validUntil: item.valid_until ? String(item.valid_until) : null,
      metadata:
        item.metadata && typeof item.metadata === "object"
          ? (item.metadata as Record<string, unknown>)
          : null,
    }))
    .filter((item: CompanyKnowledgeItem) => item.topic && item.content);

  return {
    companyFacts,
    companyKnowledge,
    retrievedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Grounded answer engine — company facts verified; current facts use web.     */
/* -------------------------------------------------------------------------- */

function hasAnyCompanyEvidence(context: ProspectInquiryContext) {
  return (
    Object.keys(context.companyFacts ?? {}).length > 0 ||
    (context.companyKnowledge ?? []).length > 0
  );
}

function collectHttpUrls(value: unknown, output = new Set<string>()) {
  if (!value) return output;

  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) output.add(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, output);
    return output;
  }

  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectHttpUrls(child, output);
    }
  }

  return output;
}

function safeNoFreshEvidenceAnswer(): ProspectAnswerResult {
  return {
    answer:
      "I can’t verify the latest information on that right now, so I don’t want to guess.",
    confidence: 1,
    usedFreshWeb: false,
    sourceUrls: [],
    evidenceMode: "insufficient_verified_information",
  };
}

function buildGroundingPayload(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}) {
  return {
    question: cleanText(input.question).slice(0, 12000),
    category: input.category,
    serviceDomainFit: input.classification.serviceDomainFit ?? "not_applicable",
    capabilityQuestion: Boolean(input.classification.capabilityQuestion),
    conversationContext: cleanText(input.conversationContext).slice(0, 6000),
    verifiedCompanyFacts: input.context.companyFacts,
    verifiedCompanyKnowledge: input.context.companyKnowledge.map((item) => ({
      topic: item.topic,
      content: item.content,
      sourceType: item.sourceType,
      sourceUrl: item.sourceUrl,
      updatedAt: item.updatedAt,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      metadata: item.metadata,
    })),
    evidenceRetrievedAt: input.context.retrievedAt,
  };
}

function extractResponsesOutputText(payload: any) {
  if (typeof payload?.output_text === "string") {
    return cleanText(payload.output_text);
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const pieces: string[] = [];

  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) {
      continue;
    }

    for (const content of item.content) {
      if (
        content?.type === "output_text" &&
        typeof content?.text === "string"
      ) {
        pieces.push(content.text);
      }
    }
  }

  return cleanText(pieces.join("\n"));
}

async function answerWithFreshWeb(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<ProspectAnswerResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return safeNoFreshEvidenceAnswer();
  }

  try {
    // Direct REST protects the existing booking dependency surface from SDK churn.
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LEADFLOW_PROSPECT_WEB_MODEL || "gpt-5",
        tools: [{ type: "web_search" }],
        instructions: [
          "You answer a real HVAC company's prospect/customer questions.",
          "This question has been classified as requiring fresh external information.",
          "Use web search before stating time-sensitive external facts.",
          "Prefer primary/official sources: manufacturer, regulator, government, utility, weather authority, or other directly authoritative source.",
          "Verified company-specific facts supplied in the input are authoritative for this company.",
          "Never invent this company's pricing, service area, brands, financing, warranty, policies, availability, or capabilities.",
          "Do not claim a company-specific fact unless it is present in verifiedCompanyFacts or verifiedCompanyKnowledge.",
          "If the web cannot establish the requested current fact, explicitly say you could not verify it.",
          "Keep the customer-facing answer concise, useful, and direct.",
          "Do not ask about booking. The caller will append the booking question separately.",
          "Do not fabricate citations, URLs, dates, recalls, laws, or manufacturer notices.",
          "For immediate danger involving gas, carbon monoxide, smoke, fire, or electrical arcing, prioritize safety and emergency/utility instructions over troubleshooting.",
        ].join("\n"),
        input: JSON.stringify(buildGroundingPayload(input)),
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          `openai_responses_http_${response.status}`
      );
    }

    const answer = extractResponsesOutputText(payload);
    const outputItems = Array.isArray(payload?.output)
      ? payload.output
      : [];

    const usedFreshWeb = outputItems.some(
      (item: any) => item?.type === "web_search_call"
    );

    // Current-sensitive answers cannot silently fall back to model memory.
    if (!usedFreshWeb || !answer) {
      return safeNoFreshEvidenceAnswer();
    }

    const sourceUrls = Array.from(
      collectHttpUrls(payload?.output)
    ).slice(0, 8);

    return {
      answer: answer.slice(0, 4000),
      confidence: 0.9,
      usedFreshWeb: true,
      sourceUrls,
      evidenceMode: "fresh_web",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] fresh web answer failed", {
      error: error?.message ?? error,
    });

    return safeNoFreshEvidenceAnswer();
  }
}


async function answerCompanyQuestionWithOfficialWeb(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<ProspectAnswerResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      answer:
        "I don’t have enough verified company information available to answer that accurately right now, so I don’t want to guess.",
      confidence: 1,
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: "insufficient_verified_information",
    };
  }

  const companyWebsite = cleanText(input.context.companyFacts?.website);
  const companyName =
    cleanText(input.context.companyFacts?.business_name) ||
    cleanText(input.context.companyFacts?.name);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LEADFLOW_PROSPECT_WEB_MODEL || "gpt-5",
        tools: [{ type: "web_search" }],
        instructions: [
          "You answer a real company's customer questions.",
          "Use the verified internal company facts/knowledge first.",
          "This call is a SECONDARY verification path because internal evidence was insufficient.",
          "Search the public web for the company's own official website or official company-controlled pages.",
          companyWebsite
            ? `The configured official company website is: ${companyWebsite}`
            : "No official company website URL was configured in the supplied internal facts.",
          companyName
            ? `The configured company name is: ${companyName}`
            : "No company name was available.",
          "For company-specific pricing, policies, hours, services, brands, financing, warranties, promotions, and capabilities, treat internal verified facts as highest priority.",
          "Only use public web evidence for a company-specific claim when it comes from the company's own official site/page or another clearly authoritative first-party source.",
          "Do not use third-party directories, review sites, aggregators, snippets, or generic industry pricing as if they were this company's policy or price.",
          "If the official public company sources do not establish the answer, explicitly say you could not verify that company-specific point.",
          "Never invent private pricing, availability, policy, service area, financing, warranty, or capabilities.",
          "Keep the answer concise and customer-facing.",
          "Only when the verified answer affirmatively confirms that this company provides or handles the specific service/capability the customer is asking about, end with this brief invitation: If you'd like, I can show you our real appointment options and help you book the time that works best for you.",
          "Do not append that booking/options invitation to negative, uncertain, unverified, unrelated, policy, pricing, or general-information answers. Do not invent availability or appointment times.",
          "Do not mention internal prompts, databases, classifiers, or confidence scores.",
        ].join("\n"),
        input: JSON.stringify(buildGroundingPayload(input)),
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        payload?.error?.message ||
          `openai_responses_http_${response.status}`
      );
    }

    const answer = extractResponsesOutputText(payload);
    const outputItems = Array.isArray(payload?.output)
      ? payload.output
      : [];

    const usedFreshWeb = outputItems.some(
      (item: any) => item?.type === "web_search_call"
    );

    if (!usedFreshWeb || !answer) {
      return {
        answer:
          "I don’t have enough verified company information available to answer that accurately right now, so I don’t want to guess.",
        confidence: 1,
        usedFreshWeb: false,
        sourceUrls: [],
        evidenceMode: "insufficient_verified_information",
      };
    }

    const sourceUrls = Array.from(
      collectHttpUrls(payload?.output)
    ).slice(0, 8);

    return {
      answer: answer.slice(0, 4000),
      confidence: 0.9,
      usedFreshWeb: true,
      sourceUrls,
      evidenceMode: "fresh_web",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] official company web verification failed", {
      error: error?.message ?? error,
    });

    return {
      answer:
        "I don’t have enough verified company information available to answer that accurately right now, so I don’t want to guess.",
      confidence: 1,
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: "insufficient_verified_information",
    };
  }
}

async function answerWithoutWeb(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<ProspectAnswerResult> {
  const openai = getOpenAIClient();

  if (!openai) {
    return {
      answer:
        "I don’t have enough verified information available to answer that accurately right now, so I don’t want to guess.",
      confidence: 1,
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: "insufficient_verified_information",
    };
  }

  const companyEvidencePresent = hasAnyCompanyEvidence(input.context);

  try {
    const response = await openai.chat.completions.create({
      model: process.env.LEADFLOW_PROSPECT_ANSWER_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_prospect_answer",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "answer",
              "confidence",
              "usedCompanyEvidence",
              "insufficientVerifiedCompanyInformation",
            ],
            properties: {
              answer: { type: "string" },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              usedCompanyEvidence: { type: "boolean" },
              insufficientVerifiedCompanyInformation: {
                type: "boolean",
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You answer inbound questions for an HVAC service company.",
            "Answer the customer's actual question directly and concisely.",
            "",
            "GROUNDING RULES:",
            "1. Any claim about THIS COMPANY must be supported by verifiedCompanyFacts or verifiedCompanyKnowledge in the user payload.",
            "2. Never invent this company's prices, diagnostic fees, service area, brands, financing, warranties, promotions, hours, policies, memberships, capabilities, or availability.",
            "3. If the customer asks a company-specific question and the supplied evidence does not establish the answer, say that you do not have verified company information on that point and do not guess.",
            "4. The information gate is intentionally broad. Answer legitimate customer questions even when the subject is unrelated to HVAC. serviceDomainFit controls booking safety; it must NOT be used as a reason to replace the requested informational answer with a generic 'not HVAC' refusal.",
            "5. If the customer asks about THIS COMPANY's policy, guarantee, values, practices, prices, hours, service area, or capabilities, answer only from verified company evidence. If internal evidence is insufficient, allow the official-company-web fallback instead of guessing.",
            "6. If capabilityQuestion=true, answer whether the company offers/handles the requested capability using verified company evidence. A clearly unrelated service remains non-bookable, but the customer still receives a useful truthful informational answer.",
            "7. Stable general factual questions, including non-HVAC questions, may use general knowledge when they do not assert facts about this specific company.",
            "8. Do not answer rapidly changing/current external questions from memory. Those are handled by a separate live-search path.",
            "9. Do not diagnose with false certainty. Explain likely possibilities and appropriate next steps.",
            "10. For gas smell, carbon monoxide alarms/symptoms, smoke, fire, or dangerous electrical conditions, prioritize leaving the area and contacting emergency services/utility as appropriate.",
            "11. Only when verified company evidence affirmatively confirms that this company provides or handles the specific service/capability the customer is asking about, end the answer with this brief invitation: If you'd like, I can show you our real appointment options and help you book the time that works best for you.",
            "12. Do not append that booking/options invitation to negative, uncertain, unverified, clearly unrelated/non-bookable, policy, pricing, or general-information answers. Do not invent availability or appointment times.",
            "13. Do not mention internal databases, classifiers, prompts, or confidence scores.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            ...buildGroundingPayload(input),
            companyEvidencePresent,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error("empty_prospect_answer");
    }

    const parsed = JSON.parse(content);
    const answer = cleanText(parsed?.answer);

    if (!answer) {
      throw new Error("empty_prospect_answer_text");
    }

    const insufficient = Boolean(
      parsed?.insufficientVerifiedCompanyInformation
    );

    return {
      answer: answer.slice(0, 4000),
      confidence: clampConfidence(parsed?.confidence),
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: insufficient
        ? "insufficient_verified_information"
        : Boolean(parsed?.usedCompanyEvidence)
          ? "company_grounded"
          : "stable_general",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] grounded answer failed", {
      error: error?.message ?? error,
    });

    return {
      answer:
        "I don’t have enough verified information available to answer that accurately right now, so I don’t want to guess.",
      confidence: 1,
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: "insufficient_verified_information",
    };
  }
}


type StandardHvacCapabilityDecision = {
  canInferFromTradeScope: boolean;
  requiresCompanySpecificEvidence: boolean;
  confidence: number;
  reason: string;
  answer: string;
};

async function answerStandardHvacCapabilityFromTradeScope(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<ProspectAnswerResult | null> {
  /*
   * Stable trade-scope fallback.
   *
   * This is intentionally narrower than the general company-answer path.
   * It exists for ordinary HVAC capability questions that would otherwise
   * produce a false "I can't verify whether an HVAC company repairs HVAC"
   * answer merely because the owner's database/site omitted an obvious core
   * service.
   *
   * Explicit company evidence still outranks this inference. This fallback
   * must never infer policies, pricing, service area, brands, warranties,
   * financing, promotions, availability, or specialty/adjacent trades.
   */
  if (
    input.category !== "company_service_question" &&
    !input.classification.capabilityQuestion
  ) {
    return null;
  }

  if (input.classification.serviceDomainFit === "clearly_unrelated") {
    return null;
  }

  const openai = getOpenAIClient();
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model:
        process.env.LEADFLOW_PROSPECT_CLASSIFIER_MODEL ||
        process.env.LEADFLOW_INBOUND_CLASSIFIER_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_standard_hvac_capability",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "canInferFromTradeScope",
              "requiresCompanySpecificEvidence",
              "confidence",
              "reason",
              "answer",
            ],
            properties: {
              canInferFromTradeScope: { type: "boolean" },
              requiresCompanySpecificEvidence: { type: "boolean" },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              reason: { type: "string" },
              answer: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You are a conservative semantic trade-scope arbiter for a real HVAC service company.",
            "This fallback runs only after verified internal company information failed to explicitly answer a service-capability question.",
            "Decide whether the customer's requested work is intrinsically CORE, ORDINARY HVAC repair/diagnostic/maintenance work that a general HVAC service company can reasonably be understood to handle absent contrary evidence.",
            "Judge the service by meaning and trade scope, not by keyword lists.",
            "Integral heating/cooling equipment and integral components may qualify when the requested work is ordinary HVAC diagnosis, repair, or maintenance.",
            "Do NOT infer services that are specialty, optional, adjacent, unusually licensed, trade-crossing, or contractor-dependent.",
            "Do NOT infer plumbing, general electrical, roofing, appliances, medical/personal issues, construction, or other non-HVAC work.",
            "Do NOT infer company-specific pricing, fees, policies, hours, service area, brands, warranties, financing, promotions, availability, guarantees, or membership programs.",
            "Set requiresCompanySpecificEvidence=true whenever the customer's capability question depends on a named manufacturer, brand, model, product family, certification, proprietary platform, warranty program, or other company-specific support relationship rather than generic HVAC trade scope.",
            "A named manufacturer/brand/model capability is NEVER established merely because the underlying equipment is HVAC. For such questions, requiresCompanySpecificEvidence=true, canInferFromTradeScope=false, and answer must be empty unless verified company evidence already established the capability before this fallback was called.",
            "Generic brand-agnostic core HVAC equipment/service may set requiresCompanySpecificEvidence=false when ordinary trade scope truly establishes it.",
            "VerifiedCompanyFacts and verifiedCompanyKnowledge are authoritative. If they explicitly contradict or exclude the requested service, canInferFromTradeScope MUST be false.",
            "A mere omission from company records is NOT a contradiction.",
            "If the requested work is core ordinary HVAC work and there is no contrary verified company evidence, set canInferFromTradeScope=true.",
            "If there is meaningful doubt whether a general HVAC company necessarily handles it, set canInferFromTradeScope=false so the existing official-company verification path can decide.",
            "When canInferFromTradeScope=true, answer the customer's capability question directly and briefly as this HVAC company, without pretending the conclusion came from a website or database.",
            "When canInferFromTradeScope=true, end with exactly this invitation: If you'd like, I can show you our real appointment options and help you book the time that works best for you.",
            "When canInferFromTradeScope=false, set answer to an empty string.",
            "Never invent availability or appointment times.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            question: cleanText(input.question).slice(0, 12000),
            conversationContext: cleanText(input.conversationContext).slice(
              0,
              6000
            ),
            serviceDomainFit:
              input.classification.serviceDomainFit ?? "not_applicable",
            verifiedCompanyFacts: input.context.companyFacts,
            verifiedCompanyKnowledge: input.context.companyKnowledge.map(
              (item) => ({
                topic: item.topic,
                content: item.content,
                sourceType: item.sourceType,
              })
            ),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);

    const decision: StandardHvacCapabilityDecision = {
      canInferFromTradeScope: Boolean(parsed?.canInferFromTradeScope),
      requiresCompanySpecificEvidence: Boolean(
        parsed?.requiresCompanySpecificEvidence
      ),
      confidence: clampConfidence(parsed?.confidence),
      reason:
        cleanText(parsed?.reason).slice(0, 500) ||
        "semantic_trade_scope_decision",
      answer: cleanText(parsed?.answer).slice(0, 4000),
    };

    console.log("[prospect-inquiry] stable HVAC trade-scope decision", {
      canInferFromTradeScope: decision.canInferFromTradeScope,
      requiresCompanySpecificEvidence:
        decision.requiresCompanySpecificEvidence,
      confidence: decision.confidence,
      reason: decision.reason,
      questionPreview: cleanText(input.question).slice(0, 240),
    });

    if (
      decision.requiresCompanySpecificEvidence ||
      !decision.canInferFromTradeScope ||
      decision.confidence < 0.9 ||
      !decision.answer
    ) {
      return null;
    }

    return {
      answer: decision.answer,
      confidence: decision.confidence,
      usedFreshWeb: false,
      sourceUrls: [],
      evidenceMode: "stable_general",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] stable HVAC trade-scope arbitration failed", {
      error: error?.message ?? error,
    });

    return null;
  }
}


type CompanySpecificCapabilityEvidenceDecision = {
  requiresCompanySpecificEvidence: boolean;
  evidenceExplicitlySupportsCapability: boolean;
  confidence: number;
  reason: string;
};

async function resolveCompanySpecificCapabilityEvidenceDecision(input: {
  question: string;
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<CompanySpecificCapabilityEvidenceDecision | null> {
  if (!input.classification.capabilityQuestion) return null;

  const openai = getOpenAIClient();
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model:
        process.env.LEADFLOW_PROSPECT_CLASSIFIER_MODEL ||
        process.env.LEADFLOW_PROSPECT_ANSWER_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_company_specific_capability_evidence",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "requiresCompanySpecificEvidence",
              "evidenceExplicitlySupportsCapability",
              "confidence",
              "reason",
            ],
            properties: {
              requiresCompanySpecificEvidence: { type: "boolean" },
              evidenceExplicitlySupportsCapability: { type: "boolean" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You are a company-capability evidence firewall for an HVAC lead-response system.",
            "Do not answer the customer and do not infer capability from generic trade scope.",
            "Decide whether this capability question depends on a company-specific support relationship rather than generic HVAC trade scope.",
            "Set requiresCompanySpecificEvidence=true when the question depends on a named manufacturer, brand, model, product family, proprietary system/platform, certification, warranty program, or similarly company-specific support relationship.",
            "Natural language may be formal, slang, abbreviated, misspelled, or conversational. Classify semantic meaning, not wording style.",
            "If requiresCompanySpecificEvidence=false, evidenceExplicitlySupportsCapability must be false because this firewall is not deciding generic trade scope.",
            "If requiresCompanySpecificEvidence=true, set evidenceExplicitlySupportsCapability=true ONLY when verifiedCompanyFacts or verifiedCompanyKnowledge explicitly establish that THIS company handles/provides/supports the exact requested capability relationship.",
            "A general statement that the company is an HVAC contractor, services HVAC systems, repairs air conditioning, or handles the broader equipment category does NOT explicitly establish support for a named manufacturer/brand/model/product family.",
            "Mere omission, ambiguity, inference, industry custom, model memory, or the fact that the equipment is HVAC is insufficient.",
            "If evidence contradicts the capability, is silent, or only supports a broader category, evidenceExplicitlySupportsCapability=false.",
            "Return only the strict JSON object.",
          ].join("\\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            question: cleanText(input.question).slice(0, 12000),
            conversationContext: cleanText(input.conversationContext).slice(
              0,
              6000
            ),
            verifiedCompanyFacts: input.context.companyFacts,
            verifiedCompanyKnowledge: input.context.companyKnowledge.map(
              (item) => ({
                topic: item.topic,
                content: item.content,
                sourceType: item.sourceType,
              })
            ),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const decision: CompanySpecificCapabilityEvidenceDecision = {
      requiresCompanySpecificEvidence: Boolean(
        parsed?.requiresCompanySpecificEvidence
      ),
      evidenceExplicitlySupportsCapability: Boolean(
        parsed?.evidenceExplicitlySupportsCapability
      ),
      confidence: clampConfidence(parsed?.confidence),
      reason:
        cleanText(parsed?.reason).slice(0, 500) ||
        "company_specific_capability_evidence_decision",
    };

    if (!decision.requiresCompanySpecificEvidence) {
      decision.evidenceExplicitlySupportsCapability = false;
    }

    console.log("[prospect-inquiry] company-specific capability evidence firewall", {
      requiresCompanySpecificEvidence:
        decision.requiresCompanySpecificEvidence,
      evidenceExplicitlySupportsCapability:
        decision.evidenceExplicitlySupportsCapability,
      confidence: decision.confidence,
      reason: decision.reason,
      questionPreview: cleanText(input.question).slice(0, 240),
    });

    return decision;
  } catch (error: any) {
    console.error(
      "[prospect-inquiry] company-specific capability evidence firewall failed",
      { error: error?.message ?? error }
    );
    return null;
  }
}

type SemanticFreshnessDecision = {
  requiresFreshExternalData: boolean;
  confidence: number;
  reason: string;
};

async function resolveSemanticFreshnessRequirement(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  conversationContext?: string | null;
}): Promise<SemanticFreshnessDecision> {
  const openai = getOpenAIClient();

  if (!openai) {
    return {
      requiresFreshExternalData: false,
      confidence: 0,
      reason: "semantic_freshness_unavailable",
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model:
        process.env.LEADFLOW_PROSPECT_CLASSIFIER_MODEL ||
        process.env.LEADFLOW_INBOUND_CLASSIFIER_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_semantic_freshness_requirement",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "requiresFreshExternalData",
              "confidence",
              "reason",
            ],
            properties: {
              requiresFreshExternalData: { type: "boolean" },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You are a semantic freshness arbiter for a customer-information system.",
            "Your only task is to decide whether answering the customer's factual question accurately requires live external information rather than model memory.",
            "Judge the underlying fact, not keywords and not whether the customer explicitly says words such as current, latest, today, or now.",
            "Set requiresFreshExternalData=true whenever the truth can materially change over time and a memory-only answer could therefore be stale at the moment of the request.",
            "This includes any fact whose correct answer depends on mutable real-world state, rankings, positions, leadership/status, prices/values/rates, live results, recent activity, active rules/notices, availability, or other changing external conditions.",
            "Set requiresFreshExternalData=false for genuinely stable facts whose truth is not materially dependent on the present moment.",
            "Use conversationContext when the newest turn is elliptical or refers to a prior subject.",
            "Do not decide whether the message should be booked, routed, refused, or answered. Do not evaluate company policy. Only decide freshness.",
            `Evaluation time: ${new Date().toISOString()}`,
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            question: cleanText(input.question).slice(0, 12000),
            category: input.category,
            conversationContext: cleanText(input.conversationContext).slice(0, 6000),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        requiresFreshExternalData: false,
        confidence: 0,
        reason: "semantic_freshness_empty_response",
      };
    }

    const parsed = JSON.parse(content);

    return {
      requiresFreshExternalData: Boolean(parsed?.requiresFreshExternalData),
      confidence: clampConfidence(parsed?.confidence),
      reason:
        cleanText(parsed?.reason).slice(0, 500) ||
        "semantic_freshness_decision",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] semantic freshness arbitration failed", {
      error: error?.message ?? error,
    });

    return {
      requiresFreshExternalData: false,
      confidence: 0,
      reason: "semantic_freshness_error",
    };
  }
}

async function answerProspectInquiry(input: {
  question: string;
  category: ProspectInquiryResult["category"];
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
}): Promise<ProspectAnswerResult> {
  if (!cleanText(input.question)) {
    throw new Error("missing_prospect_question");
  }

  // Current/changeable external facts already identified upstream must always
  // use fresh web evidence.
  if (input.classification.requiresFreshExternalData) {
    return answerWithFreshWeb(input);
  }

  /*
   * Final semantic freshness firewall.
   *
   * Upstream routing/classification decides WHAT kind of customer turn this is.
   * This guard decides only whether a GENERAL EXTERNAL FACT can safely be
   * answered from model memory. It deliberately does not run for company-
   * specific questions, because those retain the existing internal-facts ->
   * official-company-web grounding hierarchy.
   *
   * This is semantic rather than phrase-driven: the fact itself may be volatile
   * even when the customer omits words such as "current", "latest", or "today".
   */
  if (!input.classification.requiresCompanyFacts) {
    const freshness = await resolveSemanticFreshnessRequirement({
      question: input.question,
      category: input.category,
      conversationContext: input.conversationContext,
    });

    console.log("[prospect-inquiry] semantic freshness decision", {
      category: input.category,
      requiresFreshExternalData: freshness.requiresFreshExternalData,
      confidence: freshness.confidence,
      reason: freshness.reason,
      questionPreview: cleanText(input.question).slice(0, 240),
    });

    if (
      freshness.requiresFreshExternalData &&
      freshness.confidence >= 0.7
    ) {
      return answerWithFreshWeb({
        ...input,
        classification: {
          ...input.classification,
          category: "current_external_question",
          requiresFreshExternalData: true,
        },
      });
    }
  }

  /*
   * COMPANY-SPECIFIC CAPABILITY EVIDENCE FIREWALL
   *
   * Named manufacturer/brand/model/product-family support is not ordinary HVAC
   * trade-scope inference. Resolve that semantic distinction before the general
   * company answer model gets a chance to turn broad HVAC evidence into a
   * company-specific "yes". This makes formal and slang versions of the same
   * capability question share one evidence standard.
   *
   * If verified internal evidence explicitly establishes the named capability,
   * the existing grounded answer path remains authoritative. Otherwise skip the
   * generic internal answer/trade-scope inference and use the existing official
   * company-web verification path. No booking or availability behavior changes.
   */
  const companySpecificCapabilityEvidence =
    await resolveCompanySpecificCapabilityEvidenceDecision({
      question: input.question,
      classification: input.classification,
      context: input.context,
      conversationContext: input.conversationContext,
    });

  if (
    companySpecificCapabilityEvidence?.requiresCompanySpecificEvidence === true &&
    companySpecificCapabilityEvidence.evidenceExplicitlySupportsCapability !== true
  ) {
    return answerCompanyQuestionWithOfficialWeb(input);
  }

  // Internal company truth and stable general knowledge get first right of
  // refusal. This prevents stale public pages from overriding authenticated
  // company settings/knowledge.
  const grounded = await answerWithoutWeb(input);

  if (
    grounded.evidenceMode !== "insufficient_verified_information" ||
    !input.classification.requiresCompanyFacts
  ) {
    return grounded;
  }

  /*
   * If this is a service-capability question, allow a conservative semantic
   * trade-scope fallback before reaching for the public web. This handles
   * stable, core HVAC work without forcing every obvious HVAC component/service
   * to be separately enumerated in company records.
   *
   * Explicit company evidence remains authoritative; specialty/optional work
   * falls through to the existing official-company verification path.
   */
  const stableTradeCapability =
    await answerStandardHvacCapabilityFromTradeScope(input);

  if (stableTradeCapability) {
    return stableTradeCapability;
  }

  // If a company-specific point is still not established, verify the
  // company's own public web presence before giving up. This remains read-only.
  return answerCompanyQuestionWithOfficialWeb(input);
}

/* -------------------------------------------------------------------------- */
/* Prospect yes/no/question resolver — explicitly NO scheduling interpretation.*/
/* -------------------------------------------------------------------------- */

function normalizeTurnText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasQuestionBeforeBookingPriority(text: string) {
  const explicitlyDefersBooking =
    /\b(?:but|though|however)?\s*(?:first|before(?:\s+(?:we|i))?\s+book(?:ing)?|before(?:\s+(?:we|i))?\s+schedule|before\s+that|one\s+question\s+first|question\s+first)\b/.test(
      text
    );

  if (!explicitlyDefersBooking) return false;

  return (
    text.includes("?") ||
    /\b(?:what|when|where|why|how|do|does|can|could|is|are|will|would|which|price|pricing|cost|fee|financing|finance|warranty|service area|hours|brand|recall)\b/.test(
      text
    )
  );
}

function isReadOnlyBookingAvailabilityQuestion(text: string) {
  /*
   * Informational availability request.
   *
   * This is intentionally NOT booking consent. The intelligence lane may read
   * canonical availability and report real openings, but it does not create a
   * Lead, pending-slot state, scheduling context, or Calendar event.
   */
  const clearlyInformationalCompanyTopic =
    /\b(?:price|pricing|cost|fee|financing|finance|warranty|warranties|service area|hours|brand|brands|membership|maintenance plan|promotion|discount|diagnostic|policy|policies)\b/.test(
      text
    );

  if (clearlyInformationalCompanyTopic) return false;

  return (
    /\b(?:what|which|show|give|send|tell)\b.{0,55}\b(?:booking|appointment|appointments|opening|openings|slot|slots|availability|available times|times available)\b/.test(
      text
    ) ||
    /\b(?:booking|appointment|appointments)\b.{0,40}\b(?:option|options|opening|openings|slot|slots|availability|available|time|times|day|days)\b/.test(
      text
    ) ||
    /\b(?:what|which)\s+(?:times|days|openings|slots|appointments)\s+(?:do|can)\s+(?:you|we)\s+(?:have|offer|show)\b/.test(
      text
    ) ||
    /\b(?:what'?s|what is)\s+(?:your\s+)?(?:earliest|soonest|next)\s+(?:appointment|opening|availability)\b/.test(
      text
    ) ||
    /\bdo you have (?:any\s+)?(?:appointments|openings|slots|availability)\b/.test(
      text
    ) ||
    /\b(?:what are (?:your|the) options|tell me (?:some|the) options|show me (?:some|the) options)\b/.test(
      text
    ) ||
    /\b(?:whatchu|watchu|what(?:\s+do)?\s+(?:you|ya|y['’]?all))\s+(?:got|have)\s+(?:(?:anything|something|somethin')\s+)?open\b/.test(
      text
    ) ||
    /\b(?:you|ya|y['’]?all)\s+(?:got|have)\s+(?:(?:any|anything|something|somethin')\s+)?(?:openings?|slots?|appointments?|times?)\b/.test(
      text
    ) ||
    /\b(?:got|have)\s+(?:(?:any|anything|something|somethin')\s+)?(?:openings?|slots?|appointments?)\b/.test(
      text
    )
  );
}

function hasExplicitDoNotBookYet(text: string) {
  return /\b(?:don'?t book|do not book|don'?t schedule|do not schedule|not yet|not ready to book|haven'?t decided|have not decided|just checking|only checking|just looking|only looking|don'?t lock it in|do not lock it in|don'?t reserve|do not reserve)\b/.test(
    text
  );
}


type ReadOnlyWeekdayReference = {
  weekdayIndex: number;
  weekdayName: string;
  modifier:
    | "next"
    | "this"
    | "bare"
    | "after_next"
    | "following_context";
};

type ReadOnlyClockReference = {
  hour: number;
  minute: number;
};

type ReadOnlyLocalDate = {
  year: number;
  month: number;
  day: number;
};

const READ_ONLY_WEEKDAYS: Array<{
  index: number;
  name: string;
  pattern: string;
}> = [
  { index: 0, name: "Sunday", pattern: "sun(?:day)?" },
  { index: 1, name: "Monday", pattern: "mon(?:day)?" },
  { index: 2, name: "Tuesday", pattern: "tue(?:s(?:day)?)?" },
  { index: 3, name: "Wednesday", pattern: "wed(?:nesday)?" },
  { index: 4, name: "Thursday", pattern: "thu(?:r(?:s(?:day)?)?)?" },
  { index: 5, name: "Friday", pattern: "fri(?:day)?" },
  { index: 6, name: "Saturday", pattern: "sat(?:urday)?" },
];

function hasSharedComposableRelativeWeekdayResolution(intent: any) {
  return Boolean(
    intent?.interpretation?.startsWith("[shared-relative-weekday]")
  );
}

function extractReadOnlyWeekdayReference(
  message: string
): ReadOnlyWeekdayReference | null {
  const normalized = normalizeTurnText(message);

  for (const weekday of READ_ONLY_WEEKDAYS) {
    const afterNextPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:the\\s+)?(?:week\\s+)?after\\s+next(?:\\s+(${weekday.pattern}))?\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:in\\s+)?(?:the\\s+)?week\\s+after\\s+next\\b`,
        "i"
      ),
    ];

    if (afterNextPatterns.some((pattern) => pattern.test(normalized))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        modifier: "after_next",
      };
    }

    const followingContextPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?following\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+after\\s+that\\b`,
        "i"
      ),
    ];

    if (followingContextPatterns.some((pattern) => pattern.test(normalized))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        modifier: "following_context",
      };
    }

    const prefixMatch = normalized.match(
      new RegExp(
        `\\b(?:(next|this(?:\\s+coming)?|coming)\\s+)?(${weekday.pattern})\\b`,
        "i"
      )
    );

    if (!prefixMatch) continue;

    const rawModifier = String(prefixMatch[1] ?? "").toLowerCase();

    return {
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      modifier:
        rawModifier === "next"
          ? "next"
          : rawModifier === "this" ||
              rawModifier === "this coming" ||
              rawModifier === "coming"
            ? "this"
            : "bare",
    };
  }

  return null;
}

function extractReadOnlyClockReference(
  message: string
): ReadOnlyClockReference | null {
  const normalized = normalizeTurnText(message);

  const twelveHour = normalized.match(
    /\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5][0-9]))?\s*(a\.?m\.?|p\.?m\.?)\b/i
  );

  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2] ?? 0);
    const meridiem = twelveHour[3].toLowerCase().replace(/\./g, "");

    if (meridiem === "am") {
      if (hour === 12) hour = 0;
    } else if (hour !== 12) {
      hour += 12;
    }

    return { hour, minute };
  }

  const twentyFourHour = normalized.match(
    /\b(?:at\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])\b/
  );

  if (twentyFourHour) {
    return {
      hour: Number(twentyFourHour[1]),
      minute: Number(twentyFourHour[2]),
    };
  }

  return null;
}

function sameLocalCalendarDate(
  a: ReadOnlyLocalDate,
  b: ReadOnlyLocalDate
) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function getLocalCalendarDateForReadOnlyIso(
  iso: string,
  timezone: string
): ReadOnlyLocalDate | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);

  const year = get("year");
  const month = get("month");
  const day = get("day");

  if (![year, month, day].every(Number.isFinite)) return null;

  return { year, month, day };
}

function getLocalWeekdayForReadOnlyIso(
  iso: string,
  timezone: string
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const shortName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date).toLowerCase();

  const map: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  return map[shortName] ?? null;
}

function getLatestReadOnlySpecificAnchor(
  conversation: ProspectConversation | null | undefined,
  timezone: string
): ReadOnlyLocalDate | null {
  if (!conversation) return null;

  const history = normalizeProspectHistory(conversation.history)
    .slice()
    .reverse();

  for (const item of history) {
    const requestedStartTime =
      typeof item?.metadata?.requestedStartTime === "string"
        ? item.metadata.requestedStartTime
        : null;

    if (!requestedStartTime) continue;

    const localDate = getLocalCalendarDateForReadOnlyIso(
      requestedStartTime,
      timezone
    );

    if (localDate) return localDate;
  }

  return null;
}

function resolveReadOnlyWeekdayLocalDate(params: {
  message: string;
  timezone: string;
  referenceIso: string;
  conversation?: ProspectConversation | null;
}): {
  weekday: ReadOnlyWeekdayReference;
  localDate: ReadOnlyLocalDate;
  clock: ReadOnlyClockReference | null;
} | null {
  const weekday = extractReadOnlyWeekdayReference(params.message);
  if (!weekday) return null;

  const now = getNowInTimezone(params.timezone);
  const currentDate: ReadOnlyLocalDate = {
    year: now.year,
    month: now.month,
    day: now.day,
  };
  const currentWeekday = getWeekdayIndexForLocalDate(currentDate);
  const clock = extractReadOnlyClockReference(params.message);

  let localDate: ReadOnlyLocalDate;

  if (weekday.modifier === "following_context") {
    const anchor = getLatestReadOnlySpecificAnchor(
      params.conversation,
      params.timezone
    );

    if (anchor) {
      const anchorWeekday = getWeekdayIndexForLocalDate(anchor);
      let daysAfterAnchor =
        (weekday.weekdayIndex - anchorWeekday + 7) % 7;

      if (daysAfterAnchor === 0) daysAfterAnchor = 7;

      localDate = addDaysToLocalDate({
        ...anchor,
        days: daysAfterAnchor,
      });
    } else {
      let daysToAdd =
        (weekday.weekdayIndex - currentWeekday + 7) % 7;

      if (daysToAdd === 0) daysToAdd = 7;

      localDate = addDaysToLocalDate({
        ...currentDate,
        days: daysToAdd,
      });
    }
  } else if (
    weekday.modifier === "next" ||
    weekday.modifier === "after_next"
  ) {
    /*
     * Monday-based calendar-week semantics:
     *   next Thursday -> Thursday of next local calendar week
     *   Thursday after next / after next Thursday / in two weeks
     *     -> same weekday one calendar week later again.
     */
    const daysUntilNextMonday =
      currentWeekday === 0 ? 1 : 8 - currentWeekday;
    const weekdayOffsetFromMonday =
      weekday.weekdayIndex === 0 ? 6 : weekday.weekdayIndex - 1;
    const extraWeeks =
      weekday.modifier === "after_next" ? 1 : 0;

    localDate = addDaysToLocalDate({
      ...currentDate,
      days:
        daysUntilNextMonday +
        weekdayOffsetFromMonday +
        extraWeeks * 7,
    });
  } else {
    let daysToAdd =
      (weekday.weekdayIndex - currentWeekday + 7) % 7;

    if (daysToAdd === 0 && clock) {
      const currentMinuteOfDay = now.hour * 60 + now.minute;
      const requestedMinuteOfDay = clock.hour * 60 + clock.minute;

      if (requestedMinuteOfDay <= currentMinuteOfDay) {
        daysToAdd = 7;
      }
    }

    localDate = addDaysToLocalDate({
      ...currentDate,
      days: daysToAdd,
    });
  }

  return {
    weekday,
    localDate,
    clock,
  };
}

function resolveReadOnlyWeekdayStart(params: {
  message: string;
  timezone: string;
  referenceIso: string;
  conversation?: ProspectConversation | null;
}) {
  const resolved = resolveReadOnlyWeekdayLocalDate(params);
  if (!resolved || !resolved.clock) return null;

  const startTime = zonedTimeToUtc({
    ...resolved.localDate,
    hour: resolved.clock.hour,
    minute: resolved.clock.minute,
    timezone: params.timezone,
  });

  if (
    getLocalWeekdayForReadOnlyIso(startTime, params.timezone) !==
    resolved.weekday.weekdayIndex
  ) {
    throw new Error("read_only_weekday_resolution_mismatch");
  }

  return {
    startTime,
    localDate: resolved.localDate,
    weekday: resolved.weekday,
  };
}

type VerifiedReadOnlyBookingSelection = {
  requestedStartTime: string;
  requestedEndTime: string | null;
};

function getImmediateVerifiedReadOnlyBookingSelection(
  conversation: ProspectConversation
): VerifiedReadOnlyBookingSelection | null {
  const history = normalizeProspectHistory(conversation.history);

  /*
   * "Book it" may inherit ONLY the immediately preceding customer turn's
   * specific availability selection, and only when that exact slot was
   * canonically verified as available.
   *
   * This deliberately does NOT:
   * - reach back to an older stale slot,
   * - use general offeredStartTimes,
   * - create pendingSlotSuggestion,
   * - create scheduling/year state.
   */
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item: any = history[index];
    if (item?.role !== "customer") continue;

    const metadata =
      item?.metadata && typeof item.metadata === "object"
        ? item.metadata
        : null;

    if (
      metadata?.specificReadOnlyAvailabilityCheck !== true ||
      metadata?.available !== true ||
      typeof metadata?.requestedStartTime !== "string"
    ) {
      return null;
    }

    const start = new Date(metadata.requestedStartTime);
    if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
      return null;
    }

    const requestedEndTime =
      typeof metadata?.requestedEndTime === "string" &&
      !Number.isNaN(new Date(metadata.requestedEndTime).getTime())
        ? metadata.requestedEndTime
        : null;

    return {
      requestedStartTime: start.toISOString(),
      requestedEndTime,
    };
  }

  return null;
}

async function getCompanyTimezoneForProspectHandoff(companyId: string) {
  const result = await supabase
    .from("companies")
    .select("timezone")
    .eq("id", companyId)
    .maybeSingle();

  if (result.error) throw new Error(result.error.message);

  return cleanText(result.data?.timezone) || "America/Chicago";
}

function buildVerifiedSlotBookingHandoffMessage(params: {
  requestedStartTime: string;
  timezone: string;
}) {
  const formatted = formatSpecificReadOnlySlot(
    params.requestedStartTime,
    params.timezone
  );

  /*
   * This is not a new interpretation. The instant came from the immediately
   * preceding canonical read-only availability check and the customer has now
   * explicitly authorized booking it.
   */
  return `Book me for ${formatted}.`;
}

function hasRecentReadOnlyAvailabilityContext(
  conversation: ProspectConversation
) {
  return normalizeProspectHistory(conversation.history)
    .slice(-8)
    .some((item: any) => item?.metadata?.readOnlyAvailability === true);
}

function isReadOnlyAvailabilityCorrectionTurn(params: {
  message: string;
  conversation: ProspectConversation;
}) {
  const text = normalizeTurnText(params.message);

  if (!hasRecentReadOnlyAvailabilityContext(params.conversation)) {
    return false;
  }

  if (hasBookingStartIntent(text)) return false;
  if (!hasConcreteTemporalSurface(text)) return false;

  return (
    /\b(?:i said|i meant|meant|why are you saying|why did you say|actually|no[, ]|not\s+\w+|figure it out|check that|check next|what about)\b/.test(
      text
    ) ||
    extractReadOnlyWeekdayReference(text) !== null
  );
}

function hasConcreteTemporalSurface(text: string) {
  return (
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|today|tomorrow)\b/.test(
      text
    ) ||
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.test(
      text
    ) ||
    /\b(?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm)\b/.test(text)
  );
}

function isSpecificReadOnlyAvailabilityInterest(text: string) {
  if (!hasConcreteTemporalSurface(text)) return false;

  if (hasExplicitDoNotBookYet(text)) return true;

  return (
    /\b(?:is|are|would|could|can)\b.{0,50}\b(?:available|open|free)\b/.test(
      text
    ) ||
    /\b(?:available|open|free)\b.{0,50}\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|am|pm)\b/.test(
      text
    )
  );
}

function hasBookingStartIntent(text: string) {
  /*
   * Detect only actual customer intent to ENTER the canonical booking lane.
   * Asking to SEE availability/options is informational and is handled by the
   * read-only availability branch above.
   *
   * No dates, times, option numbers, years, or availability are interpreted.
   */
  if (hasExplicitDoNotBookYet(text)) return false;

  return /\b(?:book me|book us|book it|book that|schedule me|schedule us|schedule it|schedule that|set (?:it|that|a visit|an appointment) up|get (?:me|us) (?:on the schedule|an appointment|a visit)|put (?:me|us) (?:on the schedule|down for)|send someone|send somebody|send a tech|send a technician|have someone come|have somebody come|get someone out|get somebody out|get a tech out|come out|come over|come by|swing by|pull up|i want (?:to book|an appointment|a visit|service)|i'd like (?:to book|an appointment|a visit|service)|i would like (?:to book|an appointment|a visit|service)|we want (?:to book|an appointment|a visit|service)|we'd like (?:to book|an appointment|a visit|service)|let'?s book|lets book|ready to book|ready to schedule|go ahead (?:and )?(?:book|schedule|send)|start (?:the )?booking|can i book|could i book|can we book|could we book|help me book|need (?:someone|somebody|a tech|a technician) (?:out|here|to come)|need service|need a visit)\b/.test(
    text
  );
}

function obviousProspectDecision(
  message: string,
  conversationContext?: string | null
): ProspectTurnResult | null {
  const text = normalizeTurnText(message);

  if (!text) {
    return {
      decision: "unclear",
      confidence: 1,
      reason: "empty_reply",
      source: "deterministic",
    };
  }

  if (
    /^(?:no|nope|nah|not now|no thanks|no thank you|i'?m good|im good|all good|that'?s all|thats all|just asking|only asking)[.! ]*$/.test(
      text
    )
  ) {
    return {
      decision: "booking_no",
      confidence: 0.99,
      reason: "explicit_booking_decline",
      source: "deterministic",
    };
  }

  /*
   * If the customer explicitly postpones booking to ask something first,
   * answer the question before promotion even if booking language appears in
   * the same sentence.
   */
  if (hasQuestionBeforeBookingPriority(text)) {
    return {
      decision: "question",
      confidence: 0.99,
      reason: "customer_explicitly_deferred_booking_for_question",
      source: "deterministic",
    };
  }

  if (hasExplicitDoNotBookYet(text) && hasConcreteTemporalSurface(text)) {
    return {
      decision: "availability_question",
      confidence: 0.995,
      reason: "customer_discussing_specific_time_without_booking_consent",
      source: "deterministic",
    };
  }

  if (isReadOnlyBookingAvailabilityQuestion(text)) {
    return {
      decision: "availability_question",
      confidence: 0.99,
      reason: "customer_requested_read_only_booking_availability",
      source: "deterministic",
    };
  }

  if (
    /^(?:yes|yeah|yep|yup|sure|absolutely|please do|do it|sounds good|let'?s do it|lets do it|book me|schedule me)[.! ]*$/.test(
      text
    )
  ) {
    return {
      decision: "booking_yes",
      confidence: 0.99,
      reason: "explicit_booking_acceptance",
      source: "deterministic",
    };
  }

  if (hasBookingStartIntent(text)) {
    return {
      decision: "booking_yes",
      confidence: 0.98,
      reason: "customer_requested_booking_or_real_booking_options",
      source: "deterministic",
    };
  }

  /*
   * A generic question-shaped surface is not enough to determine WHAT the
   * customer means once conversation context exists. Let the semantic resolver
   * interpret elliptical follow-ups against the immediately preceding company
   * turn instead of prematurely forcing them into the generic information lane.
   */
  if (
    !cleanText(conversationContext) &&
    (
      text.includes("?") ||
      /^(?:what|when|where|why|how|do|does|can|could|is|are|will|would|which)\b/.test(
        text
      )
    )
  ) {
    return {
      decision: "question",
      confidence: 0.88,
      reason: "question_surface_without_conversation_context",
      source: "deterministic",
    };
  }

  return null;
}

async function resolveProspectTurn(input: {
  message: string;
  conversationContext?: string | null;
}): Promise<ProspectTurnResult> {
  const deterministic = obviousProspectDecision(
    input.message,
    input.conversationContext
  );
  if (deterministic) return deterministic;

  const openai = getOpenAIClient();

  if (!openai) {
    return {
      decision: "unclear",
      confidence: 0.5,
      reason: "semantic_resolver_unavailable",
      source: "deterministic",
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model:
        process.env.LEADFLOW_PROSPECT_CLASSIFIER_MODEL ||
        process.env.LEADFLOW_INBOUND_CLASSIFIER_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_prospect_turn",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["decision", "confidence", "reason"],
            properties: {
              decision: {
                type: "string",
                enum: [
                  "booking_yes",
                  "booking_no",
                  "availability_question",
                  "question",
                  "unclear",
                ],
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You resolve a customer's reply inside LeadFlow's GENERAL INFORMATION lane.",
            "The information lane and booking lane are parallel siblings. The customer may ask questions on any legitimate topic indefinitely, or may choose to enter booking at any point.",
            "The instant the customer clearly asks to book, schedule, send a technician, or otherwise start service, return booking_yes so the canonical booking pipeline takes over immediately.",
            "Return booking_yes only when the customer clearly wants to ENTER booking/service, such as asking to book/schedule/send a technician.",
            "Return availability_question when the customer is asking to SEE real booking options/openings/appointment times/availability without yet choosing or asking you to book one.",
            "Interpret short, elliptical, slang, or context-dependent follow-ups from the immediately preceding Company turn rather than in isolation.",
            "If the immediately preceding Company turn offered to show real appointment options and the customer's newest message indicates they want to see what is available, return availability_question. Do not repeat the prior service/capability answer, and do not treat merely seeing options as booking consent.",
            "A concrete appointment-time reply can count as booking_yes because it implicitly accepts booking; do NOT interpret the date/time itself here.",
            "If the customer says they want to book BUT explicitly says 'first', 'before booking', 'before that', or otherwise clearly postpones booking in order to ask another informational question, return question. Answer that question before promotion.",
            "A question about company pricing, financing, warranty, service area, hours, brands, policies, capabilities, or HVAC information remains question unless the customer is actually asking to start booking.",
            "Return booking_no only for a clear decline.",
            "Return question when the customer is asking another informational question instead of entering booking.",
            "Return unclear when none is reliably true.",
            "Do not resolve any date, year, weekday, option number, clock time, or mutate availability yourself. The worker has a separate read-only availability capability; the existing booking pipeline exclusively owns booking mutations after promotion.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            conversationContext: String(
              input.conversationContext ?? ""
            ).slice(0, 6000),
            newestCustomerMessage: String(input.message).slice(0, 12000),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("empty_prospect_turn_resolution");

    const parsed = JSON.parse(content);
    const allowed: ProspectTurnDecision[] = [
      "booking_yes",
      "booking_no",
      "availability_question",
      "question",
      "unclear",
    ];

    const decision = allowed.includes(parsed?.decision)
      ? (parsed.decision as ProspectTurnDecision)
      : "unclear";

    return {
      decision,
      confidence: clampConfidence(parsed?.confidence),
      reason:
        String(parsed?.reason ?? "").trim().slice(0, 500) ||
        "semantic_turn_resolution",
      source: "semantic_model",
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] turn resolution failed", {
      error: error?.message ?? error,
    });

    return {
      decision: "unclear",
      confidence: 0.4,
      reason: "semantic_turn_resolution_failed",
      source: "deterministic",
    };
  }
}


/* -------------------------------------------------------------------------- */
/* Read-only canonical availability — customer intelligence, NO booking write. */
/* -------------------------------------------------------------------------- */

const READ_ONLY_AVAILABILITY_MIN_LEAD_MINUTES = 120;
const READ_ONLY_AVAILABILITY_HORIZON_DAYS = 7;
const READ_ONLY_AVAILABILITY_GRID_MINUTES = 30;

function safePositiveMinutes(value: unknown, fallback: number) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  if (!Number.isInteger(minutes)) return fallback;
  if (minutes < 1 || minutes > 1440) return fallback;
  return minutes;
}

function roundUpToAvailabilityGrid(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_datetime");

  date.setUTCSeconds(0, 0);
  const minute = date.getUTCMinutes();
  const remainder = minute % READ_ONLY_AVAILABILITY_GRID_MINUTES;

  if (remainder !== 0) {
    date.setUTCMinutes(
      minute + (READ_ONLY_AVAILABILITY_GRID_MINUTES - remainder)
    );
  }

  return date.toISOString();
}

function addMinutesToIso(iso: string, minutes: number) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_datetime");
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function formatReadOnlyAvailabilitySlot(slot: {
  startTime: string;
  timezone?: string | null;
}) {
  const timezone = slot.timezone || "America/Chicago";

  return new Date(slot.startTime).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function getReadOnlyBookingOptions(companyId: string) {
  const nowIso = new Date().toISOString();
  const searchStart = roundUpToAvailabilityGrid(
    addMinutesToIso(nowIso, READ_ONLY_AVAILABILITY_MIN_LEAD_MINUTES)
  );

  const candidates = await suggestAlternativeSlots({
    companyId,
    requestedStartTime: searchStart,
  });

  const horizonMs =
    new Date(nowIso).getTime() +
    READ_ONLY_AVAILABILITY_HORIZON_DAYS * 24 * 60 * 60 * 1000;

  return candidates.filter((slot: any) => {
    const startMs = new Date(slot?.startTime).getTime();
    return Number.isFinite(startMs) && startMs <= horizonMs;
  });
}

type SpecificReadOnlyAvailabilityResult = {
  handled: boolean;
  body: string | null;
  requestedStartTime: string | null;
  requestedEndTime: string | null;
  available: boolean | null;
  alternatives: Array<{ startTime: string; timezone?: string | null }>;
};

function formatSpecificReadOnlySlot(startTime: string, timezone: string) {
  return new Date(startTime).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function getReadOnlyBookingOptionsForLocalDate(params: {
  companyId: string;
  timezone: string;
  localDate: ReadOnlyLocalDate;
}) {
  const dayStart = zonedTimeToUtc({
    ...params.localDate,
    hour: 0,
    minute: 0,
    timezone: params.timezone,
  });

  const candidates = await suggestAlternativeSlots({
    companyId: params.companyId,
    requestedStartTime: dayStart,
  } as any);

  return candidates
    .filter((slot: any) => {
      const slotDate = getLocalCalendarDateForReadOnlyIso(
        slot?.startTime,
        params.timezone
      );

      return Boolean(
        slotDate &&
          sameLocalCalendarDate(slotDate, params.localDate)
      );
    })
    .slice(0, 3);
}

async function inspectSpecificReadOnlyAvailability(params: {
  companyId: string;
  message: string;
  conversation?: ProspectConversation | null;
}): Promise<SpecificReadOnlyAvailabilityResult> {
  const normalizedMessage = normalizeTurnText(params.message);
  const isDirectInterest =
    isSpecificReadOnlyAvailabilityInterest(normalizedMessage);
  const isCorrection =
    Boolean(params.conversation) &&
    isReadOnlyAvailabilityCorrectionTurn({
      message: params.message,
      conversation: params.conversation as ProspectConversation,
    });

  if (!isDirectInterest && !isCorrection) {
    return {
      handled: false,
      body: null,
      requestedStartTime: null,
      requestedEndTime: null,
      available: null,
      alternatives: [],
    };
  }

  const context = await getProspectInquiryContext(params.companyId);
  const timezone =
    cleanText(context.companyFacts?.timezone) || "America/Chicago";
  const durationMinutes = safePositiveMinutes(
    context.companyFacts?.default_appointment_minutes,
    60
  );
  const referenceTime = new Date().toISOString();

  /*
   * Semantic temporal parsing is useful, but explicit weekday language gets a
   * deterministic consistency guard. A customer's literal "Thursday" can
   * never be accepted as Tuesday/Wednesday/etc.
   */
  const explicitWeekday = resolveReadOnlyWeekdayLocalDate({
    message: params.message,
    timezone,
    referenceIso: referenceTime,
    conversation: params.conversation,
  });

  const deterministicWeekdayStart = explicitWeekday?.clock
    ? resolveReadOnlyWeekdayStart({
        message: params.message,
        timezone,
        referenceIso: referenceTime,
        conversation: params.conversation,
      })
    : null;

  let schedulingIntent: any = null;

  try {
    schedulingIntent = await resolveSchedulingIntent({
      message: params.message,
      timezone,
      referenceTime,
    });
  } catch (error: any) {
    console.error("[prospect-inquiry] read-only temporal resolution failed", {
      companyId: params.companyId,
      error: error?.message ?? error,
    });
  }

  let requestedStartTime = schedulingIntent?.targetTime
    ? new Date(schedulingIntent.targetTime).toISOString()
    : null;

  /*
   * Explicit weekday + clock wins whenever the semantic resolver is absent OR
   * resolves a different local weekday. This is generic across every weekday.
   */
  if (
    deterministicWeekdayStart &&
    !hasSharedComposableRelativeWeekdayResolution(schedulingIntent)
  ) {
    const semanticWeekday = requestedStartTime
      ? getLocalWeekdayForReadOnlyIso(requestedStartTime, timezone)
      : null;
    const semanticLocalDate = requestedStartTime
      ? getLocalCalendarDateForReadOnlyIso(requestedStartTime, timezone)
      : null;

    const explicitRelativeDateMustMatch =
      deterministicWeekdayStart.weekday.modifier === "next" ||
      deterministicWeekdayStart.weekday.modifier === "after_next" ||
      deterministicWeekdayStart.weekday.modifier === "following_context";

    if (
      !requestedStartTime ||
      semanticWeekday !== deterministicWeekdayStart.weekday.weekdayIndex ||
      (
        explicitRelativeDateMustMatch &&
        (
          !semanticLocalDate ||
          !sameLocalCalendarDate(
            semanticLocalDate,
            deterministicWeekdayStart.localDate
          )
        )
      )
    ) {
      requestedStartTime = deterministicWeekdayStart.startTime;
    }
  }

  if (
    requestedStartTime &&
    (
      schedulingIntent?.customerSpecifiedTime === true ||
      deterministicWeekdayStart
    )
  ) {
    const requestedEndTime = addMinutesToIso(
      requestedStartTime,
      durationMinutes
    );

    const availability = await checkAvailability({
      companyId: params.companyId,
      startTime: requestedStartTime,
      endTime: requestedEndTime,
    } as any);

    const formattedRequested = formatSpecificReadOnlySlot(
      requestedStartTime,
      timezone
    );

    if (availability.available) {
      return {
        handled: true,
        body: [
          `${formattedRequested} is currently available.`,
          "",
          "I won’t book or hold it unless you explicitly tell me to book it.",
        ].join("\n"),
        requestedStartTime,
        requestedEndTime,
        available: true,
        alternatives: [],
      };
    }

    const alternatives = (
      await suggestAlternativeSlots({
        companyId: params.companyId,
        requestedStartTime,
        requestedEndTime: null,
        durationMinutes,
        timezone,
      } as any)
    ).slice(0, 3);

    const alternativeLines = alternatives.map(
      (slot: any) => `• ${formatReadOnlyAvailabilitySlot(slot)}`
    );

    return {
      handled: true,
      body: [
        `${formattedRequested} is not currently available.`,
        ...(alternativeLines.length
          ? ["", "The next real openings I can see are:", ...alternativeLines]
          : []),
        "",
        "I haven’t booked or held anything.",
      ].join("\n"),
      requestedStartTime,
      requestedEndTime,
      available: false,
      alternatives,
    };
  }

  /*
   * Date/weekday correction without a clock:
   * "I said next Thursday" / "what about Friday?"
   * Return actual openings ON that local day immediately. No "hold on" promise.
   */
  const targetLocalDate =
    explicitWeekday?.localDate ??
    (
      schedulingIntent?.customerSpecifiedDate === true &&
      schedulingIntent?.localDateTime
        ? {
            year: schedulingIntent.localDateTime.year,
            month: schedulingIntent.localDateTime.month,
            day: schedulingIntent.localDateTime.day,
          }
        : null
    );

  if (targetLocalDate) {
    const slots = await getReadOnlyBookingOptionsForLocalDate({
      companyId: params.companyId,
      timezone,
      localDate: targetLocalDate,
    });

    const localDayIso = zonedTimeToUtc({
      ...targetLocalDate,
      hour: 12,
      minute: 0,
      timezone,
    });

    const formattedDay = new Date(localDayIso).toLocaleDateString("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    if (!slots.length) {
      return {
        handled: true,
        body: [
          `I don’t see a verified opening on ${formattedDay} right now.`,
          "",
          "I haven’t booked or held anything.",
        ].join("\n"),
        requestedStartTime: null,
        requestedEndTime: null,
        available: false,
        alternatives: [],
      };
    }

    const lines = slots.map(
      (slot: any) => `• ${formatReadOnlyAvailabilitySlot(slot)}`
    );

    return {
      handled: true,
      body: [
        `For ${formattedDay}, these are the real openings I can see right now:`,
        "",
        ...lines,
        "",
        "I haven’t booked or held anything.",
      ].join("\n"),
      requestedStartTime: null,
      requestedEndTime: null,
      available: true,
      alternatives: slots,
    };
  }

  return {
    handled: false,
    body: null,
    requestedStartTime: null,
    requestedEndTime: null,
    available: null,
    alternatives: [],
  };
}

function buildReadOnlyAvailabilityAnswer(
  slots: Array<{ startTime: string; timezone?: string | null }>
) {
  if (!slots.length) {
    return [
      "I don’t see a verified opening in the next 7 days right now.",
      "",
      "If you want to book, tell me the day and time you prefer and I can move you into the booking flow.",
    ].join("\n");
  }

  const lines = slots
    .slice(0, 3)
    .map((slot) => `• ${formatReadOnlyAvailabilitySlot(slot)}`);

  return [
    "Here are the next real openings I can see right now:",
    "",
    ...lines,
    "",
    "If you want one, reply with the day and time you want and I can move you into booking.",
  ].join("\n");
}


async function respondToSpecificReadOnlyAvailabilityInterest(params: {
  conversation: ProspectConversation;
  eventId: string;
  companyId: string;
  customerEmail: string;
  subject?: string | null;
  providerThreadId: string;
  customerMessage: string;
  result: SpecificReadOnlyAvailabilityResult;
}) {
  if (!params.result.handled || !params.result.body) {
    throw new Error("specific_read_only_availability_not_resolved");
  }

  const sent = await sendProspectGmailReply({
    companyId: params.companyId,
    to: params.customerEmail,
    subject: params.subject ?? params.conversation.subject,
    body: params.result.body,
    providerThreadId: params.providerThreadId,
  });

  const conversation = await updateProspectConversation({
    conversation: params.conversation,
    status: "open",
    bookingOptIn: null,
    customerMessage: params.customerMessage,
    assistantMessage: params.result.body,
    lastAnswer: params.result.body,
    historyMetadata: {
      turnDecision: "availability_question",
      readOnlyAvailability: true,
      specificReadOnlyAvailabilityCheck: true,
      requestedStartTime: params.result.requestedStartTime,
      requestedEndTime: params.result.requestedEndTime,
      available: params.result.available,
      alternativeStartTimes: params.result.alternatives.map(
        (slot: any) => slot.startTime
      ),
      providerEmailId: sent.providerEmailId,
    },
  });

  await markProspectEventCompleted({
    eventId: params.eventId,
    companyId: params.companyId,
    metadata: {
      action: "specific_read_only_availability_answered",
      requestedStartTime: params.result.requestedStartTime,
      requestedEndTime: params.result.requestedEndTime,
      available: params.result.available,
      alternativeStartTimes: params.result.alternatives.map(
        (slot: any) => slot.startTime
      ),
      providerEmailId: sent.providerEmailId,
    },
  });

  return {
    success: true,
    action: "specific_read_only_availability_answered",
    conversationId: conversation.id,
    emailSent: true,
    available: params.result.available,
  };
}

async function respondToReadOnlyAvailabilityQuestion(params: {
  conversation: ProspectConversation;
  eventId: string;
  companyId: string;
  customerEmail: string;
  subject?: string | null;
  providerThreadId: string;
  customerMessage: string;
  turn: ProspectTurnResult;
}) {
  const slots = await getReadOnlyBookingOptions(params.companyId);
  const body = buildReadOnlyAvailabilityAnswer(slots);

  const sent = await sendProspectGmailReply({
    companyId: params.companyId,
    to: params.customerEmail,
    subject: params.subject ?? params.conversation.subject,
    body,
    providerThreadId: params.providerThreadId,
  });

  const conversation = await updateProspectConversation({
    conversation: params.conversation,
    status: "open",
    bookingOptIn: null,
    customerMessage: params.customerMessage,
    assistantMessage: body,
    lastAnswer: body,
    historyMetadata: {
      turnDecision: params.turn.decision,
      readOnlyAvailability: true,
      offeredStartTimes: slots
        .slice(0, 3)
        .map((slot: any) => slot.startTime),
      providerEmailId: sent.providerEmailId,
    },
  });

  await markProspectEventCompleted({
    eventId: params.eventId,
    companyId: params.companyId,
    metadata: {
      action: "read_only_availability_answered",
      turn: params.turn,
      offeredStartTimes: slots
        .slice(0, 3)
        .map((slot: any) => slot.startTime),
      providerEmailId: sent.providerEmailId,
    },
  });

  return {
    success: true,
    action: "read_only_availability_answered",
    conversationId: conversation.id,
    emailSent: true,
    optionCount: Math.min(slots.length, 3),
  };
}

/* -------------------------------------------------------------------------- */
/* Direct Gmail reply — exact pre-booking thread behavior.                     */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* One-way prospect -> canonical Lead promotion. NO scheduling semantics here. */
/* -------------------------------------------------------------------------- */

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

async function promoteProspectToBooking(params: {
  conversation: ProspectConversation;
  providerEventId: string;
  newestCustomerMessage: string;
  toEmail: string;
  subject?: string | null;
  sendBookingPrompt?: boolean;
}) {
  const conversation = params.conversation;
  // The message author owns this conversation. An address extracted from a
  // quoted reply or signature is contact text, not an alternative actor.
  const customerEmail = normalizeProspectEmail(conversation.customer_email);
  if (!customerEmail || customerEmail !== normalizeProspectEmail(params.toEmail)) {
    throw new Error("prospect_promotion_customer_identity_mismatch");
  }

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

    const leadMetadata = {
      ...mergeLeadMetadata({
        qualification,
        metadata: extractedMetadata,
        fallbackEmail: customerEmail,
      }),
      email: customerEmail,
    };

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
        first_response_at: now,
        qualification: {
          ...qualification,
          customerName: leadMetadata.customerName,
          email: customerEmail,
          customerEmail,
          phone: leadMetadata.phone,
          address: leadMetadata.address,
          city: leadMetadata.city,
          state: leadMetadata.state,
          zip: leadMetadata.zip,
          serviceArea: leadMetadata.serviceArea,

          // FIREWALL: deliberately do not create booking scheduling state here.
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

  const shouldSendBookingPrompt =
    params.sendBookingPrompt !== false;

  if (!alreadyPrompted && shouldSendBookingPrompt) {
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

  await updateProspectConversation({
    conversation,
    status: "promoted_to_booking",
    bookingOptIn: true,
    promotedLeadId: lead.id,
    customerMessage: params.newestCustomerMessage,
    assistantMessage: bookingPromptSent
      ? "Absolutely — what day and time works best for you?"
      : null,
    historyMetadata: {
      transition: "promoted_to_existing_booking_pipeline",
      leadId: lead.id,
    },
  });

  return {
    leadId: lead.id as string,
    alreadyPromoted: Boolean(existingLead),
    bookingPromptSent,
  };
}

async function enqueuePromotedBookingMessage(params: {
  companyId: string;
  provider: string;
  providerEventId: string;
  providerThreadId: string;
  providerEmailId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  message: string;
  preResolvedBookingCommand?: BookingCommandResult | null;
  recentAssistantMessage?: string | null;
  prospectConversationContext?: string | null;
  prospectConversationId?: string | null;
}) {
  const jobId =
    `prospect_booking_handoff:${params.companyId}:${params.providerEventId}`;

  const job = await enqueueBackgroundJob({
    name: "process_inbound_email",
    jobId,
    data: {
      companyId: params.companyId,
      provider: params.provider || "gmail_pubsub",
      providerEventId: params.providerEventId,
      providerThreadId: params.providerThreadId,
      providerEmailId:
        params.providerEmailId ?? params.providerEventId,
      fromEmail: params.fromEmail,
      toEmail: params.toEmail ?? null,
      subject: params.subject ?? null,
      textBody: params.message,
      htmlBody: null,
      preResolvedBookingCommand: params.preResolvedBookingCommand ?? null,
      recentAssistantMessage: params.recentAssistantMessage ?? null,
      prospectConversationContext: params.prospectConversationContext ?? null,
      prospectConversationId: params.prospectConversationId ?? null,
    },
    priority: 10,
  });

  return {
    jobId: job.id ?? jobId,
  };
}


async function handoffAvailabilityQuestionToBookingPipeline(params: {
  conversation: ProspectConversation;
  eventId: string;
  data: ProcessProspectInquiryJobData;
  message: string;
  turn: ProspectTurnResult;
}) {
  const promotion = await promoteProspectToBooking({
    conversation: params.conversation,
    providerEventId: params.data.providerEventId,
    newestCustomerMessage: params.message,
    toEmail: params.data.fromEmail,
    subject: params.data.subject ?? params.conversation.subject,
    sendBookingPrompt: false,
  });

  const preResolvedBookingCommand: BookingCommandResult = {
    kind: "show_availability",
    confidence: params.turn.confidence,
    requiresClarification: false,
    reason: params.turn.reason,
    source: params.turn.source,
    selectedOptionNumber: null,
    hasFreshTemporalConstraint: false,
  };

  const handoff = await enqueuePromotedBookingMessage({
    companyId: params.data.companyId,
    provider: params.data.provider || "gmail_pubsub",
    providerEventId: params.data.providerEventId,
    providerThreadId: params.data.providerThreadId,
    providerEmailId: params.data.providerEmailId,
    fromEmail: params.data.fromEmail,
    toEmail: params.data.toEmail,
    subject: params.data.subject ?? params.conversation.subject,
    message: params.message,
    preResolvedBookingCommand,
    recentAssistantMessage: params.conversation.last_answer,
    prospectConversationContext: formatProspectConversationContext(
      params.conversation
    ),
    prospectConversationId: params.conversation.id,
  });

  await markProspectEventCompleted({
    eventId: params.eventId,
    companyId: params.data.companyId,
    metadata: {
      action: "promoted_to_booking_for_availability",
      turn: params.turn,
      leadId: promotion.leadId,
      bookingHandoffJobId: handoff.jobId,
      bookingMutationAuthorized: false,
    },
  });

  return {
    success: true,
    action: "promoted_to_booking_for_availability",
    conversationId: params.conversation.id,
    leadId: promotion.leadId,
    bookingHandoffJobId: handoff.jobId,
    booked: false,
  };
}


export async function answerBookedCustomerInformationRequest(params: {
  companyId: string;
  fromEmail: string;
  subject?: string | null;
  providerThreadId: string;
  message: string;
  appointmentTime?: string | null;
  originalRequest?: string | null;
}) {
  if (!params.companyId) throw new Error("missing_company_id");
  if (!params.fromEmail) throw new Error("missing_customer_email");
  if (!params.providerThreadId) throw new Error("missing_provider_thread_id");

  const message = cleanText(params.message);
  if (!message) throw new Error("missing_information_request");

  /*
   * BOOKED-CUSTOMER READ-ONLY ENTRY POINT
   *
   * This intentionally reuses the same Customer Intelligence grounding engine
   * without creating/updating a prospect conversation, promoting a Lead,
   * writing pending-slot state, or touching Calendar/booking state.
   *
   * The booking pipeline has already decided that this turn is informational.
   * CI owns only the answer.
   */
  const conversationContext = [
    "The customer already has an active booked HVAC appointment.",
    params.appointmentTime
      ? `Current booked appointment time: ${params.appointmentTime}.`
      : null,
    params.originalRequest
      ? `Original service request: ${cleanText(params.originalRequest).slice(0, 2000)}`
      : null,
    "The current customer turn is informational.",
    "Do not offer to book another appointment.",
    "Do not cancel, reschedule, or otherwise modify the existing appointment.",
  ]
    .filter(Boolean)
    .join("\n");

  const rawClassification = await classifyProspectInquiry({
    subject: params.subject ?? null,
    body: message,
    fromEmail: params.fromEmail,
    hasExistingProspectConversation: true,
    conversationContext,
  });

  /*
   * The shared customer-action resolver has already established that this turn
   * is an information request. Preserve the CI classifier's category/evidence
   * requirements, but do not allow its pre-booking direct-service routing flag
   * to steal this already-owned informational turn.
   */
  const classification: ProspectInquiryResult = {
    ...rawClassification,
    isProspectInquiry: true,
    directServiceRequest: false,
    category:
      rawClassification.category === "not_prospect"
        ? "other_prospect_question"
        : rawClassification.category,
    reason:
      rawClassification.reason ||
      "booked_customer_information_request",
  };

  const inquiryContext = await getProspectInquiryContext(params.companyId);

  const answer = await answerProspectInquiry({
    question: message,
    category: classification.category,
    classification,
    context: inquiryContext,
    conversationContext,
  });

  const sent = await sendProspectGmailReply({
    companyId: params.companyId,
    to: params.fromEmail,
    subject: params.subject ?? "Re: Your HVAC Request",
    body: answer.answer,
    providerThreadId: params.providerThreadId,
  });

  console.log("[customer-intelligence] answered booked customer information request", {
    companyId: params.companyId,
    providerThreadId: params.providerThreadId,
    category: classification.category,
    evidenceMode: answer.evidenceMode,
    usedFreshWeb: answer.usedFreshWeb,
    providerEmailId: sent.providerEmailId,
  });

  return {
    success: true,
    answered: true,
    body: answer.answer,
    category: classification.category,
    evidenceMode: answer.evidenceMode,
    usedFreshWeb: answer.usedFreshWeb,
    sourceUrls: answer.sourceUrls,
    providerEmailId: sent.providerEmailId,
    providerThreadId: sent.providerThreadId,
  };
}

/* -------------------------------------------------------------------------- */
/* Worker orchestration.                                                       */
/* -------------------------------------------------------------------------- */

export async function processProspectInquiryJob(
  data: ProcessProspectInquiryJobData
) {
  if (!data.companyId) throw new Error("missing_company_id");
  if (!data.providerEventId) throw new Error("missing_provider_event_id");
  if (!data.providerThreadId) throw new Error("missing_provider_thread_id");
  if (!data.fromEmail) throw new Error("missing_from_email");

  const message = cleanText(data.textBody);

  if (!message) throw new Error("missing_prospect_message");

  let conversation = await findProspectConversationByThread({
    companyId: data.companyId,
    provider: data.provider || "gmail_pubsub",
    providerThreadId: data.providerThreadId,
    customerEmail: data.fromEmail,
  });

  const existedBeforeThisJob = Boolean(conversation);

  if (!conversation) {
    conversation = await getOrCreateProspectConversation({
      companyId: data.companyId,
      provider: data.provider || "gmail_pubsub",
      providerThreadId: data.providerThreadId,
      customerEmail: data.fromEmail,
      subject: data.subject ?? null,
      originalMessage: message,
    });
  }

  const reservation = await reserveProspectInboundEvent({
    conversationId: conversation.id,
    companyId: data.companyId,
    providerEventId: data.providerEventId,
    body: message,
    metadata: {
      provider: data.provider,
      providerThreadId: data.providerThreadId,
      providerEmailId: data.providerEmailId ?? null,
    },
  });

  if (reservation.duplicateCompleted || reservation.duplicateInFlight) {
    return {
      success: true,
      skipped: true,
      reason: reservation.duplicateCompleted
        ? "prospect_event_already_completed"
        : "prospect_event_already_processing",
      conversationId: conversation.id,
    };
  }

  try {
    if (
      conversation.status === "promoted_to_booking" ||
      conversation.promoted_lead_id
    ) {
      await markProspectEventCompleted({
        eventId: reservation.eventId,
        companyId: data.companyId,
        metadata: {
          skipped: true,
          reason: "prospect_already_promoted_to_booking",
          promotedLeadId: conversation.promoted_lead_id,
        },
      });

      return {
        success: true,
        skipped: true,
        reason: "prospect_already_promoted_to_booking",
        conversationId: conversation.id,
        promotedLeadId: conversation.promoted_lead_id,
      };
    }

    const conversationContext =
      formatProspectConversationContext(conversation);

    /*
     * A customer may discuss a concrete time while explicitly withholding
     * booking consent (for example, "Thursday at 2 looks good, but don't book
     * it yet"). Resolve ONLY the newest message's time read-only, query the
     * canonical availability source, and keep the prospect conversation open.
     * No Lead, pending-slot state, scheduling-year context, or Calendar event is
     * created here.
     */
    const specificReadOnlyAvailability =
      await inspectSpecificReadOnlyAvailability({
        companyId: data.companyId,
        message,
      });

    if (specificReadOnlyAvailability.handled) {
      return respondToSpecificReadOnlyAvailabilityInterest({
        conversation,
        eventId: reservation.eventId,
        companyId: data.companyId,
        customerEmail: data.fromEmail,
        subject: data.subject,
        providerThreadId: data.providerThreadId,
        customerMessage: existedBeforeThisJob ? message : "",
        result: specificReadOnlyAvailability,
      });
    }

    /*
     * Asking to SEE appointment options is the boundary between the pure
     * information lane and the canonical booking pipeline. Promotion creates
     * booking ownership only; it does NOT authorize an appointment mutation.
     * The exact customer message is handed to process_inbound_email, whose
     * read-only availability path shows real slots and persists those offered
     * options for a later explicit selection.
     */
    if (isReadOnlyBookingAvailabilityQuestion(normalizeTurnText(message))) {
      return handoffAvailabilityQuestionToBookingPipeline({
        conversation,
        eventId: reservation.eventId,
        data,
        message,
        turn: {
          decision: "availability_question",
          confidence: 0.99,
          reason: "customer_requested_read_only_booking_availability",
          source: "deterministic",
        },
      });
    }

    /*
     * First inbound message is already prospect-vetted by the router.
     * Every later reply is interpreted relative to the isolated prospect
     * conversation: yes/no/follow-up question.
     */
    if (
      existedBeforeThisJob &&
      isReadOnlyAvailabilityCorrectionTurn({
        message,
        conversation,
      })
    ) {
      const specificAvailability =
        await inspectSpecificReadOnlyAvailability({
          companyId: data.companyId,
          message,
          conversation,
        });

      if (specificAvailability.handled && specificAvailability.body) {
        return respondToSpecificReadOnlyAvailabilityInterest({
          conversation,
          eventId: reservation.eventId,
          companyId: data.companyId,
          customerEmail: data.fromEmail,
          subject: data.subject,
          providerThreadId: data.providerThreadId,
          customerMessage: message,
          result: specificAvailability,
        });
      }
    }

    if (existedBeforeThisJob) {
      const turn = await resolveProspectTurn({
        message,
        conversationContext,
      });

      if (turn.decision === "availability_question") {
        return handoffAvailabilityQuestionToBookingPipeline({
          conversation,
          eventId: reservation.eventId,
          data,
          message,
          turn,
        });
      }

      if (turn.decision === "booking_yes") {
        const newestMessageHasSchedulingSurface =
          hasConcreteTemporalSurface(normalizeTurnText(message));

        const inheritedVerifiedSelection =
          newestMessageHasSchedulingSurface
            ? null
            : getImmediateVerifiedReadOnlyBookingSelection(conversation);

        const directSchedulingHandoff =
          newestMessageHasSchedulingSurface ||
          Boolean(inheritedVerifiedSelection);

        let bookingHandoffMessage = message;
        let inheritedVerifiedStartTime: string | null = null;

        if (
          !newestMessageHasSchedulingSurface &&
          inheritedVerifiedSelection
        ) {
          const timezone =
            await getCompanyTimezoneForProspectHandoff(data.companyId);

          bookingHandoffMessage =
            buildVerifiedSlotBookingHandoffMessage({
              requestedStartTime:
                inheritedVerifiedSelection.requestedStartTime,
              timezone,
            });

          inheritedVerifiedStartTime =
            inheritedVerifiedSelection.requestedStartTime;
        }

        const promotion = await promoteProspectToBooking({
          conversation,
          providerEventId: data.providerEventId,
          newestCustomerMessage: message,
          toEmail: data.fromEmail,
          subject: data.subject ?? conversation.subject,
          sendBookingPrompt: !directSchedulingHandoff,
        });

        let bookingHandoffJobId: string | null = null;

        if (directSchedulingHandoff) {
          const preResolvedBookingCommand: BookingCommandResult = {
            kind: "book",
            confidence: turn.confidence,
            requiresClarification: false,
            reason: turn.reason,
            source: turn.source,
            selectedOptionNumber: null,
            hasFreshTemporalConstraint: newestMessageHasSchedulingSurface,
          };

          const handoff = await enqueuePromotedBookingMessage({
            companyId: data.companyId,
            provider: data.provider || "gmail_pubsub",
            providerEventId: data.providerEventId,
            providerThreadId: data.providerThreadId,
            providerEmailId: data.providerEmailId,
            fromEmail: data.fromEmail,
            toEmail: data.toEmail,
            subject: data.subject ?? conversation.subject,
            message: bookingHandoffMessage,
            preResolvedBookingCommand,
            recentAssistantMessage: conversation.last_answer,
            prospectConversationContext: conversationContext,
            prospectConversationId: conversation.id,
          });

          bookingHandoffJobId = handoff.jobId;
        }

        await markProspectEventCompleted({
          eventId: reservation.eventId,
          companyId: data.companyId,
          metadata: {
            action: directSchedulingHandoff
              ? "promoted_to_booking_with_direct_scheduling_handoff"
              : "promoted_to_booking",
            turn,
            leadId: promotion.leadId,
            bookingHandoffJobId,
            inheritedVerifiedReadOnlySlot:
              Boolean(inheritedVerifiedSelection),
            inheritedVerifiedStartTime,
          },
        });

        return {
          success: true,
          action: directSchedulingHandoff
            ? "promoted_to_booking_with_direct_scheduling_handoff"
            : "promoted_to_booking",
          conversationId: conversation.id,
          bookingHandoffJobId,
          inheritedVerifiedReadOnlySlot:
            Boolean(inheritedVerifiedSelection),
          inheritedVerifiedStartTime,
          ...promotion,
        };
      }

      if (turn.decision === "booking_no") {
        const body =
          "No problem. If you need anything else, just reply here and we’ll be happy to help.";

        const sent = await sendProspectGmailReply({
          companyId: data.companyId,
          to: data.fromEmail,
          subject: data.subject ?? conversation.subject,
          body,
          providerThreadId: data.providerThreadId,
        });

        conversation = await updateProspectConversation({
          conversation,
          status: "declined_booking",
          bookingOptIn: false,
          customerMessage: message,
          assistantMessage: body,
          lastAnswer: body,
          historyMetadata: {
            turnDecision: turn.decision,
            providerEmailId: sent.providerEmailId,
          },
        });

        await markProspectEventCompleted({
          eventId: reservation.eventId,
          companyId: data.companyId,
          metadata: {
            action: "booking_declined",
            turn,
            providerEmailId: sent.providerEmailId,
          },
        });

        return {
          success: true,
          action: "booking_declined",
          conversationId: conversation.id,
          emailSent: true,
        };
      }

      if (turn.decision === "unclear") {
        const body =
          "I can keep helping with your questions. If you’d like service, I can also help you book an appointment — just let me know.";

        const sent = await sendProspectGmailReply({
          companyId: data.companyId,
          to: data.fromEmail,
          subject: data.subject ?? conversation.subject,
          body,
          providerThreadId: data.providerThreadId,
        });

        conversation = await updateProspectConversation({
          conversation,
          status: "awaiting_booking_decision",
          customerMessage: message,
          assistantMessage: body,
          lastAnswer: body,
          historyMetadata: {
            turnDecision: turn.decision,
            providerEmailId: sent.providerEmailId,
          },
        });

        await markProspectEventCompleted({
          eventId: reservation.eventId,
          companyId: data.companyId,
          metadata: {
            action: "booking_decision_clarified",
            turn,
            providerEmailId: sent.providerEmailId,
          },
        });

        return {
          success: true,
          action: "booking_decision_clarified",
          conversationId: conversation.id,
          emailSent: true,
        };
      }
    }

    /*
     * First inquiry OR a follow-up informational question.
     * Re-classify with conversation context so short follow-ups such as
     * "how much?" inherit the known prospect context without touching booking
     * scheduling state.
     */
    const classification =
      (!existedBeforeThisJob
        ? classificationFromJob(data)
        : null) ??
      (await classifyProspectInquiry({
        subject: data.subject,
        body: message,
        fromEmail: data.fromEmail,
        hasExistingProspectConversation: existedBeforeThisJob,
        conversationContext,
      }));

    if (
      !classification.isProspectInquiry ||
      classification.directServiceRequest
    ) {
      // Fail closed. Never manufacture an answer when routing is unsafe.
      await markProspectEventCompleted({
        eventId: reservation.eventId,
        companyId: data.companyId,
        metadata: {
          skipped: true,
          reason: "prospect_classification_not_safe_to_answer",
          classification,
        },
      });

      return {
        success: true,
        skipped: true,
        reason: "prospect_classification_not_safe_to_answer",
        conversationId: conversation.id,
      };
    }

    const inquiryContext = await getProspectInquiryContext(data.companyId);

    const answer = await answerProspectInquiry({
      question: message,
      category: classification.category,
      classification,
      context: inquiryContext,
      conversationContext,
    });

    const body = answer.answer;

    const sent = await sendProspectGmailReply({
      companyId: data.companyId,
      to: data.fromEmail,
      subject: data.subject ?? conversation.subject,
      body,
      providerThreadId: data.providerThreadId,
    });

    conversation = await updateProspectConversation({
      conversation,
      status: "open",
      bookingOptIn: null,
      customerMessage: existedBeforeThisJob ? message : null,
      assistantMessage: body,
      lastAnswer: answer.answer,
      historyMetadata: {
        classification,
        evidenceMode: answer.evidenceMode,
        usedFreshWeb: answer.usedFreshWeb,
        sourceUrls: answer.sourceUrls,
        providerEmailId: sent.providerEmailId,
      },
    });

    await markProspectEventCompleted({
      eventId: reservation.eventId,
      companyId: data.companyId,
      metadata: {
        action: "prospect_question_answered",
        classification,
        evidenceMode: answer.evidenceMode,
        usedFreshWeb: answer.usedFreshWeb,
        sourceUrls: answer.sourceUrls,
        providerEmailId: sent.providerEmailId,
      },
    });

    return {
      success: true,
      action: "prospect_question_answered",
      conversationId: conversation.id,
      category: classification.category,
      evidenceMode: answer.evidenceMode,
      usedFreshWeb: answer.usedFreshWeb,
      emailSent: true,
    };
  } catch (error: any) {
    await markProspectEventFailed({
      eventId: reservation.eventId,
      companyId: data.companyId,
      error: error?.message ?? "prospect_inquiry_processing_failed",
    });

    throw error;
  }
}