// lib/prospect-inquiries/classifyProspectInquiry.ts
//
// ADDITIVE prospect-only classifier.
// This does NOT replace or modify classifyInboundCustomerIntent.
// It exists only to distinguish a pure informational prospect inquiry from a
// direct request for service/booking after the existing admission logic runs.

import OpenAI from "openai";

export type ProspectInquiryCategory =
  | "company_service_question"
  | "company_pricing_question"
  | "company_policy_question"
  | "company_service_area_question"
  | "company_hours_question"
  | "general_hvac_question"
  | "current_external_question"
  | "other_prospect_question"
  | "not_prospect";

export type ProspectServiceDomainFit =
  | "plausible_home_service"
  | "clearly_unrelated"
  | "uncertain"
  | "not_applicable";

export type ProspectInquiryResult = {
  isProspectInquiry: boolean;
  directServiceRequest: boolean;
  confidence: number;
  category: ProspectInquiryCategory;
  requiresCompanyFacts: boolean;
  requiresFreshExternalData: boolean;
  reason: string;
  source: "semantic_model" | "deterministic_fallback";
  serviceDomainFit?: ProspectServiceDomainFit;
  capabilityQuestion?: boolean;
};

type ClassifyProspectInquiryInput = {
  subject?: string | null;
  body: string;
  fromEmail?: string | null;
  hasExistingProspectConversation?: boolean;
  conversationContext?: string | null;
  existingAdmission?: Record<string, unknown> | null;
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

function normalizeCategory(value: unknown): ProspectInquiryCategory {
  const allowed: ProspectInquiryCategory[] = [
    "company_service_question",
    "company_pricing_question",
    "company_policy_question",
    "company_service_area_question",
    "company_hours_question",
    "general_hvac_question",
    "current_external_question",
    "other_prospect_question",
    "not_prospect",
  ];

  const category = String(value ?? "").trim() as ProspectInquiryCategory;
  return allowed.includes(category) ? category : "not_prospect";
}

function normalizeServiceDomainFit(value: unknown): ProspectServiceDomainFit {
  const allowed: ProspectServiceDomainFit[] = [
    "plausible_home_service",
    "clearly_unrelated",
    "uncertain",
    "not_applicable",
  ];

  const normalized = String(value ?? "").trim() as ProspectServiceDomainFit;
  return allowed.includes(normalized) ? normalized : "uncertain";
}

function hasHardNonProspectSignal(text: string) {
  return /\b(?:seo|backlinks?|lead generation|marketing services?|digital marketing|website redesign|guest post|sponsored post|partnership proposal|affiliate|wholesale|supplier|vendor|resume|résumé|job application|career|employment|recruiter|invoice attached|payment reminder|account alert|security alert|verify your account|newsletter|unsubscribe|press release)\b/i.test(
    text
  );
}


function isReadOnlyBookingAvailabilityQuestion(text: string) {
  const normalized = cleanText(text).toLowerCase();
  if (!normalized) return false;

  const informationalCompanyTopic =
    /\b(?:price|pricing|cost|fee|financing|finance|warranty|warranties|service area|hours|brand|brands|membership|maintenance plan|promotion|discount|diagnostic|policy|policies)\b/i.test(
      normalized
    );

  if (informationalCompanyTopic) return false;

  return (
    /\b(?:what|which|show|give|send|tell)\b.{0,55}\b(?:booking|appointment|appointments|opening|openings|slot|slots|availability|available times|times available)\b/i.test(
      normalized
    ) ||
    /\b(?:booking|appointment|appointments)\b.{0,40}\b(?:option|options|opening|openings|slot|slots|availability|available|time|times|day|days)\b/i.test(
      normalized
    ) ||
    /\b(?:what|which)\s+(?:times|days|openings|slots|appointments)\s+(?:do|can)\s+(?:you|we)\s+(?:have|offer|show)\b/i.test(
      normalized
    ) ||
    /\b(?:what'?s|what is)\s+(?:your\s+)?(?:earliest|soonest|next)\s+(?:appointment|opening|availability)\b/i.test(
      normalized
    ) ||
    /\bdo you have (?:any\s+)?(?:appointments|openings|slots|availability)\b/i.test(
      normalized
    ) ||
    /\b(?:what are (?:your|the) options|tell me (?:some|the) options|show me (?:some|the) options)\b/i.test(
      normalized
    )
  );
}

/*
 * Cheap surface test used by the Gmail router to avoid calling this second
 * semantic classifier for every obvious direct repair request.
 *
 * This is NOT the final prospect decision.
 */
export function hasProspectInquirySurface(
  body: string,
  subject?: string | null
) {
  const text = cleanText(`${subject ?? ""}\n${body}`).toLowerCase();

  if (!text) return false;

  return (
    text.includes("?") ||
    /^(?:hey|hi|hello|yo|sup|quick question)[,! ]*/i.test(text) &&
      /\b(?:who|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|would|should|will|tell me|explain|look up|find out|search|latest|recent|newest|current)\b/i.test(text) ||
    /\b(?:who is|who are|who was|what did|what does|what is|what are|when did|when is|where is|where are|why is|why did|how do|how does|how much|how long|which|do you|can you|could you|are you|is there|does your|tell me|explain|look up|find out|search for|wondering|wanted to know|curious|looking for info|need info|latest|most recent|newest|current|price|pricing|cost|fee|quote|estimate|financing|finance|warranty|guarantee|service area|hours|open today|brand|brands|mini[- ]?split|heat pump|maintenance plan|membership|refrigerant|recall|booking|appointment|appointments|availability|opening|openings|slot|slots)\b/i.test(
      text
    )
  );
}


/*
 * High-confidence qualification gate for pure company-capability questions.
 *
 * Examples that MUST stay in the prospect lane:
 * - "Do you fix heat pumps?"
 * - "Do you repair heat pumps?"
 * - "Do you service Trane systems?"
 * - "Can you install mini splits?"
 * - "Do you work on geothermal systems?"
 *
 * Explicit service-action language still wins and stays in the existing
 * booking lane. This helper never interprets scheduling information.
 */
function isPureCompanyCapabilityQuestion(body: string) {
  const text = cleanText(body).toLowerCase();
  if (!text) return false;

  /*
   * Fallback/firewall only. Primary routing below is semantic.
   * Asking WHETHER the company handles something is informational, even when
   * the customer says "my ...". Possession language is not booking consent.
   */
  const capabilityQuestion =
    /^(?:hi[,! ]+|hello[,! ]+|hey[,! ]+|yo[,! ]+)?\s*(?:do you(?: guys)?|does your (?:company|team)|are you(?: guys)? able to|can you|can your (?:company|team))\s+(?:fix|repair|service|install|maintain|replace|work on|work with|handle|support|help with)\b/i.test(
      text
    );

  if (!capabilityQuestion) return false;

  const explicitDispatchOrScheduling =
    /\b(?:book(?: me| us)?|schedule(?: me| us)?|appointment|send (?:someone|somebody|a tech|a technician)|come out|come over|come by|swing by|pull up|get (?:someone|somebody|a tech|a technician) out|when can (?:you|someone|somebody) come|asap|today if possible|tomorrow|at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(
      text
    );

  return !explicitDispatchOrScheduling;
}

function hasCurrentSensitiveSurface(text: string) {
  return (
    /\b(?:today|currently|current|latest|newest|most recent|right now|recent|recently|ago|this hour|this morning|this afternoon|this evening|breaking|live|as of|recall|alert|advisory|ban|banned|law|rule|regulation|weather|temperature|heat advisory|manufacturer notice|last post|latest post|recent post|just posted|posted today|news|headline|score|price right now|stock price|exchange rate)\b/i.test(
      text
    ) ||
    /\bwhat\b.{0,80}\b(?:post|tweet|say|announce|publish|release)\b.{0,35}\blast\b/i.test(
      text
    ) ||
    /\b(?:post|tweet|announcement|release)\b.{0,35}\b(?:last|latest|most recent|newest)\b/i.test(
      text
    )
  );
}

function asksCompanySpecificFact(text: string) {
  return /\b(?:do you|does your|your company|your|price|pricing|cost|fee|quote|estimate|financing|finance|warranty|service area|hours|brand|brands|install|service|policy|policies|promotion|membership|diagnostic)\b/i.test(
    text
  );
}

function deterministicFallback(
  input: ClassifyProspectInquiryInput
): ProspectInquiryResult {
  const text = cleanText(`${input.subject ?? ""}\n${input.body}`);

  const admission = input.existingAdmission ?? {};
  const hardRejectedByExistingAdmission =
    Boolean(admission.isAutomatedOrBulk) ||
    Boolean(admission.isVendorOrSolicitation) ||
    Boolean(admission.isAccountOrSystemNotice);

  if (
    !text ||
    hardRejectedByExistingAdmission ||
    hasHardNonProspectSignal(text)
  ) {
    return {
      isProspectInquiry: false,
      directServiceRequest: false,
      confidence: 0.96,
      category: "not_prospect",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "hard_non_prospect_signal",
      source: "deterministic_fallback",
    };
  }

  if (isReadOnlyBookingAvailabilityQuestion(text)) {
    return {
      isProspectInquiry: true,
      directServiceRequest: false,
      confidence: 0.99,
      category: "other_prospect_question",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "read_only_booking_availability_question",
      source: "deterministic_fallback",
    };
  }

  const directServiceRequest =
    /\b(?:book(?:\s+me|\s+us)?|schedule(?:\s+me|\s+us)?|make\s+(?:me|us)?\s*(?:an?\s+)?appointment|set\s+up\s+(?:an?\s+)?appointment|get\s+(?:me|us)\s+(?:an?\s+)?appointment|send (?:someone|somebody|a tech|a technician)|come out|come over|come by|swing by|pull up|get (?:someone|somebody|a tech|a technician) out|need (?:someone|somebody|a tech|a technician)|fix my|repair my|service my|need service|need repair|can (?:someone|somebody) come|when can (?:you|someone|somebody) come|asap|today if possible)\b/i.test(
      text
    );

  if (directServiceRequest) {
    return {
      isProspectInquiry: false,
      directServiceRequest: true,
      confidence: 0.82,
      category: "not_prospect",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "direct_service_request_should_remain_in_existing_booking_lane",
      source: "deterministic_fallback",
    };
  }

  const inquirySurface =
    Boolean(input.hasExistingProspectConversation) ||
    hasProspectInquirySurface(input.body, input.subject);

  const currentSensitive = hasCurrentSensitiveSurface(text);
  const companySpecific = asksCompanySpecificFact(text);

  /*
   * Once an exact genuine prospect conversation exists, legitimate customer
   * informational questions may be broader than HVAC. This keeps the assistant
   * useful for ordinary factual questions while preserving the outer Gmail
   * admission/vendor/system firewalls that established the conversation.
   */
  if (input.hasExistingProspectConversation && inquirySurface) {
    return {
      isProspectInquiry: true,
      directServiceRequest: false,
      confidence: 0.86,
      category: currentSensitive
        ? "current_external_question"
        : "other_prospect_question",
      requiresCompanyFacts: companySpecific,
      requiresFreshExternalData: currentSensitive,
      reason: "existing_verified_prospect_conversation_question",
      source: "deterministic_fallback",
    };
  }

  /*
   * Parallel information gate: once the outer inbox admission firewalls have
   * rejected vendors/system mail, ANY genuine customer information question
   * may be answered here. It does not need to be HVAC-specific. Booking intent
   * remains a separate lane and always wins when the customer asks for action.
   */
  if (inquirySurface) {
    return {
      isProspectInquiry: true,
      directServiceRequest: false,
      confidence: 0.84,
      category: currentSensitive
        ? "current_external_question"
        : "other_prospect_question",
      requiresCompanyFacts: companySpecific,
      requiresFreshExternalData: currentSensitive,
      reason: "general_customer_information_question",
      source: "deterministic_fallback",
    };
  }

  return {
    isProspectInquiry: false,
    directServiceRequest: false,
    confidence: 0.72,
    category: "not_prospect",
    requiresCompanyFacts: false,
    requiresFreshExternalData: false,
    reason: "no_information_or_booking_intent_detected",
    source: "deterministic_fallback",
  };
}

export async function classifyProspectInquiry(
  input: ClassifyProspectInquiryInput
): Promise<ProspectInquiryResult> {
  const body = cleanText(input.body);
  const subject = cleanText(input.subject);
  const fromEmail = cleanText(input.fromEmail).toLowerCase();

  if (!body) {
    return {
      isProspectInquiry: false,
      directServiceRequest: false,
      confidence: 1,
      category: "not_prospect",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "empty_message",
      source: "deterministic_fallback",
    };
  }

  const admission = input.existingAdmission ?? {};

  if (
    Boolean(admission.isAutomatedOrBulk) ||
    Boolean(admission.isVendorOrSolicitation) ||
    Boolean(admission.isAccountOrSystemNotice) ||
    hasHardNonProspectSignal(`${subject}\n${body}`)
  ) {
    return {
      isProspectInquiry: false,
      directServiceRequest: false,
      confidence: 0.98,
      category: "not_prospect",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "existing_or_deterministic_non_prospect_signal",
      source: "deterministic_fallback",
    };
  }

  /*
   * Read-only booking availability questions are informational. Asking to SEE
   * openings/options is not consent to book and must not be stolen by the
   * direct-service lane.
   */
  if (isReadOnlyBookingAvailabilityQuestion(body)) {
    return {
      isProspectInquiry: true,
      directServiceRequest: false,
      confidence: 0.99,
      category: "other_prospect_question",
      requiresCompanyFacts: false,
      requiresFreshExternalData: false,
      reason: "read_only_booking_availability_question",
      source: "deterministic_fallback",
    };
  }

  /*
   * Qualification firewall:
   * pure capability questions must be answered BEFORE any booking handoff.
   * This is intentionally evaluated after vendor/system rejection and before
   * semantic classification so model variance cannot steal these questions
   * into the direct-service lane.
   */
  if (isPureCompanyCapabilityQuestion(body)) {
    return {
      isProspectInquiry: true,
      directServiceRequest: false,
      confidence: 0.99,
      category: "company_service_question",
      requiresCompanyFacts: true,
      requiresFreshExternalData: false,
      reason: "pure_company_capability_question_requires_answer_before_booking",
      source: "deterministic_fallback",
      serviceDomainFit: "uncertain",
      capabilityQuestion: true,
    };
  }

  const openai = getClient();

  if (!openai) {
    return deterministicFallback(input);
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
          name: "leadflow_prospect_inquiry",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "isProspectInquiry",
              "directServiceRequest",
              "confidence",
              "category",
              "requiresCompanyFacts",
              "requiresFreshExternalData",
              "serviceDomainFit",
              "capabilityQuestion",
              "reason",
            ],
            properties: {
              isProspectInquiry: { type: "boolean" },
              directServiceRequest: { type: "boolean" },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              category: {
                type: "string",
                enum: [
                  "company_service_question",
                  "company_pricing_question",
                  "company_policy_question",
                  "company_service_area_question",
                  "company_hours_question",
                  "general_hvac_question",
                  "current_external_question",
                  "other_prospect_question",
                  "not_prospect",
                ],
              },
              requiresCompanyFacts: { type: "boolean" },
              requiresFreshExternalData: { type: "boolean" },
              serviceDomainFit: {
                type: "string",
                enum: [
                  "plausible_home_service",
                  "clearly_unrelated",
                  "uncertain",
                  "not_applicable",
                ],
              },
              capabilityQuestion: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You are a SECONDARY, additive prospect-inquiry arbiter for an HVAC service company's inbox.",
            "You do not replace the existing booking/service admission classifier.",
            "Your only job is to identify genuine end-customer/prospect INFORMATIONAL inquiries that should be answered before asking whether the person wants an appointment.",
            "",
            "PROSPECT INQUIRY examples:",
            "- Do you work on Trane systems?",
            "- How much is your diagnostic fee?",
            "- Do you fix heat pumps?",
            "- Do you service heat pumps?",
            "- Do you serve my ZIP code?",
            "- What does a frozen evaporator coil usually mean?",
            "- Do you offer financing?",
            "- Is there a current manufacturer recall on this model?",
            "",
            "READ-ONLY AVAILABILITY questions are INFORMATIONAL prospect questions, not booking consent:",
            "- What booking options do you have?",
            "- What appointment times are available?",
            "- Show me your next openings.",
            "- What's your earliest opening?",
            "",
            "DIRECT SERVICE REQUEST examples that MUST stay in the existing booking lane:",
            "- My AC is broken, send someone.",
            "- I need a technician tomorrow.",
            "- Book me for Friday.",
            "- Can somebody come out today?",
            "- Please fix my furnace.",
            "",
            "Set directServiceRequest=true whenever the customer is asking the company to actually perform/schedule service now.",
            "Do NOT set directServiceRequest=true merely because the customer asks to SEE real availability/openings/options without choosing one.",
            "When directServiceRequest=true, set isProspectInquiry=false. Existing booking routing owns that message.",
            "",
            "Reject non-prospects: vendors, sales pitches, SEO/marketing, suppliers, recruiters/job applicants, partnership requests, billing/account notices, platform/system notifications, newsletters, automated mail, surveys, unrelated personal mail, or anyone communicating toward the business in a non-customer role.",
            "HVAC vocabulary alone does not make a message a prospect inquiry.",
            "A genuine prospect may use slang, typos, fragments, profanity, or omit a question mark.",
            "If hasExistingProspectConversation=true, interpret follow-up questions in that verified customer conversation using conversationContext.",
            "A legitimate end-customer informational question does NOT have to be HVAC-specific, even on the first turn. The information gate is intentionally broad. Examples include 'What did Elon Musk post last?', 'What is the capital of Belgium?', or any other genuine factual question. Use other_prospect_question for stable general information and current_external_question when fresh facts are required.",
            "Freshness depends on the NATURE OF THE FACT, not on whether the customer literally says today/current/latest. If the truthful answer can materially change over time, classify it as current_external_question and require fresh external data on the FIRST turn.",
            "Inherently volatile facts include live or changing rankings/top-N positions, richest/wealthiest-person rankings, who is number 1/2/etc. in a current ranking, current office-holders or company leadership, prices/market values/exchange rates, sports standings/scores, current records/statuses, recent public activity/posts, weather, laws/regulations, recalls, alerts, availability, and similar changeable facts.",
            "Example: 'Who is the richest person in the world?' requires fresh external data immediately even without words like today/current/latest. By contrast, stable facts such as 'What is the capital of Belgium?' or historical facts do not require live research merely because they are factual questions.",
            "The moment the customer asks the company to actually book, schedule, send a technician, or perform service, set directServiceRequest=true so the booking pipeline takes over immediately.",
            "",
            "CAPABILITY VS ACTION — reason from meaning, not keywords:",
            "- capabilityQuestion=true when the customer is asking WHETHER the company handles/fixes/services something, even if they describe it as 'my' problem or object.",
            "- A capability question is informational. Do not turn it into booking merely because fix/repair/service language appears.",
            "- directServiceRequest=true only when the customer is actually authorizing/requesting service action, dispatch, scheduling, or booking now.",
            "",
            "SERVICE-DOMAIN FIT — semantic judgment, never a phrase blacklist:",
            "- plausible_home_service: plausibly HVAC, indoor comfort, building-mechanical, or adjacent home-service work that could reasonably require checking company capabilities.",
            "- clearly_unrelated: plainly outside HVAC/home-service work based on ordinary meaning, such as a human bodily/medical issue, legal task, vehicle repair, consumer-electronics repair, or similarly unrelated matter. Infer meaning; do not keyword-match jokes or specific phrases.",
            "- uncertain: possibly a service request, but domain fit is not clear enough to reject.",
            "- not_applicable: not a service/capability question.",
            "- serviceDomainFit applies only to a requested service/capability, not to ordinary company-policy, pricing, hours, service-area, values, guarantee, or general factual questions. For those non-service questions use not_applicable even when the topic itself is not HVAC-related.",
            "- If serviceDomainFit=clearly_unrelated, NEVER send it to booking even if action verbs appear. Keep it in the information gate and answer the customer's actual question. Do not turn domain mismatch into a canned refusal.",
            "- If capabilityQuestion=true, route to information first so verified company facts/official web determine whether the company actually offers it, regardless of whether the requested capability is plausible, uncertain, or clearly unrelated.",
            "",
            "requiresCompanyFacts=true for claims about this specific company's prices, fees, brands serviced, service area, hours, warranties, financing, policies, memberships, promotions, or capabilities.",
            "requiresFreshExternalData=true whenever the answer materially depends on a fact that can go stale, even if the customer's wording contains no explicit freshness cue. current_external_question MUST always set requiresFreshExternalData=true.",
            "Stable general factual or HVAC explanations that are not time-sensitive do not require fresh external data.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            fromEmail: fromEmail || null,
            subject: subject || null,
            body: body.slice(0, 12000),
            hasExistingProspectConversation: Boolean(
              input.hasExistingProspectConversation
            ),
            conversationContext: cleanText(input.conversationContext).slice(
              0,
              6000
            ),
            existingAdmission: input.existingAdmission ?? null,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return deterministicFallback(input);

    const parsed = JSON.parse(content);
    let serviceDomainFit = normalizeServiceDomainFit(parsed?.serviceDomainFit);
    const capabilityQuestion = Boolean(parsed?.capabilityQuestion);
    let directServiceRequest = Boolean(parsed?.directServiceRequest);
    const modelRequestedServiceAction = directServiceRequest;
    let category = normalizeCategory(parsed?.category);
    let isProspectInquiry = Boolean(parsed?.isProspectInquiry);
    let requiresCompanyFacts = Boolean(parsed?.requiresCompanyFacts);

    /*
     * Semantic domain firewall: domain fit controls BOOKING SAFETY, not whether
     * the information gate may answer a legitimate customer question.
     *
     * A clearly unrelated requested service can never become an appointment
     * merely because it contains action verbs. It remains informational.
     * Company capability questions still require company-grounded evidence.
     * Ordinary company-policy/general questions are not service-domain tests.
     */
    if (serviceDomainFit === "clearly_unrelated") {
      directServiceRequest = false;
      isProspectInquiry = true;

      if (capabilityQuestion || modelRequestedServiceAction) {
        category = "company_service_question";
        requiresCompanyFacts = true;
      } else if (category === "not_prospect") {
        category = "other_prospect_question";
      }
    } else if (capabilityQuestion) {
      directServiceRequest = false;
      isProspectInquiry = true;
      category = "company_service_question";
      requiresCompanyFacts = true;
    }

    if (
      !capabilityQuestion &&
      !modelRequestedServiceAction &&
      (category === "company_policy_question" ||
        category === "company_pricing_question" ||
        category === "company_service_area_question" ||
        category === "company_hours_question" ||
        category === "current_external_question" ||
        category === "other_prospect_question")
    ) {
      serviceDomainFit = "not_applicable";
    }

    return {
      isProspectInquiry:
        !directServiceRequest &&
        category !== "not_prospect" &&
        isProspectInquiry,
      directServiceRequest,
      confidence: clampConfidence(parsed?.confidence),
      category,
      requiresCompanyFacts,
      requiresFreshExternalData:
        category === "current_external_question" ||
        Boolean(parsed?.requiresFreshExternalData),
      reason:
        cleanText(parsed?.reason).slice(0, 500) ||
        "semantic_prospect_classification",
      source: "semantic_model",
      serviceDomainFit,
      capabilityQuestion,
    };
  } catch (error: any) {
    console.error("[prospect-inquiry] classification failed", {
      error: error?.message ?? error,
    });

    return deterministicFallback(input);
  }
}