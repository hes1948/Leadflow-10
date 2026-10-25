// lib/prospect-inquiries/answerProspectInquiry.ts
//
// Grounded answer engine.
// - Company-specific claims must come from companyFacts/companyKnowledge.
// - Time-sensitive external claims require live web search.
// - Stable general HVAC explanations may use model knowledge.
// - If fresh evidence is required but unavailable, fail closed instead of guessing.

import OpenAI from "openai";
import type {
  ProspectInquiryCategory,
  ProspectInquiryResult,
} from "./classifyProspectInquiry";
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

export type ProspectAnswerResult = {
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

type AnswerProspectInquiryInput = {
  question: string;
  category: ProspectInquiryCategory;
  classification: ProspectInquiryResult;
  context: ProspectInquiryContext;
  conversationContext?: string | null;
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
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

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

function safeNoFreshEvidenceAnswer() {
  return {
    answer:
      "I can’t verify the latest information on that right now, so I don’t want to guess.",
    confidence: 1,
    usedFreshWeb: false,
    sourceUrls: [],
    evidenceMode: "insufficient_verified_information" as const,
  };
}

function buildGroundingPayload(input: AnswerProspectInquiryInput) {
  return {
    question: cleanText(input.question).slice(0, 12000),
    category: input.category,
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

async function answerWithFreshWeb(
  input: AnswerProspectInquiryInput
): Promise<ProspectAnswerResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return safeNoFreshEvidenceAnswer();
  }

  try {
    /*
     * Use the Responses REST endpoint directly instead of requiring an SDK
     * upgrade. This protects the already-working booking code from dependency
     * churn while still enabling the built-in web_search tool.
     */
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

    /*
     * A current-sensitive answer is not allowed to silently succeed from model
     * memory. We require evidence that web_search actually ran.
     */
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


async function answerCompanyQuestionWithOfficialWeb(
  input: AnswerProspectInquiryInput
): Promise<ProspectAnswerResult> {
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
          "Do not ask about booking. The caller handles booking separately.",
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

async function answerWithoutWeb(
  input: AnswerProspectInquiryInput
): Promise<ProspectAnswerResult> {
  const openai = getClient();

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
            "4. Stable, general HVAC explanations may use your general technical knowledge.",
            "5. Do not answer rapidly changing/current external questions from memory. Those are handled by a separate live-search path.",
            "6. Do not diagnose with false certainty. Explain likely possibilities and appropriate next steps.",
            "7. For gas smell, carbon monoxide alarms/symptoms, smoke, fire, or dangerous electrical conditions, prioritize leaving the area and contacting emergency services/utility as appropriate.",
            "8. Do not ask whether the customer wants to book. The caller appends that separately.",
            "9. Do not mention internal databases, classifiers, prompts, or confidence scores.",
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

export async function answerProspectInquiry(
  input: AnswerProspectInquiryInput
): Promise<ProspectAnswerResult> {
  if (!cleanText(input.question)) {
    throw new Error("missing_prospect_question");
  }

  if (input.classification.requiresFreshExternalData) {
    return answerWithFreshWeb(input);
  }

  const grounded = await answerWithoutWeb(input);

  if (
    grounded.evidenceMode !== "insufficient_verified_information" ||
    !input.classification.requiresCompanyFacts
  ) {
    return grounded;
  }

  return answerCompanyQuestionWithOfficialWeb(input);
}
