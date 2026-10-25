// lib/gmail/processGmailPubSubWebhook.ts

import { supabase } from "@/lib/supabase";
import { getAutomationReason } from "@/lib/email/automationIdentity";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";
import { startGmailInboxWatch } from "@/lib/gmailWatch";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import { enqueueGmailMessageRouting } from "@/lib/gmail/enqueueGmailMessageRouting";
import { extractLeadData } from "@/lib/ai/extractLeadData";
import { classifyInboundCustomerIntent } from "@/lib/ai/classifyInboundCustomerIntent";
import { routeProspectInquiryIfApplicable } from "@/lib/prospect-inquiries/routeProspectInquiry";
import {
  extractLeadMetadataFromText,
  mergeLeadMetadata,
} from "@/lib/leads/leadMetadata";

type GmailPubSubPayload = {
  emailAddress?: string;
  historyId?: string;
  recoveryMode?: boolean;
};

type FlexibleQualification = Record<string, any>;

type GmailClassification = "new_hvac_lead" | "customer_booking_reply" | "noise";

type LeadMetadataForDedupe = {
  customerName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  serviceArea: string | null;
};

function decodePubSubData(data?: string | null): GmailPubSubPayload {
  if (!data) throw new Error("missing_pubsub_message_data");
  return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
}

function getHeaderValue(headers: any[] | undefined, name: string) {
  return (
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? null
  );
}

function extractEmailAddress(value?: string | null) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function flattenParts(parts: any[] = []): any[] {
  const output: any[] = [];

  for (const part of parts) {
    output.push(part);
    if (Array.isArray(part.parts)) output.push(...flattenParts(part.parts));
  }

  return output;
}

function htmlToText(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function decodeMessageBody(payload: any): string {
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);

  const parts = flattenParts(payload?.parts ?? []);

  const textPart = parts.find(
    (part: any) => part.mimeType === "text/plain" && part.body?.data
  );

  if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);

  const htmlPart = parts.find(
    (part: any) => part.mimeType === "text/html" && part.body?.data
  );

  if (htmlPart?.body?.data) {
    return htmlToText(decodeBase64Url(htmlPart.body.data));
  }

  return "";
}

function normalizeText(value?: string | null) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

type GmailInboundDecision = "ACCEPT" | "REJECT" | "SKIP" | "ERROR";

function logInboundDecision(params: {
  companyId: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  providerThreadId?: string | null;
  fromEmail?: string | null;
  subject?: string | null;
  preview?: string | null;
  decision: GmailInboundDecision;
  classification?: GmailClassification | null;
  reason: string;
  leadCreated?: boolean;
  leadId?: string | null;
  jobQueued?: boolean;
  jobId?: string | null;
  replyTriggered?: boolean;
  customerAdmission?: any;
}) {
  console.log("[gmail-pubsub] INBOUND DECISION", {
    companyId: params.companyId,
    gmailMessageId: params.gmailMessageId ?? null,
    gmailThreadId: params.gmailThreadId ?? null,
    providerThreadId: params.providerThreadId ?? null,
    fromEmail: params.fromEmail ?? null,
    subject: params.subject ?? null,
    preview: String(params.preview ?? "").slice(0, 240),
    decision: params.decision,
    classification: params.classification ?? null,
    reason: params.reason,
    leadCreated: params.leadCreated ?? false,
    leadId: params.leadId ?? null,
    jobQueued: params.jobQueued ?? false,
    jobId: params.jobId ?? null,
    replyTriggered: params.replyTriggered ?? false,
    customerAdmission: params.customerAdmission ?? null,
  });
}

function stripQuotedEmail(text: string) {
  return normalizeText(text)
    .split(/\nOn [^\n]*(?:\n[^\n]*){0,5}?wrote:/i)[0]
    .split(/\nFrom:/i)[0]
    .split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0]
    .replace(/^>.*$/gm, "")
    .trim();
}

function cleanId(value?: string | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeEmail(value?: string | null) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePhoneDigits(value?: string | null) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function normalizeComparableText(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableAddress(value?: string | null) {
  return normalizeComparableText(value)
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\blane\b/g, "ln")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl")
    .replace(/\bcircle\b/g, "cir")
    .replace(/\bterrace\b/g, "ter")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveRealThreadId(params: {
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
}) {
  const messageId = cleanId(params.gmailMessageId);
  const threadId = cleanId(params.gmailThreadId);

  if (!threadId) return null;

  if (threadId === messageId) {
    console.warn("[gmail-pubsub] gmailThreadId matched messageId", {
      gmailMessageId: messageId,
      gmailThreadId: threadId,
      action: "still_using_gmail_thread_id_because_gmail_new_threads_can_share_ids",
    });
  }

  return threadId;
}

function isGoogleAuthFailure(message: string) {
  const text = String(message ?? "").toLowerCase();

  return (
    text.includes("invalid_grant") ||
    text.includes("invalid authentication credentials") ||
    text.includes("expected oauth 2 access token") ||
    text.includes("unauthorized_client") ||
    text.includes("google_reconnect_required")
  );
}

function isBlockedSender(fromEmail: string) {
  const from = fromEmail.toLowerCase();

  return [
    "noreply@",
    "no-reply@",
    "donotreply@",
    "do-not-reply@",
    "newsletter@",
    "marketing@",
    "promotions@",
    "digest@",
    "notifications@",
    "notification@",
    "audience@",
    "daily@",
    "info@nl.",
    "support@e.",
    "care@treatmyocd.com",
    "teamzoom@",
    "capitalone@",
    "cash@square.com",
    "quora.com",
    "baskinrobbins.com",
    "shopgoodwill.com",
    "goodwill.com",
    "emailhsn.com",
    "h.emailhsn.com",
    "hsn@",
    "macys.com",
    "freddys.com",
    "washingtonpost.com",
    "spectator.co.uk",
    "politico.eu",
    "experian.com",
    "zoom.us",
    "square.com",
    "facebookmail.com",
    "linkedin.com",
    "stripe.com",
    "paypal.com",
  ].some((item) => from.includes(item));
}

function looksLikeBulkMarketing(text: string, subject?: string | null) {
  const body = text.toLowerCase();
  const subj = String(subject ?? "").toLowerCase();

  return (
    body.includes("unsubscribe") ||
    body.includes("view in browser") ||
    body.includes("manage preferences") ||
    body.includes("privacy policy") ||
    body.includes("terms of use") ||
    body.includes("sale") ||
    body.includes("markdown") ||
    body.includes("promo") ||
    body.includes("newsletter") ||
    subj.includes("newsletter") ||
    subj.includes("digest") ||
    subj.includes("markdown") ||
    subj.includes("sale") ||
    subj.includes("coupon")
  );
}

function normalizeBookingReplyText(text: string) {
  return stripQuotedEmail(text)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^\w\s:#.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasBookingReplyLanguage(textBody: string, subject?: string | null) {
  const body = normalizeBookingReplyText(textBody);
  const subj = String(subject ?? "").toLowerCase();

  const isReplyThread =
    subj.startsWith("re:") ||
    subj.includes("your hvac request") ||
    subj.includes("hvac request") ||
    subj.includes("appointment");

  if (!isReplyThread) return false;
  if (!body) return false;
  if (body.length > 1200) return false;
  if (looksLikeBulkMarketing(body, subject)) return false;

  return (
    /\b(option|slot|choice|number|#)\s*(1|2|3|one|two|three)\b/i.test(body) ||
    /\b(1st|2nd|3rd|first|second|third|middle|earliest|soonest|latest|last|final)\b/i.test(body) ||
    /\b(k|kk|ok|okay|yes|yeah|yep|yup|sure|bet|cool|perfect|great|sounds good|that works|works for me|works|fine|good|confirmed|confirm|book it|schedule it|lock it in|lock in|lets do|let's do|do it|send it|go ahead|see you then)\b/i.test(body) ||
    /\b(today|tomorrow)\b.*\b(1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(am|pm)\b/i.test(body) ||
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b.*\b(1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(am|pm)?\b/i.test(body) ||
    /\b(1[0-2]|0?[1-9])(?::[0-5][0-9])\s*(am|pm)?\b/i.test(body)
  );
}

type LeadClassificationEvidence = {
  hvacScore: number;
  problemScore: number;
  identityScore: number;
  contactScore: number;
  locationScore: number;
  commercialNoiseScore: number;
  reasons: string[];
};

function countMatches(text: string, patterns: RegExp[]) {
  let count = 0;

  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }

  return count;
}

function scoreNewLeadEvidence(
  textBody: string,
  subject?: string | null
): LeadClassificationEvidence {
  const body = String(textBody ?? "").toLowerCase();
  const subj = String(subject ?? "").toLowerCase();
  const combined = `${subj}\n${body}`;

  const reasons: string[] = [];

  const hvacPatterns = [
    /\b(ac|a\/c|hvac)\b/i,
    /\bair[\s-]*con(?:ditioner|ditioning)?(?:'s)?\b/i,
    /\bair\s*(conditioner|conditioning|unit|system|handler|thing|box)\b/i,
    /\b(furnace|heater|heating|heat pump|thermostat)\b/i,
    /\b(cooling|compressor|condenser|duct|ductwork|mini split)\b/i,
    /\b(blowing hot|blowing warm|not cooling|no cooling|no ac|no a\/c)\b/i,
    /\b(outside unit|inside unit|vents?|airflow)\b/i,
  ];

  const problemPatterns = [
    /\b(broken|broke|busted|dead|died|down|out|went out|quit|failed|failure|cooked|fried|shot|toast|done for|kaput|acting up|tripping|bugging|messed up|jacked up)\b/i,
    /\b(not working|isn'?t working|isnt working|ain'?t working|aint working|won'?t work|wont work|not doing anything|ain'?t doing anything|aint doing anything|doing nothing|won'?t do anything|wont do anything)\b/i,
    /\b(stopped|stopped working|stopped cooling|stopped heating)\b/i,
    /\b(not cooling|not heating|no cooling|no heat|no ac|no a\/c)\b/i,
    /\b(blowing hot|blowing warm|warm air|hot air)\b/i,
    /\b(leak|leaking|frozen|freezing|iced|ice on|making noise|noisy)\b/i,
    /\b(hot in here|hot as hell|hot af|house is hot|getting hot|burning up|sweating|freezing in here|house is freezing|cold as hell)\b/i,
    /\b(repair|fix|service|help|technician|tech|come out|send someone)\b/i,
    /\b(emergency|urgent|asap|today|right now|immediately)\b/i,
    /\b(estimate|quote|replace|replacement|install|installation|maintenance|tune up)\b/i,
  ];

  const identityPatterns = [
    /(?:^|\n|\s)name\s*:/i,
    /(?:^|\n|\s)customer\s*:/i,
    /(?:^|\n|\s)contact\s*:/i,
  ];

  const contactPatterns = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
  ];

  const locationPatterns = [
    /\b\d{5}(?:-\d{4})?\b/,
    /\b\d{1,6}\s+[a-z0-9.'#-]+(?:\s+[a-z0-9.'#-]+){0,8}\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|place|pl|pkwy|parkway|hwy|highway|cir|circle|trl|trail|ter|terrace)\b/i,
    /(?:^|\n|\s)address\s*:/i,
    /\b(tx|texas)\s+\d{5}\b/i,
  ];

  const commercialNoisePatterns = [
    /\bunsubscribe\b/i,
    /\bview in browser\b/i,
    /\bmanage preferences\b/i,
    /\bprivacy policy\b/i,
    /\bnewsletter\b/i,
    /\bdigest\b/i,
    /\bcoupon\b/i,
    /\bpromo(?:tion)?\b/i,
    /\bsale\b/i,
    /\bshop now\b/i,
    /\blimited time\b/i,
  ];

  const hvacHits = countMatches(combined, hvacPatterns);
  const problemHits = countMatches(combined, problemPatterns);
  const identityHits = countMatches(combined, identityPatterns);
  const contactHits = countMatches(combined, contactPatterns);
  const locationHits = countMatches(combined, locationPatterns);
  const commercialNoiseHits = countMatches(combined, commercialNoisePatterns);

  const hvacScore = Math.min(5, hvacHits) * 3;
  const problemScore = Math.min(5, problemHits) * 2;
  const identityScore = Math.min(2, identityHits) * 2;
  const contactScore = Math.min(2, contactHits) * 2;
  const locationScore = Math.min(3, locationHits) * 2;
  const commercialNoiseScore = Math.min(5, commercialNoiseHits) * 4;

  if (hvacHits > 0) reasons.push(`hvac_signals_${hvacHits}`);
  if (problemHits > 0) reasons.push(`problem_signals_${problemHits}`);
  if (identityHits > 0) reasons.push(`identity_signals_${identityHits}`);
  if (contactHits > 0) reasons.push(`contact_signals_${contactHits}`);
  if (locationHits > 0) reasons.push(`location_signals_${locationHits}`);
  if (commercialNoiseHits > 0) {
    reasons.push(`commercial_noise_signals_${commercialNoiseHits}`);
  }

  return {
    hvacScore,
    problemScore,
    identityScore,
    contactScore,
    locationScore,
    commercialNoiseScore,
    reasons,
  };
}

function hasNewLeadLanguage(textBody: string, subject?: string | null) {
  const combined = `${String(subject ?? "")}\n${String(textBody ?? "")}`.trim();

  if (!combined) return false;

  const evidence = scoreNewLeadEvidence(textBody, subject);

  const positiveScore =
    evidence.hvacScore +
    evidence.problemScore +
    evidence.identityScore +
    evidence.contactScore +
    evidence.locationScore;

  const hasHvacEvidence = evidence.hvacScore >= 3;

  const hasStrongCustomerStructure =
    evidence.identityScore >= 2 ||
    evidence.contactScore >= 2 ||
    evidence.locationScore >= 2;

  const hasAnyProblemEvidence = evidence.problemScore >= 2;

  const isClearlyCommercialNoise =
    evidence.commercialNoiseScore >= 8 &&
    evidence.commercialNoiseScore >= positiveScore;

  if (isClearlyCommercialNoise) return false;

  /*
   * Generic HVAC lead rule:
   * identity/contact fields are OPTIONAL. A customer does not need to provide a
   * name, phone number, email address, or street address for the message to be
   * accepted as a lead. Gmail already gives us a sender address, and missing
   * customer metadata can be collected later by the normal qualification flow.
   *
   * We therefore classify primarily from HVAC intent + customer/service intent,
   * while structured metadata is supporting evidence only. This is intentionally
   * wording-agnostic: professional prose, fragments, slang, regional speech,
   * typos, and terse requests can all enter the lead workflow.
   */
  const isIntentBasedHvacLead =
    hasHvacEvidence &&
    hasAnyProblemEvidence &&
    positiveScore - evidence.commercialNoiseScore >= 5;

  /*
   * Structured HVAC requests can also qualify even when the customer's exact
   * problem wording is unfamiliar. Crucially, no particular field is required:
   * name-only, phone-only, email-only, location-only, any combination, or all
   * fields are supported.
   */
  const isStructuredHvacLead =
    hasHvacEvidence &&
    hasStrongCustomerStructure &&
    positiveScore - evidence.commercialNoiseScore >= 5;

  return isIntentBasedHvacLead || isStructuredHvacLead;
}

type ActiveBookingConversation = {
  id: string;
  status: string | null;
  email: string | null;
  inbound_thread_id: string | null;
  outbound_thread_id?: string | null;
  inbound_email_id?: string | null;
  outbound_email_id?: string | null;
  qualification: Record<string, any> | null;
  appointment_time: string | null;
  calendar_event_id: string | null;
  created_at: string | null;
};


type ExactProspectConversation = {
  id: string;
  status: string | null;
  promoted_lead_id: string | null;
  customer_email: string | null;
  provider_thread_id?: string | null;
};

function isRoutableExactProspectConversation(
  conversation: ExactProspectConversation | null
) {
  if (!conversation) return false;

  const status = String(conversation.status ?? "").trim().toLowerCase();

  return (
    status !== "promoted_to_booking" &&
    status !== "closed" &&
    !conversation.promoted_lead_id
  );
}

async function findExactProspectConversationForThread(params: {
  companyId: string;
  providerThreadId?: string | null;
  fromEmail: string;
}) {
  const providerThreadId = cleanId(params.providerThreadId);
  const fromEmail = normalizeEmail(params.fromEmail);

  if (!providerThreadId || !fromEmail) return null;

  const { data, error } = await supabase
    .from("prospect_conversations")
    .select("id, status, promoted_lead_id, customer_email, provider_thread_id")
    .eq("company_id", params.companyId)
    .eq("provider", "gmail_pubsub")
    .eq("provider_thread_id", providerThreadId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const conversation = data as ExactProspectConversation;
  const customerEmail = normalizeEmail(conversation.customer_email);

  if (customerEmail && customerEmail !== fromEmail) {
    return null;
  }

  return conversation;
}


type ReplyChainConversationOwnership =
  | {
      kind: "booking";
      lead: ActiveBookingConversation;
      source: "reply_ancestry_message" | "reply_ancestry_thread";
      ancestorRfcMessageId: string;
      ancestorGmailMessageId: string;
      ancestorThreadId: string | null;
    }
  | {
      kind: "prospect";
      conversation: ExactProspectConversation;
      source: "reply_ancestry_thread";
      ancestorRfcMessageId: string;
      ancestorGmailMessageId: string;
      ancestorThreadId: string;
    };

function normalizeRfcMessageIdToken(value?: string | null) {
  return String(value ?? "")
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .trim();
}

function extractRfcMessageIdTokens(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const bracketed = Array.from(raw.matchAll(/<([^<>]+)>/g))
    .map((match) => normalizeRfcMessageIdToken(match[1]))
    .filter(Boolean);

  if (bracketed.length > 0) return bracketed;

  return raw
    .split(/\s+/)
    .map(normalizeRfcMessageIdToken)
    .filter((token) => token.includes("@"));
}

function getReplyAncestryRfcMessageIds(headers: any[] | undefined) {
  const inReplyTo = extractRfcMessageIdTokens(
    getHeaderValue(headers, "In-Reply-To")
  );
  const references = extractRfcMessageIdTokens(
    getHeaderValue(headers, "References")
  );

  const ordered = [
    ...inReplyTo,
    ...references.slice().reverse(),
  ];

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const token of ordered) {
    const key = token.toLowerCase();
    if (!token || seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
    if (unique.length >= 12) break;
  }

  return unique;
}

async function findGmailMessageByRfcMessageId(params: {
  gmail: any;
  rfcMessageId: string;
}) {
  const token = normalizeRfcMessageIdToken(params.rfcMessageId);
  if (!token) return null;

  let listed: any;

  try {
    listed = await params.gmail.users.messages.list({
      userId: "me",
      q: `rfc822msgid:${token}`,
      maxResults: 10,
      includeSpamTrash: true,
    });
  } catch (error: any) {
    /*
     * Reply ancestry is identity evidence. If Gmail says a reply has ancestry
     * but we cannot resolve it because the provider lookup failed, do NOT
     * silently downgrade the turn into semantic new-mail admission.
     * Throw so the at-least-once webhook can retry safely.
     */
    throw new Error(
      `gmail_reply_ancestry_lookup_failed:${error?.message ?? error}`
    );
  }

  const candidateIds = Array.from(
    new Set(
      (listed.data?.messages ?? [])
        .map((message: any) => cleanId(message?.id))
        .filter(Boolean)
    )
  ) as string[];

  const exactMatches: any[] = [];

  for (const id of candidateIds) {
    const candidate = await params.gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Message-ID"],
    });

    const candidateMessageId = normalizeRfcMessageIdToken(
      getHeaderValue(candidate.data?.payload?.headers ?? [], "Message-ID")
    );

    if (
      candidateMessageId &&
      candidateMessageId.toLowerCase() === token.toLowerCase()
    ) {
      exactMatches.push(candidate.data);
    }
  }

  if (exactMatches.length > 1) {
    throw new Error("ambiguous_gmail_rfc_message_id_ownership");
  }

  return exactMatches[0] ?? null;
}

function senderOwnsLead(
  lead: ActiveBookingConversation,
  fromEmail: string
) {
  const expected = normalizeEmail(lead.email);
  const actual = normalizeEmail(fromEmail);

  return !expected || !actual || expected === actual;
}

function selectUniqueLeadOwner(params: {
  leads: ActiveBookingConversation[];
  fromEmail: string;
  ambiguityError: string;
}) {
  const senderMatched = params.leads.filter((lead) =>
    senderOwnsLead(lead, params.fromEmail)
  );

  if (senderMatched.length === 0) return null;
  if (senderMatched.length === 1) return senderMatched[0];

  /*
   * Identity resolution never guesses between multiple Leads. Status is not
   * allowed to invent ownership because cancel/restore/reschedule may operate
   * on non-"active" states. Ambiguity retries/fails closed instead.
   */
  throw new Error(params.ambiguityError);
}

async function findLeadOwnedByAncestorMessage(params: {
  companyId: string;
  fromEmail: string;
  ancestorGmailMessageId: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, status, email, inbound_thread_id, outbound_thread_id, inbound_email_id, outbound_email_id, qualification, appointment_time, calendar_event_id, created_at"
    )
    .eq("company_id", params.companyId)
    .or(
      `inbound_email_id.eq.${params.ancestorGmailMessageId},outbound_email_id.eq.${params.ancestorGmailMessageId}`
    )
    .limit(20);

  if (error) throw new Error(error.message);

  return selectUniqueLeadOwner({
    leads: (data ?? []) as ActiveBookingConversation[],
    fromEmail: params.fromEmail,
    ambiguityError: "ambiguous_reply_ancestry_message_lead_ownership",
  });
}

async function findLeadOwnedByAncestorThread(params: {
  companyId: string;
  fromEmail: string;
  ancestorThreadId: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, status, email, inbound_thread_id, outbound_thread_id, inbound_email_id, outbound_email_id, qualification, appointment_time, calendar_event_id, created_at"
    )
    .eq("company_id", params.companyId)
    .or(
      `inbound_thread_id.eq.${params.ancestorThreadId},outbound_thread_id.eq.${params.ancestorThreadId}`
    )
    .limit(20);

  if (error) throw new Error(error.message);

  return selectUniqueLeadOwner({
    leads: (data ?? []) as ActiveBookingConversation[],
    fromEmail: params.fromEmail,
    ambiguityError: "ambiguous_reply_ancestry_thread_lead_ownership",
  });
}

async function findProspectOwnedByAncestorThread(params: {
  companyId: string;
  fromEmail: string;
  ancestorThreadId: string;
}) {
  const { data, error } = await supabase
    .from("prospect_conversations")
    .select(
      "id, status, promoted_lead_id, customer_email, provider_thread_id"
    )
    .eq("company_id", params.companyId)
    .eq("provider", "gmail_pubsub")
    .eq("provider_thread_id", params.ancestorThreadId)
    .limit(20);

  if (error) throw new Error(error.message);

  const sender = normalizeEmail(params.fromEmail);
  const candidates = ((data ?? []) as ExactProspectConversation[]).filter(
    (conversation) => {
      const customer = normalizeEmail(conversation.customer_email);
      return !customer || !sender || customer === sender;
    }
  );

  const routable = candidates.filter(isRoutableExactProspectConversation);

  if (routable.length === 0) return null;
  if (routable.length === 1) return routable[0];

  throw new Error("ambiguous_reply_ancestry_prospect_ownership");
}

async function resolveReplyChainConversationOwnership(params: {
  gmail: any;
  companyId: string;
  fromEmail: string;
  headers: any[] | undefined;
}): Promise<ReplyChainConversationOwnership | null> {
  const ancestry = getReplyAncestryRfcMessageIds(params.headers);

  if (ancestry.length === 0) return null;

  for (const ancestorRfcMessageId of ancestry) {
    const ancestorMessage = await findGmailMessageByRfcMessageId({
      gmail: params.gmail,
      rfcMessageId: ancestorRfcMessageId,
    });

    if (!ancestorMessage?.id) continue;

    const ancestorGmailMessageId = String(ancestorMessage.id);
    const ancestorThreadId = cleanId(ancestorMessage.threadId);

    /*
     * Exact ancestor message ownership is strongest. This catches the real
     * production case where LeadFlow's latest outbound Gmail message belongs
     * to a Lead but the customer's reply arrives under a different Gmail
     * threadId.
     */
    const messageLead = await findLeadOwnedByAncestorMessage({
      companyId: params.companyId,
      fromEmail: params.fromEmail,
      ancestorGmailMessageId,
    });

    if (messageLead) {
      return {
        kind: "booking",
        lead: messageLead,
        source: "reply_ancestry_message",
        ancestorRfcMessageId,
        ancestorGmailMessageId,
        ancestorThreadId,
      };
    }

    if (!ancestorThreadId) continue;

    /*
     * Older outbound_email_id values can be overwritten as a conversation
     * continues. Ancestor thread ownership is the durable second identity key.
     */
    const threadLead = await findLeadOwnedByAncestorThread({
      companyId: params.companyId,
      fromEmail: params.fromEmail,
      ancestorThreadId,
    });

    if (threadLead) {
      return {
        kind: "booking",
        lead: threadLead,
        source: "reply_ancestry_thread",
        ancestorRfcMessageId,
        ancestorGmailMessageId,
        ancestorThreadId,
      };
    }

    const prospectConversation = await findProspectOwnedByAncestorThread({
      companyId: params.companyId,
      fromEmail: params.fromEmail,
      ancestorThreadId,
    });

    if (prospectConversation) {
      return {
        kind: "prospect",
        conversation: prospectConversation,
        source: "reply_ancestry_thread",
        ancestorRfcMessageId,
        ancestorGmailMessageId,
        ancestorThreadId,
      };
    }
  }

  return null;
}

function isActiveBookingStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();

  return (
    normalized === "awaiting_customer" ||
    normalized === "contacted" ||
    normalized === "sent" ||
    normalized === "new"
  );
}

function subjectLooksLikeReply(subject?: string | null) {
  const value = String(subject ?? "").trim().toLowerCase();

  return (
    value.startsWith("re:") ||
    value.includes("your hvac request") ||
    value.includes("hvac request") ||
    value.includes("appointment") ||
    value.includes("booking") ||
    value.includes("schedule")
  );
}

function hasActivePendingSlotSuggestion(
  qualification?: Record<string, any> | null
) {
  const pending = qualification?.pendingSlotSuggestion;

  if (!pending || pending.status !== "awaiting_customer_confirmation") {
    return false;
  }

  if (
    Array.isArray(pending.suggestedSlots) &&
    pending.suggestedSlots.some((slot: any) => Boolean(slot?.startTime))
  ) {
    return true;
  }

  return Boolean(pending.suggestedStartTime);
}

async function findActiveBookingConversation(params: {
  companyId: string;
  fromEmail: string;
  gmailThreadId?: string | null;
  providerThreadId?: string | null;
  subject?: string | null;
}) {
  const threadId = cleanId(
    params.providerThreadId ?? params.gmailThreadId ?? null
  );
  const fromEmail = normalizeEmail(params.fromEmail);

  if (threadId) {
    const { data: threadLeads, error: threadError } = await supabase
      .from("leads")
      .select(
        "id, status, email, inbound_thread_id, qualification, appointment_time, calendar_event_id, created_at"
      )
      .eq("company_id", params.companyId)
      .eq("inbound_thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (threadError) throw new Error(threadError.message);

    const exactThreadCandidates =
      (threadLeads ?? []) as ActiveBookingConversation[];

    /*
     * Canonical Gmail-thread ownership is stronger than booking status.
     *
     * The normal invariant is one Lead per Gmail thread. Historical bad data can
     * contain more than one Lead with the same thread id, so never silently pick
     * the newest row when that happens. Prefer exactly one real booked Lead, then
     * exactly one pending-slot Lead, then exactly one other active Lead. If the
     * ownership is still ambiguous, fail closed rather than route a reschedule to
     * the wrong Lead and create a second Calendar appointment.
     */
    if (exactThreadCandidates.length === 1) {
      return exactThreadCandidates[0];
    }

    if (exactThreadCandidates.length > 1) {
      const bookedCandidates = exactThreadCandidates.filter(
        (lead) =>
          String(lead.status ?? "").toLowerCase() === "booked" &&
          Boolean(lead.calendar_event_id) &&
          Boolean(lead.appointment_time)
      );

      if (bookedCandidates.length === 1) {
        return bookedCandidates[0];
      }

      const pendingCandidates = exactThreadCandidates.filter((lead) =>
        hasActivePendingSlotSuggestion(lead.qualification)
      );

      if (pendingCandidates.length === 1) {
        return pendingCandidates[0];
      }

      const activeCandidates = exactThreadCandidates.filter((lead) =>
        isActiveBookingStatus(lead.status)
      );

      if (activeCandidates.length === 1) {
        return activeCandidates[0];
      }

      console.error("[gmail-pubsub] ambiguous exact Gmail thread ownership", {
        companyId: params.companyId,
        threadId,
        candidateLeadIds: exactThreadCandidates.map((lead) => lead.id),
        candidateStatuses: exactThreadCandidates.map((lead) => lead.status),
      });

      throw new Error("ambiguous_gmail_thread_lead_ownership");
    }
  }

  if (!fromEmail || !subjectLooksLikeReply(params.subject)) {
    return null;
  }

  const { data: emailLeads, error: emailError } = await supabase
    .from("leads")
    .select(
      "id, status, email, inbound_thread_id, qualification, appointment_time, calendar_event_id, created_at"
    )
    .eq("company_id", params.companyId)
    .ilike("email", fromEmail)
    .in("status", ["awaiting_customer", "contacted", "sent", "new", "booked"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (emailError) throw new Error(emailError.message);

  const candidates = (emailLeads ?? []) as ActiveBookingConversation[];

  /*
   * Sender fallback is intentionally weaker than exact-thread ownership. Keep
   * the existing pending-slot behavior, but also permit continuation of one
   * uniquely identifiable real booking when Gmail supplies a different thread
   * id for the reply. Never guess between multiple booked appointments.
   */
  const pendingCandidates = candidates.filter((lead) =>
    hasActivePendingSlotSuggestion(lead.qualification)
  );

  if (pendingCandidates.length === 1) {
    return pendingCandidates[0];
  }

  if (pendingCandidates.length > 1) {
    console.error("[gmail-pubsub] ambiguous sender pending lead ownership", {
      companyId: params.companyId,
      fromEmail,
      candidateLeadIds: pendingCandidates.map((lead) => lead.id),
    });
    return null;
  }

  const bookedCandidates = candidates.filter(
    (lead) =>
      String(lead.status ?? "").toLowerCase() === "booked" &&
      Boolean(lead.calendar_event_id) &&
      Boolean(lead.appointment_time)
  );

  if (bookedCandidates.length === 1) {
    console.warn("[gmail-pubsub] using unique booked-lead sender fallback", {
      companyId: params.companyId,
      fromEmail,
      leadId: bookedCandidates[0].id,
      currentThreadId: threadId,
      storedThreadId: bookedCandidates[0].inbound_thread_id,
    });
    return bookedCandidates[0];
  }

  if (bookedCandidates.length > 1) {
    console.error("[gmail-pubsub] ambiguous sender booked lead ownership", {
      companyId: params.companyId,
      fromEmail,
      candidateLeadIds: bookedCandidates.map((lead) => lead.id),
    });
  }

  return null;
}

function classifyMessage(params: {
  subject?: string | null;
  rawTextBody: string;
  cleanTextBody: string;
}): GmailClassification {
  if (hasBookingReplyLanguage(params.cleanTextBody, params.subject)) {
    return "customer_booking_reply";
  }

  if (hasNewLeadLanguage(params.rawTextBody, params.subject)) {
    return "new_hvac_lead";
  }

  return "noise";
}

async function findConnectionByEmail(emailAddress?: string | null) {
  const cleanEmail = normalizeEmail(emailAddress);
  if (!cleanEmail) throw new Error("missing_gmail_email_address");

  const { data, error } = await supabase
    .from("google_connections")
    .select(
      `
      company_id,
      google_account_email,
      gmail_watch_history_id,
      gmail_watch_active,
      gmail_watch_expiration
    `
    )
    .ilike("google_account_email", cleanEmail.replace(/[\\%_]/g, "\\$&"))
    .eq("gmail_ingestion_enabled", true)
    .limit(2)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data?.company_id) {
    throw new Error(`google_connection_not_found_for_pubsub_email:${cleanEmail}`);
  }

  return data;
}

async function updateHistoryId(companyId: string, historyId?: string | null) {
  if (!historyId) return;

  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_history_id: historyId,
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);

  if (error) console.error("FAILED_TO_UPDATE_GMAIL_HISTORY_ID:", error.message);
}

async function markReconnectRequired(companyId: string, message: string) {
  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: false,
      access_token: null,
      token_type: "RECONNECT_REQUIRED",
      scope: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);

  if (error) console.error("GOOGLE_RECONNECT_MARK_FAILED:", error.message);
}

type InboundEmailRecord = {
  id: string;
  lead_id: string | null;
  processed: boolean | null;
  created_at: string | null;
};

function isPostgresUniqueViolation(error: any) {
  const code = String(error?.code ?? "").trim();
  const message = String(error?.message ?? "").toLowerCase();

  return (
    code === "23505" ||
    message.includes("duplicate key") ||
    message.includes("unique constraint")
  );
}

async function findInboundEmail(
  companyId: string,
  messageId: string
): Promise<InboundEmailRecord | null> {
  const { data, error } = await supabase
    .from("inbound_emails")
    .select("id, lead_id, processed, created_at")
    .eq("company_id", companyId)
    .eq("provider_event_id", messageId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data) return data as InboundEmailRecord;

  // Older Gmail ledger rows may have only provider_email_id populated.
  // Recover that SAME-COMPANY identity; never reuse another tenant's row,
  // replace an existing event identity, or mistake an internal handoff for
  // the original Gmail delivery.
  const { data: legacy, error: legacyError } = await supabase
    .from("inbound_emails")
    .select("id, lead_id, processed, created_at, provider, provider_event_id")
    .eq("company_id", companyId)
    .eq("provider_email_id", messageId)
    .maybeSingle();

  if (legacyError) throw new Error(legacyError.message);
  if (!legacy) return null;

  if (legacy.provider !== "gmail" && legacy.provider !== "gmail_pubsub") {
    throw new Error("inbound_email_provider_identity_conflict");
  }

  if (legacy.provider_event_id !== null && legacy.provider_event_id !== "") {
    // A concurrent repair may already have assigned the exact identity.
    if (legacy.provider_event_id === messageId) {
      return legacy as InboundEmailRecord;
    }
    throw new Error("inbound_email_provider_event_identity_conflict");
  }

  // Compare-and-set only the missing event ID. Preserve the row, lead owner,
  // processed flag, timestamps, message content, and provider email ID.
  let repair = supabase
    .from("inbound_emails")
    .update({ provider_event_id: messageId })
    .eq("id", legacy.id)
    .eq("company_id", companyId)
    .eq("provider", legacy.provider)
    .eq("provider_email_id", messageId);

  repair = legacy.provider_event_id === null
    ? repair.is("provider_event_id", null)
    : repair.eq("provider_event_id", "");

  const { data: repaired, error: repairError } = await repair
    .select("id, lead_id, processed, created_at")
    .maybeSingle();

  if (repairError && !isPostgresUniqueViolation(repairError)) {
    throw new Error(repairError.message);
  }
  if (repaired) return repaired as InboundEmailRecord;

  // Another request may have repaired or inserted the canonical event first.
  // Read its current ownership rather than granting a second routing claim.
  const { data: raced, error: racedError } = await supabase
    .from("inbound_emails")
    .select("id, lead_id, processed, created_at")
    .eq("company_id", companyId)
    .eq("provider_event_id", messageId)
    .maybeSingle();

  if (racedError) throw new Error(racedError.message);
  if (raced) return raced as InboundEmailRecord;
  if (repairError) throw new Error(repairError.message);
  throw new Error("inbound_email_legacy_identity_repair_raced_without_row");
}

async function readLeadForGmailOwnership(params: {
  companyId: string;
  leadId: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select("id, status, reply, sent_at, appointment_time, calendar_event_id")
    .eq("id", params.leadId)
    .eq("company_id", params.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function waitForInboundEmailLead(params: {
  companyId: string;
  gmailMessageId: string;
  attempts?: number;
  delayMs?: number;
}) {
  const attempts = params.attempts ?? 20;
  const delayMs = params.delayMs ?? 250;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = await findInboundEmail(
      params.companyId,
      params.gmailMessageId
    );

    if (current?.lead_id) return current;

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return null;
}

async function attachInboundEmailToLead(params: {
  companyId: string;
  inboundEmailId: string;
  gmailMessageId: string;
  leadId: string;
  processed: boolean;
}) {
  const current = await findInboundEmail(
    params.companyId,
    params.gmailMessageId
  );

  if (!current) {
    throw new Error("inbound_email_reservation_missing");
  }

  if (current.id !== params.inboundEmailId) {
    throw new Error("inbound_email_reservation_identity_mismatch");
  }

  if (current.lead_id && current.lead_id !== params.leadId) {
    return {
      inboundEmail: current,
      canonicalLeadId: current.lead_id,
      ownershipConflict: true,
    };
  }

  const { data, error } = await supabase
    .from("inbound_emails")
    .update({
      lead_id: params.leadId,
      processed: params.processed,
    })
    .eq("id", params.inboundEmailId)
    .eq("company_id", params.companyId)
    .eq("provider_event_id", params.gmailMessageId)
    .is("lead_id", null)
    .select("id, lead_id, processed, created_at")
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (data?.lead_id) {
    return {
      inboundEmail: data as InboundEmailRecord,
      canonicalLeadId: data.lead_id,
      ownershipConflict: data.lead_id !== params.leadId,
    };
  }

  const raced = await findInboundEmail(
    params.companyId,
    params.gmailMessageId
  );

  if (!raced?.lead_id) {
    throw new Error("inbound_email_lead_link_failed");
  }

  return {
    inboundEmail: raced,
    canonicalLeadId: raced.lead_id,
    ownershipConflict: raced.lead_id !== params.leadId,
  };
}

async function fetchMessageById(gmail: any, messageId: string) {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  return msg.data;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHistoryCursorFailure(error: any) {
  const status = Number(error?.code ?? error?.response?.status ?? 0);
  const message = String(
    error?.response?.data?.error?.message ??
      error?.response?.data?.error_description ??
      error?.message ??
      error ??
      ""
  ).toLowerCase();

  return (
    status === 404 ||
    message.includes("start history id") ||
    message.includes("historyid") ||
    message.includes("history id") ||
    message.includes("too old") ||
    message.includes("not found")
  );
}

function normalizeHistoryId(value?: string | number | null) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function compareHistoryIds(
  left?: string | number | null,
  right?: string | number | null
) {
  const a = normalizeHistoryId(left);
  const b = normalizeHistoryId(right);

  if (!a || !b) return null;

  try {
    const aBig = BigInt(a);
    const bBig = BigInt(b);

    if (aBig < bBig) return -1;
    if (aBig > bBig) return 1;
    return 0;
  } catch {
    return null;
  }
}

function isStaleOrDuplicatePubSubHistory(params: {
  incomingHistoryId?: string | null;
  storedHistoryId?: string | null;
}) {
  const comparison = compareHistoryIds(
    params.incomingHistoryId,
    params.storedHistoryId
  );

  return comparison !== null && comparison <= 0;
}

async function listHistoryMessageIds(params: {
  gmail: any;
  startHistoryId: string;
}) {
  const messageIds = new Set<string>();
  let latestHistoryId: string | null = null;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const history = await params.gmail.users.history.list({
      userId: "me",
      startHistoryId: params.startHistoryId,
      historyTypes: ["messageAdded"],
      pageToken,
      maxResults: 500,
    });

    pages += 1;
    latestHistoryId = history.data.historyId ?? latestHistoryId;

    for (const item of history.data.history ?? []) {
      for (const added of item.messagesAdded ?? []) {
        if (added.message?.id) {
          messageIds.add(added.message.id);
        }
      }
    }

    pageToken = history.data.nextPageToken ?? undefined;
  } while (pageToken && pages < 100);

  if (pageToken) {
    throw new Error("gmail_history_pagination_limit_exceeded");
  }

  return {
    messageIds,
    latestHistoryId,
    pages,
  };
}

async function listRecoveryMessageIds(gmail: any) {
  const messageIds = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const recent = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox newer_than:7d",
      maxResults: 500,
      pageToken,
    });

    pages += 1;

    for (const item of recent.data.messages ?? []) {
      if (item.id) {
        messageIds.add(item.id);
      }
    }

    pageToken = recent.data.nextPageToken ?? undefined;
  } while (pageToken && pages < 20);

  if (pageToken) {
    throw new Error("gmail_recovery_pagination_limit_exceeded");
  }

  return {
    messageIds,
    pages,
  };
}

async function fetchMessagesInBatches(gmail: any, messageIds: string[]) {
  const messages: any[] = [];
  const batchSize = 10;

  for (let index = 0; index < messageIds.length; index += batchSize) {
    const batch = messageIds.slice(index, index + batchSize);

    const fetched = await Promise.all(
      batch.map(async (messageId) => {
        try {
          return await fetchMessageById(gmail, messageId);
        } catch (error: any) {
          const status = Number(error?.code ?? error?.response?.status ?? 0);

          if (status === 404) {
            console.warn("[gmail-pubsub] message disappeared before fetch", {
              gmailMessageId: messageId,
            });
            return null;
          }

          throw error;
        }
      })
    );

    messages.push(...fetched.filter(Boolean));
  }

  messages.sort((a: any, b: any) => {
    return Number(a?.internalDate ?? 0) - Number(b?.internalDate ?? 0);
  });

  return messages;
}

async function fetchChangedMessages(params: {
  companyId: string;
  startHistoryId?: string | null;
  forceRecovery?: boolean;
}) {
  const gmail = await getCompanyGmailClient(params.companyId);
  let messageIds = new Set<string>();
  let latestHistoryId: string | null = null;
  let usedFallback = Boolean(params.forceRecovery);
  let historyPages = 0;
  let recoveryPages = 0;
  let historyFailure: string | null = null;

  if (!params.forceRecovery && params.startHistoryId) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const historyResult = await listHistoryMessageIds({
          gmail,
          startHistoryId: params.startHistoryId,
        });

        messageIds = historyResult.messageIds;
        latestHistoryId = historyResult.latestHistoryId;
        historyPages = historyResult.pages;

        if (messageIds.size > 0 || attempt === 3) {
          break;
        }

        await sleep(750 * attempt);
      } catch (error: any) {
        const message = error?.message ?? String(error);

        if (isGoogleAuthFailure(message)) {
          throw new Error(`google_reconnect_required_${message}`);
        }

        historyFailure = message;

        if (!isHistoryCursorFailure(error)) {
          throw error;
        }

        usedFallback = true;
        break;
      }
    }
  } else {
    usedFallback = true;
  }

  /*
   * IMPORTANT:
   * An empty Gmail history page is a valid result. It is NOT a reason to scan
   * the last seven days of the inbox.
   *
   * Full inbox recovery is reserved for:
   *   1) no usable stored history cursor, or
   *   2) Gmail rejecting the stored cursor as stale/invalid.
   *
   * This prevents ordinary Pub/Sub deliveries and maintenance runs from
   * repeatedly re-reading and re-classifying old inbox mail.
   */
  if (usedFallback) {
    usedFallback = true;

    const recovery = await listRecoveryMessageIds(gmail);
    recoveryPages = recovery.pages;

    for (const messageId of recovery.messageIds) {
      messageIds.add(messageId);
    }
  }

  const messages = await fetchMessagesInBatches(gmail, Array.from(messageIds));

  return {
    gmail,
    messages,
    latestHistoryId,
    usedFallback,
    historyPages,
    recoveryPages,
    historyFailure,
  };
}

async function insertInboundEmailRecord(params: {
  companyId: string;
  leadId?: string | null;
  gmailMessageId: string;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  textBody: string;
  processed?: boolean;
}) {
  const insertPayload = {
    company_id: params.companyId,
    lead_id: params.leadId ?? null,
    provider: "gmail_pubsub",
    provider_event_id: params.gmailMessageId,
    provider_email_id: params.gmailMessageId,
    from_email: params.fromEmail,
    to_email: params.toEmail ?? null,
    subject: params.subject ?? null,
    text_body: params.textBody,
    html_body: null,
    processed: params.processed ?? false,
  };

  const attemptInsert = async () => {
    return supabase
      .from("inbound_emails")
      .insert(insertPayload)
      .select("id, lead_id, processed, created_at")
      .maybeSingle();
  };

  let inserted = await attemptInsert();
  let existing: InboundEmailRecord | null = null;

  // A concurrent owner can release its reservation between our unique
  // conflict and lookup. Retry the UNIQUE insert only when no row exists;
  // existing reservations keep the original ownership/coalescing behavior.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!inserted.error && inserted.data) {
      return {
        inserted: true,
        inboundEmail: inserted.data as InboundEmailRecord,
        canonicalLeadId: inserted.data.lead_id ?? null,
        ownershipConflict: false,
      };
    }

    if (!isPostgresUniqueViolation(inserted.error)) {
      throw new Error(
        inserted.error?.message ?? "inbound_email_insert_failed"
      );
    }

    existing = await findInboundEmail(
      params.companyId,
      params.gmailMessageId
    );
    if (existing) break;

    if (attempt < 2) {
      await sleep(100 * (attempt + 1));
      inserted = await attemptInsert();
    }
  }

  if (!existing) {
    // Keep failures retryable. Do not ACK an unresolved unique conflict as a
    // duplicate: a global/incorrect constraint or RLS can hide the real owner.
    console.error("[gmail-pubsub] unresolved inbound email unique conflict", {
      companyId: params.companyId,
      gmailMessageId: params.gmailMessageId,
      code: inserted.error?.code ?? null,
      message: inserted.error?.message ?? null,
      details: inserted.error?.details ?? null,
      hint: inserted.error?.hint ?? null,
    });
    throw new Error("inbound_email_unique_conflict_without_row");
  }

  /*
   * A row with no lead_id is an in-progress reservation owned by another
   * webhook request. Never create a second lead while that reservation exists.
   * If it is abandoned for more than five minutes, remove it conditionally and
   * retry the unique insert so exactly one request can reclaim ownership.
   */
  if (!existing.lead_id && existing.created_at) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    const staleAfterMs = 5 * 60 * 1000;

    if (Number.isFinite(ageMs) && ageMs >= staleAfterMs) {
      const { error: deleteError } = await supabase
        .from("inbound_emails")
        .delete()
        .eq("id", existing.id)
        .eq("company_id", params.companyId)
        .eq("provider_event_id", params.gmailMessageId)
        .is("lead_id", null)
        .eq("processed", false);

      if (deleteError) throw new Error(deleteError.message);

      inserted = await attemptInsert();

      if (!inserted.error && inserted.data) {
        return {
          inserted: true,
          inboundEmail: inserted.data as InboundEmailRecord,
          canonicalLeadId: inserted.data.lead_id ?? null,
          ownershipConflict: false,
        };
      }

      if (!isPostgresUniqueViolation(inserted.error)) {
        throw new Error(
          inserted.error?.message ?? "inbound_email_reclaim_failed"
        );
      }

      existing = await findInboundEmail(
        params.companyId,
        params.gmailMessageId
      );

      if (!existing) {
        throw new Error("inbound_email_reclaim_conflict_without_row");
      }
    }
  }

  if (params.leadId && !existing.lead_id) {
    const linked = await attachInboundEmailToLead({
      companyId: params.companyId,
      inboundEmailId: existing.id,
      gmailMessageId: params.gmailMessageId,
      leadId: params.leadId,
      processed: params.processed ?? false,
    });

    return {
      inserted: false,
      inboundEmail: linked.inboundEmail,
      canonicalLeadId: linked.canonicalLeadId,
      ownershipConflict: linked.ownershipConflict,
    };
  }

  return {
    inserted: false,
    inboundEmail: existing,
    canonicalLeadId: existing.lead_id ?? null,
    ownershipConflict: Boolean(
      params.leadId &&
        existing.lead_id &&
        existing.lead_id !== params.leadId
    ),
  };
}


type InboundRoutingClaim =
  | {
      owned: true;
      inboundEmail: InboundEmailRecord;
    }
  | {
      owned: false;
      inboundEmail: InboundEmailRecord;
      reason:
        | "inbound_email_already_processed"
        | "inbound_email_already_owned_by_lead";
    };

async function claimInboundRoutingOwnership(params: {
  companyId: string;
  gmailMessageId: string;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  textBody: string;
}): Promise<InboundRoutingClaim> {
  const claim = await insertInboundEmailRecord({
    companyId: params.companyId,
    leadId: null,
    gmailMessageId: params.gmailMessageId,
    fromEmail: params.fromEmail,
    toEmail: params.toEmail,
    subject: params.subject,
    textBody: params.textBody,
    processed: false,
  });

  if (claim.inserted) {
    return {
      owned: true,
      inboundEmail: claim.inboundEmail,
    };
  }

  const existing = claim.inboundEmail;

  if (existing?.processed) {
    return {
      owned: false,
      inboundEmail: existing,
      reason: "inbound_email_already_processed",
    };
  }

  if (existing?.lead_id) {
    return {
      owned: false,
      inboundEmail: existing,
      reason: "inbound_email_already_owned_by_lead",
    };
  }

  /*
   * A fresh unprocessed reservation with no lead belongs to another concurrent
   * webhook invocation. Do not immediately turn healthy duplicate concurrency
   * into a webhook 500. Briefly coalesce with the routing owner and observe the
   * authoritative inbound_emails row until that owner durably attaches a Lead
   * or marks routing complete.
   *
   * We still MUST NOT ACK an unresolved reservation indefinitely: another
   * delivery ACK could suppress Pub/Sub retry if the actual owner crashes.
   * Therefore a genuinely unresolved owner still throws after the bounded wait,
   * preserving at-least-once recovery and the existing five-minute stale-claim
   * reclamation contract.
   */
  const coalesceDeadline = Date.now() + 8000;

  while (Date.now() < coalesceDeadline) {
    await sleep(150);

    const current = await findInboundEmail(
      params.companyId,
      params.gmailMessageId
    );

    if (!current) {
      break;
    }

    if (current.processed) {
      return {
        owned: false,
        inboundEmail: current,
        reason: "inbound_email_already_processed",
      };
    }

    if (current.lead_id) {
      return {
        owned: false,
        inboundEmail: current,
        reason: "inbound_email_already_owned_by_lead",
      };
    }
  }

  throw new Error("inbound_email_routing_in_progress");
}

async function markInboundRoutingCompleteWithoutLead(params: {
  companyId: string;
  gmailMessageId: string;
  inboundEmailId: string;
}) {
  const { data, error } = await supabase
    .from("inbound_emails")
    .update({ processed: true })
    .eq("id", params.inboundEmailId)
    .eq("company_id", params.companyId)
    .eq("provider_event_id", params.gmailMessageId)
    .is("lead_id", null)
    .eq("processed", false)
    .select("id, lead_id, processed, created_at")
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data?.id) {
    const current = await findInboundEmail(
      params.companyId,
      params.gmailMessageId
    );

    if (current?.processed && !current.lead_id) {
      return current;
    }

    throw new Error("inbound_email_routing_finalize_failed");
  }

  return data as InboundEmailRecord;
}

const RECENT_NO_LEAD_REPLAY_WINDOW_MS = 90 * 1000;

function normalizeRecentInboundReplayBody(value?: string | null) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function findRecentProcessedNoLeadReplay(params: {
  companyId: string;
  gmailMessageId: string;
  fromEmail: string;
  textBody: string;
}) {
  const normalizedBody = normalizeRecentInboundReplayBody(params.textBody);
  if (!normalizedBody) return null;

  const createdAfter = new Date(
    Date.now() - RECENT_NO_LEAD_REPLAY_WINDOW_MS
  ).toISOString();

  const { data, error } = await supabase
    .from("inbound_emails")
    .select(
      "id, provider_event_id, from_email, text_body, processed, lead_id, created_at"
    )
    .eq("company_id", params.companyId)
    .eq("provider", "gmail_pubsub")
    .eq("from_email", params.fromEmail)
    .eq("processed", true)
    .is("lead_id", null)
    .gte("created_at", createdAfter)
    .neq("provider_event_id", params.gmailMessageId)
    .order("created_at", { ascending: false })
    .limit(12);

  if (error) throw new Error(error.message);

  for (const candidate of data ?? []) {
    if (
      normalizeRecentInboundReplayBody(candidate?.text_body) === normalizedBody
    ) {
      return candidate;
    }
  }

  return null;
}

async function enqueueProcessNewLead(params: {
  companyId: string;
  leadId: string;
}) {
  return enqueueBackgroundJob({
    name: "process_new_lead",
    jobId: `process_new_lead:${params.companyId}:${params.leadId}`,
    data: {
      companyId: params.companyId,
      leadId: params.leadId,
    },
  });
}

async function enqueueProcessInboundEmail(params: {
  companyId: string;
  leadId?: string | null;
  gmailMessageId: string;
  gmailThreadId?: string | null;
  providerThreadId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  cleanTextBody: string;
  rawTextBody: string;
  preReservedInboundEmail?: InboundEmailRecord | null;
}) {
  const inserted = params.preReservedInboundEmail
    ? params.leadId && !params.preReservedInboundEmail.lead_id
      ? await (async () => {
          const linked = await attachInboundEmailToLead({
            companyId: params.companyId,
            inboundEmailId: params.preReservedInboundEmail!.id,
            gmailMessageId: params.gmailMessageId,
            leadId: params.leadId!,
            processed: false,
          });

          return {
            inserted: true,
            inboundEmail: linked.inboundEmail,
            canonicalLeadId: linked.canonicalLeadId,
            ownershipConflict: linked.ownershipConflict,
          };
        })()
      : {
          inserted: true,
          inboundEmail: params.preReservedInboundEmail,
          canonicalLeadId: params.preReservedInboundEmail.lead_id ?? null,
          ownershipConflict: Boolean(
            params.leadId &&
              params.preReservedInboundEmail.lead_id &&
              params.preReservedInboundEmail.lead_id !== params.leadId
          ),
        }
    : await insertInboundEmailRecord({
        companyId: params.companyId,
        leadId: params.leadId ?? null,
        gmailMessageId: params.gmailMessageId,
        fromEmail: params.fromEmail,
        toEmail: params.toEmail,
        subject: params.subject,
        textBody: params.cleanTextBody,
        processed: false,
      });

  const alreadyProcessed = Boolean(
    !inserted.inserted && inserted.inboundEmail?.processed
  );

  if (inserted.ownershipConflict) {
    console.warn("[gmail-pubsub] booking reply kept canonical lead ownership", {
      companyId: params.companyId,
      gmailMessageId: params.gmailMessageId,
      requestedLeadId: params.leadId ?? null,
      canonicalLeadId: inserted.canonicalLeadId ?? null,
    });
  }

  if (alreadyProcessed) {
    return {
      queued: false,
      duplicate: true,
      reason: "inbound_email_already_processed",
      inboundEmailId: inserted.inboundEmail?.id ?? null,
      canonicalLeadId: inserted.canonicalLeadId ?? null,
    };
  }

  const jobId = `gmail_pubsub_reply:${params.companyId}:${params.gmailMessageId}`;

  const job = await enqueueBackgroundJob({
    name: "process_inbound_email",
    jobId,
    data: {
      companyId: params.companyId,
      provider: "gmail_pubsub",
      providerEventId: params.gmailMessageId,
      providerThreadId: params.providerThreadId ?? params.gmailThreadId ?? null,
      providerEmailId: params.gmailMessageId,
      fromEmail: params.fromEmail,
      toEmail: params.toEmail ?? null,
      subject: params.subject ?? null,
      textBody: params.cleanTextBody || params.rawTextBody,
      htmlBody: null,
    },
    priority: 10,
  });

  return {
    queued: true,
    duplicate: !inserted.inserted,
    jobId: job.id ?? jobId,
    inboundEmailId: inserted.inboundEmail?.id ?? null,
    canonicalLeadId: inserted.canonicalLeadId ?? params.leadId ?? null,
  };
}

function shouldRequeueExistingLead(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();

  return (
    !normalized ||
    normalized === "new" ||
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "processing"
  );
}

async function findDuplicateLeadByCustomerIdentity(params: {
  companyId: string;
  metadata: LeadMetadataForDedupe;
}) {
  const targetPhone = normalizePhoneDigits(params.metadata.phone);
  const targetAddress = normalizeComparableAddress(params.metadata.address);
  const targetName = normalizeComparableText(params.metadata.customerName);
  const targetZip = normalizeComparableText(params.metadata.zip);

  if (!targetPhone && !targetAddress) return null;

  const { data, error } = await supabase
    .from("leads")
    .select(
      `
      id,
      status,
      reply,
      sent_at,
      appointment_time,
      calendar_event_id,
      phone,
      email,
      customer_name,
      address,
      zip,
      created_at
    `
    )
    .eq("company_id", params.companyId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw new Error(error.message);

  const leads = Array.isArray(data) ? data : [];

  for (const lead of leads) {
    const leadPhone = normalizePhoneDigits((lead as any).phone);
    const leadAddress = normalizeComparableAddress((lead as any).address);
    const leadName = normalizeComparableText((lead as any).customer_name);
    const leadZip = normalizeComparableText((lead as any).zip);

    const samePhone = Boolean(targetPhone && leadPhone && targetPhone === leadPhone);
    const sameAddress = Boolean(
      targetAddress && leadAddress && targetAddress === leadAddress
    );
    const sameName = Boolean(targetName && leadName && targetName === leadName);
    const sameZip = Boolean(targetZip && leadZip && targetZip === leadZip);

    if (samePhone) return lead;
    if (sameAddress && sameName) return lead;
    if (sameAddress && sameZip) return lead;
  }

  return null;
}

async function createLeadFromGmail(params: {
  companyId: string;
  gmailMessageId: string;
  gmailThreadId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  textBody: string;
  preReservedInboundEmail?: InboundEmailRecord | null;
}) {
  /*
   * Normally this function reserves the Gmail message itself. When the webhook
   * already claimed cross-lane routing ownership, reuse that exact reservation
   * instead of attempting a second insert.
   */
  const reservation = params.preReservedInboundEmail
    ? {
        inserted: true,
        inboundEmail: params.preReservedInboundEmail,
        canonicalLeadId: params.preReservedInboundEmail.lead_id ?? null,
        ownershipConflict: false,
      }
    : await insertInboundEmailRecord({
        companyId: params.companyId,
        leadId: null,
        gmailMessageId: params.gmailMessageId,
        fromEmail: params.fromEmail,
        toEmail: params.toEmail,
        subject: params.subject,
        textBody: params.textBody,
        processed: false,
      });

  if (!reservation.inserted) {
    let canonicalInbound: InboundEmailRecord | null = reservation.inboundEmail;

    if (!canonicalInbound?.lead_id) {
      canonicalInbound = await waitForInboundEmailLead({
        companyId: params.companyId,
        gmailMessageId: params.gmailMessageId,
      });
    }

    if (!canonicalInbound?.lead_id) {
      /*
       * Another request owns a fresh reservation but has not linked its lead
       * yet. Failing this delivery causes Pub/Sub to retry; creating a second
       * lead here would recreate the exact check-then-insert race.
       */
      throw new Error("inbound_email_processing_in_progress");
    }

    const existingLead = await readLeadForGmailOwnership({
      companyId: params.companyId,
      leadId: canonicalInbound.lead_id,
    });

    if (!existingLead?.id) {
      throw new Error("inbound_email_points_to_missing_lead");
    }

    return {
      lead: existingLead,
      duplicateLead: true,
      shouldRequeue: false,
    };
  }

  const reservationId = reservation.inboundEmail.id;

  const rawQualification = await extractLeadData(params.textBody);
  const qualification = rawQualification as FlexibleQualification;

  const extractedMetadata = extractLeadMetadataFromText(
    params.textBody,
    params.fromEmail
  );

  const leadMetadata = mergeLeadMetadata({
    qualification,
    metadata: extractedMetadata,
    fallbackEmail: params.fromEmail,
  });

  /*
   * Recover safely if historical data already contains the lead row but the
   * inbound-email ownership row was missing. The reservation is linked to the
   * already-existing lead instead of creating another one.
   */
  const existingLeadByMessage = await supabase
    .from("leads")
    .select("id, status, reply, sent_at, appointment_time, calendar_event_id")
    .eq("company_id", params.companyId)
    .eq("inbound_email_id", params.gmailMessageId)
    .maybeSingle();

  if (existingLeadByMessage.error) {
    throw new Error(existingLeadByMessage.error.message);
  }

  if (existingLeadByMessage.data?.id) {
    const linked = await attachInboundEmailToLead({
      companyId: params.companyId,
      inboundEmailId: reservationId,
      gmailMessageId: params.gmailMessageId,
      leadId: existingLeadByMessage.data.id,
      processed: true,
    });

    const canonicalLead =
      linked.canonicalLeadId === existingLeadByMessage.data.id
        ? existingLeadByMessage.data
        : await readLeadForGmailOwnership({
            companyId: params.companyId,
            leadId: linked.canonicalLeadId,
          });

    if (!canonicalLead?.id) {
      throw new Error("canonical_gmail_lead_missing");
    }

    return {
      lead: canonicalLead,
      duplicateLead: true,
      shouldRequeue: false,
    };
  }

  const duplicateLead = await findDuplicateLeadByCustomerIdentity({
    companyId: params.companyId,
    metadata: leadMetadata,
  });

  if (duplicateLead?.id) {
    const linked = await attachInboundEmailToLead({
      companyId: params.companyId,
      inboundEmailId: reservationId,
      gmailMessageId: params.gmailMessageId,
      leadId: duplicateLead.id,
      processed: true,
    });

    const canonicalLead =
      linked.canonicalLeadId === duplicateLead.id
        ? duplicateLead
        : await readLeadForGmailOwnership({
            companyId: params.companyId,
            leadId: linked.canonicalLeadId,
          });

    if (!canonicalLead?.id) {
      throw new Error("canonical_duplicate_lead_missing");
    }

    console.warn("[gmail-pubsub] duplicate lead blocked by customer identity", {
      companyId: params.companyId,
      existingLeadId: canonicalLead.id,
      gmailMessageId: params.gmailMessageId,
      phone: leadMetadata.phone,
      customerName: leadMetadata.customerName,
      address: leadMetadata.address,
      zip: leadMetadata.zip,
    });

    return {
      lead: canonicalLead,
      duplicateLead: true,
      shouldRequeue: false,
    };
  }

  const leadInsertPayload = {
    company_id: params.companyId,
    input: params.textBody,
    message: params.textBody,
    status: "new",
    priority:
      qualification.urgency === "emergency" ||
      qualification.urgency === "high"
        ? "high"
        : "normal",
    type: qualification.serviceType ?? "hvac",
    email: leadMetadata.email,
    phone: leadMetadata.phone,
    customer_name: leadMetadata.customerName,
    preferred_time: qualification.preferredTime ?? null,
    issue_summary: qualification.issueSummary ?? null,
    address: leadMetadata.address,
    city: leadMetadata.city,
    state: leadMetadata.state,
    zip: leadMetadata.zip,
    source: "gmail",
    inbound_email_id: params.gmailMessageId,
    inbound_thread_id: params.gmailThreadId ?? null,
    qualification: {
      ...qualification,
      customerName: leadMetadata.customerName,
      email: leadMetadata.email,
      phone: leadMetadata.phone,
      address: leadMetadata.address,
      city: leadMetadata.city,
      state: leadMetadata.state,
      zip: leadMetadata.zip,
      serviceArea: leadMetadata.serviceArea,
    },
  };

  const insertedLead = await supabase
    .from("leads")
    .insert(leadInsertPayload)
    .select("id, status, reply, sent_at, appointment_time, calendar_event_id")
    .maybeSingle();

  let lead = insertedLead.data;
  let duplicateLeadFromConflict = false;

  if (insertedLead.error || !lead?.id) {
    if (!isPostgresUniqueViolation(insertedLead.error)) {
      throw new Error(
        insertedLead.error?.message ?? "gmail_lead_insert_failed"
      );
    }

    const recovered = await supabase
      .from("leads")
      .select("id, status, reply, sent_at, appointment_time, calendar_event_id")
      .eq("company_id", params.companyId)
      .eq("inbound_email_id", params.gmailMessageId)
      .maybeSingle();

    if (recovered.error) throw new Error(recovered.error.message);
    if (!recovered.data?.id) {
      throw new Error("gmail_lead_unique_conflict_without_row");
    }

    lead = recovered.data;
    duplicateLeadFromConflict = true;
  }

  const linked = await attachInboundEmailToLead({
    companyId: params.companyId,
    inboundEmailId: reservationId,
    gmailMessageId: params.gmailMessageId,
    leadId: lead.id,
    processed: true,
  });

  if (linked.canonicalLeadId !== lead.id) {
    /*
     * This can only occur with pre-existing inconsistent data or an external
     * writer that bypasses this ownership protocol. The inbound_emails row is
     * authoritative. Never enqueue work for the non-canonical lead.
     */
    const canonicalLead = await readLeadForGmailOwnership({
      companyId: params.companyId,
      leadId: linked.canonicalLeadId,
    });

    if (!canonicalLead?.id) {
      throw new Error("inbound_email_ownership_conflict_missing_canonical_lead");
    }

    console.error("[gmail-pubsub] prevented conflicting Gmail lead ownership", {
      companyId: params.companyId,
      gmailMessageId: params.gmailMessageId,
      attemptedLeadId: lead.id,
      canonicalLeadId: canonicalLead.id,
    });

    return {
      lead: canonicalLead,
      duplicateLead: true,
      shouldRequeue: false,
    };
  }

  console.log("[gmail-pubsub] created lead with metadata", {
    companyId: params.companyId,
    leadId: lead.id,
    email: leadMetadata.email,
    phone: leadMetadata.phone,
    customerName: leadMetadata.customerName,
    address: leadMetadata.address,
    city: leadMetadata.city,
    state: leadMetadata.state,
    zip: leadMetadata.zip,
    serviceArea: leadMetadata.serviceArea,
  });

  return {
    lead,
    duplicateLead: duplicateLeadFromConflict,
    shouldRequeue: !duplicateLeadFromConflict,
  };
}

export async function enqueueGmailPubSubWebhook(body: any) {
  const message = body?.message;
  if (!message?.data) return { success: true, received: false, skipped: true, reason: "missing_pubsub_message_data" };
  const event = decodePubSubData(message.data);
  const connection = await findConnectionByEmail(event.emailAddress);
  const eventKey = String(event.recoveryMode === true
    ? (message.messageId ?? "") : (event.historyId ?? message.messageId ?? "")).trim();
  if (!eventKey) throw new Error("missing_gmail_notification_id");
  const job = await enqueueBackgroundJob({ name: "sync_gmail_mailbox",
    jobId: `sync_gmail_mailbox:${connection.company_id}:${eventKey}`,
    data: { companyId: connection.company_id, body }, priority: 50 });
  return { success: true, received: true, queued: true, companyId: connection.company_id, jobId: job.id };
}

export async function processGmailPubSubWebhook(
  body: any,
  routing?: { companyId: string; messageId: string }
) {
  let companyIdForFailure: string | null = null;

  try {
    const pubsubMessage = body?.message;

    if (!pubsubMessage?.data) {
      return {
        success: true,
        received: false,
        skipped: true,
        reason: "missing_pubsub_message_data",
      };
    }

    const gmailEvent = decodePubSubData(pubsubMessage.data);
    const connection = await findConnectionByEmail(gmailEvent.emailAddress);

    companyIdForFailure = connection.company_id;

    if (routing && (routing.companyId !== connection.company_id || !routing.messageId)) {
      throw new Error("gmail_routing_company_scope_mismatch");
    }

    const connectedEmail = normalizeEmail(connection.google_account_email);

    const storedHistoryId =
      connection.gmail_watch_history_id != null
        ? String(connection.gmail_watch_history_id).trim() || null
        : null;

    const incomingHistoryId = normalizeHistoryId(gmailEvent.historyId ?? null);

    /*
     * Gmail Pub/Sub is at-least-once delivery. The same notification can be
     * delivered again, and older notifications can arrive after newer ones.
     *
     * If this is a real Pub/Sub notification (not our synthetic recovery call)
     * and its historyId is not newer than the cursor already stored for this
     * mailbox, there is nothing left to process. ACK it immediately.
     *
     * This fast-path is deliberately BEFORE getCompanyGmailClient/history.list,
     * so stale redeliveries cannot trigger old-mail scans or classifier spam.
     */
    if (
      !routing &&
      gmailEvent.recoveryMode !== true &&
      isStaleOrDuplicatePubSubHistory({
        incomingHistoryId,
        storedHistoryId,
      })
    ) {
      console.log("[gmail-pubsub] stale or duplicate notification skipped", {
        companyId: connection.company_id,
        emailAddress: connectedEmail,
        pubsubMessageId: pubsubMessage?.messageId ?? null,
        incomingHistoryId,
        storedHistoryId,
        reason: "stale_or_duplicate_pubsub_notification",
      });

      return {
        success: true,
        received: true,
        skipped: true,
        companyId: connection.company_id,
        emailAddress: connectedEmail,
        reason: "stale_or_duplicate_pubsub_notification",
        incomingHistoryId,
        storedHistoryId,
        queuedMessages: 0,
        inspectedMessages: 0,
        usedFallback: false,
        watchRenewed: false,
        historyPages: 0,
        recoveryPages: 0,
        historyFailure: null,
        results: [],
      };
    }

    const routingGmail = routing ? await getCompanyGmailClient(connection.company_id) : null;
    const fetched = routing
      ? {
          gmail: routingGmail,
          messages: await fetchMessagesInBatches(
            routingGmail, [routing.messageId]
          ),
          latestHistoryId: null,
          usedFallback: false,
          historyPages: 0,
          recoveryPages: 0,
          historyFailure: null,
        }
      : await fetchChangedMessages({
          companyId: connection.company_id,
          startHistoryId: storedHistoryId,
          forceRecovery: !storedHistoryId,
        });

    // Persist every message handoff before advancing the history cursor.
    // Classification runs in separate jobs so replies can claim the company
    // lease between messages, instead of waiting behind an entire inbox scan.
    const routedMessages = routing ? 0 : await enqueueGmailMessageRouting({
      companyId: connection.company_id,
      body,
      messageIds: fetched.messages.map((message: any) => cleanId(message?.id)).filter((id): id is string => id !== null),
    });

    const results: any[] = [];

    for (const message of routing ? fetched.messages : []) {
      const gmailMessageId = cleanId(message?.id);
      const gmailThreadId = cleanId(message?.threadId);
      const realProviderThreadId = resolveRealThreadId({
        gmailMessageId,
        gmailThreadId,
      });
      let ownedRoutingReservationId: string | null = null;

      try {
        if (!gmailMessageId) {
          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId: null,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            decision: "SKIP",
            reason: "missing_gmail_message_id",
          });

          results.push({ queued: false, reason: "missing_gmail_message_id" });
          continue;
        }

        const labelIds: string[] = message?.labelIds ?? [];

        if (!labelIds.includes("INBOX")) {
          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            decision: "SKIP",
            reason: "skipped_non_inbox_message",
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            queued: false,
            reason: "skipped_non_inbox_message",
          });
          continue;
        }

        const headers = message?.payload?.headers ?? [];
        const fromEmail = extractEmailAddress(getHeaderValue(headers, "From"));
        const toEmail = extractEmailAddress(getHeaderValue(headers, "To"));
        const subject = getHeaderValue(headers, "Subject");
        const rawTextBody = normalizeText(decodeMessageBody(message?.payload));
        const cleanTextBody = stripQuotedEmail(rawTextBody);

        if (!fromEmail || !rawTextBody) {
          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "REJECT",
            reason: "missing_from_or_body",
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            queued: false,
            reason: "missing_from_or_body",
          });
          continue;
        }

        if (fromEmail === connectedEmail) {
          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "SKIP",
            reason: "skipped_self_sent_message",
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            fromEmail,
            subject,
            queued: false,
            reason: "skipped_self_sent_message",
          });
          continue;
        }

        // Message direction is independent of the sender's company membership.
        // A connected provider may manually ask another company for service;
        // an automated provider reply must never become that customer's turn.
        const automationReason = getAutomationReason(headers);
        if (automationReason) {
          logInboundDecision({ companyId: connection.company_id, gmailMessageId,
            gmailThreadId, fromEmail, subject, decision: "SKIP", reason: automationReason });
          results.push({ gmailMessageId, gmailThreadId, queued: false, reason: automationReason });
          continue;
        }

        /*
         * CROSS-LANE GMAIL MESSAGE OWNERSHIP.
         *
         * Gmail/PubSub is at-least-once and two webhook invocations can inspect
         * the same Gmail message concurrently. Claim the provider event BEFORE
         * prospect-vs-booking-vs-new-lead routing so one message can have only
         * one routing owner.
         */
        const routingClaim = await claimInboundRoutingOwnership({
          companyId: connection.company_id,
          gmailMessageId,
          fromEmail,
          toEmail,
          subject,
          textBody: cleanTextBody || rawTextBody,
        });

        if (!routingClaim.owned) {
          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "SKIP",
            reason: routingClaim.reason,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            queued: false,
            duplicate: true,
            reason: routingClaim.reason,
            inboundEmailId: routingClaim.inboundEmail.id,
            canonicalLeadId: routingClaim.inboundEmail.lead_id ?? null,
          });

          continue;
        }

        const routingReservation = routingClaim.inboundEmail;
        ownedRoutingReservationId = routingReservation.id;

        const activeBookingConversation =
          await findActiveBookingConversation({
            companyId: connection.company_id,
            fromEmail,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            subject,
          });

        /*
         * PROSPECT THREAD OWNERSHIP FIREWALL.
         *
         * Exact Gmail-thread ownership is stronger than sender fallback.
         * Exact Lead thread -> existing booking.
         * Exact routable prospect thread -> prospect lane.
         * Otherwise -> existing sender-level booking fallback unchanged.
         */
        const currentProviderThreadId =
          realProviderThreadId ?? gmailThreadId ?? gmailMessageId;

        const activeBookingOwnsExactThread = (() => {
          if (!activeBookingConversation) return false;

          const currentThreadId = cleanId(currentProviderThreadId);
          if (!currentThreadId) return false;

          return [
            activeBookingConversation.inbound_thread_id,
            activeBookingConversation.outbound_thread_id,
            activeBookingConversation.inbound_email_id,
            activeBookingConversation.outbound_email_id,
          ].some((value) => cleanId(value) === currentThreadId);
        })();

        if (!activeBookingOwnsExactThread) {
          /*
           * VERY-RECENT NO-LEAD REPLAY COALESCING.
           *
           * Exact provider-id idempotency cannot catch a provider replay that
           * arrives under a different Gmail message/thread id. Only coalesce
           * when an earlier matching inbound was already fully processed with
           * NO Lead owner, from the same company/sender, inside a short replay
           * window. Active booking threads are excluded above, so booking replies
           * keep their existing authoritative ownership semantics.
           */
          const recentNoLeadReplay =
            await findRecentProcessedNoLeadReplay({
              companyId: connection.company_id,
              gmailMessageId,
              fromEmail,
              textBody: cleanTextBody || rawTextBody,
            });

          if (recentNoLeadReplay) {
            await markInboundRoutingCompleteWithoutLead({
              companyId: connection.company_id,
              gmailMessageId,
              inboundEmailId: routingReservation.id,
            });

            console.log(
              "[gmail-pubsub] coalesced very recent duplicate no-lead inbound replay",
              {
                companyId: connection.company_id,
                gmailMessageId,
                gmailThreadId,
                providerThreadId: currentProviderThreadId,
                fromEmail,
                previousProviderEventId:
                  recentNoLeadReplay.provider_event_id ?? null,
                replayWindowMs: RECENT_NO_LEAD_REPLAY_WINDOW_MS,
              }
            );

            logInboundDecision({
              companyId: connection.company_id,
              gmailMessageId,
              gmailThreadId,
              providerThreadId: currentProviderThreadId,
              fromEmail,
              subject,
              preview: cleanTextBody || rawTextBody,
              decision: "SKIP",
              reason: "recent_duplicate_no_lead_replay",
              leadCreated: false,
              leadId: null,
              jobQueued: false,
              jobId: null,
              replyTriggered: false,
            });

            results.push({
              gmailMessageId,
              gmailThreadId,
              providerThreadId: currentProviderThreadId,
              fromEmail,
              subject,
              queued: false,
              duplicate: true,
              reason: "recent_duplicate_no_lead_replay",
              inboundEmailId: routingReservation.id,
              canonicalLeadId: null,
            });

            continue;
          }

          const exactProspectConversation =
            await findExactProspectConversationForThread({
              companyId: connection.company_id,
              providerThreadId: currentProviderThreadId,
              fromEmail,
            });

          if (isRoutableExactProspectConversation(exactProspectConversation)) {
            const exactProspectRoute = await routeProspectInquiryIfApplicable({
              companyId: connection.company_id,
              existingClassification: "noise",
              existingAdmission: null,
              hasActiveBookingConversation: false,
              provider: "gmail_pubsub",
              providerEventId: gmailMessageId,
              providerThreadId: currentProviderThreadId,
              providerEmailId: gmailMessageId,
              fromEmail,
              toEmail,
              subject,
              cleanTextBody,
              rawTextBody,
            });

            if (exactProspectRoute.routed) {
              if (!String(exactProspectRoute.jobId ?? "").trim()) {
                throw new Error("prospect_route_routed_without_queued_job");
              }

              await markInboundRoutingCompleteWithoutLead({
                companyId: connection.company_id,
                gmailMessageId,
                inboundEmailId: routingReservation.id,
              });

              console.log(
                "[gmail-pubsub] exact prospect thread retained before sender booking fallback",
                {
                  companyId: connection.company_id,
                  gmailMessageId,
                  gmailThreadId,
                  providerThreadId: currentProviderThreadId,
                  fromEmail,
                  subject,
                  prospectConversationId: exactProspectRoute.conversationId,
                  prospectReason: exactProspectRoute.reason,
                  ignoredSenderFallbackLeadId:
                    activeBookingConversation?.id ?? null,
                  jobId: exactProspectRoute.jobId,
                }
              );

              results.push({
                gmailMessageId,
                gmailThreadId,
                providerThreadId: currentProviderThreadId,
                fromEmail,
                subject,
                classification: "noise",
                prospectClassification: exactProspectRoute.reason,
                prospectConversationId: exactProspectRoute.conversationId,
                queued: true,
                jobId: exactProspectRoute.jobId,
                cleanTextPreview: cleanTextBody.slice(0, 240),
              });

              continue;
            }
          }
        }

        /*
         * AUTHORITATIVE EXISTING BOOKING OWNERSHIP.
         *
         * An exact provider-thread -> Lead match is identity/state evidence, not a
         * semantic guess. Once that ownership exists, the message belongs to the
         * booking conversation and must reach processInboundEmail. New-mail
         * admission must never veto it. processInboundEmail/resolveBookingCommand
         * still decide WHAT the customer means and whether any mutation is allowed.
         */
        if (activeBookingOwnsExactThread && activeBookingConversation) {
          const queued = await enqueueProcessInboundEmail({
            companyId: connection.company_id,
            leadId: activeBookingConversation.id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            toEmail,
            subject,
            cleanTextBody,
            rawTextBody,
            preReservedInboundEmail: routingReservation,
          });

          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "ACCEPT",
            classification: "customer_booking_reply",
            reason: "authoritative_exact_booking_thread_owner",
            leadCreated: false,
            leadId: queued.canonicalLeadId ?? activeBookingConversation.id,
            jobQueued: Boolean(queued.queued),
            jobId: queued.jobId ?? null,
            replyTriggered: Boolean(queued.queued),
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            classification: "customer_booking_reply",
            conversationOwnership: "exact_booking_thread",
            activeBookingLeadId: activeBookingConversation.id,
            ...queued,
            cleanTextPreview: cleanTextBody.slice(0, 240),
          });

          continue;
        }

        /*
         * AUTHORITATIVE RFC REPLY-CHAIN OWNERSHIP.
         *
         * Gmail threadId is useful but not sufficient identity. A customer can
         * reply to a real LeadFlow message and Gmail can surface that reply under
         * a different threadId. In-Reply-To / References are provider identity
         * evidence and therefore run BEFORE semantic customer admission.
         *
         * This bridge is generic: it does not inspect "option", dates, booking
         * words, or any other customer phrase. Once ownership is proven, the
         * existing booking/prospect pipeline decides meaning exactly as before.
         */
        const replyChainOwnership =
          await resolveReplyChainConversationOwnership({
            gmail: fetched.gmail,
            companyId: connection.company_id,
            fromEmail,
            headers,
          });

        if (replyChainOwnership?.kind === "booking") {
          const queued = await enqueueProcessInboundEmail({
            companyId: connection.company_id,
            leadId: replyChainOwnership.lead.id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            toEmail,
            subject,
            cleanTextBody,
            rawTextBody,
            preReservedInboundEmail: routingReservation,
          });

          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "ACCEPT",
            classification: "customer_booking_reply",
            reason: "authoritative_reply_chain_booking_owner",
            leadCreated: false,
            leadId: queued.canonicalLeadId ?? replyChainOwnership.lead.id,
            jobQueued: Boolean(queued.queued),
            jobId: queued.jobId ?? null,
            replyTriggered: Boolean(queued.queued),
          });

          console.log("[gmail-pubsub] reply-chain booking ownership bridge", {
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            leadId: replyChainOwnership.lead.id,
            ownershipSource: replyChainOwnership.source,
            ancestorRfcMessageId:
              replyChainOwnership.ancestorRfcMessageId,
            ancestorGmailMessageId:
              replyChainOwnership.ancestorGmailMessageId,
            ancestorThreadId:
              replyChainOwnership.ancestorThreadId,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            classification: "customer_booking_reply",
            conversationOwnership: "reply_chain_booking",
            activeBookingLeadId: replyChainOwnership.lead.id,
            ...queued,
            cleanTextPreview: cleanTextBody.slice(0, 240),
          });

          continue;
        }

        if (replyChainOwnership?.kind === "prospect") {
          /*
           * routeProspectInquiryIfApplicable currently resolves continuity by
           * provider_thread_id. Feed it the proven ancestor thread, while the
           * provider event remains the NEW Gmail message id for idempotency.
           */
          const replyChainProspectRoute =
            await routeProspectInquiryIfApplicable({
              companyId: connection.company_id,
              existingClassification: "noise",
              existingAdmission: null,
              hasActiveBookingConversation: false,
              provider: "gmail_pubsub",
              providerEventId: gmailMessageId,
              providerThreadId:
                replyChainOwnership.ancestorThreadId,
              providerEmailId: gmailMessageId,
              fromEmail,
              toEmail,
              subject,
              cleanTextBody,
              rawTextBody,
            });

          if (!replyChainProspectRoute.routed) {
            throw new Error(
              "reply_chain_prospect_owner_failed_to_route"
            );
          }

          if (!String(replyChainProspectRoute.jobId ?? "").trim()) {
            throw new Error(
              "reply_chain_prospect_route_without_queued_job"
            );
          }

          await markInboundRoutingCompleteWithoutLead({
            companyId: connection.company_id,
            gmailMessageId,
            inboundEmailId: routingReservation.id,
          });

          console.log("[gmail-pubsub] reply-chain prospect ownership bridge", {
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            prospectConversationId:
              replyChainOwnership.conversation.id,
            ownershipSource: replyChainOwnership.source,
            ancestorRfcMessageId:
              replyChainOwnership.ancestorRfcMessageId,
            ancestorGmailMessageId:
              replyChainOwnership.ancestorGmailMessageId,
            ancestorThreadId:
              replyChainOwnership.ancestorThreadId,
            jobId: replyChainProspectRoute.jobId,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            classification: "noise",
            prospectClassification:
              replyChainProspectRoute.reason,
            prospectConversationId:
              replyChainOwnership.conversation.id,
            conversationOwnership: "reply_chain_prospect",
            queued: true,
            jobId: replyChainProspectRoute.jobId,
            cleanTextPreview: cleanTextBody.slice(0, 240),
          });

          continue;
        }

        /*
         * Customer admission is a semantic direction-of-intent decision.
         * HVAC words, addresses, phone numbers, "help", "urgent", or a Re: subject
         * are supporting context only; none of them can independently turn vendor,
         * platform, account, compliance, marketing, billing, recruiting, partnership,
         * support-ticket, or other business-directed mail into a customer lead.
         *
         * Existing canonical customer conversations remain first-class context so a
         * terse reply ("3", "yeah", "tomorrow", a corrected phone/address, etc.)
         * does not have to restate HVAC intent. Conversely, a reply-looking subject
         * with no real customer conversation is never enough by itself to route a
         * message into booking automation.
         */
        const classificationEvidence = scoreNewLeadEvidence(rawTextBody, subject);
        const cleanBodyIsNewHvacLead = hasNewLeadLanguage(cleanTextBody, subject);
        const fallbackLooksLikeNoise =
          isBlockedSender(fromEmail) ||
          looksLikeBulkMarketing(rawTextBody, subject) ||
          (classificationEvidence.commercialNoiseScore >= 8 &&
            classificationEvidence.commercialNoiseScore >=
              classificationEvidence.hvacScore +
                classificationEvidence.problemScore +
                classificationEvidence.identityScore +
                classificationEvidence.contactScore +
                classificationEvidence.locationScore);

        const customerAdmission = await classifyInboundCustomerIntent({
          subject,
          body: cleanTextBody || rawTextBody,
          fromEmail,
          hasExistingCustomerConversation: Boolean(activeBookingConversation),
          fallbackLooksLikeCustomerRequest: cleanBodyIsNewHvacLead,
          fallbackLooksLikeNoise,
        });

        const admissionAllowsExistingConversation =
          Boolean(activeBookingConversation) &&
          (customerAdmission.decision === "customer_conversation_reply" ||
            customerAdmission.decision === "customer_service_request");

        const admissionAllowsNewLead =
          !activeBookingConversation &&
          customerAdmission.decision === "customer_service_request";

        const classification: GmailClassification =
          admissionAllowsExistingConversation
            ? "customer_booking_reply"
            : admissionAllowsNewLead
              ? "new_hvac_lead"
              : "noise";

        console.log("[gmail-pubsub] classified message", {
          companyId: connection.company_id,
          gmailMessageId,
          gmailThreadId,
          realProviderThreadId,
          fromEmail,
          subject,
          classification,
          classificationEvidence,
          customerAdmission,
          cleanBodyIsNewHvacLead,
          activeBookingLeadId: activeBookingConversation?.id ?? null,
          activeBookingLeadStatus: activeBookingConversation?.status ?? null,
          cleanPreview: cleanTextBody.slice(0, 180),
          rawPreview: rawTextBody.slice(0, 180),
        });

        if (classification === "customer_booking_reply") {
          const queued = await enqueueProcessInboundEmail({
            companyId: connection.company_id,
            leadId: activeBookingConversation?.id ?? null,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            toEmail,
            subject,
            cleanTextBody,
            rawTextBody,
            preReservedInboundEmail: routingReservation,
          });

          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "ACCEPT",
            classification,
            reason: "accepted_existing_customer_conversation",
            leadCreated: false,
            leadId:
              queued.canonicalLeadId ??
              activeBookingConversation?.id ??
              null,
            jobQueued: Boolean(queued.queued),
            jobId: queued.jobId ?? null,
            replyTriggered: Boolean(queued.queued),
            customerAdmission,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            classification,
            activeBookingLeadId: activeBookingConversation?.id ?? null,
            ...queued,
            cleanTextPreview: cleanTextBody.slice(0, 240),
          });

          continue;
        }

        /*
         * ADDITIVE PROSPECT-INQUIRY ROUTING.
         *
         * Exact booking-thread ownership already had first right of refusal above.
         * A sender-only fallback is not conversation ownership and cannot suppress
         * a genuine prospect/info turn on a different provider thread.
         *
         * Pure informational prospect questions and already-established
         * prospect-inquiry threads may route to the isolated inquiry worker.
         * Direct service requests fall through to the existing new-lead branch.
         */
        const prospectThreadId =
          realProviderThreadId ?? gmailThreadId ?? gmailMessageId;

        const prospectRoute = await routeProspectInquiryIfApplicable({
          companyId: connection.company_id,
          existingClassification: classification,
          existingAdmission: customerAdmission as Record<string, unknown>,
          hasActiveBookingConversation: false,
          provider: "gmail_pubsub",
          providerEventId: gmailMessageId,
          providerThreadId: prospectThreadId,
          providerEmailId: gmailMessageId,
          fromEmail,
          toEmail,
          subject,
          cleanTextBody,
          rawTextBody,
        });

        if (prospectRoute.routed) {
          if (!String(prospectRoute.jobId ?? "").trim()) {
            throw new Error("prospect_route_routed_without_queued_job");
          }

          await markInboundRoutingCompleteWithoutLead({
            companyId: connection.company_id,
            gmailMessageId,
            inboundEmailId: routingReservation.id,
          });

          console.log("[gmail-pubsub] routed prospect inquiry", {
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: prospectThreadId,
            fromEmail,
            subject,
            existingClassification: classification,
            prospectReason: prospectRoute.reason,
            prospectConversationId: prospectRoute.conversationId,
            prospectClassification: prospectRoute.classification,
            jobId: prospectRoute.jobId,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            providerThreadId: prospectThreadId,
            fromEmail,
            subject,
            classification,
            prospectClassification: prospectRoute.reason,
            prospectConversationId: prospectRoute.conversationId,
            queued: true,
            jobId: prospectRoute.jobId,
            cleanTextPreview: cleanTextBody.slice(0, 240),
          });

          continue;
        }

        if (classification === "new_hvac_lead") {
          const created = await createLeadFromGmail({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId: realProviderThreadId,
            fromEmail,
            toEmail,
            subject,
            textBody: rawTextBody,
            preReservedInboundEmail: routingReservation,
          });

          let queued = false;
          let jobId: string | null = null;

          if (created.shouldRequeue && created.lead?.id) {
            const job = await enqueueProcessNewLead({
              companyId: connection.company_id,
              leadId: created.lead.id,
            });

            queued = true;
            jobId = job.id ?? `process_new_lead:${connection.company_id}:${created.lead.id}`;
          }

          logInboundDecision({
            companyId: connection.company_id,
            gmailMessageId,
            gmailThreadId,
            providerThreadId: realProviderThreadId,
            fromEmail,
            subject,
            preview: cleanTextBody || rawTextBody,
            decision: "ACCEPT",
            classification,
            reason: created.duplicateLead
              ? "accepted_customer_request_existing_lead"
              : "accepted_customer_request_new_lead",
            leadCreated: !created.duplicateLead,
            leadId: created.lead?.id ?? null,
            jobQueued: queued,
            jobId,
            replyTriggered: queued,
            customerAdmission,
          });

          results.push({
            gmailMessageId,
            gmailThreadId,
            fromEmail,
            subject,
            classification,
            queued,
            jobId,
            leadId: created.lead?.id ?? null,
            duplicateLead: created.duplicateLead,
            textPreview: rawTextBody.slice(0, 240),
          });

          continue;
        }

        await markInboundRoutingCompleteWithoutLead({
          companyId: connection.company_id,
          gmailMessageId,
          inboundEmailId: routingReservation.id,
        });

        logInboundDecision({
          companyId: connection.company_id,
          gmailMessageId,
          gmailThreadId,
          providerThreadId: realProviderThreadId,
          fromEmail,
          subject,
          preview: cleanTextBody || rawTextBody,
          decision: "REJECT",
          classification,
          reason: "skipped_non_customer_or_unrelated_message",
          leadCreated: false,
          jobQueued: false,
          replyTriggered: false,
          customerAdmission,
        });

        results.push({
          gmailMessageId,
          gmailThreadId,
          fromEmail,
          subject,
          classification,
          queued: false,
          reason: "skipped_non_customer_or_unrelated_message",
          customerAdmission,
        });
      } catch (messageErr: any) {
        if (ownedRoutingReservationId) {
          const { error: releaseError } = await supabase
            .from("inbound_emails")
            .delete()
            .eq("id", ownedRoutingReservationId)
            .eq("company_id", connection.company_id)
            .eq("provider_event_id", gmailMessageId)
            .is("lead_id", null)
            .eq("processed", false);

          if (releaseError) {
            console.error("[gmail-pubsub] failed to release routing ownership", {
              companyId: connection.company_id,
              gmailMessageId,
              inboundEmailId: ownedRoutingReservationId,
              error: releaseError.message,
            });
          }
        }

        logInboundDecision({
          companyId: connection.company_id,
          gmailMessageId,
          gmailThreadId,
          providerThreadId: realProviderThreadId,
          decision: "ERROR",
          reason: messageErr?.message ?? "message_processing_failed",
        });

        results.push({
          gmailMessageId,
          gmailThreadId,
          queued: false,
          error: messageErr?.message ?? "message_processing_failed",
        });

        console.error("[gmail-pubsub] message processing failed", {
          companyId: connection.company_id,
          gmailMessageId,
          gmailThreadId,
          error: messageErr?.message ?? messageErr,
        });
      }
    }

    const messageFailures = results.filter((item) => item?.error);

    if (messageFailures.length > 0) {
      throw new Error(
        `gmail_message_processing_failed_count_${messageFailures.length}`
      );
    }

    let nextHistoryId = fetched.latestHistoryId ?? null;
    let watchRenewed = false;

    if (!routing && fetched.usedFallback) {
      const renewedWatch = await startGmailInboxWatch(connection.company_id, { resetHistory: true });
      nextHistoryId =
        renewedWatch.historyId ??
        nextHistoryId ??
        incomingHistoryId ??
        storedHistoryId ??
        null;
      watchRenewed = true;
    } else if (!routing) {
      /*
       * Prefer the history cursor returned by users.history.list.
       *
       * If Gmail returned no history records and no latest cursor, preserve the
       * stored cursor instead of advancing solely from the Pub/Sub notification.
       * That avoids losing a change if Gmail history is briefly delayed.
       */
      nextHistoryId = nextHistoryId ?? storedHistoryId ?? null;
      await updateHistoryId(connection.company_id, nextHistoryId);
    }

    const queuedMessages = routedMessages + results.filter((item) => item.queued).length;

    console.log("[gmail-pubsub] webhook completed", {
      companyId: connection.company_id,
      emailAddress: connectedEmail,
      queuedMessages,
      inspectedMessages: results.length,
      usedFallback: fetched.usedFallback,
      watchRenewed,
      historyPages: fetched.historyPages,
      recoveryPages: fetched.recoveryPages,
      historyFailure: fetched.historyFailure,
      results,
    });

    return {
      success: true,
      received: true,
      companyId: connection.company_id,
      emailAddress: connectedEmail,
      queuedMessages,
      inspectedMessages: results.length,
      usedFallback: fetched.usedFallback,
      watchRenewed,
      historyPages: fetched.historyPages,
      recoveryPages: fetched.recoveryPages,
      historyFailure: fetched.historyFailure,
      results,
    };
  } catch (err: any) {
    const message = err?.message ?? "gmail_pubsub_processing_failed";

    if (companyIdForFailure && isGoogleAuthFailure(message)) {
      await markReconnectRequired(companyIdForFailure, message);
    }

    console.error("[gmail-pubsub] webhook failed", {
      message,
      reconnectRequired: isGoogleAuthFailure(message),
    });

    throw new Error(message);
  }
}

export async function recoverCompanyGmailMailbox(companyId: string, options: { enqueue?: boolean } = {}) {
  const cleanCompanyId = String(companyId ?? "").trim();

  if (!cleanCompanyId) {
    throw new Error("missing_company_id");
  }

  const { data: connection, error } = await supabase
    .from("google_connections")
    .select(
      "company_id, google_account_email, gmail_watch_history_id, refresh_token, gmail_ingestion_enabled"
    )
    .eq("company_id", cleanCompanyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (connection && connection.gmail_ingestion_enabled !== true) {
    return { success: true, skipped: true, companyId: cleanCompanyId, reason: "gmail_ingestion_disabled" };
  }
  if (!connection?.google_account_email) {
    throw new Error("missing_google_connection_email");
  }
  if (!connection?.refresh_token) {
    throw new Error("missing_google_refresh_token");
  }

  const syntheticPayload = {
    emailAddress: connection.google_account_email,
    historyId: connection.gmail_watch_history_id ?? undefined,
    recoveryMode: true,
  };

  const process = options.enqueue === false ? processGmailPubSubWebhook : enqueueGmailPubSubWebhook;
  return process({
    message: {
      messageId: `gmail_recovery_${cleanCompanyId}_${Date.now()}`,
      publishTime: new Date().toISOString(),
      data: Buffer.from(JSON.stringify(syntheticPayload), "utf8").toString(
        "base64"
      ),
    },
  });
}

export async function recoverAllCompanyGmailMailboxes() {
  const { data: connections, error } = await supabase
    .from("google_connections")
    .select("company_id")
    .eq("gmail_ingestion_enabled", true)
    .not("refresh_token", "is", null)
    .limit(500);

  if (error) throw new Error(error.message);

  const results: any[] = [];

  for (const connection of connections ?? []) {
    const companyId = String((connection as any)?.company_id ?? "").trim();

    if (!companyId) {
      results.push({
        companyId: null,
        success: false,
        error: "missing_company_id",
      });
      continue;
    }

    try {
      const result = await recoverCompanyGmailMailbox(companyId);
      results.push({
        companyId,
        success: true,
        result,
      });
    } catch (error: any) {
      results.push({
        companyId,
        success: false,
        error: error?.message ?? "gmail_recovery_failed",
      });
    }
  }

  return {
    success: results.every((item) => item.success),
    recoveredCompanies: results.filter((item) => item.success).length,
    failedCompanies: results.filter((item) => !item.success).length,
    results,
  };
}
