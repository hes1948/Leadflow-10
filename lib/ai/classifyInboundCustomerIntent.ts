// lib/ai/classifyInboundCustomerIntent.ts

import OpenAI from "openai";

export type InboundCustomerIntentDecision =
  | "customer_service_request"
  | "customer_conversation_reply"
  | "non_customer";

export type InboundCustomerIntentResult = {
  decision: InboundCustomerIntentDecision;
  confidence: number;
  customerDirection: "seeking_service" | "continuing_service_conversation" | "not_seeking_service";
  isAutomatedOrBulk: boolean;
  isVendorOrSolicitation: boolean;
  isAccountOrSystemNotice: boolean;
  reason: string;
  source: "semantic_model" | "deterministic_fallback";
};

type ClassifyInboundCustomerIntentInput = {
  subject?: string | null;
  body: string;
  fromEmail?: string | null;
  hasExistingCustomerConversation?: boolean;
  fallbackLooksLikeCustomerRequest?: boolean;
  fallbackLooksLikeNoise?: boolean;
};

let client: OpenAI | null = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
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
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeDecision(value: unknown): InboundCustomerIntentDecision {
  const decision = String(value ?? "").trim();

  if (
    decision === "customer_service_request" ||
    decision === "customer_conversation_reply" ||
    decision === "non_customer"
  ) {
    return decision;
  }

  return "non_customer";
}

function deterministicFallback(
  input: ClassifyInboundCustomerIntentInput
): InboundCustomerIntentResult {
  if (input.hasExistingCustomerConversation && !input.fallbackLooksLikeNoise) {
    return {
      decision: "customer_conversation_reply",
      confidence: 0.72,
      customerDirection: "continuing_service_conversation",
      isAutomatedOrBulk: false,
      isVendorOrSolicitation: false,
      isAccountOrSystemNotice: false,
      reason: "existing_customer_conversation_without_strong_noise_signal",
      source: "deterministic_fallback",
    };
  }

  if (input.fallbackLooksLikeCustomerRequest && !input.fallbackLooksLikeNoise) {
    return {
      decision: "customer_service_request",
      confidence: 0.68,
      customerDirection: "seeking_service",
      isAutomatedOrBulk: false,
      isVendorOrSolicitation: false,
      isAccountOrSystemNotice: false,
      reason: "fallback_customer_service_evidence",
      source: "deterministic_fallback",
    };
  }

  return {
    decision: "non_customer",
    confidence: input.fallbackLooksLikeNoise ? 0.9 : 0.62,
    customerDirection: "not_seeking_service",
    isAutomatedOrBulk: Boolean(input.fallbackLooksLikeNoise),
    isVendorOrSolicitation: false,
    isAccountOrSystemNotice: false,
    reason: input.fallbackLooksLikeNoise
      ? "fallback_strong_noise_signal"
      : "insufficient_customer_service_evidence",
    source: "deterministic_fallback",
  };
}

export async function classifyInboundCustomerIntent(
  input: ClassifyInboundCustomerIntentInput
): Promise<InboundCustomerIntentResult> {
  const body = cleanText(input.body);
  const subject = cleanText(input.subject);
  const fromEmail = cleanText(input.fromEmail).toLowerCase();

  if (!body) {
    return {
      decision: "non_customer",
      confidence: 1,
      customerDirection: "not_seeking_service",
      isAutomatedOrBulk: false,
      isVendorOrSolicitation: false,
      isAccountOrSystemNotice: false,
      reason: "empty_message",
      source: "deterministic_fallback",
    };
  }

  const openai = getClient();

  if (!openai) {
    return deterministicFallback(input);
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.LEADFLOW_INBOUND_CLASSIFIER_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "inbound_customer_intent",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "decision",
              "confidence",
              "customerDirection",
              "isAutomatedOrBulk",
              "isVendorOrSolicitation",
              "isAccountOrSystemNotice",
              "reason",
            ],
            properties: {
              decision: {
                type: "string",
                enum: [
                  "customer_service_request",
                  "customer_conversation_reply",
                  "non_customer",
                ],
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              customerDirection: {
                type: "string",
                enum: [
                  "seeking_service",
                  "continuing_service_conversation",
                  "not_seeking_service",
                ],
              },
              isAutomatedOrBulk: { type: "boolean" },
              isVendorOrSolicitation: { type: "boolean" },
              isAccountOrSystemNotice: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You are the admission gate for an HVAC service company's inbound mailbox.",
            "Your job is semantic direction-of-intent classification, not keyword matching.",
            "Admit genuine customers who are seeking HVAC service, repair, diagnosis, maintenance, replacement, installation, estimates, scheduling, or who are continuing an already-established customer service conversation.",
            "Real customers may use any wording, spelling, grammar, dialect, slang, profanity, fragments, abbreviations, emojis, typos, regional speech, or extremely short messages. They do not need to provide a name, phone, address, ZIP code, or formal request. Do not reject a genuine customer merely because their message is messy or incomplete.",
            "Reject messages whose direction is toward selling to, marketing to, recruiting, partnering with, billing, notifying, administering, warning, surveying, supporting, or otherwise communicating with the HVAC business rather than asking the HVAC business to perform customer service.",
            "Reject vendors, lead sellers, SEO/marketing agencies, sales outreach, partnership pitches, recruiters, newsletters, promotions, invoices, receipts, account notices, compliance notices, security alerts, subscription notices, platform notifications, support-ticket traffic, surveys, automated transactional notices, and unrelated mail even when they contain HVAC words, addresses, phone numbers, urgent language, repair words, or the word help.",
            "The decisive question is: is this sender acting as a customer/prospect asking this HVAC company for service, or are they acting in some other role toward the business?",
            "A message mentioning AC/HVAC is not enough. 'Do you need sales with your ACs?' is not a customer request. A platform email describing an HVAC campaign is not a customer request. A customer saying their AC is cooked and asking for somebody to come out is a customer request.",
            "If hasExistingCustomerConversation is true, short replies such as yes, option numbers, times, corrections, names, phone numbers, addresses, questions, confirmations, cancellations, or rescheduling language can be valid customer-conversation replies. However, obvious automated/vendor/system messages remain non-customer even if they occur in a reply-looking subject.",
            "Do not invent context. Use non_customer when the sender's role is clearly not customer/prospect. When a genuine service-seeking interpretation is substantially more likely than a vendor/system interpretation, admit it.",
            "Keep reason concise and describe the semantic direction, not a keyword count.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            fromEmail: fromEmail || null,
            subject: subject || null,
            body: body.slice(0, 12000),
            hasExistingCustomerConversation: Boolean(
              input.hasExistingCustomerConversation
            ),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return deterministicFallback(input);

    const parsed = JSON.parse(content);
    const decision = normalizeDecision(parsed?.decision);

    return {
      decision,
      confidence: clampConfidence(parsed?.confidence),
      customerDirection:
        parsed?.customerDirection === "seeking_service" ||
        parsed?.customerDirection === "continuing_service_conversation" ||
        parsed?.customerDirection === "not_seeking_service"
          ? parsed.customerDirection
          : decision === "customer_service_request"
            ? "seeking_service"
            : decision === "customer_conversation_reply"
              ? "continuing_service_conversation"
              : "not_seeking_service",
      isAutomatedOrBulk: Boolean(parsed?.isAutomatedOrBulk),
      isVendorOrSolicitation: Boolean(parsed?.isVendorOrSolicitation),
      isAccountOrSystemNotice: Boolean(parsed?.isAccountOrSystemNotice),
      reason: cleanText(parsed?.reason).slice(0, 500) || "semantic_classification",
      source: "semantic_model",
    };
  } catch (error: any) {
    console.error("[inbound-customer-classifier] semantic classification failed", {
      error: error?.message ?? error,
    });

    return deterministicFallback(input);
  }
}