// lib/inbound/processInboundEmail.ts
// Hardened booking-conversation resolver: active pending leads are interpreted first, then clarified if unresolved.

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { supabase } from "@/lib/supabase";
import { findLeadForInboundEmail } from "@/lib/inbound/findLeadForInboundEmail";
import { resolveSchedulingIntent, reconcileUngroundedCalendarPoint } from "../ai/resolveSchedulingIntent";
import {
  resolveBookingCommand,
  toLegacyAvailabilityIntent,
  toLegacyCustomerActionIntent,
  type BookingCommandKind,
  type BookingCommandResult,
} from "@/lib/booking/resolveBookingCommand";
import { resolveCanonicalTemporalIntent } from "@/lib/scheduling/resolveCanonicalTemporalIntent";
import {
  buildBookingRequirementsPrompt,
  getPendingBookingRequirements,
  hasExplicitSecondaryServiceLocator,
  isStructurallyCompleteServiceStreetAddress,
  resolveBookingRequirements,
  type PendingBookingRequirementsAction,
} from "@/lib/booking/bookingRequirements";
import { answerBookedCustomerInformationRequest } from "@/lib/jobs/processProspectInquiryJob";
import { createCalendarBooking } from "@/lib/google/createCalendarBooking";
import { getCompanyCalendarClient } from "@/lib/google/companyGoogle";
import {
  getCompanyBusinessHoursStatus,
  suggestAlternativeSlots,
} from "@/lib/availability/checkAvailability";
import { sendLeadReply } from "@/lib/email/sendLeadReply";
import { extractLeadMetadataFromTextSemantic } from "@/lib/leads/leadMetadata";
import {
  addDaysToLocalDate,
  addMinutesUtc,
  getNowInTimezone,
  getWeekdayIndexForLocalDate,
  zonedTimeToUtc,
} from "@/lib/time/companyTime";

type ProcessInboundEmailInput = {
  companyId: string;
  provider?: string;
  providerEventId?: string | null;
  providerThreadId?: string | null;
  providerEmailId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  receivedAt?: string | null;

  /*
   * Prospect -> booking handoff contract. The prospect lane may resolve WHAT
   * the customer wants exactly once and hand that immutable result here.
   * processInboundEmail still owns all downstream state/availability validation.
   */
  preResolvedBookingCommand?: BookingCommandResult | null;
  recentAssistantMessage?: string | null;
  prospectConversationContext?: string | null;
  prospectConversationId?: string | null;
};

type LeadForInboundEmail = {
  id: string;
  company_id: string;
  status?: string | null;
  input?: string | null;
  message?: string | null;
  email?: string | null;
  phone?: string | null;
  customer_name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  appointment_time?: string | null;
  calendar_event_id?: string | null;
  qualification?: Record<string, any> | null;
};

type AlternativeSlot = {
  startTime: string;
  endTime?: string | null;
  timezone?: string | null;
  travelBufferMinutes?: number | null;
};

type PendingSlotSuggestion = {
  status?: string | null;
  originalRequestedStartTime?: string | null;
  originalRequestedEndTime?: string | null;
  suggestedStartTime?: string | null;
  suggestedEndTime?: string | null;
  suggestedSlots?: AlternativeSlot[] | null;
};

type ActiveSchedulingYearContext = {
  year: number;
  source: "relative_year" | "absolute_year" | "resolved_future_calendar";
  establishedByReply?: string | null;
  establishedAt?: string | null;
};

type PendingSlotMatch = {
  matched: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
  confidence: "low" | "medium" | "high";
};

type PendingBookingConfirmation = {
  version: 1;
  status: "pending" | "consumed";
  kind: BookingCommandKind;
  appointmentTime: string | null;
  requestedAt: string;
  requestedByReply: string;
  expiresAt: string;
  consumedAt?: string | null;
  consumedByProviderEventId?: string | null;
};

type PendingBookingClarification = {
  version: 1;
  status: "pending" | "consumed";
  kind: "reschedule";
  missing: "temporal_target";
  appointmentTime: string | null;
  requestedAt: string;
  requestedByReply: string;
  expiresAt: string;
  consumedAt?: string | null;
  consumedByProviderEventId?: string | null;
};

const PENDING_BOOKING_CONFIRMATION_TTL_MS = 72 * 60 * 60 * 1000;
const PENDING_BOOKING_CLARIFICATION_TTL_MS = 72 * 60 * 60 * 1000;

function isPersistableConfirmationMutation(
  kind: unknown
): kind is BookingCommandKind {
  return (
    kind === "cancel" ||
    kind === "restore_previous" ||
    kind === "restore_original" ||
    kind === "restore_cancelled"
  );
}

function getPendingBookingConfirmation(params: {
  qualification?: Record<string, any> | null;
  consumerEventId: string;
}): PendingBookingConfirmation | null {
  const raw = params.qualification?.pendingBookingConfirmation;

  if (!raw || typeof raw !== "object" || raw.version !== 1) return null;
  if (!isPersistableConfirmationMutation(raw.kind)) return null;

  const requestedAt = String(raw.requestedAt ?? "").trim();
  const expiresAt = String(raw.expiresAt ?? "").trim();

  if (!requestedAt || !expiresAt) return null;

  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;

  const status = String(raw.status ?? "");
  const consumedByProviderEventId = String(
    raw.consumedByProviderEventId ?? ""
  ).trim();

  const usable =
    status === "pending" ||
    (
      status === "consumed" &&
      consumedByProviderEventId === params.consumerEventId
    );

  if (!usable) return null;

  return {
    version: 1,
    status: status as "pending" | "consumed",
    kind: raw.kind,
    appointmentTime:
      typeof raw.appointmentTime === "string" && raw.appointmentTime
        ? raw.appointmentTime
        : null,
    requestedAt,
    requestedByReply:
      typeof raw.requestedByReply === "string"
        ? raw.requestedByReply
        : "",
    expiresAt,
    consumedAt:
      typeof raw.consumedAt === "string" ? raw.consumedAt : null,
    consumedByProviderEventId:
      consumedByProviderEventId || null,
  };
}

function getPendingBookingClarification(params: {
  qualification?: Record<string, any> | null;
  consumerEventId: string;
}): PendingBookingClarification | null {
  const raw = params.qualification?.pendingBookingClarification;

  if (!raw || typeof raw !== "object" || raw.version !== 1) return null;
  if (raw.kind !== "reschedule" || raw.missing !== "temporal_target") {
    return null;
  }

  const requestedAt = String(raw.requestedAt ?? "").trim();
  const expiresAt = String(raw.expiresAt ?? "").trim();

  if (!requestedAt || !expiresAt) return null;

  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return null;

  const status = String(raw.status ?? "");
  const consumedByProviderEventId = String(
    raw.consumedByProviderEventId ?? ""
  ).trim();

  const usable =
    status === "pending" ||
    (status === "consumed" &&
      consumedByProviderEventId === params.consumerEventId);

  if (!usable) return null;

  return {
    version: 1,
    status: status as "pending" | "consumed",
    kind: "reschedule",
    missing: "temporal_target",
    appointmentTime:
      typeof raw.appointmentTime === "string" && raw.appointmentTime
        ? raw.appointmentTime
        : null,
    requestedAt,
    requestedByReply:
      typeof raw.requestedByReply === "string"
        ? raw.requestedByReply
        : "",
    expiresAt,
    consumedAt:
      typeof raw.consumedAt === "string" ? raw.consumedAt : null,
    consumedByProviderEventId:
      consumedByProviderEventId || null,
  };
}

/*
 * Compatibility-only request shape for deferred mixed-turn information.
 *
 * The imported read-only CI entry point may be seen by TypeScript through an
 * older parameter shape while the runtime implementation supports sendReply.
 * Intersecting the imported parameter type keeps every existing required field
 * intact and permits only this optional delivery-control flag.
 */
type DeferredBookedCustomerInformationRequest =
  Parameters<typeof answerBookedCustomerInformationRequest>[0] & {
    sendReply?: boolean;
  };

function normalizeBodyText(text?: string | null) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripQuotedEmail(text: string) {
  return text
    .split(/\nOn [^\n]*(?:\n[^\n]*){0,5}?wrote:/i)[0]
    .split(/\nFrom:/i)[0]
    .split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0]
    .replace(/^>.*$/gm, "")
    .trim();
}

function extractImmediateQuotedAssistantMessage(text?: string | null) {
  const normalized = normalizeBodyText(text);
  if (!normalized) return null;

  const wroteMatch = normalized.match(/\nOn [^\n]*(?:\n[^\n]*){0,5}?wrote:\s*\n([\s\S]*)$/i);
  const source = wroteMatch?.[1] ?? "";
  if (!source) return null;

  const quotedLines: string[] = [];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();

    if (/^\s*>/.test(line)) {
      quotedLines.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }

    if (quotedLines.length > 0 && !line.trim()) {
      quotedLines.push("");
      continue;
    }

    if (quotedLines.length > 0) break;
  }

  const quoted = quotedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return quoted ? quoted.slice(0, 4000) : null;
}

function cleanBody(text?: string | null) {
  const normalized = normalizeBodyText(text);
  const unquoted = stripQuotedEmail(normalized);

  return unquoted
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function normalizeSimpleText(text: string) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\bya['’]?ll\b/g, " yall ")
    .replace(/\by['’]?all\b/g, " yall ")
    .replace(/\bu\b/g, " you ")
    .replace(/\bur\b/g, " your ")
    .replace(/\br\b/g, " are ")
    .replace(/\bpls\b/g, " please ")
    .replace(/\bplz\b/g, " please ")
    .replace(/\bthx\b/g, " thanks ")
    .replace(/\bty\b/g, " thanks ")
    .replace(/\bw\/\b/g, " with ")
    .replace(/\bappt\b/g, " appointment ")
    .replace(/\bsched\b/g, " schedule ")
    .replace(/\bdef\b/g, " definitely ")
    .replace(/\bprob\b/g, " probably ")
    .replace(/\s*#\s*/g, " number ")
    .replace(/[^\w\s:.#'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


/*
 * Explicit read-only appointment-availability firewall.
 *
 * The semantic availability resolver is still the normal classifier, but it
 * must not send an unmistakable request to SEE bookable appointment choices
 * into Customer Intelligence merely because the sentence contains the word
 * "booking". This helper is deliberately narrow:
 *   - it requires explicit appointment/availability vocabulary;
 *   - it requires a request-to-see/know choices cue;
 *   - it rejects explicit mutation language such as "book me", "move my",
 *     "cancel", or "reschedule" so Booking Gate authorization is untouched.
 *
 * It does not parse dates/times, decide availability, or mutate anything.
 */
/*
 * Mixed-turn segmentation for active booking conversations.
 *
 * This is deliberately domain-agnostic: it does not look for policy names,
 * HVAC parts, dates, or any test phrase. It only finds independent conversational
 * clauses so the existing semantic action resolver can judge each clause itself.
 * The booking resolver remains authoritative for mutations.
 */
function splitPotentialMixedTurnSegments(message: string) {
  const normalized = String(message ?? "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (!normalized) return [];

  return normalized
    .replace(/([?!;])+/g, "$&\n")
    .replace(/\b(?:and\s+also|also|plus|by\s+the\s+way|btw)\b/gi, "\n$& ")
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function mergeMixedInformationWithActionReply(
  informationAnswer?: string | null,
  actionReply?: string | null
) {
  const info = String(informationAnswer ?? "").trim();
  const action = String(actionReply ?? "").trim();

  if (!info) return action;
  if (!action) return info;

  return `${info}\n\n${action}`;
}

function hasPositiveBookingLanguage(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  const positivePatterns = [
    /\b(yes|yeah|yep|yup|ya|sure|surely|absolutely|definitely|confirm|confirmed|correct|agree|approved|approve)\b/,
    /\b(ok|okay|k|kk|alright|all right|fine|good|great|perfect|cool|bet|solid|sounds good|looks good)\b/,
    /\b(work|works|working|good for me|fine for me|that works|this works|works for us|works for me)\b/,
    /\b(book|schedule|scheduled|set|lock|lock in|reserve|confirm|put me down|sign me up|make it|make that|mark me|pencil me)\b/,
    /\b(take|grab|choose|pick|select|use|go with|go ahead|send|run|do|can do|able to do|works for|work for|slide|swing|come|stop by|show up|pull up)\b/,
    /\b(i can|we can|you can|yall can|ya ll can|can do|that one|this one|that slot|this slot|that time|this time|the time|the slot|the appointment|first one|second one|third one)\b/,
    /\b(see you|see yall|see you then|see yall then|see ya then|be there|we will be there|i will be there)\b/,
  ];

  return positivePatterns.some((pattern) => pattern.test(text));
}

function hasNegativeBookingLanguage(message: string) {
  const text = normalizeSimpleText(message);

  return /\b(no|nope|nah|not that|doesn'?t work|does not work|wont work|won't work|can't|cannot|cant|wont|won't|different|another|later|earlier|reschedule|cancel|never mind|nevermind|hold off|not sure|maybe|question|how much|price|cost|estimate only)\b/.test(
    text
  );
}

function numberWordToIndex(value: string) {
  const text = normalizeSimpleText(value);

  if (!text) return null;

  const direct = parseOrdinalTextToIndex(text, 1000);
  return direct;
}

function parseOrdinalTextToIndex(value: string, max: number) {
  const text = normalizeSimpleText(value)
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\b(?:option|slot|choice|opening|appointment|appt|number|num)\b/g, " ")
    .replace(/\bno\s+/g, "")
    .replace(/\bone\b$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || max <= 0) return null;

  const numeric = text.match(/^#?\s*(\d{1,4})(?:st|nd|rd|th)?$/);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return index >= 0 && index < max ? index : null;
  }

  const aliases: Record<string, number> = {
    earliest: 0,
    soonest: 0,
    asap: 0,
    opener: 0,
    opening: 0,
    initial: 0,
    top: 0,
    first: 0,
    firstly: 0,
    last: max - 1,
    latest: max - 1,
    final: max - 1,
    bottom: max - 1,
  };

  if (aliases[text] !== undefined) {
    const index = aliases[text];
    return index >= 0 && index < max ? index : null;
  }

  const ordinalWords: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    forth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
    thirtieth: 30,
    fortieth: 40,
    fourtieth: 40,
    fiftieth: 50,
    sixtieth: 60,
    seventieth: 70,
    eightieth: 80,
    ninetieth: 90,
    hundredth: 100,
  };

  const cardinalWords: Record<string, number> = {
    zero: 0,
    one: 1,
    won: 1,
    two: 2,
    too: 2,
    to: 2,
    three: 3,
    four: 4,
    for: 4,
    fore: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    ate: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fourty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
  };

  if (ordinalWords[text] !== undefined) {
    const index = ordinalWords[text] - 1;
    return index >= 0 && index < max ? index : null;
  }

  if (cardinalWords[text] !== undefined) {
    const index = cardinalWords[text] - 1;
    return index >= 0 && index < max ? index : null;
  }

  const pieces = text.replace(/-/g, " ").split(/\s+/).filter(Boolean);

  let total = 0;
  let sawNumberWord = false;

  for (const piece of pieces) {
    if (ordinalWords[piece] !== undefined) {
      total += ordinalWords[piece];
      sawNumberWord = true;
      break;
    }

    if (cardinalWords[piece] !== undefined) {
      total += cardinalWords[piece];
      sawNumberWord = true;
      continue;
    }

    return null;
  }

  if (!sawNumberWord || total <= 0) return null;

  const index = total - 1;
  return index >= 0 && index < max ? index : null;
}

function extractOrdinalCandidatePhrases(text: string) {
  const normalized = normalizeSimpleText(text)
    .replace(/\bnumber\s+/g, " number ")
    .replace(/\s+/g, " ")
    .trim();

  const candidates: string[] = [];

  const optionAnchoredPatterns = [
    /\b(?:option|slot|choice|opening|appointment|appt|number|num)\s*#?\s*(\d{1,4}(?:st|nd|rd|th)?|[a-z]+(?:[-\s]+[a-z]+){0,3})\b/g,
    /\b#\s*(\d{1,4})(?:st|nd|rd|th)?\b/g,
    /\b(\d{1,4}(?:st|nd|rd|th)?|[a-z]+(?:[-\s]+[a-z]+){0,3})\s+(?:option|slot|choice|opening|appointment|appt)\b/g,
    /\b(?:book|schedule|confirm|lock|reserve|take|grab|choose|pick|select|use|do|make|set)\s+(?:the\s+)?([a-z0-9-]+(?:\s+[a-z0-9-]+){0,4})(?=\s+(?:one|option|slot|choice|opening|appointment|appt)\b|[?.!,]|$)/g,
    /\b(?:go\s+with|roll\s+with|run\s+with|put\s+me\s+down\s+for)\s+(?:the\s+)?([a-z0-9-]+(?:\s+[a-z0-9-]+){0,4})(?=\s+(?:one|option|slot|choice|opening|appointment|appt)\b|[?.!,]|$)/g,
    /\b(?:the\s+)?([a-z0-9-]+(?:\s+[a-z0-9-]+){0,4})\s+(?:one|option|slot|choice|opening|appointment|appt)\b/g,
  ];

  for (const pattern of optionAnchoredPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match[1]) candidates.push(match[1].trim());
    }
  }

  const bareNumeric = normalized.match(/^\s*(\d{1,4})(?:st|nd|rd|th)?\s*$/);
  if (bareNumeric?.[1]) candidates.push(bareNumeric[1]);

  const bareOrdinal = normalized.match(
    /^\s*(first|second|third|fourth|forth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fourtieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|one|two|too|to|three|four|for|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+[a-z]+){0,3}\s*$/
  );
  if (bareOrdinal?.[0]) candidates.push(bareOrdinal[0].trim());

  const priorityWords = [
    "earliest",
    "soonest",
    "asap",
    "first available",
    "soonest available",
    "earliest available",
    "next available",
    "last",
    "latest",
    "final",
  ];

  for (const phrase of priorityWords) {
    if (normalized.includes(phrase)) candidates.push(phrase);
  }

  return candidates;
}
function getPendingSuggestionSlots(
  qualification?: Record<string, any> | null
): AlternativeSlot[] {
  const pending = qualification?.pendingSlotSuggestion as
    | PendingSlotSuggestion
    | undefined;

  if (!pending) return [];
  if (pending.status !== "awaiting_customer_confirmation") return [];

  if (Array.isArray(pending.suggestedSlots) && pending.suggestedSlots.length > 0) {
    return pending.suggestedSlots
      .filter((slot) => slot?.startTime)
      .map((slot) => ({
        startTime: String(slot.startTime),
        endTime: slot.endTime ? String(slot.endTime) : null,
        timezone: slot.timezone ?? null,
        travelBufferMinutes: slot.travelBufferMinutes ?? null,
      }));
  }

  if (pending.suggestedStartTime) {
    return [
      {
        startTime: String(pending.suggestedStartTime),
        endTime: pending.suggestedEndTime ? String(pending.suggestedEndTime) : null,
      },
    ];
  }

  return [];
}

function hasActivePendingSlotSuggestion(
  qualification?: Record<string, any> | null
) {
  return getPendingSuggestionSlots(qualification).length > 0;
}


function getLocalCalendarDateForIso(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const year = get("year");
  const month = get("month");
  const day = get("day");

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  return { year, month, day };
}

function resolveUnambiguousPendingCalendarDate(params: {
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  const dates = params.alternatives
    .map((slot) => getLocalCalendarDateForIso(slot.startTime, params.timezone))
    .filter(Boolean) as Array<{ year: number; month: number; day: number }>;

  if (dates.length === 0) return null;

  const unique = new Map<string, { year: number; month: number; day: number }>();

  for (const date of dates) {
    unique.set(`${date.year}-${date.month}-${date.day}`, date);
  }

  /*
    A bare time may inherit the date only when the ACTIVE offered context has
    one unambiguous local calendar date. If the options span dates, fail closed
    instead of silently choosing one.
  */
  if (unique.size !== 1) return null;

  return [...unique.values()][0] ?? null;
}


/*
  Preserve the CUSTOMER'S active requested calendar date across an unavailable
  response.

  Replacement openings are suggestions, not a rewrite of what the customer
  asked for. Therefore a later bare-time correction such as "then do 2 PM"
  should replace only the clock dimension of the customer's original request.

  This helper returns a date only when the pending record proves one
  unambiguous original local calendar day:
    - exact date/time request -> same original day
    - single-day date/window request -> same original day
    - multi-day window -> ambiguous, return null

  If no safe original day exists, existing offered-slot date inheritance is
  allowed as the fallback.
*/
function resolvePendingOriginalRequestedCalendarDate(params: {
  qualification?: Record<string, any> | null;
  timezone: string;
}) {
  const pending = params.qualification?.pendingSlotSuggestion as
    | PendingSlotSuggestion
    | undefined;

  if (!pending) return null;
  if (pending.status !== "awaiting_customer_confirmation") return null;
  if (!pending.originalRequestedStartTime) return null;

  const startDate = getLocalCalendarDateForIso(
    String(pending.originalRequestedStartTime),
    params.timezone
  );

  if (!startDate) return null;

  if (!pending.originalRequestedEndTime) {
    return startDate;
  }

  const endMs = new Date(String(pending.originalRequestedEndTime)).getTime();

  if (!Number.isFinite(endMs)) return null;

  /*
    Windows use an exclusive end boundary. Probe one millisecond before the
    boundary so a single local day ending at next midnight remains one day.
  */
  const inclusiveEndProbe = new Date(endMs - 1).toISOString();
  const endDate = getLocalCalendarDateForIso(
    inclusiveEndProbe,
    params.timezone
  );

  if (!endDate) return null;

  if (
    startDate.year !== endDate.year ||
    startDate.month !== endDate.month ||
    startDate.day !== endDate.day
  ) {
    return null;
  }

  return startDate;
}

/*
  Contextual same-calendar-day continuity.

  A phrase such as "same day", "that day", or "same date" is an anaphoric
  calendar reference. It does not create a new date from the inbound message
  reference timestamp. It points back to the customer's immediately active
  requested calendar day.

  This helper only detects the reference. Ownership of the turn (read-only
  availability vs booking mutation) remains entirely with the existing
  semantic booking/availability gates.
*/
function hasContextualSameCalendarDayReference(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return false;

  return (
    /\b(?:same|that)\s+(?:calendar\s+)?(?:day|date)\b/.test(text) ||
    /\b(?:keep|use|stay\s+on)\s+(?:the\s+)?same\s+(?:calendar\s+)?(?:day|date)\b/.test(
      text
    )
  );
}

function resolveStoredSchedulingContextCalendarDate(params: {
  context:
    | {
        requestedStartTime: string;
        requestedEndTime: string | null;
      }
    | null;
  timezone: string;
}) {
  if (!params.context?.requestedStartTime) return null;

  const startDate = getLocalCalendarDateForIso(
    params.context.requestedStartTime,
    params.timezone
  );

  if (!startDate) return null;

  if (!params.context.requestedEndTime) {
    return startDate;
  }

  const endMs = new Date(params.context.requestedEndTime).getTime();
  if (!Number.isFinite(endMs)) return null;

  const inclusiveEndProbe = new Date(endMs - 1).toISOString();
  const endDate = getLocalCalendarDateForIso(
    inclusiveEndProbe,
    params.timezone
  );

  if (
    !endDate ||
    startDate.year !== endDate.year ||
    startDate.month !== endDate.month ||
    startDate.day !== endDate.day
  ) {
    return null;
  }

  return startDate;
}

/*
  Contextual calendar-fragment continuity.

  A follow-up such as "18th at 2 PM" can intentionally replace only the day
  and/or clock while leaving the active month/year unchanged. When the pending
  scheduling record proves one unambiguous original requested date, preserve
  that month/year instead of allowing an isolated ordinal day to be rebuilt
  against an unrelated month from the resolver reference date.

  This is deliberately narrow:
    - the newest message must contain an ordinal day-of-month fragment;
    - it must NOT name a month or numeric month/day date;
    - it must NOT establish a fresh year scope;
    - an active pending record must prove the prior requested calendar date.
*/
function extractContextualDayOfMonthFragment(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return null;

  if (hasExplicitCalendarDateSurface(message)) return null;

  if (
    /\b(?:this|current|next|following|coming|last|previous)\s+year\b/.test(text) ||
    /\b(?:19|20)\d{2}\b/.test(text)
  ) {
    return null;
  }

  const match = text.match(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b/);
  if (!match) return null;

  const day = Number(match[1]);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function isValidCalendarDateParts(params: {
  year: number;
  month: number;
  day: number;
}) {
  const probe = new Date(Date.UTC(params.year, params.month - 1, params.day));
  return (
    probe.getUTCFullYear() === params.year &&
    probe.getUTCMonth() + 1 === params.month &&
    probe.getUTCDate() === params.day
  );
}

function localCalendarDayDelta(
  start: { year: number; month: number; day: number },
  end: { year: number; month: number; day: number }
) {
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const endDay = Date.UTC(end.year, end.month - 1, end.day);
  const delta = Math.round((endDay - startDay) / 86_400_000);
  return Number.isInteger(delta) ? delta : null;
}

function rebaseTemporalWindowToCalendarDate(params: {
  window: { startTime: string; endTime?: string | null };
  targetDate: { year: number; month: number; day: number };
  timezone: string;
}) {
  const sourceStartDate = getLocalCalendarDateForIso(
    params.window.startTime,
    params.timezone
  );
  const sourceStartClock = getLocalClockForIso(
    params.window.startTime,
    params.timezone
  );

  if (!sourceStartDate || !sourceStartClock) return null;

  const startTime = zonedTimeToUtc({
    ...params.targetDate,
    hour: sourceStartClock.hour,
    minute: sourceStartClock.minute,
    timezone: params.timezone,
  });

  if (!params.window.endTime) {
    return { startTime, endTime: null };
  }

  const sourceEndDate = getLocalCalendarDateForIso(
    params.window.endTime,
    params.timezone
  );
  const sourceEndClock = getLocalClockForIso(
    params.window.endTime,
    params.timezone
  );

  if (!sourceEndDate || !sourceEndClock) return null;

  const endDayDelta = localCalendarDayDelta(sourceStartDate, sourceEndDate);
  if (endDayDelta === null || endDayDelta < 0) return null;

  const targetEndDate = addDaysToLocalDate({
    ...params.targetDate,
    days: endDayDelta,
  });

  const endTime = zonedTimeToUtc({
    ...targetEndDate,
    hour: sourceEndClock.hour,
    minute: sourceEndClock.minute,
    timezone: params.timezone,
  });

  if (new Date(endTime).getTime() <= new Date(startTime).getTime()) {
    return null;
  }

  return { startTime, endTime };
}

function getActiveSchedulingYearContext(
  qualification?: Record<string, any> | null
): ActiveSchedulingYearContext | null {
  const raw = qualification?.activeSchedulingYearContext;

  if (!raw || typeof raw !== "object") return null;

  const year = Number(raw.year);
  const source = raw.source;

  if (
    !Number.isInteger(year) ||
    year < 1 ||
    year > 9999 ||
    (source !== "relative_year" &&
      source !== "absolute_year" &&
      source !== "resolved_future_calendar")
  ) {
    return null;
  }

  return {
    year,
    source,
    establishedByReply:
      typeof raw.establishedByReply === "string"
        ? raw.establishedByReply
        : null,
    establishedAt:
      typeof raw.establishedAt === "string"
        ? raw.establishedAt
        : null,
  };
}

function setActiveSchedulingYearContextOnLead(params: {
  lead: LeadForInboundEmail;
  context: ActiveSchedulingYearContext | null;
}) {
  const currentQualification = params.lead.qualification ?? {};

  if (params.context) {
    params.lead.qualification = {
      ...currentQualification,
      activeSchedulingYearContext: params.context,
    };
    return;
  }

  const {
    activeSchedulingYearContext: _discardedActiveSchedulingYearContext,
    ...remainingQualification
  } = currentQualification;

  params.lead.qualification = remainingQualification;
}

async function persistLeadQualification(params: {
  companyId: string;
  lead: LeadForInboundEmail;
}) {
  const qualification = params.lead.qualification ?? {};

  const { data: persistedLead, error } = await supabase
    .from("leads")
    .update({ qualification })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!persistedLead) throw new Error("lead_qualification_scope_violation");
}

function hasExplicitCalendarDateSurface(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  const monthToken =
    "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

  /*
    This is intentionally narrower than hasGroundedDateEvidence(). It means
    the customer actually named a calendar month/date shape that can safely
    continue an already-established conversation year. Relative dates such as
    "tomorrow", "next Tuesday", and "next month" are excluded because those
    expressions establish their own temporal frame and must be resolved from
    the reference instant instead.
  */
  return (
    new RegExp(`\\b${monthToken}\\b`).test(text) ||
    /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text)
  );
}

function hasExplicitCurrentYearScope(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  const monthToken =
    "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";

  return (
    /\b(?:this|current)\s+year\b/.test(text) ||
    new RegExp(`\\bthis\\s+${monthToken}\\b`).test(text)
  );
}

function hasExplicitActiveYearContextEscape(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  /*
    This is consulted ONLY while an active future-year conversation frame
    already exists. Preserve that frame by default. Clear it only when the
    customer's own words explicitly establish a current/reference-relative
    frame that should be resolved from the message reference time instead.

    Deliberately excluded: a bare weekday such as "Thursday". Without an
    explicit relative/current anchor, that wording does not by itself revoke
    an already-established future-year conversation.
  */
  return (
    /\b(?:today|tomorrow|tonight|day\s+after\s+tomorrow)\b/.test(text) ||
    /\b(?:this|current)\s+year\b/.test(text) ||
    /\bthis\s+(?:week|weekend|month)\b/.test(text) ||
    /\b(?:next|coming|following)\s+(?:day|week|weekend|month)\b/.test(text) ||
    /\b(?:next|coming|following|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(text) ||
    /\b(?:in|within)\s+\d+\s+(?:day|days|week|weeks|month|months)\b/.test(text) ||
    /\b\d+\s+(?:day|days|week|weeks|month|months)\s+(?:from\s+now|away)\b/.test(text) ||
    hasExplicitRelativeWeekdayRelation(text)
  );
}

function getExplicitWeekdayIndex(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return null;

  const weekdayPatterns: Array<[RegExp, number]> = [
    [/\b(?:sunday|sun)\b/, 0],
    [/\b(?:monday|mon)\b/, 1],
    [/\b(?:tuesday|tue|tues)\b/, 2],
    [/\b(?:wednesday|wed)\b/, 3],
    [/\b(?:thursday|thu|thur|thurs)\b/, 4],
    [/\b(?:friday|fri)\b/, 5],
    [/\b(?:saturday|sat)\b/, 6],
  ];

  for (const [pattern, weekdayIndex] of weekdayPatterns) {
    if (pattern.test(text)) return weekdayIndex;
  }

  return null;
}

function getResolvedIntentLocalYear(params: {
  intent: any;
  timezone: string;
}) {
  const localYear = Number(params.intent?.localDateTime?.year);

  if (Number.isInteger(localYear) && localYear >= 1 && localYear <= 9999) {
    return localYear;
  }

  const startTime =
    params.intent?.targetTime ??
    params.intent?.allowedWindows?.[0]?.startTime ??
    null;

  if (!startTime) return null;

  return getLocalCalendarDateForIso(startTime, params.timezone)?.year ?? null;
}

function shiftIsoByLocalCalendarYears(params: {
  iso: string;
  years: number;
  timezone: string;
}) {
  const date = new Date(params.iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const rawHour = get("hour");
  const hour = rawHour === 24 ? 0 : rawHour;
  const targetLocal = {
    year: get("year") + params.years,
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };

  if (
    !Number.isInteger(targetLocal.year) ||
    targetLocal.year < 1 ||
    targetLocal.year > 9999
  ) {
    return null;
  }

  const shifted = zonedTimeToUtc({
    ...targetLocal,
    timezone: params.timezone,
  });

  const shiftedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(shifted));

  const shiftedGet = (type: string) =>
    Number(shiftedParts.find((part) => part.type === type)?.value);
  const shiftedRawHour = shiftedGet("hour");
  const shiftedHour = shiftedRawHour === 24 ? 0 : shiftedRawHour;

  if (
    shiftedGet("year") !== targetLocal.year ||
    shiftedGet("month") !== targetLocal.month ||
    shiftedGet("day") !== targetLocal.day ||
    shiftedHour !== targetLocal.hour ||
    shiftedGet("minute") !== targetLocal.minute
  ) {
    return null;
  }

  return shifted;
}

function inheritActiveSchedulingYearIntoIntent(params: {
  intent: any;
  activeYear: number;
  timezone: string;
}) {
  const intent = params.intent;

  if (!intent?.hasPreference || intent?.customerSpecifiedDate !== true) {
    return intent;
  }

  const sourceYear = getResolvedIntentLocalYear({
    intent,
    timezone: params.timezone,
  });

  if (!sourceYear || sourceYear === params.activeYear) {
    return intent;
  }

  const years = params.activeYear - sourceYear;

  if (intent.localDateTime && intent.customerSpecifiedTime === true) {
    const inheritedLocalDateTime = {
      ...intent.localDateTime,
      year: params.activeYear,
    };

    const inheritedStartTime = zonedTimeToUtc({
      ...inheritedLocalDateTime,
      timezone: params.timezone,
    });

    const roundTrip = getLocalCalendarDateForIso(
      inheritedStartTime,
      params.timezone
    );

    if (
      !roundTrip ||
      roundTrip.year !== inheritedLocalDateTime.year ||
      roundTrip.month !== inheritedLocalDateTime.month ||
      roundTrip.day !== inheritedLocalDateTime.day
    ) {
      return intent;
    }

    const shiftedExcludedWindows = Array.isArray(intent.excludedWindows)
      ? intent.excludedWindows
          .map((window: any) => {
            const startTime = shiftIsoByLocalCalendarYears({
              iso: window.startTime,
              years,
              timezone: params.timezone,
            });
            const endTime = window.endTime
              ? shiftIsoByLocalCalendarYears({
                  iso: window.endTime,
                  years,
                  timezone: params.timezone,
                })
              : null;

            if (!startTime || (window.endTime && !endTime)) return null;
            return { startTime, endTime };
          })
          .filter(Boolean)
      : [];

    return {
      ...intent,
      allowedWindows: [{ startTime: inheritedStartTime, endTime: null }],
      excludedWindows: shiftedExcludedWindows,
      targetTime: inheritedStartTime,
      selectionMode: "closest",
      localDateTime: inheritedLocalDateTime,
      interpretation:
        intent.interpretation ??
        "Customer omitted the year while continuing an explicitly established future-year scheduling context.",
    };
  }

  const shiftWindow = (window: any) => {
    const startTime = shiftIsoByLocalCalendarYears({
      iso: window.startTime,
      years,
      timezone: params.timezone,
    });
    const endTime = window.endTime
      ? shiftIsoByLocalCalendarYears({
          iso: window.endTime,
          years,
          timezone: params.timezone,
        })
      : null;

    if (!startTime || (window.endTime && !endTime)) return null;
    if (
      endTime &&
      new Date(endTime).getTime() <= new Date(startTime).getTime()
    ) {
      return null;
    }

    return { startTime, endTime };
  };

  const shiftedAllowedWindows = Array.isArray(intent.allowedWindows)
    ? intent.allowedWindows.map(shiftWindow).filter(Boolean)
    : [];

  if (
    Array.isArray(intent.allowedWindows) &&
    shiftedAllowedWindows.length !== intent.allowedWindows.length
  ) {
    return intent;
  }

  const shiftedExcludedWindows = Array.isArray(intent.excludedWindows)
    ? intent.excludedWindows.map(shiftWindow).filter(Boolean)
    : [];

  if (
    Array.isArray(intent.excludedWindows) &&
    shiftedExcludedWindows.length !== intent.excludedWindows.length
  ) {
    return intent;
  }

  const shiftedTargetTime = intent.targetTime
    ? shiftIsoByLocalCalendarYears({
        iso: intent.targetTime,
        years,
        timezone: params.timezone,
      })
    : null;

  if (intent.targetTime && !shiftedTargetTime) {
    return intent;
  }

  return {
    ...intent,
    allowedWindows: shiftedAllowedWindows,
    excludedWindows: shiftedExcludedWindows,
    targetTime: shiftedTargetTime,
    interpretation:
      intent.interpretation ??
      "Customer omitted the year while continuing an explicitly established future-year scheduling context.",
  };
}

function extractOptionIndex(message: string, max: number) {
  /*
   * Surgical slot-selection normalization.
   *
   * Keep this local to option selection instead of changing normalizeSimpleText()
   * globally. That prevents colloquial ordinal aliases from affecting unrelated
   * inbound-email parsing, metadata extraction, time interpretation, or routing.
   *
   * Examples normalized deterministically here:
   *   "sec one" / "da sec one" / "the sec option" -> "second one/option"
   *   "fst one" / "fir option"                    -> "first one/option"
   *   "thrd one" / "trd option"                   -> "third one/option"
   *
   * The abbreviation is only expanded when it directly describes an offered-slot
   * noun, so ordinary uses of words such as "sec" are not globally reinterpreted.
   */
  const text = normalizeSimpleText(message)
    .replace(/\bda\b/g, "the")
    .replace(
      /\b(?:fst|fir)\b(?=\s+(?:one|option|slot|choice|opening|appointment|appt)\b)/g,
      "first"
    )
    .replace(
      /\b(?:sec|scnd|snd)\b(?=\s+(?:one|option|slot|choice|opening|appointment|appt)\b)/g,
      "second"
    )
    .replace(
      /\b(?:thrd|trd)\b(?=\s+(?:one|option|slot|choice|opening|appointment|appt)\b)/g,
      "third"
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!text || max <= 0) return null;
  if (hasNegativeBookingLanguage(text)) return null;

  // Duration arithmetic is not an offered-option ordinal.
  if (extractRelativeClockOffsetSurface(text)) return null;

  const explicitTimeLanguage =
    /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|morning|afternoon|evening|tonight|noon|midnight)\b/.test(
      text
    ) ||
    /\b(?:at|around|about|before|after|by)\s+(?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm)?\b/.test(
      text
    ) ||
    /\b(?:1[0-2]|0?[1-9])(?::[0-5][0-9])\s*(?:am|pm)?\b/.test(text) ||
    /\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/.test(text);

  const explicitOptionPatterns: Array<[RegExp, number]> = [
    [
      /\b(?:option|slot|choice|opening|appointment|appt|number|num)\s*(?:number\s*)?(?:1|one|first|1st)\b/,
      0,
    ],
    [
      /\b(?:option|slot|choice|opening|appointment|appt|number|num)\s*(?:number\s*)?(?:2|two|second|2nd|middle)\b/,
      1,
    ],
    [
      /\b(?:option|slot|choice|opening|appointment|appt|number|num)\s*(?:number\s*)?(?:3|three|third|3rd|last|latest|final|bottom)\b/,
      2,
    ],
    [/\b(?:first|1st)\s+(?:one|option|slot|choice|opening|appointment)\b/, 0],
    [/\b(?:second|2nd|middle)\s+(?:one|option|slot|choice|opening|appointment)\b/, 1],
    [/\b(?:third|3rd|last|final|bottom)\s+(?:one|option|slot|choice|opening|appointment)\b/, 2],
  ];

  for (const [pattern, index] of explicitOptionPatterns) {
    if (index < max && pattern.test(text)) {
      return index;
    }
  }

  /*
   * Fresh-calendar firewall: weak option shorthand must not steal a turn that
   * contains a literal calendar request. Explicit offer nouns above remain
   * valid because the customer actually anchored the offered list.
   */
  if (hasGroundedDateEvidence(text)) {
    return null;
  }

  /*
   * Generic action + option matching. This deliberately runs before the bare
   * numeric fallback so a long natural-language reply can say things like
   * "do 1", "book the second", or "put me down for option 3" while also
   * containing a name, phone number, email address, or service address.
   * Random digits in those metadata fields are not treated as slot choices.
   */
  const actionOptionPatterns: Array<[RegExp, number]> = [
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|appt\s+|number\s+|num\s+)?(?:1|one|first|1st)\b/,
      0,
    ],
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|appt\s+|number\s+|num\s+)?(?:2|two|second|2nd)\b/,
      1,
    ],
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|appt\s+|number\s+|num\s+)?(?:3|three|third|3rd)\b/,
      2,
    ],
  ];

  for (const [pattern, index] of actionOptionPatterns) {
    if (index < max && pattern.test(text)) {
      return index;
    }
  }

  const priorityAliases: Array<[RegExp, number]> = [
    [/\b(?:earliest|soonest|asap|first available|next available|top one)\b/, 0],
    [/\b(?:middle one|middle option|middle slot)\b/, 1],
    [/\b(?:last|latest|final|bottom one|last one|final one)\b/, max - 1],
  ];

  for (const [pattern, index] of priorityAliases) {
    if (index >= 0 && index < max && pattern.test(text)) {
      return index;
    }
  }

  /*
   * IMPORTANT DISAMBIGUATION RULE:
   *
   * Do not interpret an ordinal/number merely because it appears somewhere in
   * a longer customer message. Dates and other temporal requests legitimately
   * contain ordinals and small numbers.
   *
   * Explicit option/slang forms above remain intact:
   *   "option 2", "slot 3", "second one", "da sec one",
   *   "book the second", "take 2", "go with option 3", etc.
   *
   * Bare whole-message selections remain supported below through
   * extractOrdinalCandidatePhrases(), e.g. "1", "2", "3", "first",
   * "second", "third".
   *
   * What is intentionally removed is only the unsafe behavior that treated
   * an ordinal or small number ANYWHERE in an unrelated longer sentence as
   * an offered-slot selection.
   */

  const candidates = extractOrdinalCandidatePhrases(text);

  for (const candidate of candidates) {
    const index = parseOrdinalTextToIndex(candidate, max);

    if (index !== null) {
      return index;
    }
  }

  return null;
}

const SPOKEN_CLOCK_HOURS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const SPOKEN_CLOCK_MINUTES: Record<string, number> = {
  "oh five": 5,
  "zero five": 5,
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  "twenty five": 25,
  thirty: 30,
  "thirty five": 35,
  forty: 40,
  "forty five": 45,
  fifty: 50,
  "fifty five": 55,
};

function extractSpokenClockParts(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return null;

  const hourToken =
    "(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const minuteToken =
    "(?:oh\\s+five|zero\\s+five|five|ten|fifteen|twenty(?:\\s+five)?|thirty(?:\\s+five)?|forty(?:\\s+five)?|fifty(?:\\s+five)?)";

  const match = text.match(
    new RegExp(`\\b(${hourToken})\\s+(${minuteToken})\\s*(am|pm)?\\b`)
  );

  if (!match) return null;

  const hourText = match[1];
  const minuteText = match[2].replace(/\s+/g, " ");

  const rawHour = /^\d+$/.test(hourText)
    ? Number(hourText)
    : SPOKEN_CLOCK_HOURS[hourText];

  const minute = /^\d+$/.test(minuteText)
    ? Number(minuteText)
    : SPOKEN_CLOCK_MINUTES[minuteText];

  if (
    !Number.isInteger(rawHour) ||
    rawHour < 1 ||
    rawHour > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  let meridian = match[3] ?? null;
  if (!meridian) {
    if (/\bmorning\b/.test(text)) meridian = "am";
    if (/\b(?:afternoon|evening|tonight)\b/.test(text)) meridian = "pm";
  }

  let hour = rawHour;
  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;

  return {
    rawHour,
    hour,
    minute,
    hasMinute: true,
    hasMeridian: Boolean(meridian),
  };
}

function hasGroundedClockEvidence(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  /*
    Grounding invariant: a semantic resolver may classify a turn, but it may
    not invent a customer-specified clock time that has no surface evidence in
    the customer's actual message. Keep this deliberately syntax-based and
    phrase-agnostic.
  */
  if (/\b(?:noon|midnight)\b/.test(text)) return true;
  if (extractSpokenClockParts(text)) return true;
  if (/\b(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:am|pm)?\b/.test(text)) return true;
  if (/\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/.test(text)) return true;
  if (
    /\b(?:1[0-2]|0?[1-9])\s+(?:in\s+the\s+)?(?:morning|afternoon|evening)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(?:at|around|about|before|after|by)\s+(?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\b/.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

function hasBareClockCandidate(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  const hourToken =
    "(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

  /*
    Support conversational clock shorthand such as "make it 4" or "do four"
    without treating ordinals such as "second one" as clock times. Whether a
    bare candidate is allowed to act as time is decided later using the active
    pending-option context.
  */
  if (new RegExp(`^${hourToken}$`).test(text)) return true;

  return new RegExp(
    `\\b(?:make\\s+it|do|schedule(?:\\s+it)?(?:\\s+for)?|book(?:\\s+it)?(?:\\s+for)?|come(?:\\s+at)?|arrive(?:\\s+at)?|move(?:\\s+it)?(?:\\s+to)?|change(?:\\s+it)?(?:\\s+to)?|switch(?:\\s+it)?(?:\\s+to)?|reschedule(?:\\s+it)?(?:\\s+to)?)\\s+(?:the\\s+)?${hourToken}\\b`
  ).test(text);
}


function getLocalClockForIso(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const rawHour = get("hour");
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = get("minute");

  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { hour, minute };
}

function extractTrailingBareClockHour(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return null;

  const wordHours: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  const match = text.match(
    /\b(1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*$/
  );

  if (!match) return null;

  const token = match[1];
  const numeric = /^\d+$/.test(token)
    ? Number(token)
    : wordHours[token] ?? null;

  if (!numeric || numeric < 1 || numeric > 12) return null;

  return numeric;
}

function isBareClockOnlySurface(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return false;

  return /^(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(
    text
  );
}

function resolveUniquePendingBareClockReference(params: {
  message: string;
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  if (params.alternatives.length === 0) return null;

  const text = normalizeSimpleText(params.message);
  if (!text) return null;

  /*
   * Context-reference invariant:
   * A bare 1-12 token may refer to an already-offered CLOCK, but only when
   * exactly one persisted pending slot has that exact whole-hour local clock.
   * This resolves WHAT the shorthand refers to; it does not by itself decide
   * whether the customer authorized a booking mutation.
   */
  if (hasGroundedDateEvidence(text) || hasGroundedClockEvidence(text)) {
    return null;
  }

  if (/\b(?:option|slot|choice|opening|number|num)\b/.test(text)) {
    return null;
  }

  const rawHour = extractTrailingBareClockHour(text);
  if (rawHour === null) return null;

  const matches = params.alternatives
    .map((slot, index) => {
      const clock = getLocalClockForIso(slot.startTime, params.timezone);
      if (!clock) return null;

      const local12 = clock.hour % 12 || 12;
      if (local12 !== rawHour || clock.minute !== 0) return null;

      return {
        rawHour,
        optionNumber: index + 1,
        startTime: slot.startTime,
        endTime: slot.endTime ?? null,
      };
    })
    .filter(Boolean) as Array<{
      rawHour: number;
      optionNumber: number;
      startTime: string;
      endTime: string | null;
    }>;

  return matches.length === 1 ? matches[0] : null;
}

function hasWeekdayPlusTrailingBareClock(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return false;

  /*
   * A booked reschedule such as "move it to saturday 9" contains a genuine
   * date-bearing weekday plus a conversational bare clock. The old generic
   * bare-clock guard only recognized shapes like "move it to 9", so inserting
   * the weekday caused the explicit 9 to be dropped and the system fell back
   * to date-only options.
   *
   * Keep this deliberately narrow and reject explicit option vocabulary so
   * "Saturday option 2" can never be reinterpreted as 2 o'clock.
   */
  if (
    /\b(?:option|slot|choice|opening|number|num)\b/.test(text)
  ) {
    return false;
  }

  const weekday =
    "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)";
  const hour =
    "(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

  return new RegExp(
    `\\b${weekday}\\b(?:\\s+(?:at|around|about))?\\s+${hour}\\s*$`
  ).test(text);
}

function hasCurrentAppointmentTimeReference(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return false;

  /*
   * Reschedule dimension-preservation invariant.
   *
   * This helper does not invent a clock. It only recognizes that the customer
   * is explicitly referring back to the CURRENT appointment's clock while
   * changing another scheduling dimension (normally the date/weekday).
   *
   * It is consulted only inside an already-confirmed reschedule context, and
   * an explicit new clock still wins because grounded clock evidence bypasses
   * this inheritance path entirely.
   */
  return (
    /\b(?:same|current|existing|original|previous)\s+(?:time|hour)\b/.test(text) ||
    /\b(?:keep|leave|retain|use)\s+(?:(?:it|that)\s+)?(?:at\s+)?(?:the\s+)?(?:same\s+)?(?:time|hour)\b/.test(text) ||
    /\b(?:at|for)\s+(?:the\s+)?same\s+(?:time|hour)\b/.test(text)
  );
}

function resolveContextualBareHourFromCurrentAppointment(params: {
  message: string;
  currentAppointmentTime: string | null | undefined;
  timezone: string;
  isRescheduleCommand: boolean;
}) {
  if (!params.currentAppointmentTime) return null;
  if (hasGroundedClockEvidence(params.message)) return null;
  if (!hasGroundedDateEvidence(params.message)) return null;
  if (!params.isRescheduleCommand) return null;

  const keepCurrentAppointmentClock =
    hasCurrentAppointmentTimeReference(params.message);

  if (
    !keepCurrentAppointmentClock &&
    !hasBareClockCandidate(params.message) &&
    !hasWeekdayPlusTrailingBareClock(params.message)
  ) {
    return null;
  }

  const currentClock = getLocalClockForIso(
    params.currentAppointmentTime,
    params.timezone
  );

  if (!currentClock) return null;

  if (keepCurrentAppointmentClock) {
    return {
      rawHour: currentClock.hour,
      hour: currentClock.hour,
      minute: currentClock.minute,
      source: "current_appointment_clock_reference" as const,
    };
  }

  const rawHour = extractTrailingBareClockHour(params.message);
  if (!rawHour) return null;

  /*
   * Bare 12-hour shorthand inherits the most plausible AM/PM context from
   * the appointment being changed. This avoids an extra confirmation while
   * remaining contextual instead of globally assuming AM or PM.
   *
   * Examples:
   *   current noon  + "Friday 12" -> 12 PM
   *   current 2 PM  + "Friday 3"  -> 3 PM
   *   current 9 AM  + "Friday 10" -> 10 AM
   *
   * Ties preserve the current appointment's AM/PM half-day.
   */
  const base = rawHour % 12;
  const amHour = base;
  const pmHour = base + 12;

  const amDistance = Math.abs(currentClock.hour - amHour);
  const pmDistance = Math.abs(currentClock.hour - pmHour);

  let hour: number;

  if (amDistance < pmDistance) {
    hour = amHour;
  } else if (pmDistance < amDistance) {
    hour = pmHour;
  } else {
    hour = currentClock.hour >= 12 ? pmHour : amHour;
  }

  return {
    rawHour,
    hour,
    minute: 0,
    source: "bare_hour_context" as const,
  };
}

function getContextualPendingClockReference(params: {
  qualification?: Record<string, any> | null;
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  const schedulingIntent = params.qualification?.schedulingIntent;
  const priorTargetTime =
    schedulingIntent?.customerSpecifiedTime === true &&
    typeof schedulingIntent?.targetTime === "string"
      ? schedulingIntent.targetTime
      : null;

  if (priorTargetTime) {
    const clock = getLocalClockForIso(priorTargetTime, params.timezone);
    if (clock) return clock;
  }

  const pending = params.qualification?.pendingSlotSuggestion as
    | PendingSlotSuggestion
    | undefined;

  if (pending?.originalRequestedStartTime) {
    const clock = getLocalClockForIso(
      String(pending.originalRequestedStartTime),
      params.timezone
    );

    if (clock) {
      const hasMeaningfulClock = clock.hour !== 0 || clock.minute !== 0;
      if (hasMeaningfulClock) return clock;
    }
  }

  const offeredClocks = params.alternatives
    .map((slot) => getLocalClockForIso(slot.startTime, params.timezone))
    .filter(Boolean) as Array<{ hour: number; minute: number }>;

  if (offeredClocks.length === 0) return null;

  const minutes = offeredClocks
    .map((clock) => clock.hour * 60 + clock.minute)
    .sort((a, b) => a - b);
  const midpoint = minutes[Math.floor(minutes.length / 2)];

  return {
    hour: Math.floor(midpoint / 60),
    minute: midpoint % 60,
  };
}

function resolveContextualPendingBareClock(params: {
  message: string;
  qualification?: Record<string, any> | null;
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  if (hasGroundedClockEvidence(params.message)) return null;
  if (!hasWeekdayPlusTrailingBareClock(params.message)) return null;

  const rawHour = extractTrailingBareClockHour(params.message);
  if (!rawHour) return null;

  const referenceClock = getContextualPendingClockReference({
    qualification: params.qualification,
    alternatives: params.alternatives,
    timezone: params.timezone,
  });

  if (!referenceClock) return null;

  const base = rawHour % 12;
  const amHour = base;
  const pmHour = base + 12;
  const referenceMinutes = referenceClock.hour * 60 + referenceClock.minute;
  const amMinutes = amHour * 60;
  const pmMinutes = pmHour * 60;
  const amDistance = Math.abs(referenceMinutes - amMinutes);
  const pmDistance = Math.abs(referenceMinutes - pmMinutes);

  const referenceIsPm = referenceClock.hour >= 12;
  const hour =
    amDistance < pmDistance
      ? amHour
      : pmDistance < amDistance
        ? pmHour
        : referenceIsPm
          ? pmHour
          : amHour;

  return {
    rawHour,
    hour,
    minute: 0,
    hasMinute: false,
    hasMeridian: false,
    referenceClock,
  };
}

/*
 * Confirmed contact fields are data, not calendar constraints. Mask only the
 * exact current lead values; retain the rest of a mixed reply so a genuinely
 * new date/time still overrides the selected offer. Never discard a whole
 * requirements-completion message or bypass temporal conflict checks.
 */
function getBookingReplyTemporalEvidenceText(params: {
  message: string;
  phone?: string | null;
  address?: string | null;
}) {
  let text = normalizeSimpleText(params.message);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const address = normalizeSimpleText(params.address ?? "");
  if (address) {
    const pattern = address.split(/\s+/).map(escape).join("\\s+");
    text = text.replace(new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, "g"), " ");
  }
  const phoneDigits = String(params.phone ?? "").replace(/\D/g, "");
  if (phoneDigits.length >= 7 && phoneDigits.length <= 15) {
    const pattern = phoneDigits.split("").join("[\\s().+\\-]*");
    text = text.replace(new RegExp(`(?<![0-9])${pattern}(?![0-9])`, "g"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function hasGroundedDateEvidence(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;

  return (
    /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(
      text
    ) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(
      text
    ) ||
    /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text) ||
    /\b\d{4}\b/.test(text) ||
    /\b(?:next|this|following|coming)\s+(?:day|week|weekend|month|year)\b/.test(text) ||
    /\b(?:in|within)\s+\d+\s+(?:day|days|week|weeks|month|months)\b/.test(text)
  );
}

function hasGroundedTemporalSurfaceEvidence(message: string) {
  const text = normalizeSimpleText(message);

  return (
    hasGroundedClockEvidence(text) ||
    hasGroundedDateEvidence(text) ||
    /\b(?:morning|afternoon|evening|tonight|noon|midnight)\b/.test(text) ||
    /\b(?:before|after|between|during|until|later|earlier)\b/.test(text)
  );
}

function extractRequestedTimeParts(message: string) {
  const text = normalizeSimpleText(message);

  const spokenClock = extractSpokenClockParts(text);
  if (spokenClock) return spokenClock;

  const match = text.match(
    /\b(1[0-2]|0?[1-9])(?::([0-5][0-9]))?\s*(am|pm)?\b/
  );

  if (!match) return null;

  let hour = Number(match[1]);
  const rawHour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  let meridian = match[3] ?? null;

  if (!meridian) {
    if (/\bmorning\b/.test(text)) meridian = "am";
    if (/\bafternoon|evening|tonight\b/.test(text)) meridian = "pm";
  }

  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;

  return {
    rawHour,
    hour,
    minute,
    hasMinute: Boolean(match[2]),
    hasMeridian: Boolean(meridian),
  };
}

function extractRelativeClockOffsetSurface(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return null;

  const quantity =
    "(?:\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half(?:\\s+an?)?)";
  const clock =
    "(?:noon|midnight|(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::[0-5][0-9])?\\s*(?:am|pm)?)";
  const match = text.match(
    new RegExp(
      `\\b(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\s+(after|before)\\s+(?:at\\s+)?(${clock})\\b`
    )
  );
  if (!match) return null;

  const numberWords: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const quantityText = match[1].replace(/\s+/g, " ").trim();
  const amount = quantityText.startsWith("half")
    ? 0.5
    : /^\d/.test(quantityText)
      ? Number(quantityText)
      : numberWords[quantityText];
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const anchorText = match[4].replace(/\s+/g, " ").trim();
  let anchorRawHour: number;
  let anchorHour24: number | null = null;
  let anchorMinute = 0;

  if (anchorText === "noon") {
    anchorRawHour = 12;
    anchorHour24 = 12;
  } else if (anchorText === "midnight") {
    anchorRawHour = 12;
    anchorHour24 = 0;
  } else {
    const anchorMatch = anchorText.match(
      /^(1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::([0-5][0-9]))?\s*(am|pm)?$/
    );
    if (!anchorMatch) return null;

    anchorRawHour = /^\d+$/.test(anchorMatch[1])
      ? Number(anchorMatch[1])
      : SPOKEN_CLOCK_HOURS[anchorMatch[1]];
    anchorMinute = anchorMatch[2] ? Number(anchorMatch[2]) : 0;

    if (anchorMatch[3]) {
      anchorHour24 = anchorRawHour % 12;
      if (anchorMatch[3] === "pm") anchorHour24 += 12;
    }
  }

  const minutesPerUnit = /^h(?:ou)?r/.test(match[2]) ? 60 : 1;
  const signedMinutes =
    amount * minutesPerUnit * (match[3] === "before" ? -1 : 1);

  return {
    signedMinutes,
    anchorRawHour,
    anchorHour24,
    anchorMinute,
  };
}

function resolveRelativeClockOffsetAgainstActiveOffers(params: {
  message: string;
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  const surface = extractRelativeClockOffsetSurface(params.message);
  if (!surface || params.alternatives.length === 0) return null;

  const anchorMatches = params.alternatives.filter((slot) => {
    const local = getLocalClockForIso(slot.startTime, params.timezone);
    if (!local) return false;
    if (surface.anchorHour24 !== null) {
      return local.hour === surface.anchorHour24 && local.minute === surface.anchorMinute;
    }
    return (local.hour % 12 || 12) === surface.anchorRawHour &&
      local.minute === surface.anchorMinute;
  });

  let anchorStartTime: string | null =
    anchorMatches.length === 1 ? anchorMatches[0].startTime : null;

  if (!anchorStartTime && anchorMatches.length === 0 && surface.anchorHour24 !== null) {
    const date = resolveUnambiguousPendingCalendarDate({
      alternatives: params.alternatives,
      timezone: params.timezone,
    });
    if (date) {
      anchorStartTime = zonedTimeToUtc({
        ...date,
        hour: surface.anchorHour24,
        minute: surface.anchorMinute,
        timezone: params.timezone,
      });
    }
  }

  // Bare AM/PM with no unique active clock anchor is ambiguous: do not guess.
  if (!anchorStartTime) return null;

  const resolvedStartTime = addMinutesUtc(anchorStartTime, surface.signedMinutes);
  const date = getLocalCalendarDateForIso(resolvedStartTime, params.timezone);
  const clock = getLocalClockForIso(resolvedStartTime, params.timezone);
  if (!date || !clock) return null;

  return {
    anchorStartTime,
    signedMinutes: surface.signedMinutes,
    resolvedStartTime,
    localDateTime: { ...date, hour: clock.hour, minute: clock.minute },
  };
}

function getSlotLocalParts(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));

  const get = (type: string) => parts.find((part) => part.type === type)?.value;

  return {
    weekday: String(get("weekday") ?? "").toLowerCase(),
    hour: Number(get("hour") ?? 0),
    minute: Number(get("minute") ?? 0),
  };
}


type PendingOfferedSlotSurfaceConstraints = {
  weekdayIndex: number | null;
  month: number | null;
  day: number | null;
  year: number | null;
  clock: ReturnType<typeof extractRequestedTimeParts>;
};

const PENDING_MONTH_ALIASES: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function getPendingOfferedSlotLocalParts(
  iso: string,
  timezone: string
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? null;

  const rawHour = Number(get("hour"));
  const hour = rawHour === 24 ? 0 : rawHour;

  const local = {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: String(get("weekday") ?? "").toLowerCase(),
    hour,
    minute: Number(get("minute")),
  };

  if (
    !Number.isInteger(local.year) ||
    !Number.isInteger(local.month) ||
    !Number.isInteger(local.day) ||
    !Number.isInteger(local.hour) ||
    !Number.isInteger(local.minute)
  ) {
    return null;
  }

  return local;
}

function extractPendingOfferedSlotSurfaceConstraints(
  message: string
): PendingOfferedSlotSurfaceConstraints {
  const text = normalizeSimpleText(message);

  const weekdayIndex = getExplicitWeekdayIndex(text);

  let month: number | null = null;
  for (const [token, monthNumber] of Object.entries(PENDING_MONTH_ALIASES)) {
    if (new RegExp(`\\b${token}\\b`).test(text)) {
      month = monthNumber;
      break;
    }
  }

  const yearMatch = text.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  /*
   * Extract a customer-supplied day-of-month without confusing the clock
   * itself ("8:30") or an explicit option number ("option 2") with a date.
   *
   * This supports conversational shorthand such as:
   *   "23 8:30"
   *   "do the 23rd at 8:30"
   *
   * When multiple independent bare day candidates remain, do not guess.
   */
  const clockSpans: Array<{ start: number; end: number }> = [];
  const clockRegex = /\b(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:am|pm)?\b/g;
  let clockMatch: RegExpExecArray | null;

  while ((clockMatch = clockRegex.exec(text)) !== null) {
    clockSpans.push({
      start: clockMatch.index,
      end: clockMatch.index + clockMatch[0].length,
    });
  }

  const insideClock = (start: number, end: number) =>
    clockSpans.some((span) => start >= span.start && end <= span.end);

  const explicitOrdinal = text.match(
    /\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b/
  );

  let day: number | null = explicitOrdinal
    ? Number(explicitOrdinal[1])
    : null;

  if (day === null && month !== null) {
    const monthTokens = Object.entries(PENDING_MONTH_ALIASES)
      .filter(([, monthNumber]) => monthNumber === month)
      .map(([token]) => token)
      .sort((a, b) => b.length - a.length)
      .join("|");

    const monthDay = text.match(
      new RegExp(
        `\\b(?:${monthTokens})\\s+([1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\b`
      )
    );

    const dayMonth = text.match(
      new RegExp(
        `\\b([1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?\\s+(?:${monthTokens})\\b`
      )
    );

    day = monthDay
      ? Number(monthDay[1])
      : dayMonth
        ? Number(dayMonth[1])
        : null;
  }

  if (day === null) {
    const candidates: number[] = [];
    const bareDayRegex = /\b([1-9]|[12]\d|3[01])\b/g;
    let match: RegExpExecArray | null;

    while ((match = bareDayRegex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      if (insideClock(start, end)) continue;

      const before = text.slice(Math.max(0, start - 18), start);
      if (/\b(?:option|slot|choice)\s*$/.test(before)) continue;

      candidates.push(Number(match[1]));
    }

    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length === 1) {
      day = uniqueCandidates[0];
    }
  }

  const clock = hasGroundedClockEvidence(text)
    ? extractRequestedTimeParts(text)
    : hasBareClockCandidate(text)
      ? extractRequestedTimeParts(text)
      : null;

  return {
    weekdayIndex,
    month,
    day,
    year,
    clock,
  };
}

function pendingOfferedSlotReferenceMatchesMessage(params: {
  message: string;
  slotStart: string;
  timezone: string;
}) {
  const constraints = extractPendingOfferedSlotSurfaceConstraints(
    params.message
  );
  const slot = getPendingOfferedSlotLocalParts(
    params.slotStart,
    params.timezone
  );

  if (!slot) return false;

  if (
    constraints.weekdayIndex !== null &&
    getWeekdayIndexForLocalDate({
      year: slot.year,
      month: slot.month,
      day: slot.day,
    }) !== constraints.weekdayIndex
  ) {
    return false;
  }

  if (constraints.month !== null && slot.month !== constraints.month) {
    return false;
  }

  if (constraints.day !== null && slot.day !== constraints.day) {
    return false;
  }

  if (constraints.year !== null && slot.year !== constraints.year) {
    return false;
  }

  if (constraints.clock) {
    const requested = constraints.clock;

    const hourMatches =
      requested.hour === slot.hour ||
      (
        !requested.hasMeridian &&
        (
          requested.rawHour === slot.hour ||
          requested.rawHour + 12 === slot.hour ||
          (requested.rawHour === 12 && slot.hour === 0)
        )
      );

    if (!hourMatches) return false;

    if (requested.hasMinute && requested.minute !== slot.minute) {
      return false;
    }
  }

  return true;
}

function messageConfirmsBooking(message: string) {
  const text = normalizeSimpleText(message);

  if (!text) return false;
  if (hasNegativeBookingLanguage(text)) return false;

  return hasPositiveBookingLanguage(text);
}

function scorePendingSlotMatch(params: {
  message: string;
  slotStart: string;
  timezone: string;
}) {
  const text = normalizeSimpleText(params.message);
  const requested = hasGroundedClockEvidence(text)
    ? extractRequestedTimeParts(text)
    : null;
  const slot = getSlotLocalParts(params.slotStart, params.timezone);

  let score = 0;

  if (text.includes(slot.weekday)) score += 35;

  if (requested) {
    const exactHour = requested.hour === slot.hour;
    const possibleNoMeridianHour =
      !requested.hasMeridian &&
      (requested.rawHour === slot.hour || requested.rawHour + 12 === slot.hour);

    const hourMatches = exactHour || possibleNoMeridianHour;

    if (hourMatches) {
      score += 55;

      const minuteDistance = Math.abs(requested.minute - slot.minute);

      /*
       * Exact-minute invariant for offered-slot selection.
       *
       * When the customer actually supplies minutes, an offered slot may own
       * the turn only when those minutes match exactly. A request for 9:30 is
       * a fresh clock request when the offered slot is 9:00; it must never be
       * rounded/coerced to the offered hour merely because the hour matches.
       */
      if (requested.hasMinute && minuteDistance === 0) score += 45;
      else if (requested.hasMinute) score -= 100;
      else if (!requested.hasMinute && slot.minute <= 15) score += 35;
      else if (!requested.hasMinute && slot.minute <= 45) score += 15;
    } else {
      score -= 100;
    }
  }

  if (messageConfirmsBooking(text)) score += 30;

  return score;
}

function resolvePendingSlotConfirmation(params: {
  message: string;
  qualification?: Record<string, any> | null;
  timezone: string;
}): PendingSlotMatch {
  const slots = getPendingSuggestionSlots(params.qualification);

  if (slots.length === 0) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "no_pending_slot_suggestion",
      confidence: "low",
    };
  }

  const optionIndex = extractOptionIndex(params.message, slots.length);

  if (optionIndex !== null) {
    const slot = slots[optionIndex];

    return {
      matched: true,
      startTime: slot.startTime,
      endTime: slot.endTime ?? null,
      reason: "matched_option_or_slang_reference",
      confidence: "high",
    };
  }
  /*
   * Offered-clock fallback for conversational bare-hour selections.
   *
   * A valid offered option index above always wins. When there is no valid
   * option index, a booking-confirming bare 1-12 may resolve to an already-
   * offered clock time only when exactly ONE pending slot matches that hour.
   * Explicit option/slot vocabulary is never reinterpreted as a clock, and
   * zero/multiple matches remain ambiguous.
   */
  const normalizedPendingSelection = normalizeSimpleText(params.message);
  const uniqueOfferedBareClockReference =
    resolveUniquePendingBareClockReference({
      message: params.message,
      alternatives: slots,
      timezone: params.timezone,
    });

  /*
   * If the customer's entire reply is just a bare clock and exactly one active
   * persisted offer has that clock, the offered context itself disambiguates
   * the reference. This is the clock equivalent of choosing an offered option.
   * Longer/question-shaped turns still go through the semantic action gate.
   */
  if (
    uniqueOfferedBareClockReference &&
    isBareClockOnlySurface(normalizedPendingSelection)
  ) {
    return {
      matched: true,
      startTime: uniqueOfferedBareClockReference.startTime,
      endTime: uniqueOfferedBareClockReference.endTime,
      reason: "matched_contextual_offered_bare_clock_reference",
      confidence: "high",
    };
  }

  const explicitlyNamesOfferOrdinal =
    /\b(?:option|slot|choice|opening|appointment|appt|number|num)\b/.test(
      normalizedPendingSelection
    ) ||
    /\b\d{1,2}(?:st|nd|rd|th)\b/.test(normalizedPendingSelection);

  if (
    !explicitlyNamesOfferOrdinal &&
    !hasGroundedDateEvidence(normalizedPendingSelection) &&
    messageConfirmsBooking(normalizedPendingSelection)
  ) {
    const bareClock = extractRequestedTimeParts(normalizedPendingSelection);

    if (bareClock && !bareClock.hasMinute && !bareClock.hasMeridian) {
      const clockMatches = slots.filter((slot) => {
        const local = getSlotLocalParts(slot.startTime, params.timezone);
        const local12 = local.hour % 12 || 12;
        return local12 === bareClock.rawHour && local.minute === 0;
      });

      if (clockMatches.length === 1) {
        return {
          matched: true,
          startTime: clockMatches[0].startTime,
          endTime: clockMatches[0].endTime ?? null,
          reason: "matched_unique_offered_bare_clock",
          confidence: "high",
        };
      }
    }
  }

  /*
    Contextual weekday + option reference, e.g. "Thursday 2" after we just
    offered three Thursday slots. This is allowed only when every active
    offered slot is on that same weekday and the trailing token is a valid
    offered-option ordinal. Explicit clock syntax is excluded, so
    "Thursday at 2" / "Thursday 2 PM" remain fresh scheduling requests.
  */
  if (!hasGroundedClockEvidence(params.message)) {
    const normalized = normalizeSimpleText(params.message);
    const contextualMatch = normalized.match(
      /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s+(?:option\s+|slot\s+|choice\s+)?(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth)$/
    );

    if (contextualMatch) {
      const weekdayAliases: Record<string, string> = {
        sun: "sunday",
        mon: "monday",
        tue: "tuesday",
        tues: "tuesday",
        wed: "wednesday",
        thu: "thursday",
        thur: "thursday",
        thurs: "thursday",
        fri: "friday",
        sat: "saturday",
      };
      const requestedWeekday =
        weekdayAliases[contextualMatch[1]] ?? contextualMatch[1];
      const contextualOptionIndex = parseOrdinalTextToIndex(
        contextualMatch[2],
        slots.length
      );
      const allOfferedSlotsMatchWeekday = slots.every(
        (slot) =>
          getSlotLocalParts(slot.startTime, params.timezone).weekday ===
          requestedWeekday
      );

      if (contextualOptionIndex !== null && allOfferedSlotsMatchWeekday) {
        const slot = slots[contextualOptionIndex];
        return {
          matched: true,
          startTime: slot.startTime,
          endTime: slot.endTime ?? null,
          reason: "matched_contextual_weekday_option_reference",
          confidence: "high",
        };
      }
    }
  }

  if (slots.length === 1 && messageConfirmsBooking(params.message)) {
    const hasLiteralTemporalConstraint =
      hasGroundedTemporalSurfaceEvidence(params.message);
    const literalConstraintMatchesOnlyOffer =
      !hasLiteralTemporalConstraint ||
      pendingOfferedSlotReferenceMatchesMessage({
        message: params.message,
        slotStart: slots[0].startTime,
        timezone: params.timezone,
      });

    if (literalConstraintMatchesOnlyOffer) {
      return {
        matched: true,
        startTime: slots[0].startTime,
        endTime: slots[0].endTime ?? null,
        reason: "single_pending_slot_confirmed",
        confidence: "high",
      };
    }
  }

  const scored = slots
    .map((slot, index) => ({
      index,
      slot,
      score: scorePendingSlotMatch({
        message: params.message,
        slotStart: slot.startTime,
        timezone: params.timezone,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (!best || best.score < 60) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "pending_slot_confirmation_too_ambiguous_or_not_offered",
      confidence: "low",
    };
  }

  if (second && best.score - second.score < 15) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "multiple_pending_slots_too_close",
      confidence: "medium",
    };
  }

  return {
    matched: true,
    startTime: best.slot.startTime,
    endTime: best.slot.endTime ?? null,
    reason: "matched_by_natural_language_time",
    confidence: "high",
  };
}

function forceExtractBookingWindow(
  message: string,
  timezone: string,
  referenceTime?: string | null
) {
  const lower = normalizeSimpleText(message);

  /*
   * This fallback is only allowed to interpret an actual clock expression.
   * A bare small number can be a date/day/option and must not silently become
   * a clock time. This remains phrase-agnostic and date-agnostic.
   */
  const requestedClock = hasGroundedClockEvidence(lower)
    ? extractRequestedTimeParts(lower)
    : null;

  if (!requestedClock) {
    return {
      start: null,
      end: null,
    };
  }

  const hour = requestedClock.hour;
  const minute = requestedClock.minute;

  const referenceTimeMs =
    referenceTime && !Number.isNaN(new Date(referenceTime).getTime())
      ? new Date(referenceTime).getTime()
      : Date.now();

  const referenceLocalDate =
    getLocalCalendarDateForIso(
      new Date(referenceTimeMs).toISOString(),
      timezone
    ) ?? getNowInTimezone(timezone);

  let localDate = {
    year: referenceLocalDate.year,
    month: referenceLocalDate.month,
    day: referenceLocalDate.day,
  };

  const weekdays: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  if (lower.includes("tomorrow")) {
    localDate = addDaysToLocalDate({
      ...localDate,
      days: 1,
    });
  } else {
    const todayWeekday = getWeekdayIndexForLocalDate(localDate);
    let foundWeekday = false;

    for (const [name, targetWeekday] of Object.entries(weekdays)) {
      if (lower.includes(name)) {
        foundWeekday = true;

        let daysUntil = targetWeekday - todayWeekday;
        if (daysUntil <= 0) daysUntil += 7;

        localDate = addDaysToLocalDate({
          ...localDate,
          days: daysUntil,
        });

        break;
      }
    }

    const candidate = zonedTimeToUtc({
      ...localDate,
      hour,
      minute,
      timezone,
    });

    if (
      !foundWeekday &&
      !lower.includes("today") &&
      new Date(candidate).getTime() <= referenceTimeMs
    ) {
      localDate = addDaysToLocalDate({
        ...localDate,
        days: 1,
      });
    }
  }

  const start = zonedTimeToUtc({
    ...localDate,
    hour,
    minute,
    timezone,
  });

  return {
    start,
    end: addMinutesUtc(start, 90),
  };
}



type ExplicitRelativeWeekdayRelation = {
  weekdayIndex: number;
  weekdayName: string;
  relation:
    | "current_week"
    | "previous_week"
    | "next_week"
    | "week_before_last"
    | "week_after_next"
    | "previous_occurrence"
    | "next_occurrence";
};

const EXPLICIT_RELATIVE_WEEKDAYS: Array<{
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

function getExplicitRelativeWeekdayRelation(
  message: string
): ExplicitRelativeWeekdayRelation | null {
  const text = normalizeSimpleText(message);
  if (!text) return null;

  for (const weekday of EXPLICIT_RELATIVE_WEEKDAYS) {
    /*
     * Generic weekday-relative grammar. Full customer sentences are never
     * hardcoded; surface variants normalize into a small calendar relation set.
     * For reschedules the authoritative anchor is the active appointment.
     */

    const weekBeforeLastPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:in\\s+)?(?:the\\s+)?week\\s+before\\s+last\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?week\\s+before\\s+last(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:from\\s+)?two\\s+weeks\\s+ago\\b`,
        "i"
      ),
      new RegExp(
        `\\btwo\\s+weeks\\s+ago(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
    ];

    if (weekBeforeLastPatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "week_before_last",
      };
    }

    const weekAfterNextPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:the\\s+)?(?:week\\s+)?after\\s+next(?:\\s+(${weekday.pattern}))?\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:in\\s+)?(?:the\\s+)?week\\s+after\\s+next\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?week\\s+after\\s+next(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:in\\s+)?two\\s+weeks(?:\\s+from\\s+now)?\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:in\\s+)?two\\s+weeks(?:\\s+from\\s+now)?(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
    ];

    if (weekAfterNextPatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "week_after_next",
      };
    }

    const previousWeekPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:of\\s+)?(?:last|previous|prior)\\s+week\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:last|previous|prior)\\s+week(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
    ];

    if (previousWeekPatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "previous_week",
      };
    }

    const nextWeekPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:of\\s+)?(?:(?:this\\s+)?coming|next|following)\\s+week\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:(?:this\\s+)?coming|next|following)\\s+week(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      // Preserve established natural-language meaning of "next Monday".
      new RegExp(
        `\\b(?:next|following|coming|upcoming)\\s+(${weekday.pattern})\\b`,
        "i"
      ),
    ];

    if (nextWeekPatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "next_week",
      };
    }

    const currentWeekPatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:of\\s+)?this\\s+week\\b`,
        "i"
      ),
      new RegExp(
        `\\bthis\\s+week(?:'s)?\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\bthis\\s+(${weekday.pattern})\\b`,
        "i"
      ),
    ];

    if (currentWeekPatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "current_week",
      };
    }

    const previousOccurrencePatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:(?:immediately|right)\\s+)?(?:before|prior|previous|preceding|earlier)\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(?:prior|previous|preceding|last)\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:immediately\\s+)?before\\s+(?:that|it|the\\s+(?:appointment|booking|current\\s+appointment))\\b`,
        "i"
      ),
    ];

    if (previousOccurrencePatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "previous_occurrence",
      };
    }

    const nextOccurrencePatterns = [
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:(?:immediately|right)\\s+)?(?:after|later|following)\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(?:subsequent)\\s+(${weekday.pattern})\\b`,
        "i"
      ),
      new RegExp(
        `\\b(?:the\\s+)?(${weekday.pattern})\\s+(?:immediately\\s+)?after\\s+(?:that|it|the\\s+(?:appointment|booking|current\\s+appointment))\\b`,
        "i"
      ),
    ];

    if (nextOccurrencePatterns.some((pattern) => pattern.test(text))) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        relation: "next_occurrence",
      };
    }
  }

  return null;
}

function hasExplicitRelativeWeekdayRelation(message: string) {
  return getExplicitRelativeWeekdayRelation(message) !== null;
}

type ExplicitRelativeWeekdayMonthScope = {
  month: number;
  year: number;
};

function getExplicitRelativeWeekdayMonthScope(params: {
  message: string;
  timezone: string;
  referenceIso: string;
}): ExplicitRelativeWeekdayMonthScope | null {
  const text = normalizeSimpleText(params.message);
  if (!text) return null;

  const monthAliases = Object.entries(PENDING_MONTH_ALIASES).sort(
    ([a], [b]) => b.length - a.length
  );

  let month: number | null = null;
  let monthToken: string | null = null;

  for (const [token, monthNumber] of monthAliases) {
    if (new RegExp(`\\b${token}\\b`).test(text)) {
      month = monthNumber;
      monthToken = token;
      break;
    }
  }

  if (month === null || !monthToken) return null;

  const referenceDate =
    getLocalCalendarDateForIso(params.referenceIso, params.timezone) ??
    getNowInTimezone(params.timezone);

  const explicitYearMatch = text.match(/\b(20\d{2})\b/);
  const explicitYear = explicitYearMatch
    ? Number(explicitYearMatch[1])
    : null;

  if (
    explicitYear !== null &&
    Number.isInteger(explicitYear) &&
    explicitYear >= 2000 &&
    explicitYear <= 9999
  ) {
    return { month, year: explicitYear };
  }

  const escapedMonthToken = monthToken.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const modifierMatch = text.match(
    new RegExp(
      `\\b(next|coming|following|this)\\s+${escapedMonthToken}\\b`
    )
  );
  const modifier = modifierMatch?.[1] ?? null;

  if (modifier === "this") {
    return { month, year: referenceDate.year };
  }

  if (
    modifier === "next" ||
    modifier === "coming" ||
    modifier === "following"
  ) {
    return {
      month,
      year:
        month > referenceDate.month
          ? referenceDate.year
          : referenceDate.year + 1,
    };
  }

  // A bare named month is an upcoming calendar-month scope. It only changes
  // relative-weekday behavior when both surfaces coexist in the same message.
  return {
    month,
    year:
      month >= referenceDate.month
        ? referenceDate.year
        : referenceDate.year + 1,
  };
}

function describeExplicitRelativeWeekdayRelation(
  relation: ExplicitRelativeWeekdayRelation,
  monthScoped: boolean
) {
  if (relation.relation === "previous_occurrence") {
    return `Explicit ${relation.weekdayName}-before relation enforced against the authoritative scheduling reference.`;
  }
  if (relation.relation === "next_occurrence") {
    return `Explicit ${relation.weekdayName}-after relation enforced against the authoritative scheduling reference.`;
  }
  if (relation.relation === "week_before_last") {
    return `Explicit ${relation.weekdayName} week-before-last relation enforced against the authoritative scheduling reference.`;
  }
  if (relation.relation === "previous_week") {
    return `Explicit ${relation.weekdayName} previous-week relation enforced against the authoritative scheduling reference.`;
  }
  if (relation.relation === "current_week") {
    return `Explicit ${relation.weekdayName} current-week relation enforced against the authoritative scheduling reference.`;
  }
  if (monthScoped) {
    return `Explicit ${relation.weekdayName} relative-weekday relation composed inside the customer-specified calendar month.`;
  }
  if (relation.relation === "week_after_next") {
    return `Explicit ${relation.weekdayName} week-after-next relation enforced against the authoritative scheduling reference.`;
  }
  return `Explicit next-week ${relation.weekdayName} relation enforced against the authoritative scheduling reference.`;
}

function enforceExplicitRelativeWeekdayRelation(params: {
  message: string;
  timezone: string;
  referenceIso: string | null;
  intent: any;
}) {
  const relation = getExplicitRelativeWeekdayRelation(params.message);
  if (!relation) return params.intent;

  const referenceIso =
    params.referenceIso &&
    !Number.isNaN(new Date(params.referenceIso).getTime())
      ? new Date(params.referenceIso).toISOString()
      : new Date().toISOString();

  const ordinaryReferenceDate =
    getLocalCalendarDateForIso(referenceIso, params.timezone) ??
    getNowInTimezone(params.timezone);

  /*
   * Compositional calendar invariant: when the customer supplies BOTH a
   * relative weekday relation and a named calendar month, the month is the
   * temporal frame. Resolve the weekday relation inside that month instead of
   * silently falling back to the inbound message reference date. Ordinary
   * relative-weekday behavior is unchanged when no named month is present.
   */
  const anchoredOccurrenceRelation =
    relation.relation === "previous_occurrence" ||
    relation.relation === "next_occurrence" ||
    relation.relation === "current_week" ||
    relation.relation === "previous_week" ||
    relation.relation === "week_before_last";

  const monthScope = anchoredOccurrenceRelation
    ? null
    : getExplicitRelativeWeekdayMonthScope({
        message: params.message,
        timezone: params.timezone,
        referenceIso,
      });

  const referenceDate = monthScope
    ? { year: monthScope.year, month: monthScope.month, day: 1 }
    : ordinaryReferenceDate;

  const currentWeekday = getWeekdayIndexForLocalDate(referenceDate);

  const resolvedDate = (() => {
    if (relation.relation === "previous_occurrence") {
      let days = relation.weekdayIndex - currentWeekday;
      if (days >= 0) days -= 7;

      return addDaysToLocalDate({
        year: referenceDate.year,
        month: referenceDate.month,
        day: referenceDate.day,
        days,
      });
    }

    if (relation.relation === "next_occurrence") {
      let days = relation.weekdayIndex - currentWeekday;
      if (days <= 0) days += 7;

      return addDaysToLocalDate({
        year: referenceDate.year,
        month: referenceDate.month,
        day: referenceDate.day,
        days,
      });
    }

    // Calendar-week relations use a Monday-Sunday frame around the
    // authoritative reference date. This makes every weekday deterministic
    // in both directions, including when the anchor is the same weekday.
    const daysFromMondayToReference =
      currentWeekday === 0 ? 6 : currentWeekday - 1;
    const weekdayOffsetFromMonday =
      relation.weekdayIndex === 0 ? 6 : relation.weekdayIndex - 1;

    const weekOffset =
      relation.relation === "week_before_last"
        ? -2
        : relation.relation === "previous_week"
          ? -1
          : relation.relation === "current_week"
            ? 0
            : relation.relation === "week_after_next"
              ? 2
              : 1;

    return addDaysToLocalDate({
      year: referenceDate.year,
      month: referenceDate.month,
      day: referenceDate.day,
      days:
        -daysFromMondayToReference +
        weekOffset * 7 +
        weekdayOffsetFromMonday,
    });
  })();

  const groundedClock = hasGroundedClockEvidence(params.message)
    ? extractRequestedTimeParts(params.message)
    : null;

  if (groundedClock) {
    const startTime = zonedTimeToUtc({
      ...resolvedDate,
      hour: groundedClock.hour,
      minute: groundedClock.minute,
      timezone: params.timezone,
    });

    return {
      ...params.intent,
      hasPreference: true,
      allowedWindows: [{ startTime, endTime: null }],
      targetTime: startTime,
      selectionMode: "closest",
      temporalGranularity: "date_time",
      customerSpecifiedDate: true,
      customerSpecifiedTime: true,
      localDateTime: {
        ...resolvedDate,
        hour: groundedClock.hour,
        minute: groundedClock.minute,
      },
      interpretation: describeExplicitRelativeWeekdayRelation(
        relation,
        Boolean(monthScope)
      ),
    };
  }

  const startTime = zonedTimeToUtc({
    ...resolvedDate,
    hour: 0,
    minute: 0,
    timezone: params.timezone,
  });
  const followingDate = addDaysToLocalDate({
    ...resolvedDate,
    days: 1,
  });
  const endTime = zonedTimeToUtc({
    ...followingDate,
    hour: 0,
    minute: 0,
    timezone: params.timezone,
  });

  return {
    ...params.intent,
    hasPreference: true,
    allowedWindows: [{ startTime, endTime }],
    targetTime: null,
    selectionMode: "earliest",
    temporalGranularity: "date_only",
    customerSpecifiedDate: true,
    customerSpecifiedTime: false,
    localDateTime: null,
    interpretation: describeExplicitRelativeWeekdayRelation(
      relation,
      Boolean(monthScope)
    ),
  };
}


function deterministicCalendarEventIdForLead(companyId: string, leadId: string) {
  return createHash("sha256")
    .update(`${companyId}:${leadId}`)
    .digest("hex");
}

async function recoverCanonicalBookingTruthForCancellation(params: {
  companyId: string;
  lead: LeadForInboundEmail;
}) {
  const refreshedLead =
    (await fetchLeadByIdForInbound({
      companyId: params.companyId,
      leadId: params.lead.id,
    })) ?? params.lead;

  if (refreshedLead.appointment_time && refreshedLead.calendar_event_id) {
    return refreshedLead;
  }

  const expectedCalendarEventId = deterministicCalendarEventIdForLead(
    params.companyId,
    params.lead.id
  );

  const calendar = await getCompanyCalendarClient(params.companyId);

  let event: any = null;

  try {
    const fetched = await calendar.events.get({
      calendarId: "primary",
      eventId: expectedCalendarEventId,
    });

    event = fetched?.data ?? null;
  } catch (error: any) {
    if (!isGoogleCalendarMissingError(error)) throw error;
    return refreshedLead;
  }

  if (!event?.id) return refreshedLead;

  const privateProperties = event?.extendedProperties?.private ?? {};
  const eventLeadId =
    typeof privateProperties?.leadId === "string"
      ? privateProperties.leadId
      : null;
  const eventCompanyId =
    typeof privateProperties?.companyId === "string"
      ? privateProperties.companyId
      : null;

  if (eventLeadId && eventLeadId !== params.lead.id) {
    throw new Error("calendar_cancellation_recovery_lead_ownership_mismatch");
  }

  if (eventCompanyId && eventCompanyId !== params.companyId) {
    throw new Error("calendar_cancellation_recovery_company_ownership_mismatch");
  }

  const eventStartRaw = event?.start?.dateTime ?? null;
  if (!eventStartRaw) {
    throw new Error("calendar_cancellation_recovery_missing_event_start");
  }

  const recoveredAppointmentTime = new Date(eventStartRaw).toISOString();
  const recoveredCalendarEventId = String(
    event.id ?? expectedCalendarEventId
  ).trim();

  if (!recoveredCalendarEventId) {
    throw new Error("calendar_cancellation_recovery_missing_event_id");
  }

  const recoveredLead: LeadForInboundEmail = {
    ...refreshedLead,
    status: "booked",
    appointment_time: recoveredAppointmentTime,
    calendar_event_id: recoveredCalendarEventId,
  };

  await forceRestoreLeadBookingAfterCancellationFailure({
    companyId: params.companyId,
    lead: recoveredLead,
  });

  console.warn("[inbound] recovered canonical booking truth for cancellation", {
    leadId: recoveredLead.id,
    appointmentTime: recoveredAppointmentTime,
    calendarEventId: recoveredCalendarEventId,
  });

  return recoveredLead;
}

function hasDisengagementLanguageForAcknowledgement(message: string) {
  const text = normalizeSimpleText(message);
  if (!text) return false;

  return (
    /\b(?:never\s*mind|nevermind|forget\s+it|scratch\s+that)\b/.test(text) ||
    /\b(?:i'?m|im|we'?re|were)\s+good\b/.test(text) ||
    /\b(?:don't|dont|do\s+not)\s+worry\b/.test(text) ||
    /\bno\s+thanks\b/.test(text)
  );
}

function isGoogleCalendarMissingError(error: any) {
  const code = Number(error?.code ?? error?.response?.status ?? 0);
  const message = String(error?.message ?? "").toLowerCase();

  return (
    code === 404 ||
    code === 410 ||
    message.includes("not found") ||
    message.includes("resource has been deleted")
  );
}

function buildCancellationQualification(params: {
  lead: LeadForInboundEmail;
  message: string;
  providerEventId?: string | null;
}) {
  const qualification =
    params.lead.qualification &&
    typeof params.lead.qualification === "object"
      ? params.lead.qualification
      : {};

  const {
    pendingSlotSuggestion: _discardedPendingSlotSuggestion,
    activeSchedulingYearContext: _discardedActiveSchedulingYearContext,
    ...remainingQualification
  } = qualification;

  return {
    ...remainingQualification,
    appointmentCancellation: {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledByReply: params.message,
      providerEventId: params.providerEventId ?? null,
      previousAppointmentTime: params.lead.appointment_time ?? null,
      previousCalendarEventId: params.lead.calendar_event_id ?? null,
    },
  };
}


type CancelledAppointmentSnapshot = {
  status: "cancelled";
  cancelledAt: string | null;
  cancelledByReply: string | null;
  providerEventId: string | null;
  previousAppointmentTime: string;
  previousCalendarEventId: string | null;
};

function getRestorableCancelledAppointment(
  qualification: Record<string, any> | null | undefined
): CancelledAppointmentSnapshot | null {
  const raw = qualification?.appointmentCancellation;

  if (!raw || typeof raw !== "object") return null;
  if (String(raw.status ?? "") !== "cancelled") return null;

  const previousAppointmentTime = String(
    raw.previousAppointmentTime ?? ""
  ).trim();

  if (!previousAppointmentTime) return null;
  if (Number.isNaN(new Date(previousAppointmentTime).getTime())) return null;

  return {
    status: "cancelled",
    cancelledAt:
      typeof raw.cancelledAt === "string" ? raw.cancelledAt : null,
    cancelledByReply:
      typeof raw.cancelledByReply === "string" ? raw.cancelledByReply : null,
    providerEventId:
      typeof raw.providerEventId === "string" ? raw.providerEventId : null,
    previousAppointmentTime,
    previousCalendarEventId:
      typeof raw.previousCalendarEventId === "string"
        ? raw.previousCalendarEventId
        : null,
  };
}

async function restoreCancelledAppointmentFromHistory(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  updates: Record<string, any>;
  message: string;
  toEmail?: string | null;
  subject?: string | null;
  timezone: string;
}) {
  const cancelled = getRestorableCancelledAppointment(
    params.lead.qualification
  );

  if (!cancelled) return null;

  const bookingRequirementsBlock =
    await requireBookingDetailsBeforeNewAppointment({
      companyId: params.companyId,
      lead: params.lead,
      inboundEmailId: params.inboundEmailId,
      inboundUpdates: params.updates,
      toEmail: params.toEmail,
      subject: params.subject,
      timezone: params.timezone,
      message: params.message,
      actionKind: "restore_cancelled",
      requestedStartTime: cancelled.previousAppointmentTime,
      requestedEndTime: null,
    });

  if (bookingRequirementsBlock) return bookingRequirementsBlock;

  const leadAddress = buildLeadAddress(params.lead);
  const customerMetadata = resolveCustomerMetadata(
    params.lead,
    params.toEmail
  );
  const customerLabel = customerMetadata.customerLabel;
  const calendarSummary = leadAddress
    ? `HVAC Appointment - ${customerLabel} - ${leadAddress}`
    : `HVAC Appointment - ${customerLabel}`;

  let booking: any;

  try {
    /*
     * The cancelled Google event was deliberately deleted. Restoration is
     * therefore a NEW calendar event at the authoritative cancelled start
     * time, not a reschedule of the deleted event id.
     */
    booking = await createCalendarBooking({
      companyId: params.companyId,
      leadId: params.lead.id,
      bookingRequirementsVerifiedByCaller: true,
      startTime: cancelled.previousAppointmentTime,
      summary: calendarSummary,
      ...(leadAddress ? { location: leadAddress } : {}),
      description: [
        "Restored automatically from authoritative LeadFlow cancellation history.",
        "Restore mode: restore_cancelled_appointment",
        "",
        `Customer: ${customerMetadata.customerName ?? customerLabel}`,
        customerMetadata.customerPhone
          ? `Phone: ${customerMetadata.customerPhone}`
          : null,
        customerMetadata.customerEmail
          ? `Email: ${customerMetadata.customerEmail}`
          : null,
        leadAddress ? `Service address: ${leadAddress}` : null,
        params.lead.input
          ? `Original request: ${params.lead.input}`
          : null,
        "",
        `Customer reply: ${params.message}`,
        `Company timezone: ${params.timezone}`,
      ]
        .filter(Boolean)
        .join("\\n"),
      attendeeEmail: customerMetadata.attendeeEmail,
      attendeeName: customerMetadata.attendeeName,
      allowReschedule: false,
      /*
       * A cancelled Google event was physically deleted. Its deterministic
       * event id must never be reused as proof of restoration because Google
       * can retain deleted event identities. Force a fresh Calendar event.
       */
      forceFreshEventIdentity: true,
    } as any);

    assertRealCalendarBooking(booking, {
      startTime: cancelled.previousAppointmentTime,
      endTime: null,
    });

    if (
      cancelled.previousCalendarEventId &&
      booking.calendarEventId === cancelled.previousCalendarEventId
    ) {
      throw new Error(
        "cancelled_appointment_restore_reused_deleted_calendar_event_identity"
      );
    }
  } catch (error: any) {
    const safelyUnavailable =
      error?.message === "slot_unavailable" ||
      error?.message === "outside_business_hours" ||
      error?.message === "appointment_start_time_is_in_the_past";

    if (!safelyUnavailable) throw error;

    let alternatives: AlternativeSlot[] = [];

    try {
      alternatives = await suggestCadenceAlignedAlternativeSlots({
        companyId: params.companyId,
        requestedStartTime: cancelled.previousAppointmentTime,
        requestedEndTime: null,
        timezone: params.timezone,
      });
    } catch (availabilityError: any) {
      console.error(
        "[inbound] cancelled appointment restore alternative lookup failed",
        {
          leadId: params.lead.id,
          cancelledAppointmentTime: cancelled.previousAppointmentTime,
          error: availabilityError?.message ?? availabilityError,
        }
      );
      alternatives = [];
    }

    if (alternatives.length > 0) {
      return sendUnavailableAndStorePending({
        companyId: params.companyId,
        lead: params.lead,
        inboundEmailId: params.inboundEmailId,
        inboundUpdates: params.updates,
        toEmail: params.toEmail,
        subject: params.subject,
        companyTimezone: params.timezone,
        message: params.message,
        reason:
          error?.message === "outside_business_hours"
            ? "outside_business_hours"
            : "slot_unavailable",
        alternatives: getCleanAlternativeSlots(alternatives).slice(0, 3),
        originalRequestedStartTime: cancelled.previousAppointmentTime,
        originalRequestedEndTime: null,
        schedulingPreferenceText: "restore cancelled appointment",
      });
    }

    const cancelledLabel = formatCustomerRequestedSlot(
      cancelled.previousAppointmentTime,
      params.timezone
    );

    if (params.toEmail) {
      await sendLeadReply({
        companyId: params.companyId,
        leadId: params.lead.id,
        to: params.toEmail,
        subject: params.subject ?? "Re: Your HVAC Request",
        body: `I couldn't restore${
          cancelledLabel ? ` your appointment for ${cancelledLabel}` : " that cancelled appointment"
        } because that time is no longer available.`,
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: params.inboundEmailId,
      companyId: params.companyId,
      leadId: params.lead.id,
      processingError: "cancelled_appointment_restore_unavailable",
    });

    return {
      success: true,
      processed: true,
      booked: false,
      restored: false,
      reason: "cancelled_appointment_restore_unavailable",
      inboundEmailId: params.inboundEmailId,
      leadId: params.lead.id,
    };
  }

  const restoredAt = new Date().toISOString();

  /*
   * Restoring a cancelled appointment creates a FRESH Google Calendar event
   * identity. Any authoritative reschedule lineage that describes the same
   * appointment must therefore be rebound to that fresh event id. Otherwise
   * the lineage survives semantically but fails the later integrity check
   * because it still points at the deleted pre-cancellation event.
   *
   * This is state reconciliation, not language interpretation. We only rebind
   * when the cancelled slot matches the appointment position represented by
   * the existing lineage.
   */
  const existingLineage = getRescheduleLineage(params.lead.qualification);
  const lineageCurrentAppointmentTime = existingLineage
    ? existingLineage.lastCompletedReschedule.status === "active"
      ? existingLineage.lastCompletedReschedule.toAppointmentTime
      : existingLineage.lastCompletedReschedule.status === "undone"
        ? existingLineage.lastCompletedReschedule.fromAppointmentTime
        : existingLineage.originalAppointmentTime
    : null;

  const reboundLineage =
    existingLineage &&
    lineageCurrentAppointmentTime &&
    slotTimesMatchWithinOneMinute(
      cancelled.previousAppointmentTime,
      lineageCurrentAppointmentTime
    )
      ? {
          ...existingLineage,
          calendarEventId: booking.calendarEventId,
        }
      : null;

  const qualification = {
    ...(params.lead.qualification ?? {}),
    ...(reboundLineage ? { rescheduleLineage: reboundLineage } : {}),
    appointmentCancellation: {
      ...((params.lead.qualification ?? {}).appointmentCancellation ?? {}),
      status: "restored",
      restoredAt,
      restoredByReply: params.message,
      restoredAppointmentTime: booking.appointmentTime,
      restoredCalendarEventId: booking.calendarEventId,
    },
    pendingSlotSuggestion: {
      ...((params.lead.qualification ?? {}).pendingSlotSuggestion ?? {}),
      status: "confirmed_and_booked",
      confirmedStartTime: booking.appointmentTime,
      confirmedEndTime: booking.appointmentEndTime ?? null,
      confirmedByReply: params.message,
      confirmedAt: restoredAt,
      matchReason: "restore_cancelled_appointment",
    },
  };

  let verifiedLead = await forceMarkLeadBooked({
    companyId: params.companyId,
    leadId: params.lead.id,
    appointmentTime: booking.appointmentTime,
    calendarEventId: booking.calendarEventId,
    qualification,
    updates: params.updates,
  });

  const restoredLabel = formatCustomerRequestedSlot(
    verifiedLead.appointment_time,
    params.timezone
  );

  if (params.toEmail) {
    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body: `Got it — I've restored your cancelled appointment${
        restoredLabel ? ` for ${restoredLabel}` : ""
      }.`,
      isFollowUp: false,
    });

    /* Reassert booking truth after the outbound send, matching the other
       mutation paths' protection against stale concurrent updates. */
    verifiedLead = await forceMarkLeadBooked({
      companyId: params.companyId,
      leadId: params.lead.id,
      appointmentTime: booking.appointmentTime,
      calendarEventId: booking.calendarEventId,
      qualification,
      updates: params.updates,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  console.log("[inbound] cancelled appointment restored from authoritative history", {
    leadId: params.lead.id,
    previousAppointmentTime: cancelled.previousAppointmentTime,
    previousCalendarEventId: cancelled.previousCalendarEventId,
    restoredAppointmentTime: booking.appointmentTime,
    restoredCalendarEventId: booking.calendarEventId,
    parsedMessage: params.message,
  });

  return {
    success: true,
    processed: true,
    booked: true,
    restored: true,
    restoreKind: "restore_cancelled_appointment",
    reason: "cancelled_appointment_restored_from_authoritative_history",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    verifiedLead,
  };
}

async function forceRestoreLeadBookingAfterCancellationFailure(params: {
  companyId: string;
  lead: LeadForInboundEmail;
}) {
  if (!params.lead.appointment_time || !params.lead.calendar_event_id) {
    throw new Error("cannot_restore_booking_truth_without_original_booking");
  }

  const { data, error } = await supabase
    .from("leads")
    .update({
      status: "booked",
      appointment_time: params.lead.appointment_time,
      calendar_event_id: params.lead.calendar_event_id,
      qualification: params.lead.qualification ?? {},
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .select("id, status, appointment_time, calendar_event_id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("lead_booking_restore_scope_violation");

  return data;
}

async function forceMarkAppointmentCancelled(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  updates: Record<string, any>;
  qualification: Record<string, any>;
}) {
  const expectedEventId = params.lead.calendar_event_id;

  if (!expectedEventId) {
    throw new Error("missing_calendar_event_id_for_cancellation");
  }

  const { data, error } = await supabase
    .from("leads")
    .update({
      ...params.updates,
      status: "contacted",
      appointment_time: null,
      calendar_event_id: null,
      qualification: params.qualification,
      next_follow_up_at: null,
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .eq("calendar_event_id", expectedEventId)
    .select("id, status, appointment_time, calendar_event_id, qualification")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("appointment_cancellation_compare_and_swap_failed");

  if (data.appointment_time || data.calendar_event_id) {
    throw new Error("appointment_cancellation_db_truth_not_cleared");
  }

  return data;
}

async function reassertAppointmentCancelledAfterReply(params: {
  companyId: string;
  leadId: string;
  qualification: Record<string, any>;
}) {
  const { data, error } = await supabase
    .from("leads")
    .update({
      status: "contacted",
      appointment_time: null,
      calendar_event_id: null,
      qualification: params.qualification,
      next_follow_up_at: null,
    })
    .eq("id", params.leadId)
    .eq("company_id", params.companyId)
    .select("id, status, appointment_time, calendar_event_id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("appointment_cancellation_reassert_scope_violation");

  if (data.appointment_time || data.calendar_event_id) {
    throw new Error("appointment_cancellation_reassert_truth_mismatch");
  }

  return data;
}

async function cancelExistingAppointment(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  updates: Record<string, any>;
  message: string;
  providerEventId?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  timezone: string;
  mixedInformationAnswer?: string | null;
}) {
  if (!params.lead.calendar_event_id || !params.lead.appointment_time) {
    throw new Error("no_canonical_booking_truth_to_cancel");
  }

  const previousEventId = params.lead.calendar_event_id;
  const previousAppointmentTime = params.lead.appointment_time;

  const calendar = await getCompanyCalendarClient(params.companyId);

  let calendarEvent: any = null;
  let calendarAlreadyMissing = false;

  try {
    const fetched = await calendar.events.get({
      calendarId: "primary",
      eventId: previousEventId,
    });

    calendarEvent = fetched?.data ?? null;
  } catch (error: any) {
    if (!isGoogleCalendarMissingError(error)) throw error;
    calendarAlreadyMissing = true;
  }

  if (calendarEvent) {
    const privateProperties =
      calendarEvent?.extendedProperties?.private ?? {};

    const eventLeadId =
      typeof privateProperties?.leadId === "string"
        ? privateProperties.leadId
        : null;
    const eventCompanyId =
      typeof privateProperties?.companyId === "string"
        ? privateProperties.companyId
        : null;

    if (eventLeadId && eventLeadId !== params.lead.id) {
      throw new Error("calendar_cancellation_lead_ownership_mismatch");
    }

    if (eventCompanyId && eventCompanyId !== params.companyId) {
      throw new Error("calendar_cancellation_company_ownership_mismatch");
    }
  }

  const cancellationQualification = buildCancellationQualification({
    lead: params.lead,
    message: params.message,
    providerEventId: params.providerEventId,
  });

  await forceMarkAppointmentCancelled({
    companyId: params.companyId,
    lead: params.lead,
    updates: params.updates,
    qualification: cancellationQualification,
  });

  if (!calendarAlreadyMissing) {
    try {
      await calendar.events.delete({
        calendarId: "primary",
        eventId: previousEventId,
        sendUpdates: "all",
      });
    } catch (error: any) {
      if (!isGoogleCalendarMissingError(error)) {
        await forceRestoreLeadBookingAfterCancellationFailure({
          companyId: params.companyId,
          lead: params.lead,
        });

        throw error;
      }
    }
  }

  if (params.toEmail) {
    const cancelledTime = new Date(previousAppointmentTime).toLocaleString(
      "en-US",
      {
        timeZone: params.timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }
    );

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body: mergeMixedInformationWithActionReply(
        params.mixedInformationAnswer,
        `Your appointment for ${cancelledTime} has been canceled. It has been removed from the calendar.`
      ),
      isFollowUp: false,
    });
  }

  const verifiedLead = await reassertAppointmentCancelledAfterReply({
    companyId: params.companyId,
    leadId: params.lead.id,
    qualification: cancellationQualification,
  });

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  console.log("[inbound] appointment cancellation verified", {
    leadId: params.lead.id,
    previousAppointmentTime,
    previousCalendarEventId: previousEventId,
    calendarAlreadyMissing,
    status: verifiedLead.status,
    appointmentTime: verifiedLead.appointment_time,
    calendarEventId: verifiedLead.calendar_event_id,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    cancelled: true,
    leadId: params.lead.id,
    inboundEmailId: params.inboundEmailId,
    previousAppointmentTime,
    previousCalendarEventId: previousEventId,
    calendarAlreadyMissing,
    verifiedLead,
  };
}

function isBlockedStatus(status?: string | null) {
  return (
    status === "booked" ||
    status === "completed" ||
    status === "closed" ||
    status === "duplicate" ||
    status === "spam" ||
    status === "outside_service_area"
  );
}

function isBlockedLead(lead: LeadForInboundEmail) {
  if (lead.status === "booked") {
    return Boolean(lead.calendar_event_id);
  }

  return isBlockedStatus(lead.status);
}

function customerExplicitlyGaveEndTime(message: string) {
  const text = message.toLowerCase();

  return (
    /\bfrom\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s*(to|-|until)\s*\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(
      text
    ) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\s*(to|-|until)\s*\d{1,2}(:\d{2})?\s*(am|pm)\b/.test(
      text
    ) ||
    /\bfor\s+\d+\s*(hour|hours|hr|hrs|minute|minutes|min|mins)\b/.test(text)
  );
}

function formatAlternativeSlot(
  slot: AlternativeSlot,
  index: number,
  timezone: string,
  includeYear = false
) {
  const start = new Date(slot.startTime).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });

  return `${index + 1}. ${start}`;
}

function formatCustomerRequestedSlot(iso: string | null | undefined, timezone: string) {
  if (!iso) return null;

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatCustomerRequestedPeriod(params: {
  startTime?: string | null;
  endTime?: string | null;
  timezone: string;
}) {
  if (!params.startTime) return null;

  const start = new Date(params.startTime);

  if (Number.isNaN(start.getTime())) return null;

  if (!params.endTime) {
    return formatCustomerRequestedSlot(params.startTime, params.timezone);
  }

  const end = new Date(params.endTime);

  if (Number.isNaN(end.getTime())) {
    return formatCustomerRequestedSlot(params.startTime, params.timezone);
  }

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: params.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const startDateKey = dateKeyFormatter.format(start);
  const endDateKey = dateKeyFormatter.format(end);

  const startClockParts = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(start);

  const endClockParts = new Intl.DateTimeFormat("en-US", {
    timeZone: params.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(end);

  const readClock = (parts: Intl.DateTimeFormatPart[]) => {
    const rawHour = Number(parts.find((part) => part.type === "hour")?.value);
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return { hour, minute };
  };

  const startClock = readClock(startClockParts);
  const endClock = readClock(endClockParts);

  const startLocalDate = getLocalCalendarDateForIso(
    params.startTime,
    params.timezone
  );

  const nextLocalDayIso = startLocalDate
    ? zonedTimeToUtc({
        ...addDaysToLocalDate({
          ...startLocalDate,
          days: 1,
        }),
        hour: 0,
        minute: 0,
        timezone: params.timezone,
      })
    : null;

  const isFullLocalDay =
    startClock.hour === 0 &&
    startClock.minute === 0 &&
    endClock.hour === 0 &&
    endClock.minute === 0 &&
    Boolean(nextLocalDayIso) &&
    slotTimesMatchWithinOneMinute(params.endTime, nextLocalDayIso);

  if (isFullLocalDay) {
    return dateFormatter.format(start);
  }

  if (startDateKey === endDateKey) {
    return `${dateFormatter.format(start)}, between ${timeFormatter.format(
      start
    )} and ${timeFormatter.format(end)}`;
  }

  const endInclusiveProbe = new Date(end.getTime() - 1);
  const inclusiveEndDateKey = dateKeyFormatter.format(endInclusiveProbe);

  if (startDateKey === inclusiveEndDateKey) {
    return `${dateFormatter.format(start)}, between ${timeFormatter.format(
      start
    )} and ${timeFormatter.format(end)}`;
  }

  return `${dateFormatter.format(start)} through ${dateFormatter.format(
    endInclusiveProbe
  )}`;
}

function getCleanAlternativeSlots(alternatives: AlternativeSlot[]) {
  const seen = new Set<string>();

  return alternatives
    .filter((slot) => {
      if (!slot?.startTime) return false;

      const startMs = new Date(slot.startTime).getTime();

      if (Number.isNaN(startMs)) return false;

      return true;
    })
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    )
    .filter((slot) => {
      const key = `${slot.startTime}|${slot.endTime ?? ""}`;

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .slice(0, 3);
}


function alternativeSlotKey(slot: AlternativeSlot) {
  const startMs = new Date(slot.startTime).getTime();
  // One offered opening is identified by its start instant, not by optional
  // end-time serialization. Provider rechecks may fill in a missing end time.
  return Number.isFinite(startMs) ? String(startMs) : slot.startTime;
}

function excludePreviouslyOfferedSlots(params: {
  alternatives: AlternativeSlot[];
  previouslyOffered: AlternativeSlot[];
}) {
  const offeredKeys = new Set(
    params.previouslyOffered.map((slot) => alternativeSlotKey(slot))
  );

  return getCleanAlternativeSlots(params.alternatives).filter(
    (slot) => !offeredKeys.has(alternativeSlotKey(slot))
  );
}

function mergeAlternativeSlots(
  ...groups: AlternativeSlot[][]
) {
  const merged: AlternativeSlot[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const slot of group) {
      if (!slot?.startTime) continue;

      const key = alternativeSlotKey(slot);
      if (seen.has(key)) continue;

      seen.add(key);
      merged.push(slot);
    }
  }

  return merged
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    )
    .slice(0, 3);
}

function addMinutesToIsoSafe(iso: string, minutes: number) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

const CANONICAL_AVAILABILITY_SLOT_CADENCE_MINUTES = 30;

function ceilIsoToAvailabilitySlotCadence(
  iso: string,
  cadenceMinutes = CANONICAL_AVAILABILITY_SLOT_CADENCE_MINUTES
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const cadenceMs = cadenceMinutes * 60_000;
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) return null;

  return new Date(Math.ceil(date.getTime() / cadenceMs) * cadenceMs).toISOString();
}

async function suggestCadenceAlignedAlternativeSlots(
  input: Parameters<typeof suggestAlternativeSlots>[0]
) {
  /*
   * requestedStartTime is a LOWER BOUND. Alternative generation advances in
   * fixed 30-minute steps, so the search anchor must align FORWARD to cadence,
   * never backward. Clamp that lower bound to wall-clock now as well, because a
   * queued worker can begin after the inbound message timestamp. Exact customer
   * booking times are never rounded here; this helper only generates alternatives.
   * Every returned option is also checked against the same lower bound before it
   * can reach any downstream availability response.
   */
  const requestedStartMs = new Date(input.requestedStartTime).getTime();
  const nowMs = Date.now();
  const minimumStartMs = Number.isFinite(requestedStartMs)
    ? Math.max(requestedStartMs, nowMs)
    : nowMs;
  const minimumStartIso = new Date(minimumStartMs).toISOString();
  const alignedStart = ceilIsoToAvailabilitySlotCadence(minimumStartIso);

  const alternatives = await suggestAlternativeSlots({
    ...input,
    requestedStartTime: alignedStart ?? minimumStartIso,
  });

  return getCleanAlternativeSlots(alternatives).filter((slot) => {
    const slotStartMs = new Date(slot.startTime).getTime();
    return Number.isFinite(slotStartMs) && slotStartMs >= minimumStartMs;
  });
}


function inheritOfferedDateForTimeWindow(params: {
  intent: Awaited<ReturnType<typeof resolveSchedulingIntent>>;
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  const { intent } = params;
  if (!intent.hasPreference || intent.customerSpecifiedDate !== false ||
    intent.customerSpecifiedTime !== true || intent.yearReference !== "unspecified" ||
    intent.temporalGranularity !== "window" || intent.temporalOperation ||
    intent.allowedWindows.length === 0) return intent;
  const dates = params.alternatives.map((slot) => getLocalCalendarDateForIso(slot.startTime, params.timezone));
  if (dates.length === 0 || dates.some((date) => !date)) return intent;
  const targetDate = dates[0]!;
  if (!dates.every((date) => date?.year === targetDate.year && date.month === targetDate.month && date.day === targetDate.day)) return intent;
  const rebase = (windows: typeof intent.allowedWindows) => windows.map((window) => rebaseTemporalWindowToCalendarDate({ window, targetDate, timezone: params.timezone }));
  const allowed = rebase(intent.allowedWindows);
  const excluded = rebase(intent.excludedWindows);
  if (allowed.some((window) => !window) || excluded.some((window) => !window)) return intent;
  return {
    ...intent,
    allowedWindows: allowed as typeof intent.allowedWindows,
    excludedWindows: excluded as typeof intent.excludedWindows,
    targetTime: null,
    localDateTime: null,
    interpretation: "Time-only availability refinement inherited the unique local calendar date of the current offered appointments while preserving the requested time windows and exclusions.",
  };
}

function isLeadWaitingForCustomerBookingChoice(lead: LeadForInboundEmail) {
  return (
    lead.status === "awaiting_customer" ||
    lead.status === "contacted" ||
    lead.status === "sent" ||
    lead.status === "new" ||
    !lead.status
  );
}

function isReplyToBookingOptions(subject?: string | null) {
  const value = normalizeSimpleText(String(subject ?? ""));

  return (
    value.startsWith("re your hvac request") ||
    value.includes("your hvac request") ||
    value.includes("hvac request") ||
    value.includes("appointment")
  );
}

function hasExplicitRequestedAppointmentTime(message: string) {
  const text = normalizeSimpleText(message);

  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b.*\b(1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(am|pm)?\b/.test(
    text
  ) || /\b(1[0-2]|0?[1-9])(?::[0-5][0-9])\s*(am|pm)\b/.test(text);
}

function isPureOfferedOptionSelection(message: string, maxOptions: number) {
  const text = normalizeSimpleText(message);
  const optionIndex = extractOptionIndex(text, Math.max(1, maxOptions));

  if (optionIndex === null) return false;
  if (hasExplicitRequestedAppointmentTime(text)) return false;

  return hasPositiveBookingLanguage(text) || /^\s*\d{1,4}(?:st|nd|rd|th)?\s*$/.test(text);
}

function slotTimesMatchWithinOneMinute(a?: string | null, b?: string | null) {
  if (!a || !b) return false;

  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();

  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;

  return Math.abs(aMs - bMs) <= 60_000;
}

function requestedTimeMatchesAnyOfferedSlot(params: {
  requestedStartTime?: string | null;
  alternatives: AlternativeSlot[];
}) {
  return params.alternatives.some((slot) =>
    slotTimesMatchWithinOneMinute(params.requestedStartTime, slot.startTime)
  );
}

function buildFallbackAlternativeSlots(params: {
  companyTimezone: string;
  requestedStartTime?: string | null;
}) {
  const now = getNowInTimezone(params.companyTimezone);
  const requestedStartMs = params.requestedStartTime
    ? new Date(params.requestedStartTime).getTime()
    : 0;

  const slots: AlternativeSlot[] = [];

  for (let dayOffset = 0; dayOffset <= 14 && slots.length < 3; dayOffset += 1) {
    const localDate = addDaysToLocalDate({
      year: now.year,
      month: now.month,
      day: now.day,
      days: dayOffset,
    });

    const weekday = getWeekdayIndexForLocalDate(localDate);

    if (weekday === 0 || weekday === 6) continue;

    for (const candidate of [
      { hour: 8, minute: 0 },
      { hour: 8, minute: 30 },
      { hour: 9, minute: 0 },
      { hour: 9, minute: 30 },
      { hour: 10, minute: 0 },
      { hour: 10, minute: 30 },
      { hour: 11, minute: 0 },
      { hour: 13, minute: 0 },
      { hour: 13, minute: 30 },
      { hour: 14, minute: 0 },
      { hour: 14, minute: 30 },
      { hour: 15, minute: 0 },
    ]) {
      if (slots.length >= 3) break;

      const startTime = zonedTimeToUtc({
        ...localDate,
        hour: candidate.hour,
        minute: candidate.minute,
        timezone: params.companyTimezone,
      });

      const startMs = new Date(startTime).getTime();

      if (!Number.isFinite(startMs)) continue;
      if (startMs <= Date.now() + 30 * 60_000) continue;
      if (
        Number.isFinite(requestedStartMs) &&
        requestedStartMs > 0 &&
        Math.abs(startMs - requestedStartMs) <= 60_000
      ) {
        continue;
      }

      slots.push({
        startTime,
        endTime: addMinutesUtc(startTime, 60),
        timezone: params.companyTimezone,
        travelBufferMinutes: null,
      });
    }
  }

  return slots;
}

function getSafeAlternativesForRejectedRequestedTime(params: {
  lead: LeadForInboundEmail;
  companyTimezone: string;
  requestedStartTime?: string | null;
}) {
  const offered = getPendingSuggestionSlots(params.lead.qualification);

  if (offered.length > 0) {
    return offered;
  }

  return buildFallbackAlternativeSlots({
    companyTimezone: params.companyTimezone,
    requestedStartTime: params.requestedStartTime,
  });
}


function buildUnavailableReply(params: {
  reason: "outside_business_hours" | "slot_unavailable" | "not_offered_option";
  alternatives: AlternativeSlot[];
  timezone: string;
  originalRequestedStartTime?: string | null;
  originalRequestedEndTime?: string | null;
  schedulingPreferenceText?: string | null;
}) {
  const cleanAlternatives = getCleanAlternativeSlots(params.alternatives);
  const requestedTime =
    formatCustomerRequestedPeriod({
      startTime: params.originalRequestedStartTime,
      endTime: params.originalRequestedEndTime ?? null,
      timezone: params.timezone,
    }) ||
    params.schedulingPreferenceText?.trim() ||
    null;

  const alternativeText =
    cleanAlternatives.length > 0
      ? cleanAlternatives
          .map((slot, index) =>
            formatAlternativeSlot(slot, index, params.timezone, true)
          )
          .join("\n")
      : "We do not have a clean replacement opening available yet, so we will follow up with the next confirmed slot.";

  const unavailableLine =
    params.reason === "outside_business_hours"
      ? requestedTime
        ? `Your request for ${requestedTime} is outside our service hours.`
        : "Your requested time is outside our service hours."
      : params.reason === "not_offered_option"
        ? requestedTime
          ? `Your request for ${requestedTime} is not one of the open appointment options.`
          : "Your requested time is not one of the open appointment options."
        : requestedTime
          ? `Your request for ${requestedTime} is not available.`
          : "Your requested time is not available.";

  const optionsLine =
    cleanAlternatives.length > 0
      ? "Here are the next real openings we can book:"
      : "We will follow up with the next confirmed opening.";

  return [unavailableLine, "", optionsLine, "", alternativeText].join("\n");
}

function buildBookingClarificationReply(params: {
  alternatives: AlternativeSlot[];
  timezone: string;
}) {
  const cleanAlternatives = getCleanAlternativeSlots(params.alternatives);

  if (cleanAlternatives.length === 0) {
    return [
      "Hey — just to clarify, do you want us to book an appointment?",
      "",
      "Reply with the exact day and time you want.",
    ].join("\n");
  }

  const optionList = cleanAlternatives
    .map((slot, index) => formatAlternativeSlot(slot, index, params.timezone))
    .join("\n");

  const optionWords = cleanAlternatives
    .map((_, index) => `OPTION ${index + 1}`)
    .join(", ");

  return [
    "Hey — just to clarify, which opening do you want us to book?",
    "",
    optionList,
    "",
    `Reply with ${optionWords}, or reply with the exact appointment time shown above.`,
  ].join("\n");
}


async function storePendingSchedulingState(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  qualification: Record<string, any>;
  updates: Record<string, any>;
}) {
  /*
    Existing booked appointments are immutable while a replacement is merely
    being discussed or checked. Preserve the old Calendar truth until a new
    slot has been successfully committed.
  */
  if (
    params.lead.status === "booked" &&
    params.lead.calendar_event_id &&
    params.lead.appointment_time
  ) {
    const { data: preservedLead, error } = await supabase
      .from("leads")
      .update({
        ...params.updates,
        status: "booked",
        appointment_time: params.lead.appointment_time,
        calendar_event_id: params.lead.calendar_event_id,
        qualification: params.qualification,
      })
      .eq("id", params.lead.id)
      .eq("company_id", params.companyId)
      .eq("calendar_event_id", params.lead.calendar_event_id)
      .eq("appointment_time", params.lead.appointment_time)
      .select("id, status, appointment_time, calendar_event_id")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!preservedLead) {
      throw new Error("booked_pending_state_compare_and_swap_failed");
    }

    if (
      preservedLead.status !== "booked" ||
      preservedLead.calendar_event_id !== params.lead.calendar_event_id ||
      !slotTimesMatchWithinOneMinute(
        preservedLead.appointment_time,
        params.lead.appointment_time
      )
    ) {
      throw new Error("booked_pending_state_truth_mismatch");
    }

    return preservedLead;
  }

  return forceMarkLeadAwaitingCustomerAfterUnavailable({
    companyId: params.companyId,
    lead: params.lead,
    qualification: params.qualification,
    updates: params.updates,
  });
}

async function sendBookingClarificationAndKeepPending(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  companyTimezone: string;
  message: string;
  alternatives: AlternativeSlot[];
  resolverReason: string;
  resolverConfidence: "low" | "medium" | "high";
}) {
  const cleanAlternatives = getCleanAlternativeSlots(params.alternatives);

  const nextQualification = {
    ...(params.lead.qualification ?? {}),
    pendingSlotSuggestion: {
      ...((params.lead.qualification ?? {}).pendingSlotSuggestion ?? {}),
      status: "awaiting_customer_confirmation",
      suggestedStartTime: cleanAlternatives[0]?.startTime ?? null,
      suggestedEndTime: cleanAlternatives[0]?.endTime ?? null,
      suggestedSlots: cleanAlternatives,
      lastAmbiguousReply: params.message,
      lastClarificationReason: params.resolverReason,
      lastClarificationConfidence: params.resolverConfidence,
      clarificationSentAt: new Date().toISOString(),
    },
  };

  try {
    try {
      await storePendingSchedulingState({
        companyId: params.companyId,
        lead: params.lead,
        qualification: nextQualification,
        updates: params.inboundUpdates,
      });
    } catch (error: any) {
      if (!isStaleAvailabilityStateError(error)) throw error;
      console.warn("[inbound] newer booking truth won after availability reply send", {
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
      });
    }
  } catch (error: any) {
    if (isStaleAvailabilityStateError(error)) {
      return suppressStaleAvailabilityResponse({
        companyId: params.companyId,
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
        message: params.message,
      });
    }
    throw error;
  }

  if (params.toEmail) {
    const body = buildBookingClarificationReply({
      alternatives: cleanAlternatives,
      timezone: params.companyTimezone,
    });

    console.log("[inbound] sending booking clarification", {
      leadId: params.lead.id,
      toEmail: params.toEmail,
      alternativeCount: cleanAlternatives.length,
      resolverReason: params.resolverReason,
      resolverConfidence: params.resolverConfidence,
      bodyPreview: body.slice(0, 300),
    });

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body,
      isFollowUp: false,
    });

    await storePendingSchedulingState({
      companyId: params.companyId,
      lead: params.lead,
      qualification: nextQualification,
      updates: params.inboundUpdates,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
    processingError: "booking_choice_needs_clarification",
  });

  return {
    success: true,
    processed: true,
    booked: false,
    reason: "booking_choice_needs_clarification",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    companyTimezone: params.companyTimezone,
    parsedMessage: params.message,
    resolverReason: params.resolverReason,
    resolverConfidence: params.resolverConfidence,
    alternatives: cleanAlternatives,
  };
}

function cleanMetadataValue(value?: string | null) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[,.;:]+$/g, "")
    .trim();
}

function buildLeadAddress(lead: LeadForInboundEmail) {
  const directAddress = cleanMetadataValue(lead.address);
  const city = cleanMetadataValue(lead.city);
  const state = cleanMetadataValue(lead.state).toUpperCase();
  const zip = cleanMetadataValue(lead.zip);

  const qualification = lead.qualification ?? {};
  const qLocation =
    typeof qualification.location === "object" && qualification.location !== null
      ? qualification.location
      : {};

  const qAddress = cleanMetadataValue(
    qualification.address ?? qLocation.address
  );

  const qCity = cleanMetadataValue(qualification.city ?? qLocation.city);
  const qState = cleanMetadataValue(
    qualification.state ?? qLocation.state
  ).toUpperCase();
  const qZip = cleanMetadataValue(qualification.zip ?? qLocation.zip);

  const bestAddress = directAddress || qAddress;
  const bestCity = city || qCity;
  const bestState = state || qState;
  const bestZip = zip || qZip;

  if (bestAddress && bestCity && bestState && bestZip) {
    return `${bestAddress}, ${bestCity}, ${bestState}, ${bestZip}`;
  }

  if (bestAddress && bestState && bestZip) {
    return `${bestAddress}, ${bestState}, ${bestZip}`;
  }

  if (bestAddress) return bestAddress;

  const sourceText = cleanMetadataValue(lead.input ?? lead.message);

  const fullAddressMatch = sourceText.match(
    /\b\d+\s+[A-Za-z0-9 .'-]+?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl)\s+[A-Za-z .'-]+\s+(?:TX|AZ|CA|FL|NY)\s+\d{5}\b/i
  );

  if (fullAddressMatch?.[0]) {
    return fullAddressMatch[0].replace(/\s+/g, " ").trim();
  }

  const streetOnlyMatch = sourceText.match(
    /\b\d+\s+[A-Za-z0-9 .'-]+?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl)\b/i
  );

  if (streetOnlyMatch?.[0]) {
    return streetOnlyMatch[0].replace(/\s+/g, " ").trim();
  }

  return "";
}

function cleanNameCandidate(value?: string | null) {
  const text = cleanMetadataValue(value);

  if (!text) return "";

  const lower = text.toLowerCase();

  if (lower.includes("@")) return "";
  if (/^unknown\b/.test(lower)) return "";
  if (/^n\/?a$/.test(lower)) return "";
  if (/^none$/.test(lower)) return "";
  if (/^null$/.test(lower)) return "";
  if (/^undefined$/.test(lower)) return "";
  if (/^hvac customer$/.test(lower)) return "";

  return text;
}

function extractInlineField(source: unknown, field: "name" | "email" | "phone") {
  const text = String(source ?? "").replace(/\r/g, "\n");

  if (!text.trim()) return "";

  if (field === "name") {
    const match = text.match(/(?:^|\n|\s)name\s*:\s*([^\n]+?)(?=\s+(?:phone|email|address)\s*:|\n|$)/i);
    return cleanNameCandidate(match?.[1]);
  }

  if (field === "email") {
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return cleanMetadataValue(match?.[0]).toLowerCase();
  }

  const match = text.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return cleanMetadataValue(match?.[0]);
}

function resolveCustomerMetadata(
  lead: LeadForInboundEmail,
  fallbackEmail?: string | null
) {
  const qualification = lead.qualification ?? {};
  const qLocation =
    typeof qualification.location === "object" && qualification.location !== null
      ? qualification.location
      : {};

  const customerName =
    cleanNameCandidate(lead.customer_name) ||
    cleanNameCandidate(qualification.customerName) ||
    cleanNameCandidate(qualification.customer_name) ||
    cleanNameCandidate(qualification.name) ||
    cleanNameCandidate(qualification.fullName) ||
    cleanNameCandidate(qualification.full_name) ||
    cleanNameCandidate(qualification.contactName) ||
    cleanNameCandidate(qualification.contact_name) ||
    cleanNameCandidate(qLocation.customerName) ||
    extractInlineField(lead.input, "name") ||
    extractInlineField(lead.message, "name");

  const customerEmail =
    cleanMetadataValue(lead.email).toLowerCase() ||
    cleanMetadataValue(qualification.email).toLowerCase() ||
    cleanMetadataValue(qualification.customerEmail).toLowerCase() ||
    extractInlineField(lead.input, "email") ||
    extractInlineField(lead.message, "email") ||
    cleanMetadataValue(fallbackEmail).toLowerCase();

  const customerPhone =
    cleanMetadataValue(lead.phone) ||
    cleanMetadataValue(qualification.phone) ||
    cleanMetadataValue(qualification.customerPhone) ||
    extractInlineField(lead.input, "phone") ||
    extractInlineField(lead.message, "phone");

  const customerLabel = customerName || customerEmail || customerPhone || "HVAC Customer";

  return {
    customerName: customerName || null,
    customerEmail: customerEmail || null,
    customerPhone: customerPhone || null,
    customerLabel,
    attendeeEmail: customerEmail || cleanMetadataValue(fallbackEmail).toLowerCase() || null,
    attendeeName: customerName || customerLabel,
  };
}

async function requireBookingDetailsBeforeNewAppointment(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates?: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  timezone: string;
  message: string;
  actionKind: PendingBookingRequirementsAction;
  requestedStartTime: string;
  requestedEndTime?: string | null;
  selectedOptionNumber?: number | null;
}) {
  const requirements = resolveBookingRequirements(params.lead);
  if (requirements.complete) return null;

  const qualification = params.lead.qualification ?? {};
  const existingPendingSlots = getPendingSuggestionSlots(qualification);
  const targetStart = new Date(params.requestedStartTime).toISOString();
  const targetEnd = params.requestedEndTime
    ? new Date(params.requestedEndTime).toISOString()
    : null;

  const existingPendingBookingRequirements =
    getPendingBookingRequirements(qualification);
  const continuingSameRequirementsRequest = Boolean(
    existingPendingBookingRequirements?.status === "awaiting_required_contact" &&
      existingPendingBookingRequirements.actionKind === params.actionKind &&
      slotTimesMatchWithinOneMinute(
        existingPendingBookingRequirements.requestedStartTime,
        targetStart
      )
  );
  const reminderCount = continuingSameRequirementsRequest
    ? Number(existingPendingBookingRequirements?.reminderCount ?? 0) + 1
    : 0;

  let selectedOptionNumber =
    Number.isInteger(params.selectedOptionNumber) &&
    Number(params.selectedOptionNumber) > 0
      ? Number(params.selectedOptionNumber)
      : null;

  let pendingSlotSuggestion = qualification.pendingSlotSuggestion;

  /*
   * Preserve the customer's already-authorized target. Missing dispatch
   * information must never force them to choose the appointment a second time.
   */
  if (params.actionKind === "book" || params.actionKind === "select_offer") {
    let targetIndex = existingPendingSlots.findIndex((slot) =>
      slotTimesMatchWithinOneMinute(slot.startTime, targetStart)
    );

    let slotsToPersist = existingPendingSlots;

    if (targetIndex < 0) {
      slotsToPersist = [
        {
          startTime: targetStart,
          endTime: targetEnd,
        },
      ];
      targetIndex = 0;
    }

    if (
      selectedOptionNumber === null ||
      selectedOptionNumber > slotsToPersist.length ||
      !slotTimesMatchWithinOneMinute(
        slotsToPersist[selectedOptionNumber - 1]?.startTime,
        targetStart
      )
    ) {
      selectedOptionNumber = targetIndex + 1;
    }

    pendingSlotSuggestion = {
      ...(qualification.pendingSlotSuggestion ?? {}),
      status: "awaiting_customer_confirmation",
      suggestedStartTime: slotsToPersist[0]?.startTime ?? targetStart,
      suggestedEndTime: slotsToPersist[0]?.endTime ?? targetEnd,
      suggestedSlots: slotsToPersist,
      customerReply: params.message,
      suggestionReason: "booking_requirements_pending_target",
    };
  }

  const nextQualification = {
    ...qualification,
    ...(pendingSlotSuggestion ? { pendingSlotSuggestion } : {}),
    pendingBookingRequirements: {
      status: "awaiting_required_contact",
      actionKind: params.actionKind,
      requestedStartTime: targetStart,
      requestedEndTime: targetEnd,
      selectedOptionNumber,
      selectedByReply: params.message,
      requestedAt: new Date().toISOString(),
      reminderCount,
      missing: requirements.missing,
    },
  };

  const nextStatus =
    params.lead.status === "booked" ? params.lead.status : "awaiting_customer";

  const { data: updatedLead, error } = await supabase
    .from("leads")
    .update({
      ...(params.inboundUpdates ?? {}),
      status: nextStatus,
      qualification: nextQualification,
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .select(
      "id, company_id, status, input, message, email, phone, customer_name, address, city, state, zip, appointment_time, calendar_event_id, qualification"
    )
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!updatedLead) {
    throw new Error("booking_requirements_lead_update_scope_violation");
  }

  params.lead.status = updatedLead.status;
  params.lead.qualification = updatedLead.qualification;

  const selectedTimeLabel = formatCustomerRequestedSlot(
    targetStart,
    params.timezone
  );

  const body = buildBookingRequirementsPrompt(requirements, {
    selectedTimeLabel,
    reminderCount,
  });

  if (params.toEmail) {
    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body,
      isFollowUp: false,
    });

    /*
     * Outbound delivery updates engagement state. Reassert this authoritative
     * pending-requirements state so the next customer reply resumes the exact
     * previously authorized target instead of losing it.
     */
    const { error: reassertError } = await supabase
      .from("leads")
      .update({
        status: nextStatus,
        qualification: nextQualification,
      })
      .eq("id", params.lead.id)
      .eq("company_id", params.companyId);

    if (reassertError) throw new Error(reassertError.message);
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
    processingError: "booking_requirements_incomplete",
  });

  console.log("[inbound] booking blocked pending required customer details", {
    leadId: params.lead.id,
    actionKind: params.actionKind,
    requestedStartTime: targetStart,
    selectedOptionNumber,
    missing: requirements.missing,
    parsedMessage: params.message,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    reason: "booking_requirements_incomplete",
    missingBookingRequirements: requirements.missing,
    selectedStartTime: targetStart,
    selectedEndTime: targetEnd,
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
  };
}

function buildCustomerLabel(
  lead: LeadForInboundEmail,
  fallbackEmail?: string | null
) {
  return resolveCustomerMetadata(lead, fallbackEmail).customerLabel;
}

async function fetchLeadByIdForInbound(params: {
  companyId: string;
  leadId: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, company_id, status, input, message, email, phone, customer_name, address, city, state, zip, service_area, appointment_time, calendar_event_id, qualification"
    )
    .eq("id", params.leadId)
    .eq("company_id", params.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as LeadForInboundEmail | null) ?? null;
}

function normalizeProspectHandoffEmail(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function normalizeProspectHandoffThreadId(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

async function fetchPromotedLeadForProspectBookingHandoff(params: {
  companyId: string;
  prospectConversationId: string;
  fromEmail?: string | null;
  providerThreadId?: string | null;
}) {
  const { data: conversation, error } = await supabase
    .from("prospect_conversations")
    .select(
      "id, company_id, status, promoted_lead_id, customer_email, provider_thread_id"
    )
    .eq("id", params.prospectConversationId)
    .eq("company_id", params.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!conversation) {
    throw new Error("prospect_booking_handoff_conversation_not_found");
  }

  if (String((conversation as any).status ?? "") !== "promoted_to_booking") {
    throw new Error("prospect_booking_handoff_conversation_not_promoted");
  }

  const expectedEmail = normalizeProspectHandoffEmail(
    (conversation as any).customer_email
  );
  const actualEmail = normalizeProspectHandoffEmail(params.fromEmail);

  if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
    throw new Error("prospect_booking_handoff_customer_mismatch");
  }

  const expectedThreadId = normalizeProspectHandoffThreadId(
    (conversation as any).provider_thread_id
  );
  const actualThreadId = normalizeProspectHandoffThreadId(
    params.providerThreadId
  );

  if (
    expectedThreadId &&
    actualThreadId &&
    expectedThreadId !== actualThreadId
  ) {
    throw new Error("prospect_booking_handoff_thread_mismatch");
  }

  const promotedLeadId = String(
    (conversation as any).promoted_lead_id ?? ""
  ).trim();

  if (!promotedLeadId) {
    throw new Error("prospect_booking_handoff_missing_promoted_lead");
  }

  const promotedLead = await fetchLeadByIdForInbound({
    companyId: params.companyId,
    leadId: promotedLeadId,
  });

  if (!promotedLead) {
    throw new Error("prospect_booking_handoff_promoted_lead_not_found");
  }

  const promotedLeadEmail = normalizeProspectHandoffEmail(
    promotedLead.email
  );

  if (
    expectedEmail &&
    promotedLeadEmail &&
    expectedEmail !== promotedLeadEmail
  ) {
    throw new Error("prospect_booking_handoff_promoted_lead_customer_mismatch");
  }

  return promotedLead;
}

function bodyContainsExplicitEmail(message: string) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message);
}

type ServiceLocationCompletionDisposition =
  | "complete_as_is"
  | "supplied_secondary_locator"
  | "needs_secondary_locator"
  | "unrelated_or_unclear";

type ServiceLocationCompletionDecision = {
  disposition: ServiceLocationCompletionDisposition;
  secondaryLocator: string | null;
};

let serviceLocationCompletionClient: OpenAI | null = null;

function getServiceLocationCompletionClient() {
  if (!process.env.OPENAI_API_KEY) return null;

  if (!serviceLocationCompletionClient) {
    serviceLocationCompletionClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return serviceLocationCompletionClient;
}

function normalizeAddressForDispatchComparison(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanSecondaryServiceLocator(value: unknown) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:=-]+|[\s,;:.=-]+$/g, "")
    .trim();

  if (!text || text.length > 100) return null;

  /*
   * A secondary locator supplements an already-known civic street address; it
   * must not be another full street address. This keeps the semantic completion
   * helper from silently replacing the authoritative address.
   */
  if (/^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+[A-Za-z]/.test(text)) {
    return null;
  }

  return text;
}

function newestTurnAddsDispatchMeaningBeyondBareAddress(params: {
  message: string;
  candidateAddress?: string | null;
}) {
  const message = normalizeAddressForDispatchComparison(params.message);
  const address = normalizeAddressForDispatchComparison(params.candidateAddress);

  if (!message || !address) return false;

  /*
   * A turn that merely SUPPLIES an address does not also prove that the address
   * is the complete navigable destination. This is a structural rule, not a
   * property-type guess: the same rule applies to houses, apartments, condos,
   * offices, shops, lots, trailers, campuses, and every other property shape.
   *
   * Remove the exact address value and harmless address-introduction grammar.
   * Only meaningful residue is allowed to reach the semantic completion
   * resolver as possible evidence that the customer additionally said the
   * location is complete or supplied some other dispatch-location meaning.
   */
  const withoutAddress = message.replace(address, " ");
  const ignoredIntroductionTokens = new Set([
    "i",
    "im",
    "m",
    "am",
    "we",
    "were",
    "re",
    "are",
    "my",
    "our",
    "the",
    "service",
    "street",
    "home",
    "house",
    "residential",
    "business",
    "commercial",
    "property",
    "place",
    "address",
    "location",
    "located",
    "live",
    "is",
    "at",
    "it",
    "this",
    "here",
  ]);

  const meaningfulResidue = withoutAddress
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !ignoredIntroductionTokens.has(token));

  return meaningfulResidue.length > 0;
}

async function resolveServiceLocationCompletionTurn(params: {
  message: string;
  candidateAddress?: string | null;
  persistedAddress?: string | null;
}): Promise<ServiceLocationCompletionDecision> {
  const candidateAddress = String(params.candidateAddress ?? "").trim() || null;
  const persistedAddress = String(params.persistedAddress ?? "").trim() || null;

  if (
    hasExplicitSecondaryServiceLocator(candidateAddress) ||
    hasExplicitSecondaryServiceLocator(persistedAddress)
  ) {
    return {
      disposition: "complete_as_is",
      secondaryLocator: null,
    };
  }

  const client = getServiceLocationCompletionClient();
  if (!client) {
    return {
      disposition: "unrelated_or_unclear",
      secondaryLocator: null,
    };
  }

  try {
    const response = await client.chat.completions.create({
      model:
        process.env.LEADFLOW_BOOKING_COMMAND_MODEL ||
        process.env.LEADFLOW_SCHEDULING_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_service_location_completion",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["disposition", "secondaryLocator"],
            properties: {
              disposition: {
                type: "string",
                enum: [
                  "complete_as_is",
                  "supplied_secondary_locator",
                  "needs_secondary_locator",
                  "unrelated_or_unclear",
                ],
              },
              secondaryLocator: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
            },
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "You resolve one narrow HVAC dispatch question: whether the newest customer turn establishes an exact navigable service location.",
            "Do not decide booking, scheduling, availability, service eligibility, or property type.",
            "Do not infer that a street address belongs to a house, apartment, condo, office, or multi-unit property from the street text alone.",
            "complete_as_is means the customer explicitly communicates that the known street address is the complete location and that no further location identifier is needed, explicitly identifies the destination as a single-location property with no secondary locator, or the newest turn itself provides a complete address with its needed secondary locator.",
            "supplied_secondary_locator means the customer supplies only the missing secondary location identifier for an already-known street address. Return only that locator in secondaryLocator, preserving useful wording such as Unit 7, Building B, Suite 200, Lot 4, Floor 3, Room 12, Space 8, Block C, or equivalent real-world locator language.",
            "needs_secondary_locator means the customer indicates that an additional locator is required but does not provide enough information to identify it. A clearly multi-unit destination with no specific unit/building/suite/lot/space/floor/room or equivalent locator belongs here unless the customer explicitly says no secondary locator applies.",
            "unrelated_or_unclear means the newest turn does not establish either completion or a missing secondary locator. A bare street address with no evidence about whether an additional locator applies is unrelated_or_unclear, not complete_as_is.",
            "Use meaning, not phrase matching. Understand slang, fragments, typos, terse confirmations, and natural conversation.",
            "Never invent a locator. secondaryLocator must be null unless the customer actually supplied it in the newest turn.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            newestCustomerMessage: params.message,
            newlyExtractedStreetAddress: candidateAddress,
            previouslyKnownStreetAddress: persistedAddress,
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      return {
        disposition: "unrelated_or_unclear",
        secondaryLocator: null,
      };
    }

    const parsed = JSON.parse(raw);
    const disposition: ServiceLocationCompletionDisposition =
      parsed?.disposition === "complete_as_is" ||
      parsed?.disposition === "supplied_secondary_locator" ||
      parsed?.disposition === "needs_secondary_locator" ||
      parsed?.disposition === "unrelated_or_unclear"
        ? parsed.disposition
        : "unrelated_or_unclear";

    return {
      disposition,
      secondaryLocator:
        disposition === "supplied_secondary_locator"
          ? cleanSecondaryServiceLocator(parsed?.secondaryLocator)
          : null,
    };
  } catch (error: any) {
    console.error("[inbound] service-location completion resolution failed", {
      error: error?.message ?? error,
      parsedMessage: params.message,
    });

    return {
      disposition: "unrelated_or_unclear",
      secondaryLocator: null,
    };
  }
}

/*
 * Deterministic fallback for customer-supplied service addresses when the
 * semantic metadata extractor leaves address empty. This is intentionally
 * generic: it requires the customer to explicitly identify the value as an
 * address/location, and the candidate itself must contain both a civic number
 * and alphabetic location text. ZIP-only replies and unit-only replies cannot
 * satisfy the service-address requirement.
 */
function extractExplicitServiceAddressFallback(
  message: string,
  options?: {
    allowBareAddressCandidate?: boolean;
    addressContext?: {
      city?: unknown;
      state?: unknown;
      zip?: unknown;
    };
  }
) {
  const normalized = String(message ?? "")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;

  const explicitMatch = normalized.match(
    /\b(?:(?:service|street|home|house|residential|business|commercial|property|apartment|apt)\s+)?(?:address|location)\b\s*(?:(?:is|=|:)\s*)?(.+)$/i
  );

  let candidate = explicitMatch?.[1] ?? null;

  /*
   * When the booking gate is already waiting specifically for a service
   * address, the conversation state itself supplies the missing-field context.
   * In that narrow state, customers should not be forced to repeat the word
   * "address" if they simply reply with an address-shaped value such as
   * "12003 Culebra Creek Apt 5". ZIP-only, phone-only, and unit-only replies
   * still fail the structural checks below.
   */
  if (!candidate && options?.allowBareAddressCandidate) {
    const bareCandidate = normalized
      .replace(
        /\s+(?:and|,)?\s*(?:my\s+)?(?:callback(?:\s+number)?|phone(?:\s+number)?|number|email)\b.*$/i,
        ""
      )
      .replace(/^[\s:=-]+|[\s,.;:-]+$/g, "")
      .trim();

    /*
     * The booking state already tells us the customer is being asked for a
     * service address. Natural replies frequently introduce that value with a
     * location clause (for example, a first-person/household copula followed
     * by "at") instead of starting directly with the civic number. Strip only
     * that narrow grammatical wrapper, then keep the existing structural
     * street-address validator as the authority. Phone-only, ZIP-only,
     * unit-only, and PO Box replies remain unable to satisfy this fallback.
     */
    const normalizedBareCandidate = bareCandidate
      .replace(
        /^(?:(?:i(?:['’]?m| am)|we(?:['’]?re| are)|(?:my|our)\s+(?:place|home|house|property|business)\s+(?:is|at)|(?:it|this)\s+is)\s+(?:located\s+)?(?:at\s+)?)/i,
        ""
      )
      .trim();

    if (
      /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+[A-Za-z]/.test(
        normalizedBareCandidate
      )
    ) {
      candidate = normalizedBareCandidate;
    }
  }

  if (!candidate) return null;

  candidate = candidate
    .replace(
      /\s+(?:and|,)?\s*(?:my\s+)?(?:callback(?:\s+number)?|phone(?:\s+number)?|number|email)\b.*$/i,
      ""
    )
    .replace(/^[\s:=-]+|[\s,.;:-]+$/g, "")
    .trim();

  if (!candidate) return null;

  /*
   * Reuse the canonical booking-gate validator here so extraction and final
   * booking authorization cannot disagree about what counts as a real street
   * address.
   */
  if (
    !isStructurallyCompleteServiceStreetAddress(
      candidate,
      options?.addressContext
    )
  ) {
    return null;
  }

  return candidate;
}

async function mergeInboundCustomerMetadataIntoLead(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  message: string;
  fallbackEmail?: string | null;
}) {
  /*
   * Customer metadata supplied in a booking reply enriches the EXISTING lead.
   * It never creates a second lead. Any subset of name/phone/email/address is
   * persisted; the canonical booking-requirements gate later decides whether a
   * NEW appointment has enough dispatch information to be created.
   */
  const incoming = await extractLeadMetadataFromTextSemantic(
    params.message,
    params.fallbackEmail ?? null
  );

  const existingQualification = params.lead.qualification ?? {};
  const existingLocation =
    typeof existingQualification.location === "object" &&
    existingQualification.location !== null
      ? existingQualification.location
      : {};

  /*
   * Persisted customer metadata is cumulative across booking turns. The Lead
   * row is preferred, with qualification/location as a durable fallback when
   * a retrieval path omits or has not backfilled one of the direct columns.
   * Once the customer has supplied a valid required detail, a later reply that
   * omits that detail must never erase it or cause us to ask for it again.
   */
  const persistedCustomerName =
    params.lead.customer_name ??
    existingQualification.customerName ??
    existingQualification.customer_name ??
    existingQualification.name ??
    null;
  const persistedPhone =
    params.lead.phone ??
    existingQualification.phone ??
    existingQualification.customerPhone ??
    existingQualification.callbackPhone ??
    null;
  const persistedEmail =
    params.lead.email ??
    existingQualification.email ??
    existingQualification.customerEmail ??
    null;
  const persistedAddress =
    params.lead.address ??
    existingQualification.address ??
    existingLocation.address ??
    null;
  const persistedCity =
    params.lead.city ??
    existingQualification.city ??
    existingLocation.city ??
    null;
  const persistedState =
    params.lead.state ??
    existingQualification.state ??
    existingLocation.state ??
    null;
  const persistedZip =
    params.lead.zip ??
    existingQualification.zip ??
    existingLocation.zip ??
    null;

  const serviceAddressStillRequired = resolveBookingRequirements(
    params.lead
  ).missing.includes("service_address");

  const addressContext = {
    city: incoming.city ?? persistedCity ?? null,
    state: incoming.state ?? persistedState ?? null,
    zip: incoming.zip ?? persistedZip ?? null,
  };

  /*
   * Semantic extraction is not itself authorization. A semantically extracted
   * address must pass the same structural street-address validator as every
   * deterministic fallback before it can satisfy or overwrite booking state.
   */
  const structurallyValidIncomingAddress =
    isStructurallyCompleteServiceStreetAddress(
      incoming.address,
      addressContext
    )
      ? incoming.address
      : null;

  const explicitAddressFallback = structurallyValidIncomingAddress
    ? null
    : extractExplicitServiceAddressFallback(params.message, {
        allowBareAddressCandidate: serviceAddressStillRequired,
        addressContext,
      });

  /*
   * Stable customer identity wins over incidental extraction from later
   * booking-control messages. This prevents slang/typos in commands from
   * silently renaming an already-known customer while still allowing a name
   * to be filled when the lead does not have one yet.
   */
  const customerName = persistedCustomerName ?? incoming.customerName ?? null;
  const phone = incoming.phone ?? persistedPhone ?? null;
  const email = bodyContainsExplicitEmail(params.message)
    ? incoming.email ?? persistedEmail ?? null
    : persistedEmail ?? incoming.email ?? null;
  const persistedAddressStillValid =
    isStructurallyCompleteServiceStreetAddress(
      persistedAddress,
      {
        city: persistedCity,
        state: persistedState,
        zip: persistedZip,
      }
    )
      ? persistedAddress
      : null;

  const incomingAddressCandidate =
    structurallyValidIncomingAddress ?? explicitAddressFallback ?? null;

  let address = incomingAddressCandidate ?? persistedAddressStillValid ?? null;
  const city = incoming.city ?? persistedCity ?? null;
  const state = incoming.state ?? persistedState ?? null;
  const zip = incoming.zip ?? persistedZip ?? null;

  const persistedDispatchConfirmed = Boolean(
    persistedAddressStillValid &&
      (hasExplicitSecondaryServiceLocator(persistedAddressStillValid) ||
        existingQualification.serviceAddressDispatchConfirmed === true ||
        existingLocation.serviceAddressDispatchConfirmed === true)
  );

  const incomingAddressChanged = Boolean(
    incomingAddressCandidate &&
      normalizeAddressForDispatchComparison(incomingAddressCandidate) !==
        normalizeAddressForDispatchComparison(persistedAddressStillValid)
  );

  let serviceAddressDispatchConfirmed = Boolean(
    address &&
      (hasExplicitSecondaryServiceLocator(address) ||
        (!incomingAddressChanged && persistedDispatchConfirmed))
  );

  let serviceAddressDispatchConfirmationSource: string | null =
    serviceAddressDispatchConfirmed
      ? hasExplicitSecondaryServiceLocator(address)
        ? "secondary_locator_present"
        : String(
            existingQualification.serviceAddressDispatchConfirmationSource ??
              "customer_confirmed_complete"
          )
      : null;

  /*
   * A structurally valid street address is not automatically an exact dispatch
   * location. If there is no positive secondary-locator evidence, ask the
   * existing semantic layer whether the customer has explicitly confirmed the
   * address is complete as written, or whether this turn supplies the missing
   * locator for the persisted street address. We fail closed on ambiguity.
   */
  if (address && !serviceAddressDispatchConfirmed && serviceAddressStillRequired) {
    const newestTurnIsOnlySupplyingBareAddress = Boolean(
      incomingAddressCandidate &&
        !hasExplicitSecondaryServiceLocator(incomingAddressCandidate) &&
        !newestTurnAddsDispatchMeaningBeyondBareAddress({
          message: params.message,
          candidateAddress: incomingAddressCandidate,
        })
    );

    /*
     * Do not spend a semantic-model call asking whether a bare newly-supplied
     * street address is magically complete. The customer has supplied an
     * address value, not evidence about whether an additional locator applies.
     * Persist the street and let the canonical booking-requirements prompt ask
     * the one real-world follow-up. This both fails closed and removes needless
     * latency from the common bare-address turn.
     */
    const completion = newestTurnIsOnlySupplyingBareAddress
      ? ({
          disposition: "unrelated_or_unclear",
          secondaryLocator: null,
        } as ServiceLocationCompletionDecision)
      : await resolveServiceLocationCompletionTurn({
          message: params.message,
          candidateAddress: incomingAddressCandidate,
          persistedAddress: persistedAddressStillValid,
        });

    if (
      completion.disposition === "supplied_secondary_locator" &&
      completion.secondaryLocator &&
      persistedAddressStillValid
    ) {
      const combinedAddress = `${persistedAddressStillValid} ${completion.secondaryLocator}`
        .replace(/\s+/g, " ")
        .trim();

      if (
        isStructurallyCompleteServiceStreetAddress(combinedAddress, {
          city,
          state,
          zip,
        })
      ) {
        address = combinedAddress;
        serviceAddressDispatchConfirmed = true;
        serviceAddressDispatchConfirmationSource =
          "customer_supplied_secondary_locator";
      }
    } else if (completion.disposition === "complete_as_is") {
      serviceAddressDispatchConfirmed = true;
      serviceAddressDispatchConfirmationSource = "customer_confirmed_complete";
    }
  }

  const serviceArea =
  incoming.serviceArea ??
  (typeof existingQualification.serviceArea === "string"
    ? existingQualification.serviceArea
    : null);

  const nextQualification = {
    ...existingQualification,
    ...(customerName ? { customerName } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(zip ? { zip } : {}),
    ...(serviceArea ? { serviceArea } : {}),
    ...(address
      ? {
          serviceAddressDispatchConfirmed,
          serviceAddressDispatchConfirmationSource,
        }
      : {}),
    location: {
      ...(typeof existingQualification.location === "object" &&
      existingQualification.location !== null
        ? existingQualification.location
        : {}),
      ...(address ? { address } : {}),
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(zip ? { zip } : {}),
      ...(address ? { serviceAddressDispatchConfirmed } : {}),
    },
  };

  const { data, error } = await supabase
    .from("leads")
    .update({
      customer_name: customerName,
      email,
      phone,
      address,
      city,
      state,
      zip,
      qualification: nextQualification,
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .select(
      "id, company_id, status, input, message, email, phone, customer_name, address, city, state, zip, service_area, appointment_time, calendar_event_id, qualification"
    )
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("lead_metadata_merge_scope_violation");

  console.log("[inbound] merged reply metadata into existing lead", {
    leadId: data.id,
    customerName: data.customer_name ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    address: data.address ?? null,
    serviceAddressDispatchConfirmed:
      data.qualification?.serviceAddressDispatchConfirmed === true,
    city: data.city ?? null,
    state: data.state ?? null,
    zip: data.zip ?? null,
  });

  return data as LeadForInboundEmail;
}

async function getCompanyTimezone(companyId: string) {
  const { data, error } = await supabase
    .from("companies")
    .select("timezone")
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data?.timezone || "America/Chicago";
}

async function findExistingInboundEmail(
  companyId: string,
  providerEventId?: string | null
) {
  if (!providerEventId) return null;

  const { data, error } = await supabase
    .from("inbound_emails")
    .select("id, company_id, lead_id, processed, processing_error, created_at")
    .eq("company_id", companyId)
    .eq("provider_event_id", providerEventId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

async function insertInboundEmail(params: {
  companyId: string;
  leadId?: string | null;
  provider: string;
  providerEventId?: string | null;
  providerEmailId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}) {
  const existing = await findExistingInboundEmail(
    params.companyId,
    params.providerEventId
  );

  if (existing) {
    return {
      inboundEmail: existing,
      duplicateWebhookEvent: true,
    };
  }

  const { data, error } = await supabase
    .from("inbound_emails")
    .insert({
      company_id: params.companyId,
      lead_id: params.leadId ?? null,
      provider: params.provider,
      provider_event_id: params.providerEventId ?? null,
      provider_email_id: params.providerEmailId ?? null,
      from_email: params.fromEmail ?? null,
      to_email: params.toEmail ?? null,
      subject: params.subject ?? null,
      text_body: params.textBody ?? null,
      html_body: params.htmlBody ?? null,
    })
    .select("id, company_id, lead_id, processed, processing_error, created_at")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("inbound_email_insert_failed");

  return {
    inboundEmail: data,
    duplicateWebhookEvent: false,
  };
}

async function markInboundProcessed(params: {
  inboundEmailId: string;
  companyId: string;
  leadId: string;
  processingError?: string | null;
}) {
  const { error } = await supabase
    .from("inbound_emails")
    .update({
      lead_id: params.leadId,
      processed: true,
      processing_error: params.processingError ?? null,
    })
    .eq("id", params.inboundEmailId)
    .eq("company_id", params.companyId);

  if (error) throw new Error(error.message);
}

async function forceMarkLeadBooked(params: {
  companyId: string;
  leadId: string;
  appointmentTime: string;
  calendarEventId?: string | null;
  qualification: Record<string, any>;
  updates: Record<string, any>;
}) {
  if (!params.calendarEventId) {
    throw new Error("calendar_event_missing_refusing_fake_booked_status");
  }

  const { data: bookedLead, error } = await supabase
    .from("leads")
    .update({
      ...params.updates,
      status: "booked",
      appointment_time: params.appointmentTime,
      calendar_event_id: params.calendarEventId,
      qualification: params.qualification,
    })
    .eq("id", params.leadId)
    .eq("company_id", params.companyId)
    .select("id, company_id, status, appointment_time, calendar_event_id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!bookedLead) throw new Error("lead_booking_update_scope_violation");

  if (bookedLead.status !== "booked") {
    throw new Error(`lead_booking_update_failed_status_${bookedLead.status}`);
  }

  if (!bookedLead.appointment_time) {
    throw new Error("lead_booking_update_failed_missing_appointment_time");
  }

  if (!bookedLead.calendar_event_id) {
    throw new Error("lead_booking_update_failed_missing_calendar_event_id");
  }

  if (
    !slotTimesMatchWithinOneMinute(
      bookedLead.appointment_time,
      params.appointmentTime
    )
  ) {
    throw new Error("lead_booking_update_failed_appointment_time_mismatch");
  }

  if (bookedLead.calendar_event_id !== params.calendarEventId) {
    throw new Error("lead_booking_update_failed_calendar_event_id_mismatch");
  }

  console.log("[inbound] lead booking update verified", {
    leadId: bookedLead.id,
    status: bookedLead.status,
    appointmentTime: bookedLead.appointment_time,
    calendarEventId: bookedLead.calendar_event_id,
  });

  return bookedLead;
}

async function forceMarkLeadAwaitingCustomerAfterUnavailable(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  qualification: Record<string, any>;
  updates: Record<string, any>;
}) {
  /*
   * STALE-AVAILABILITY FIREWALL
   *
   * Never let an older availability job erase newer booking truth. The old
   * unbooked path updated by id/company only, so a slow/stale job could set a
   * newly booked/rescheduled lead back to awaiting_customer and null out the
   * real Calendar event.
   *
   * Compare-and-swap against the booking truth observed by this job. For an
   * unbooked lead, the row must STILL be unbooked and still have no appointment
   * or calendar_event_id. If a newer turn booked/rescheduled it, update zero
   * rows and fail closed before any stale customer reply is sent.
   */
  let updateQuery = supabase
    .from("leads")
    .update({
      ...params.updates,
      status: "awaiting_customer",
      appointment_time: null,
      calendar_event_id: null,
      qualification: params.qualification,
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId)
    .is("appointment_time", null)
    .is("calendar_event_id", null);

  if (params.lead.status) {
    const safeUnbookedStatuses = Array.from(
      new Set([
        params.lead.status,
        "new",
        "sent",
        "contacted",
        "awaiting_customer",
      ])
    );

    updateQuery = updateQuery.in("status", safeUnbookedStatuses);
  }

  const { data: updatedLead, error } = await updateQuery
    .select("id, company_id, status, appointment_time, calendar_event_id")
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!updatedLead) {
    const currentLead = await fetchLeadByIdForInbound({
      companyId: params.companyId,
      leadId: params.lead.id,
    });

    console.warn("[inbound] stale availability state suppressed", {
      leadId: params.lead.id,
      expectedStatus: params.lead.status ?? null,
      currentStatus: currentLead?.status ?? null,
      currentAppointmentTime: currentLead?.appointment_time ?? null,
      currentCalendarEventId: currentLead?.calendar_event_id ?? null,
    });

    throw new Error("stale_availability_state_refusing_newer_booking_clobber");
  }

  if (updatedLead.status !== "awaiting_customer") {
    throw new Error(`lead_unavailable_update_failed_status_${updatedLead.status}`);
  }

  if (updatedLead.appointment_time) {
    throw new Error("lead_unavailable_update_failed_fake_appointment_time");
  }

  if (updatedLead.calendar_event_id) {
    throw new Error("lead_unavailable_update_failed_fake_calendar_event_id");
  }

  console.log("[inbound] lead unavailable state verified", {
    leadId: updatedLead.id,
    status: updatedLead.status,
    appointmentTime: updatedLead.appointment_time,
    calendarEventId: updatedLead.calendar_event_id,
  });

  return updatedLead;
}

function isStaleAvailabilityStateError(error: any) {
  return (
    error?.message ===
    "stale_availability_state_refusing_newer_booking_clobber"
  );
}

async function suppressStaleAvailabilityResponse(params: {
  companyId: string;
  leadId: string;
  inboundEmailId: string;
  message: string;
}) {
  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.leadId,
    processingError: "stale_availability_response_suppressed",
  });

  console.warn("[inbound] stale availability reply not sent", {
    leadId: params.leadId,
    inboundEmailId: params.inboundEmailId,
    parsedMessage: params.message,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    staleAvailabilitySuppressed: true,
    reason: "stale_availability_response_suppressed",
    inboundEmailId: params.inboundEmailId,
    leadId: params.leadId,
    parsedMessage: params.message,
  };
}


type SelectedOfferPlacementContext = {
  referencesPersistedOffer: boolean;
  referencedOptionNumber: number | null;
  placementMode: "flexible_within_window" | "specific_within_window" | "unclear";
};

let selectedOfferPlacementClient: OpenAI | null = null;

function getSelectedOfferPlacementClient() {
  if (!process.env.OPENAI_API_KEY) return null;

  if (!selectedOfferPlacementClient) {
    selectedOfferPlacementClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return selectedOfferPlacementClient;
}

function getSingleBoundedSchedulingWindow(intent: any) {
  /*
   * Structural eligibility only. This does NOT decide whether the customer's
   * language is vague/flexible. Canonical temporal resolution remains the sole
   * authority for the actual requested window.
   */
  if (!intent?.hasPreference || intent?.targetTime) return null;
  if (intent?.customerSpecifiedTime === true) return null;

  const windows = Array.isArray(intent?.allowedWindows)
    ? intent.allowedWindows.filter(
        (window: any) =>
          typeof window?.startTime === "string" &&
          typeof window?.endTime === "string"
      )
    : [];

  if (windows.length !== 1) return null;

  const startMs = new Date(windows[0].startTime).getTime();
  const endMs = new Date(windows[0].endTime).getTime();

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

async function resolveSelectedOfferPlacementContext(params: {
  message: string;
  schedulingIntent: any;
  pendingAlternatives: AlternativeSlot[];
}): Promise<SelectedOfferPlacementContext | null> {
  const client = getSelectedOfferPlacementClient();
  if (!client || params.pendingAlternatives.length === 0) return null;

  try {
    const response = await client.chat.completions.create({
      model:
        process.env.LEADFLOW_SCHEDULING_MODEL ||
        process.env.LEADFLOW_BOOKING_COMMAND_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_selected_offer_placement_context",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "referencesPersistedOffer",
              "referencedOptionNumber",
              "placementMode",
            ],
            properties: {
              referencesPersistedOffer: { type: "boolean" },
              referencedOptionNumber: {
                type: "integer",
                minimum: 0,
                maximum: Math.max(1, params.pendingAlternatives.length),
              },
              placementMode: {
                type: "string",
                enum: [
                  "flexible_within_window",
                  "specific_within_window",
                  "unclear",
                ],
              },
            },
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "You classify conversational scheduling context only.",
            "You MUST NOT resolve, change, narrow, widen, or invent any date/time window.",
            "You MUST NOT decide availability and MUST NOT authorize a booking, reschedule, cancellation, or restoration.",
            "The supplied canonical scheduling intent is authoritative for WHEN.",
            "The persisted offered options are conversation context only.",
            "First decide whether the newest customer message clearly references exactly one persisted offered option. If not, referencesPersistedOffer=false and referencedOptionNumber=0.",
            "Then classify placementMode relative to the already-resolved canonical window.",
            "flexible_within_window means the customer's language itself communicates that the exact placement inside the canonical window is intentionally open, loose, or indifferent, so choosing one arbitrary point would add precision the customer did not provide.",
            "specific_within_window means the customer's language communicates a preferred point, subrange, ordering, edge, priority, day/date/time, or other placement preference inside the canonical window.",
            "Do not call a message specific merely because it defines the canonical window itself; specific_within_window requires additional placement meaning inside that already-resolved window, except that an exact day/date/time is itself specific placement.",
            "unclear means the language does not safely establish either meaning.",
            "Mere absence of a clock, mere existence of a bounded window, or temporalGranularity=window is NOT by itself evidence of flexibility.",
            "Use meaning, not a fixed phrase list. Treat slang, abbreviations, and professional language equivalently when they express the same meaning.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            newestCustomerMessage: params.message,
            canonicalSchedulingIntent: {
              allowedWindows: params.schedulingIntent?.allowedWindows ?? [],
              excludedWindows: params.schedulingIntent?.excludedWindows ?? [],
              targetTime: params.schedulingIntent?.targetTime ?? null,
              selectionMode: params.schedulingIntent?.selectionMode ?? null,
              temporalGranularity:
                params.schedulingIntent?.temporalGranularity ?? null,
              customerSpecifiedDate:
                params.schedulingIntent?.customerSpecifiedDate === true,
              customerSpecifiedTime:
                params.schedulingIntent?.customerSpecifiedTime === true,
              displayPreference:
                params.schedulingIntent?.displayPreference ?? null,
              originalPreference:
                params.schedulingIntent?.originalPreference ?? null,
              interpretation:
                params.schedulingIntent?.interpretation ?? null,
            },
            persistedOfferedOptions: params.pendingAlternatives.map(
              (slot, index) => ({
                optionNumber: index + 1,
                startTime: slot.startTime,
                endTime: slot.endTime ?? null,
              })
            ),
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const optionNumber = Number(parsed?.referencedOptionNumber);
    const referencesPersistedOffer =
      parsed?.referencesPersistedOffer === true &&
      Number.isInteger(optionNumber) &&
      optionNumber >= 1 &&
      optionNumber <= params.pendingAlternatives.length;

    const placementMode =
      parsed?.placementMode === "flexible_within_window" ||
      parsed?.placementMode === "specific_within_window" ||
      parsed?.placementMode === "unclear"
        ? parsed.placementMode
        : "unclear";

    return {
      referencesPersistedOffer,
      referencedOptionNumber: referencesPersistedOffer ? optionNumber : null,
      placementMode,
    };
  } catch (error: any) {
    console.error("[inbound] selected-offer placement context resolution failed", {
      error: error?.message ?? error,
      parsedMessage: params.message,
    });
    return null;
  }
}


type SelectedOfferRelativeTransformRelation =
  | "selected_offer_transform"
  | "different_anchor_transform"
  | "unclear";

async function resolveSelectedOfferRelativeTransformRelation(params: {
  message: string;
  selectedOffer: AlternativeSlot;
  selectedOptionNumber: number;
  bookingCommandReason?: string | null;
  temporalOperation: any;
  schedulingIntent: any;
}): Promise<SelectedOfferRelativeTransformRelation> {
  const client = getSelectedOfferPlacementClient();
  if (!client) return "unclear";

  try {
    const response = await client.chat.completions.create({
      model:
        process.env.LEADFLOW_SCHEDULING_MODEL ||
        process.env.LEADFLOW_BOOKING_COMMAND_MODEL ||
        "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_selected_offer_relative_transform_relation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["relation"],
            properties: {
              relation: {
                type: "string",
                enum: [
                  "selected_offer_transform",
                  "different_anchor_transform",
                  "unclear",
                ],
              },
            },
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "You classify one narrow scheduling-semantic relationship only.",
            "The booking-command authority has already determined that the customer selected exactly one persisted offered appointment. Separately, the scheduling resolver produced a relative temporal shift from the same newest customer turn.",
            "Decide only whether that relative shift semantically modifies the selected persisted offer, or instead clearly uses a different temporal anchor such as now/current time or another appointment.",
            "selected_offer_transform means the customer is taking the selected offered appointment as the temporal anchor and changing it by the relative shift. Conversational filler, politeness, slang, or action wording must not change this meaning.",
            "different_anchor_transform means the customer's words clearly attach the relative shift to a different anchor rather than the selected offer.",
            "unclear means the anchor relationship cannot be established safely from meaning.",
            "Do not decide what happens to the clock. Do not compute dates, offsets, option numbers, availability, business hours, or booking authority.",
            "Use meaning rather than a phrase list. Semantically equivalent professional, casual, abbreviated, or slang wording must classify identically.",
          ].join("\\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            newestCustomerMessage: params.message,
            authoritativeSelectedOptionNumber: params.selectedOptionNumber,
            bookingCommandReason: params.bookingCommandReason ?? null,
            selectedPersistedOffer: {
              startTime: params.selectedOffer.startTime,
              endTime: params.selectedOffer.endTime ?? null,
            },
            semanticTemporalOperation: params.temporalOperation,
            semanticSchedulingIntent: {
              targetTime: params.schedulingIntent?.targetTime ?? null,
              allowedWindows: params.schedulingIntent?.allowedWindows ?? [],
              customerSpecifiedDate:
                params.schedulingIntent?.customerSpecifiedDate === true,
              customerSpecifiedTime:
                params.schedulingIntent?.customerSpecifiedTime === true,
              temporalGranularity:
                params.schedulingIntent?.temporalGranularity ?? null,
              displayPreference:
                params.schedulingIntent?.displayPreference ?? null,
              originalPreference:
                params.schedulingIntent?.originalPreference ?? null,
              interpretation:
                params.schedulingIntent?.interpretation ?? null,
            },
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return "unclear";

    const parsed = JSON.parse(raw);
    return parsed?.relation === "selected_offer_transform" ||
      parsed?.relation === "different_anchor_transform" ||
      parsed?.relation === "unclear"
      ? parsed.relation
      : "unclear";
  } catch (error: any) {
    console.error(
      "[inbound] selected-offer relative transform relation resolution failed",
      {
        error: error?.message ?? error,
        parsedMessage: params.message,
      }
    );
    return "unclear";
  }
}

async function normalizeSelectedOfferRelativeCalendarShiftClock(params: {
  message: string;
  schedulingIntent: any;
  bookingCommand: BookingCommandResult;
  pendingAlternatives: AlternativeSlot[];
}) {
  const operation = params.schedulingIntent?.temporalOperation;

  if (!operation || operation.kind !== "shift") {
    return params.schedulingIntent;
  }

  if (
    params.bookingCommand.kind !== "select_offer" ||
    params.bookingCommand.selectedOptionNumber === null
  ) {
    return params.schedulingIntent;
  }

  const selectedOptionNumber = params.bookingCommand.selectedOptionNumber;
  const selectedOffer =
    params.pendingAlternatives[selectedOptionNumber - 1] ?? null;

  if (!selectedOffer?.startTime) return params.schedulingIntent;

  const hasCalendarShift = [
    operation.years,
    operation.months,
    operation.weeks,
    operation.days,
  ].some((value) => Number(value ?? 0) !== 0);

  const hasElapsedClockShift =
    Number(operation.hours ?? 0) !== 0 ||
    Number(operation.minutes ?? 0) !== 0;

  const hasReplacementClock = Boolean(
    operation.setClock &&
      Number.isInteger(Number(operation.setClock.hour)) &&
      Number.isInteger(Number(operation.setClock.minute))
  );

  if (!hasCalendarShift && !hasElapsedClockShift) {
    return params.schedulingIntent;
  }

  const operationOptionNumber = Number(operation.optionNumber);
  const operationNamesDifferentOffer =
    operation.anchorKind === "selected_offer" &&
    Number.isFinite(operationOptionNumber) &&
    operationOptionNumber !== selectedOptionNumber;

  if (operationNamesDifferentOffer) {
    return params.schedulingIntent;
  }

  const anchorAlreadyMatchesSelectedOffer =
    operation.anchorKind === "selected_offer";
  const anchorCanBeReconciledFromSelectedOfferContext =
    anchorAlreadyMatchesSelectedOffer ||
    operation.anchorKind === "active_temporal_context";

  if (!anchorCanBeReconciledFromSelectedOfferContext) {
    return params.schedulingIntent;
  }

  let relation: SelectedOfferRelativeTransformRelation =
    anchorAlreadyMatchesSelectedOffer
      ? "selected_offer_transform"
      : "unclear";

  if (!anchorAlreadyMatchesSelectedOffer) {
    relation = await resolveSelectedOfferRelativeTransformRelation({
      message: params.message,
      selectedOffer,
      selectedOptionNumber,
      bookingCommandReason: params.bookingCommand.reason ?? null,
      temporalOperation: operation,
      schedulingIntent: params.schedulingIntent,
    });
  }

  if (relation !== "selected_offer_transform") {
    return params.schedulingIntent;
  }

  /*
   * SELECTED-OFFER CALENDAR TRANSFORM CLOCK INVARIANT
   *
   * Once WHAT authority has selected one persisted offer and temporal semantics
   * say the relative transform applies to that offer, a pure calendar-unit move
   * inherits the offer's local clock unless the customer supplied positive clock
   * meaning of their own.
   *
   * Crucially, preserveClock=false from the semantic model is NOT positive evidence
   * that the customer released the clock. A model cannot erase an authoritative
   * offered clock merely because the newest message omitted a time. Positive clock
   * meaning is carried structurally by one of the following existing semantic facts:
   *   - setClock: explicit replacement clock;
   *   - hours/minutes: elapsed clock movement;
   *   - customerSpecifiedTime: the customer supplied new time/daypart meaning.
   *
   * Therefore a selected-offer pure calendar-unit move with none of those facts
   * deterministically preserves the offered clock. This is a
   * semantic invariant, not customer-phrase matching and not date grammar.
   */
  const customerSuppliedClockMeaning =
    hasReplacementClock ||
    hasElapsedClockShift ||
    params.schedulingIntent?.customerSpecifiedTime === true;

  const shouldInheritOfferClock =
    hasCalendarShift && !customerSuppliedClockMeaning;

  const normalizedOperation = {
    ...operation,
    anchorKind: "selected_offer",
    optionNumber: selectedOptionNumber,
    preserveClock: shouldInheritOfferClock
      ? true
      : operation.preserveClock,
  };

  console.log("[inbound] selected-offer relative transform normalized", {
    selectedOptionNumber,
    selectedOfferStartTime: selectedOffer.startTime,
    originalTemporalAnchorKind: operation.anchorKind ?? null,
    originalTemporalOptionNumber: operation.optionNumber ?? null,
    originalPreserveClock: operation.preserveClock ?? null,
    relation,
    hasCalendarShift,
    hasElapsedClockShift,
    hasReplacementClock,
    customerSpecifiedTime:
      params.schedulingIntent?.customerSpecifiedTime === true,
    normalizedPreserveClock: normalizedOperation.preserveClock ?? null,
    parsedMessage: params.message,
  });

  return {
    ...params.schedulingIntent,
    temporalOperation: normalizedOperation,
  };
}

function normalizeActiveAppointmentRelativeCalendarShiftClock(params: {
  message: string;
  schedulingIntent: any;
  bookingCommand: BookingCommandResult;
  activeAppointmentTime?: string | null;
  timezone: string;
}) {
  const operation = params.schedulingIntent?.temporalOperation;

  if (
    !operation ||
    operation.kind !== "shift" ||
    params.bookingCommand.kind !== "reschedule" ||
    !params.activeAppointmentTime
  ) {
    return params.schedulingIntent;
  }

  const hasCalendarShift = [
    operation.years,
    operation.months,
    operation.weeks,
    operation.days,
  ].some((value) => Number(value ?? 0) !== 0);

  const hasElapsedClockShift =
    Number(operation.hours ?? 0) !== 0 ||
    Number(operation.minutes ?? 0) !== 0;

  const hasReplacementClock = Boolean(
    operation.setClock &&
      Number.isInteger(Number(operation.setClock.hour)) &&
      Number.isInteger(Number(operation.setClock.minute))
  );

  const anchorCanBeActiveAppointment =
    operation.anchorKind === "active_appointment" ||
    operation.anchorKind === "active_temporal_context";

  if (
    !hasCalendarShift ||
    hasElapsedClockShift ||
    hasReplacementClock ||
    !anchorCanBeActiveAppointment
  ) {
    return params.schedulingIntent;
  }

  const activeAppointmentClock = getLocalClockForIso(
    params.activeAppointmentTime,
    params.timezone
  );

  if (!activeAppointmentClock) {
    return params.schedulingIntent;
  }

  /*
   * ACTIVE-APPOINTMENT CALENDAR TRANSFORM CLOCK INVARIANT
   *
   * A pure years/months/weeks/days move is calendar arithmetic. With no new
   * customer clock and no elapsed hours/minutes shift, preserve the active
   * appointment's LOCAL wall-clock time. Carrying that clock structurally is
   * stronger than a boolean preserveClock hint: the canonical temporal layer
   * receives the authoritative wall clock directly and can reconstruct the
   * destination instant using the destination date's actual timezone offset.
   *
   * This is what prevents DST boundaries from silently turning (for example)
   * 2:30 PM into 1:30 PM while still allowing the UTC instant to change.
   * Explicit replacement clocks and elapsed clock shifts bypass this invariant
   * above and therefore retain their existing behavior.
   *
   * This rule is structural and contains no customer-phrase/date hardcoding.
   */
  return {
    ...params.schedulingIntent,
    temporalOperation: {
      ...operation,
      anchorKind: "active_appointment",
      setClock: {
        hour: activeAppointmentClock.hour,
        minute: activeAppointmentClock.minute,
      },
      preserveClock: true,
    },
  };
}

async function suggestRepresentativeVerifiedSlotsAcrossWindow(params: {
  companyId: string;
  requestedStartTime: string;
  requestedEndTime: string;
  timezone: string;
  previouslyOffered: AlternativeSlot[];
  desiredCount: number;
}) {
  const startMs = new Date(params.requestedStartTime).getTime();
  const endMs = new Date(params.requestedEndTime).getTime();

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    !Number.isInteger(params.desiredCount) ||
    params.desiredCount <= 0
  ) {
    return [] as AlternativeSlot[];
  }

  const previouslyOfferedKeys = new Set(
    params.previouslyOffered.map((slot) => alternativeSlotKey(slot))
  );
  const selected: AlternativeSlot[] = [];
  const selectedKeys = new Set<string>();
  const spanMs = endMs - startMs;

  const addFirstValid = (candidates: AlternativeSlot[], regionStart: number, regionEnd: number) => {
    for (const slot of candidates) {
      if (!slot?.startTime) continue;

      const slotStartMs = new Date(slot.startTime).getTime();
      const slotEndMs = slot.endTime
        ? new Date(slot.endTime).getTime()
        : slotStartMs;
      const key = alternativeSlotKey(slot);

      if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs)) continue;
      if (slotStartMs < regionStart || slotStartMs >= regionEnd) continue;
      if (slotEndMs > endMs) continue;
      if (previouslyOfferedKeys.has(key) || selectedKeys.has(key)) continue;

      selected.push(slot);
      selectedKeys.add(key);
      return true;
    }

    return false;
  };

  for (let index = 0; index < params.desiredCount; index += 1) {
    const regionStart = startMs + (spanMs * index) / params.desiredCount;
    const regionEnd =
      index === params.desiredCount - 1
        ? endMs
        : startMs + (spanMs * (index + 1)) / params.desiredCount;
    const regionCenter = regionStart + (regionEnd - regionStart) / 2;

    let candidates: AlternativeSlot[] = [];

    try {
      candidates = await suggestCadenceAlignedAlternativeSlots({
        companyId: params.companyId,
        requestedStartTime: new Date(regionCenter).toISOString(),
        requestedEndTime: new Date(regionEnd).toISOString(),
        timezone: params.timezone,
      });
    } catch (error: any) {
      console.error("[inbound] representative region availability lookup failed", {
        requestedStartTime: new Date(regionCenter).toISOString(),
        requestedEndTime: new Date(regionEnd).toISOString(),
        error: error?.message ?? error,
      });
    }

    if (addFirstValid(candidates, regionStart, regionEnd)) continue;

    try {
      candidates = await suggestCadenceAlignedAlternativeSlots({
        companyId: params.companyId,
        requestedStartTime: new Date(regionStart).toISOString(),
        requestedEndTime: new Date(regionEnd).toISOString(),
        timezone: params.timezone,
      });
    } catch (error: any) {
      console.error("[inbound] representative region fallback lookup failed", {
        requestedStartTime: new Date(regionStart).toISOString(),
        requestedEndTime: new Date(regionEnd).toISOString(),
        error: error?.message ?? error,
      });
    }

    addFirstValid(candidates, regionStart, regionEnd);
  }

  if (selected.length < params.desiredCount) {
    try {
      const fallbackCandidates = await suggestCadenceAlignedAlternativeSlots({
        companyId: params.companyId,
        requestedStartTime: params.requestedStartTime,
        requestedEndTime: params.requestedEndTime,
        timezone: params.timezone,
      });

      for (const slot of fallbackCandidates) {
        if (selected.length >= params.desiredCount) break;
        if (!slot?.startTime) continue;

        const slotStartMs = new Date(slot.startTime).getTime();
        const slotEndMs = slot.endTime
          ? new Date(slot.endTime).getTime()
          : slotStartMs;
        const key = alternativeSlotKey(slot);

        if (!Number.isFinite(slotStartMs) || !Number.isFinite(slotEndMs)) continue;
        if (slotStartMs < startMs || slotStartMs >= endMs) continue;
        if (slotEndMs > endMs) continue;
        if (previouslyOfferedKeys.has(key) || selectedKeys.has(key)) continue;

        selected.push(slot);
        selectedKeys.add(key);
      }
    } catch (error: any) {
      console.error("[inbound] representative whole-window fallback failed", {
        requestedStartTime: params.requestedStartTime,
        requestedEndTime: params.requestedEndTime,
        error: error?.message ?? error,
      });
    }
  }

  return selected.sort(
    (a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
}

async function sendRequestedWindowOptionsAndStorePending(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  companyTimezone: string;
  message: string;
  alternatives: AlternativeSlot[];
  originalRequestedStartTime: string;
  originalRequestedEndTime?: string | null;
  schedulingPreferenceText?: string | null;
  readOnlyAvailabilityInquiry?: boolean;
  genericReadOnlyAvailabilityInquiry?: boolean;
  mixedInformationAnswer?: string | null;
  suggestionReason?: string | null;
  introOverride?: string | null;
  closingPromptOverride?: string | null;
  resultReason?: string | null;
}) {
  const cleanAlternatives = getCleanAlternativeSlots(params.alternatives);

  if (cleanAlternatives.length === 0) {
    throw new Error("requested_window_options_missing");
  }

  const nextQualification = {
    ...(params.lead.qualification ?? {}),
    pendingSlotSuggestion: {
      status: "awaiting_customer_confirmation",
      originalRequestedStartTime: params.originalRequestedStartTime,
      originalRequestedEndTime: params.originalRequestedEndTime,
      suggestedStartTime: cleanAlternatives[0]?.startTime ?? null,
      suggestedEndTime: cleanAlternatives[0]?.endTime ?? null,
      suggestedSlots: cleanAlternatives,
      customerReply: params.message,
      suggestedAt: new Date().toISOString(),
      suggestionReason:
        params.suggestionReason?.trim() ||
        (params.readOnlyAvailabilityInquiry
          ? "customer_asked_to_see_availability"
          : "customer_requested_window"),
    },
  };

  try {
    try {
      await storePendingSchedulingState({
        companyId: params.companyId,
        lead: params.lead,
        qualification: nextQualification,
        updates: params.inboundUpdates,
      });
    } catch (error: any) {
      if (!isStaleAvailabilityStateError(error)) throw error;
      console.warn("[inbound] newer booking truth won after availability reply send", {
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
      });
    }
  } catch (error: any) {
    if (isStaleAvailabilityStateError(error)) {
      return suppressStaleAvailabilityResponse({
        companyId: params.companyId,
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
        message: params.message,
      });
    }
    throw error;
  }

  if (params.toEmail) {
    const requestedText =
      formatCustomerRequestedPeriod({
        startTime: params.originalRequestedStartTime,
        endTime: params.originalRequestedEndTime,
        timezone: params.companyTimezone,
      }) ||
      params.schedulingPreferenceText?.trim() ||
      "that requested time window";

    const optionList = cleanAlternatives
      .map((slot, index) =>
        formatAlternativeSlot(slot, index, params.companyTimezone, true)
      )
      .join("\n");

    const intro =
      params.introOverride?.trim() ||
      (params.genericReadOnlyAvailabilityInquiry
        ? "Here are the next real openings we have:"
        : params.readOnlyAvailabilityInquiry
          ? `Here are the real openings we have for ${requestedText}:`
          : `Your request for ${requestedText} is available. Here are the options we can book:`);

    const closingPrompt =
      params.closingPromptOverride?.trim() || "Which one works best?";

    const actionBody = [
      intro,
      "",
      optionList,
      "",
      closingPrompt,
    ].join("\n");

    const body = mergeMixedInformationWithActionReply(
      params.mixedInformationAnswer,
      actionBody
    );

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body,
      isFollowUp: false,
    });

    await storePendingSchedulingState({
      companyId: params.companyId,
      lead: params.lead,
      qualification: nextQualification,
      updates: params.inboundUpdates,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    reason: params.resultReason?.trim() || "requested_window_options_sent",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    companyTimezone: params.companyTimezone,
    parsedMessage: params.message,
    alternatives: cleanAlternatives,
  };
}


async function sendReadOnlyAvailabilityNoMatches(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  companyTimezone: string;
  message: string;
  originalRequestedStartTime: string;
  originalRequestedEndTime?: string | null;
  schedulingIntent: any;
  availabilityLookupFailed?: boolean;
  businessHoursStatus?: {
    timezone: string;
    weekday: string;
    closed: boolean;
    closedByCompanyRule: boolean;
    configuredByCompany: boolean;
    source: "company" | "default";
    open: string | null;
    close: string | null;
  } | null;
}) {
  const currentQualification = params.lead.qualification ?? {};
  const {
    pendingSlotSuggestion: _discardedPendingSlotSuggestion,
    ...qualificationWithoutPendingSlots
  } = currentQualification;

  const nextQualification = {
    ...qualificationWithoutPendingSlots,
    schedulingIntent: params.schedulingIntent,
  };

  try {
    await storePendingSchedulingState({
      companyId: params.companyId,
      lead: params.lead,
      qualification: nextQualification,
      updates: params.inboundUpdates,
    });
  } catch (error: any) {
    if (isStaleAvailabilityStateError(error)) {
      return suppressStaleAvailabilityResponse({
        companyId: params.companyId,
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
        message: params.message,
      });
    }
    throw error;
  }

  if (params.toEmail) {
    const requestedText =
      formatCustomerRequestedPeriod({
        startTime: params.originalRequestedStartTime,
        endTime: params.originalRequestedEndTime ?? null,
        timezone: params.companyTimezone,
      }) || "that time";

    const requestedDate = new Date(params.originalRequestedStartTime);
    const requestedDateText = Number.isNaN(requestedDate.getTime())
      ? null
      : requestedDate.toLocaleDateString("en-US", {
          timeZone: params.companyTimezone,
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });

    const body = params.businessHoursStatus?.closedByCompanyRule
      ? [
          `${requestedDateText ?? "That day"} is unavailable for appointments because the company's settings mark that day as closed.`,
          "",
          "If you want, tell me another day or time and I'll check the real openings.",
        ].join("\n")
      : params.availabilityLookupFailed
        ? [
            `I couldn't verify the real appointment availability for ${requestedText} right now, so I don't want to guess.`,
            "",
            "If you want, try another day or time and I'll check again.",
          ].join("\n")
        : params.businessHoursStatus && !params.businessHoursStatus.closed
          ? [
              `We're open on ${requestedDateText ?? "that day"} under the applicable business-hours rule, but there aren't any real openings for ${requestedText}.`,
              "",
              "If you want, tell me another day or time and I'll check the real openings.",
            ].join("\n")
          : [
              `There aren't any real openings for ${requestedText}.`,
              "",
              "If you want, tell me another day or time and I'll check the real openings.",
            ].join("\n");

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body,
      isFollowUp: false,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    informationAnswered: true,
    reason: "read_only_availability_no_matching_openings",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    parsedMessage: params.message,
  };
}


async function sendExpandedAvailabilityOptionsAndStorePending(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  companyTimezone: string;
  message: string;
  alternatives: AlternativeSlot[];
  originalRequestedStartTime: string;
  originalRequestedEndTime?: string | null;
  previouslyOfferedStillAvailable: AlternativeSlot[];
}) {
  const cleanAlternatives = getCleanAlternativeSlots(params.alternatives);
  const stillAvailable = getCleanAlternativeSlots(
    params.previouslyOfferedStillAvailable
  );

  const requestedText =
    formatCustomerRequestedPeriod({
      startTime: params.originalRequestedStartTime,
      endTime: params.originalRequestedEndTime ?? null,
      timezone: params.companyTimezone,
    }) || "your requested window";

  if (cleanAlternatives.length === 0) {
    if (params.toEmail) {
      const previousAvailabilityLine =
        stillAvailable.length === 1
          ? `The ${new Date(stillAvailable[0].startTime).toLocaleString(
              "en-US",
              {
                timeZone: params.companyTimezone,
                weekday: "short",
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }
            )} option I already sent is still available.`
          : stillAvailable.length > 1
            ? "The appointment options I already sent are still available."
            : null;

      const body = [
        `I don't have another confirmed opening inside ${requestedText}.`,
        previousAvailabilityLine,
      ]
        .filter(Boolean)
        .join("\n\n");

      await sendLeadReply({
        companyId: params.companyId,
        leadId: params.lead.id,
        to: params.toEmail,
        subject: params.subject ?? "Re: Your HVAC Request",
        body,
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: params.inboundEmailId,
      companyId: params.companyId,
      leadId: params.lead.id,
    });

    return {
      success: true,
      processed: true,
      booked: false,
      reason: "no_additional_availability_inside_requested_window",
      inboundEmailId: params.inboundEmailId,
      leadId: params.lead.id,
      alternatives: [],
    };
  }

  const nextQualification = {
    ...(params.lead.qualification ?? {}),
    pendingSlotSuggestion: {
      status: "awaiting_customer_confirmation",
      originalRequestedStartTime: params.originalRequestedStartTime,
      originalRequestedEndTime: params.originalRequestedEndTime ?? null,
      suggestedStartTime: cleanAlternatives[0]?.startTime ?? null,
      suggestedEndTime: cleanAlternatives[0]?.endTime ?? null,
      suggestedSlots: cleanAlternatives,
      customerReply: params.message,
      suggestedAt: new Date().toISOString(),
      suggestionReason: "customer_requested_additional_options_outside_window",
    },
  };

  try {
    await storePendingSchedulingState({
      companyId: params.companyId,
      lead: params.lead,
      qualification: nextQualification,
      updates: params.inboundUpdates,
    });
  } catch (error: any) {
    if (isStaleAvailabilityStateError(error)) {
      return suppressStaleAvailabilityResponse({
        companyId: params.companyId,
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
        message: params.message,
      });
    }
    throw error;
  }

  if (params.toEmail) {
    const optionList = cleanAlternatives
      .map((slot, index) =>
        formatAlternativeSlot(slot, index, params.companyTimezone, true)
      )
      .join("\n");

    const previousAvailabilityLine =
      stillAvailable.length === 1
        ? `The ${new Date(stillAvailable[0].startTime).toLocaleString(
            "en-US",
            {
              timeZone: params.companyTimezone,
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }
          )} option I already sent is still available.`
        : stillAvailable.length > 1
          ? "The appointment options I already sent are still available."
          : null;

    const body = [
      `I don't have another opening inside ${requestedText}.`,
      previousAvailabilityLine,
      "",
      "If you're flexible outside that window, here are the next real openings we can book:",
      "",
      optionList,
      "",
      "Which one works best?",
    ]
      .filter((line) => line !== null)
      .join("\n");

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body,
      isFollowUp: false,
    });

    /*
     * sendLeadReply may move an unbooked lead through a benign "contacted"
     * status. Re-assert pending choice state only while booking truth is still
     * empty. storePendingSchedulingState's compare-and-swap firewall prevents
     * any newer booked/rescheduled/cancelled state from being clobbered.
     */
    try {
      await storePendingSchedulingState({
        companyId: params.companyId,
        lead: params.lead,
        qualification: nextQualification,
        updates: params.inboundUpdates,
      });
    } catch (error: any) {
      if (!isStaleAvailabilityStateError(error)) throw error;
      console.warn(
        "[inbound] newer booking truth won after expanded availability reply",
        {
          leadId: params.lead.id,
          inboundEmailId: params.inboundEmailId,
        }
      );
    }
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  return {
    success: true,
    processed: true,
    booked: false,
    reason: "expanded_availability_options_sent",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    alternatives: cleanAlternatives,
  };
}

async function sendUnavailableAndStorePending(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  inboundUpdates: Record<string, any>;
  toEmail?: string | null;
  subject?: string | null;
  companyTimezone: string;
  message: string;
  reason: "outside_business_hours" | "slot_unavailable" | "not_offered_option";
  alternatives: AlternativeSlot[];
  originalRequestedStartTime?: string | null;
  originalRequestedEndTime?: string | null;
  schedulingPreferenceText?: string | null;
  mixedInformationAnswer?: string | null;
}) {
  const nextQualification = {
    ...(params.lead.qualification ?? {}),
    pendingSlotSuggestion: {
      status: "awaiting_customer_confirmation",
      originalRequestedStartTime: params.originalRequestedStartTime ?? null,
      originalRequestedEndTime: params.originalRequestedEndTime ?? null,
      suggestedStartTime: params.alternatives[0]?.startTime ?? null,
      suggestedEndTime: params.alternatives[0]?.endTime ?? null,
      suggestedSlots: params.alternatives,
      customerReply: params.message,
      suggestedAt: new Date().toISOString(),
      unavailableReason: params.reason,
    },
  };

  try {
    try {
      await storePendingSchedulingState({
        companyId: params.companyId,
        lead: params.lead,
        qualification: nextQualification,
        updates: params.inboundUpdates,
      });
    } catch (error: any) {
      if (!isStaleAvailabilityStateError(error)) throw error;
      console.warn("[inbound] newer booking truth won after availability reply send", {
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
      });
    }
  } catch (error: any) {
    if (isStaleAvailabilityStateError(error)) {
      return suppressStaleAvailabilityResponse({
        companyId: params.companyId,
        leadId: params.lead.id,
        inboundEmailId: params.inboundEmailId,
        message: params.message,
      });
    }
    throw error;
  }

  if (params.toEmail) {
    const baseUnavailableReplyBody = buildUnavailableReply({
      reason: params.reason,
      alternatives: params.alternatives,
      timezone: params.companyTimezone,
      originalRequestedStartTime: params.originalRequestedStartTime ?? null,
      originalRequestedEndTime: params.originalRequestedEndTime ?? null,
      schedulingPreferenceText: params.schedulingPreferenceText ?? null,
    });

    const actionUnavailableReplyBody =
      params.lead.status === "booked" &&
      params.lead.appointment_time &&
      params.lead.calendar_event_id
        ? [
            baseUnavailableReplyBody,
            "",
            `Your current appointment for ${new Date(
              params.lead.appointment_time
            ).toLocaleString("en-US", {
              timeZone: params.companyTimezone,
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })} remains booked until you choose a replacement.`,
          ].join("\n")
        : baseUnavailableReplyBody;

    const unavailableReplyBody = mergeMixedInformationWithActionReply(
      params.mixedInformationAnswer,
      actionUnavailableReplyBody
    );

    console.log("[inbound] sending unavailable slot response", {
      leadId: params.lead.id,
      reason: params.reason,
      toEmail: params.toEmail,
      alternativeCount: getCleanAlternativeSlots(params.alternatives).length,
      bodyPreview: unavailableReplyBody.slice(0, 260),
    });

    if (
      !unavailableReplyBody.includes("is not available") &&
      !unavailableReplyBody.includes("outside our service hours") &&
      !unavailableReplyBody.includes("not one of the open appointment options")
    ) {
      throw new Error("unavailable_reply_body_missing_unavailable_sentence");
    }

    if (!unavailableReplyBody.includes("Here are the next real openings we can book:")) {
      throw new Error("unavailable_reply_body_missing_real_openings_sentence");
    }

    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body: unavailableReplyBody,
      isFollowUp: false,
    });

    await storePendingSchedulingState({
      companyId: params.companyId,
      lead: params.lead,
      qualification: nextQualification,
      updates: params.inboundUpdates,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
    processingError:
      params.reason === "outside_business_hours"
        ? "requested_time_outside_business_hours"
        : params.reason === "not_offered_option"
          ? "requested_time_not_in_suggested_options"
          : "requested_slot_unavailable",
  });

  return {
    success: true,
    processed: true,
    booked: false,
    reason:
      params.reason === "outside_business_hours"
        ? "requested_time_outside_business_hours"
        : params.reason === "not_offered_option"
          ? "requested_time_not_in_suggested_options"
          : "requested_slot_unavailable",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    companyTimezone: params.companyTimezone,
    parsedMessage: params.message,
    alternatives: params.alternatives,
  };
}


type RescheduleLineage = {
  version: 1;
  calendarEventId: string;
  originalAppointmentTime: string;
  originalAppointmentEndTime: string | null;
  lastCompletedReschedule: {
    fromAppointmentTime: string;
    fromAppointmentEndTime: string | null;
    toAppointmentTime: string;
    toAppointmentEndTime: string | null;
    completedAt: string;
    completedByReply: string;
    status: "active" | "undone" | "restored_original";
    restoredAt?: string | null;
    restoredByReply?: string | null;
  };
};

function getRescheduleLineage(
  qualification: Record<string, any> | null | undefined
): RescheduleLineage | null {
  const raw = qualification?.rescheduleLineage;

  if (!raw || typeof raw !== "object") return null;
  if (raw.version !== 1) return null;

  const calendarEventId = String(raw.calendarEventId ?? "").trim();
  const originalAppointmentTime = String(
    raw.originalAppointmentTime ?? ""
  ).trim();

  const last = raw.lastCompletedReschedule;

  if (
    !calendarEventId ||
    !originalAppointmentTime ||
    !last ||
    typeof last !== "object"
  ) {
    return null;
  }

  const fromAppointmentTime = String(
    last.fromAppointmentTime ?? ""
  ).trim();
  const toAppointmentTime = String(
    last.toAppointmentTime ?? ""
  ).trim();

  if (!fromAppointmentTime || !toAppointmentTime) return null;

  return raw as RescheduleLineage;
}

function buildQualificationWithSuccessfulRescheduleLineage(params: {
  lead: LeadForInboundEmail;
  qualification: Record<string, any>;
  booking: any;
  customerReply: string;
}) {
  if (
    params.booking?.rescheduled !== true ||
    !params.booking?.calendarEventId ||
    !params.booking?.appointmentTime ||
    !params.booking?.previousAppointmentTime
  ) {
    return params.qualification;
  }

  const existing = getRescheduleLineage(params.lead.qualification);

  const sameLineage =
    existing?.calendarEventId === params.booking.calendarEventId;

  const originalAppointmentTime =
    sameLineage && existing
      ? existing.originalAppointmentTime
      : params.booking.previousAppointmentTime;

  const originalAppointmentEndTime =
    sameLineage && existing
      ? existing.originalAppointmentEndTime
      : params.booking.previousAppointmentEndTime ?? null;

  const lineage: RescheduleLineage = {
    version: 1,
    calendarEventId: params.booking.calendarEventId,
    originalAppointmentTime,
    originalAppointmentEndTime,
    lastCompletedReschedule: {
      fromAppointmentTime: params.booking.previousAppointmentTime,
      fromAppointmentEndTime:
        params.booking.previousAppointmentEndTime ?? null,
      toAppointmentTime: params.booking.appointmentTime,
      toAppointmentEndTime:
        params.booking.appointmentEndTime ?? null,
      completedAt: new Date().toISOString(),
      completedByReply: params.customerReply,
      status: "active",
    },
  };

  return {
    ...params.qualification,
    rescheduleLineage: lineage,
  };
}



function getStoredSchedulingContextForAvailabilityOptions(
  qualification: Record<string, any> | null | undefined
) {
  const raw = qualification?.schedulingIntent;

  if (!raw || typeof raw !== "object" || raw.hasPreference !== true) {
    return null;
  }

  const allowedWindows = Array.isArray(raw.allowedWindows)
    ? raw.allowedWindows
        .map((window: any) => ({
          startTime:
            typeof window?.startTime === "string" ? window.startTime : null,
          endTime:
            typeof window?.endTime === "string" ? window.endTime : null,
        }))
        .filter(
          (window: { startTime: string | null; endTime: string | null }) =>
            Boolean(window.startTime)
        )
    : [];

  const primaryWindow = allowedWindows[0] ?? null;
  const targetTime =
    typeof raw.targetTime === "string" && raw.targetTime
      ? raw.targetTime
      : null;

  const requestedStartTime = primaryWindow?.startTime ?? targetTime;
  if (!requestedStartTime) return null;

  const excludedWindows = Array.isArray(raw.excludedWindows)
    ? raw.excludedWindows
        .map((window: any) => ({
          startTime:
            typeof window?.startTime === "string" ? window.startTime : null,
          endTime:
            typeof window?.endTime === "string" ? window.endTime : null,
        }))
        .filter(
          (window: { startTime: string | null; endTime: string | null }) =>
            Boolean(window.startTime)
        )
    : [];

  return {
    requestedStartTime,
    requestedEndTime: primaryWindow?.endTime ?? null,
    allowedWindows: allowedWindows.map(
      (window: { startTime: string | null; endTime: string | null }) => ({
        startTime: window.startTime as string,
        endTime: window.endTime ?? null,
      })
    ),
    excludedWindows: excludedWindows.map(
      (window: { startTime: string | null; endTime: string | null }) => ({
        startTime: window.startTime as string,
        endTime: window.endTime ?? null,
      })
    ),
    selectionMode:
      raw.selectionMode === "chronological" ||
      raw.selectionMode === "earliest" ||
      raw.selectionMode === "closest"
        ? raw.selectionMode
        : undefined,
    targetTime:
      typeof raw.targetTime === "string" && raw.targetTime
        ? raw.targetTime
        : null,
    displayPreference:
      typeof raw.displayPreference === "string" && raw.displayPreference.trim()
        ? raw.displayPreference.trim()
        : typeof raw.originalPreference === "string" &&
            raw.originalPreference.trim()
          ? raw.originalPreference.trim()
          : null,
  };
}

function getRequestedBookingRestoration(params: {
  lead: LeadForInboundEmail;
  restoreKind: "restore_previous" | "restore_original";
}) {
  const lineage = getRescheduleLineage(params.lead.qualification);
  if (!lineage) return null;

  const hasActiveCalendarBooking = Boolean(
    params.lead.status === "booked" &&
      params.lead.calendar_event_id &&
      params.lead.appointment_time
  );

  const cancelled = getRestorableCancelledAppointment(
    params.lead.qualification
  );

  const restoringFromCancelledState =
    !hasActiveCalendarBooking && Boolean(cancelled);

  if (!hasActiveCalendarBooking && !restoringFromCancelledState) {
    return null;
  }

  if (
    hasActiveCalendarBooking &&
    lineage.calendarEventId !== params.lead.calendar_event_id
  ) {
    return null;
  }

  if (params.restoreKind === "restore_previous") {
    if (lineage.lastCompletedReschedule.status !== "active") {
      return null;
    }

    if (
      hasActiveCalendarBooking &&
      !slotTimesMatchWithinOneMinute(
        params.lead.appointment_time,
        lineage.lastCompletedReschedule.toAppointmentTime
      )
    ) {
      return null;
    }

    if (
      restoringFromCancelledState &&
      cancelled &&
      !slotTimesMatchWithinOneMinute(
        cancelled.previousAppointmentTime,
        lineage.lastCompletedReschedule.toAppointmentTime
      )
    ) {
      return null;
    }

    return {
      kind: "undo_last_reschedule" as const,
      targetAppointmentTime:
        lineage.lastCompletedReschedule.fromAppointmentTime,
      targetAppointmentEndTime:
        lineage.lastCompletedReschedule.fromAppointmentEndTime,
      lineage,
      sourceState: restoringFromCancelledState
        ? ("cancelled_booking" as const)
        : ("active_booking" as const),
      cancelled,
    };
  }

  if (
    hasActiveCalendarBooking &&
    slotTimesMatchWithinOneMinute(
      params.lead.appointment_time,
      lineage.originalAppointmentTime
    )
  ) {
    return null;
  }

  return {
    kind: "restore_original_booking" as const,
    targetAppointmentTime: lineage.originalAppointmentTime,
    targetAppointmentEndTime: lineage.originalAppointmentEndTime,
    lineage,
    sourceState: restoringFromCancelledState
      ? ("cancelled_booking" as const)
      : ("active_booking" as const),
    cancelled,
  };
}

async function restoreBookingFromRescheduleLineage(params: {
  companyId: string;
  lead: LeadForInboundEmail;
  inboundEmailId: string;
  updates: Record<string, any>;
  message: string;
  restoreKind: "restore_previous" | "restore_original";
  toEmail?: string | null;
  subject?: string | null;
  timezone: string;
  mixedInformationAnswer?: string | null;
}) {
  const restoration = getRequestedBookingRestoration({
    lead: params.lead,
    restoreKind: params.restoreKind,
  });

  if (!restoration) return null;

  const restoringFromCancelledState =
    restoration.sourceState === "cancelled_booking";

  if (restoringFromCancelledState) {
    const bookingRequirementsBlock =
      await requireBookingDetailsBeforeNewAppointment({
        companyId: params.companyId,
        lead: params.lead,
        inboundEmailId: params.inboundEmailId,
        inboundUpdates: params.updates,
        toEmail: params.toEmail,
        subject: params.subject,
        timezone: params.timezone,
        message: params.message,
        actionKind:
          restoration.kind === "restore_original_booking"
            ? "restore_original"
            : "restore_previous",
        requestedStartTime: restoration.targetAppointmentTime,
        requestedEndTime: restoration.targetAppointmentEndTime,
      });

    if (bookingRequirementsBlock) return bookingRequirementsBlock;
  }

  const leadAddress = buildLeadAddress(params.lead);
  const customerMetadata = resolveCustomerMetadata(
    params.lead,
    params.toEmail
  );
  const customerLabel = customerMetadata.customerLabel;

  const calendarSummary = leadAddress
    ? `HVAC Appointment - ${customerLabel} - ${leadAddress}`
    : `HVAC Appointment - ${customerLabel}`;

  let booking: any;

  try {
    booking = await createCalendarBooking({
      companyId: params.companyId,
      leadId: params.lead.id,
      bookingRequirementsVerifiedByCaller: true,
      startTime: restoration.targetAppointmentTime,
      ...(restoration.targetAppointmentEndTime
        ? { endTime: restoration.targetAppointmentEndTime }
        : {}),
      summary: calendarSummary,
      ...(leadAddress ? { location: leadAddress } : {}),
      description: [
        "Restored automatically from authoritative LeadFlow booking lineage.",
        `Restore mode: ${restoration.kind}`,
        restoringFromCancelledState
          ? "Calendar state: recreating a fresh event because the active event was cancelled."
          : "Calendar state: moving the existing active event.",
        "",
        `Customer: ${customerMetadata.customerName ?? customerLabel}`,
        customerMetadata.customerPhone
          ? `Phone: ${customerMetadata.customerPhone}`
          : null,
        customerMetadata.customerEmail
          ? `Email: ${customerMetadata.customerEmail}`
          : null,
        leadAddress ? `Service address: ${leadAddress}` : null,
        params.lead.input
          ? `Original request: ${params.lead.input}`
          : null,
        "",
        `Customer reply: ${params.message}`,
        `Company timezone: ${params.timezone}`,
      ]
        .filter(Boolean)
        .join("\n"),
      attendeeEmail: customerMetadata.attendeeEmail,
      attendeeName: customerMetadata.attendeeName,
      allowReschedule: !restoringFromCancelledState,
      ...(restoringFromCancelledState
        ? { forceFreshEventIdentity: true }
        : {}),
    } as any);

    assertRealCalendarBooking(booking, {
      startTime: restoration.targetAppointmentTime,
      endTime: restoration.targetAppointmentEndTime,
    });

    if (restoringFromCancelledState) {
      if (
        restoration.cancelled?.previousCalendarEventId &&
        booking.calendarEventId ===
          restoration.cancelled.previousCalendarEventId
      ) {
        throw new Error(
          "lineage_restore_reused_cancelled_calendar_event_identity"
        );
      }
    } else {
      assertRescheduleReusedExistingCalendarEvent({
        booking,
        lead: params.lead,
        requestedStartTime: restoration.targetAppointmentTime,
      });
    }
  } catch (error: any) {
    const safelyUnavailable =
      error?.message === "slot_unavailable" ||
      error?.message === "outside_business_hours" ||
      error?.message === "appointment_start_time_is_in_the_past";

    if (!safelyUnavailable) throw error;

    const targetLabel = formatCustomerRequestedSlot(
      restoration.targetAppointmentTime,
      params.timezone
    );

    if (restoringFromCancelledState) {
      let alternatives: AlternativeSlot[] = [];

      try {
        alternatives = await suggestCadenceAlignedAlternativeSlots({
          companyId: params.companyId,
          requestedStartTime: restoration.targetAppointmentTime,
          requestedEndTime: restoration.targetAppointmentEndTime,
          timezone: params.timezone,
        });
      } catch (availabilityError: any) {
        console.error(
          "[inbound] booking-lineage restore alternative lookup failed",
          {
            leadId: params.lead.id,
            restoreKind: restoration.kind,
            targetAppointmentTime: restoration.targetAppointmentTime,
            error: availabilityError?.message ?? availabilityError,
          }
        );
        alternatives = [];
      }

      if (alternatives.length > 0) {
        return sendUnavailableAndStorePending({
          companyId: params.companyId,
          lead: params.lead,
          inboundEmailId: params.inboundEmailId,
          inboundUpdates: params.updates,
          toEmail: params.toEmail,
          subject: params.subject,
          companyTimezone: params.timezone,
          message: params.message,
          reason:
            error?.message === "outside_business_hours"
              ? "outside_business_hours"
              : "slot_unavailable",
          alternatives: getCleanAlternativeSlots(alternatives).slice(0, 3),
          originalRequestedStartTime: restoration.targetAppointmentTime,
          originalRequestedEndTime:
            restoration.targetAppointmentEndTime,
          schedulingPreferenceText:
            restoration.kind === "restore_original_booking"
              ? "restore original appointment"
              : "restore previous appointment",
        });
      }

      if (params.toEmail) {
        await sendLeadReply({
          companyId: params.companyId,
          leadId: params.lead.id,
          to: params.toEmail,
          subject: params.subject ?? "Re: Your HVAC Request",
          body: mergeMixedInformationWithActionReply(
            params.mixedInformationAnswer,
            `I couldn't restore ${
              targetLabel ?? "that appointment time"
            } because it is no longer available. There is currently no active appointment on the calendar.`
          ),
          isFollowUp: false,
        });
      }

      await markInboundProcessed({
        inboundEmailId: params.inboundEmailId,
        companyId: params.companyId,
        leadId: params.lead.id,
        processingError: "booking_lineage_restore_unavailable",
      });

      return {
        success: true,
        processed: true,
        booked: false,
        restored: false,
        bookingPreserved: false,
        reason: "booking_lineage_restore_unavailable_no_active_booking",
        inboundEmailId: params.inboundEmailId,
        leadId: params.lead.id,
      };
    }

    const currentLabel = formatCustomerRequestedSlot(
      params.lead.appointment_time,
      params.timezone
    );

    if (params.toEmail) {
      await sendLeadReply({
        companyId: params.companyId,
        leadId: params.lead.id,
        to: params.toEmail,
        subject: params.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          params.mixedInformationAnswer,
          `I couldn't restore ${
            targetLabel ?? "that previous appointment time"
          } because it is no longer available. ` +
            `Your current appointment${
              currentLabel ? ` for ${currentLabel}` : ""
            } is still scheduled.`
        ),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: params.inboundEmailId,
      companyId: params.companyId,
      leadId: params.lead.id,
    });

    return {
      success: true,
      processed: true,
      booked: true,
      restored: false,
      bookingPreserved: true,
      reason: "previous_booking_restore_unavailable_current_booking_preserved",
      inboundEmailId: params.inboundEmailId,
      leadId: params.lead.id,
    };
  }

  const restoredAt = new Date().toISOString();

  const updatedLineage: RescheduleLineage = {
    ...restoration.lineage,
    calendarEventId: booking.calendarEventId,
    lastCompletedReschedule: {
      ...restoration.lineage.lastCompletedReschedule,
      status:
        restoration.kind === "restore_original_booking"
          ? "restored_original"
          : "undone",
      restoredAt,
      restoredByReply: params.message,
    },
  };

  const qualification = {
    ...(params.lead.qualification ?? {}),
    ...(restoringFromCancelledState
      ? {
          appointmentCancellation: {
            ...((params.lead.qualification ?? {})
              .appointmentCancellation ?? {}),
            status: "resolved_by_history_restore",
            resolvedAt: restoredAt,
            resolvedByReply: params.message,
            resolutionMode: restoration.kind,
            restoredAppointmentTime: booking.appointmentTime,
            restoredCalendarEventId: booking.calendarEventId,
          },
        }
      : {}),
    rescheduleLineage: updatedLineage,
    pendingSlotSuggestion: {
      ...((params.lead.qualification ?? {}).pendingSlotSuggestion ?? {}),
      status: "confirmed_and_booked",
      confirmedStartTime: booking.appointmentTime,
      confirmedEndTime: booking.appointmentEndTime ?? null,
      confirmedByReply: params.message,
      confirmedAt: restoredAt,
      matchReason: restoration.kind,
    },
  };

  let verifiedLead = await forceMarkLeadBooked({
    companyId: params.companyId,
    leadId: params.lead.id,
    appointmentTime: booking.appointmentTime,
    calendarEventId: booking.calendarEventId,
    qualification,
    updates: params.updates,
  });

  const restoredLabel = formatCustomerRequestedSlot(
    verifiedLead.appointment_time,
    params.timezone
  );

  if (params.toEmail) {
    await sendLeadReply({
      companyId: params.companyId,
      leadId: params.lead.id,
      to: params.toEmail,
      subject: params.subject ?? "Re: Your HVAC Request",
      body: mergeMixedInformationWithActionReply(
        params.mixedInformationAnswer,
        restoration.kind === "restore_original_booking"
          ? `Got it — I've restored your original appointment${
              restoredLabel ? ` for ${restoredLabel}` : ""
            }.`
          : `Got it — I've restored your previous appointment${
              restoredLabel ? ` for ${restoredLabel}` : ""
            }.`
      ),
      isFollowUp: false,
    });

    verifiedLead = await forceMarkLeadBooked({
      companyId: params.companyId,
      leadId: params.lead.id,
      appointmentTime: booking.appointmentTime,
      calendarEventId: booking.calendarEventId,
      qualification,
      updates: params.updates,
    });
  }

  await markInboundProcessed({
    inboundEmailId: params.inboundEmailId,
    companyId: params.companyId,
    leadId: params.lead.id,
  });

  console.log("[inbound] booking restored from authoritative lineage", {
    leadId: params.lead.id,
    restoreKind: restoration.kind,
    sourceState: restoration.sourceState,
    restoredAppointmentTime: booking.appointmentTime,
    calendarEventId: booking.calendarEventId,
    parsedMessage: params.message,
  });

  return {
    success: true,
    processed: true,
    booked: true,
    restored: true,
    restoreKind: restoration.kind,
    restoreSourceState: restoration.sourceState,
    reason: "booking_restored_from_authoritative_lineage",
    inboundEmailId: params.inboundEmailId,
    leadId: params.lead.id,
    verifiedLead,
  };
}

function assertRescheduleReusedExistingCalendarEvent(params: {
  booking: any;
  lead: LeadForInboundEmail;
  requestedStartTime: string;
}) {
  if (
    params.lead.status !== "booked" ||
    !params.lead.calendar_event_id ||
    !params.lead.appointment_time
  ) {
    return;
  }

  const requestedChanged =
    !slotTimesMatchWithinOneMinute(
      params.lead.appointment_time,
      params.requestedStartTime
    );

  if (!requestedChanged) return;

  /*
   * Hard reschedule invariant:
   * a real reschedule MOVES the existing Google event. It must never create a
   * second event while leaving the previous appointment behind.
   */
  if (params.booking?.rescheduled !== true) {
    throw new Error("reschedule_did_not_report_existing_event_move");
  }

  if (params.booking?.calendarEventId !== params.lead.calendar_event_id) {
    throw new Error(
      "reschedule_created_new_calendar_event_instead_of_moving_existing"
    );
  }

  if (
    !slotTimesMatchWithinOneMinute(
      params.booking?.appointmentTime,
      params.requestedStartTime
    )
  ) {
    throw new Error("reschedule_result_time_mismatch");
  }

  if (
    params.booking?.previousAppointmentTime &&
    !slotTimesMatchWithinOneMinute(
      params.booking.previousAppointmentTime,
      params.lead.appointment_time
    )
  ) {
    throw new Error("reschedule_previous_appointment_truth_mismatch");
  }
}

function assertRealCalendarBooking(
  booking: any,
  expected?: {
    startTime?: string | null;
    endTime?: string | null;
  }
) {
  if (!booking?.calendarEventId) {
    throw new Error("calendar_booking_failed_missing_calendar_event_id");
  }

  if (!booking?.appointmentTime) {
    throw new Error("calendar_booking_failed_missing_appointment_time");
  }

  if (
    expected?.startTime &&
    !slotTimesMatchWithinOneMinute(
      booking.appointmentTime,
      expected.startTime
    )
  ) {
    throw new Error("calendar_booking_result_start_mismatch");
  }

  if (expected?.endTime) {
    if (!booking?.appointmentEndTime) {
      throw new Error("calendar_booking_failed_missing_appointment_end_time");
    }

    if (
      !slotTimesMatchWithinOneMinute(
        booking.appointmentEndTime,
        expected.endTime
      )
    ) {
      throw new Error("calendar_booking_result_end_mismatch");
    }
  }
}

export async function processInboundEmail(input: ProcessInboundEmailInput) {
  if (!input.companyId) throw new Error("missing_company_id");

  const message = cleanBody(input.textBody);

  if (!message) throw new Error("missing_inbound_message");

  const companyTimezone = await getCompanyTimezone(input.companyId);

  console.log("[inbound] processing reply", {
    companyId: input.companyId,
    fromEmail: input.fromEmail,
    subject: input.subject,
    providerEventId: input.providerEventId,
    providerThreadId: input.providerThreadId,
    parsedMessage: message,
    companyTimezone,
  });

  /*
   * PROSPECT -> BOOKING HANDOFF OWNERSHIP
   *
   * The original Gmail event may already be marked processed by the prospect/info
   * lane. Reusing that same provider_event_id here would make the booking pipeline
   * trip its normal duplicate-event guard and silently exit before availability
   * can be shown. It can also let sender heuristics drift onto an unrelated older
   * lead when the same customer has multiple historical leads.
   *
   * A trusted handoff is structurally identified by BOTH:
   *   - the immutable pre-resolved booking command, and
   *   - the exact prospect conversation id that was just promoted.
   *
   * For that handoff only:
   *   1. bind directly to prospect_conversations.promoted_lead_id; and
   *   2. derive a stable internal provider event id so the internal booking turn
   *      is idempotent without colliding with the already-processed Gmail event.
   *
   * Ordinary Gmail/customer-booking events keep their existing identity and
   * ownership path unchanged.
   */
  const trustedProspectBookingHandoff = Boolean(
    input.preResolvedBookingCommand && input.prospectConversationId
  );

  if (trustedProspectBookingHandoff) {
    if (!input.providerEventId) {
      throw new Error("prospect_booking_handoff_missing_provider_event_id");
    }
    if (!input.providerThreadId) {
      throw new Error("prospect_booking_handoff_missing_provider_thread_id");
    }
    if (!input.fromEmail) {
      throw new Error("prospect_booking_handoff_missing_customer_email");
    }

    const kind = input.preResolvedBookingCommand?.kind;
    if (
      kind !== "show_availability" &&
      kind !== "book"
    ) {
      throw new Error(`prospect_booking_handoff_disallowed_command_${kind ?? "missing"}`);
    }

    if (input.preResolvedBookingCommand?.requiresClarification === true) {
      throw new Error("prospect_booking_handoff_command_requires_clarification");
    }
  }

  const prospectHandoffPrefix =
    `prospect_booking_handoff:${input.companyId}:`;

  const effectiveProviderEventId =
    trustedProspectBookingHandoff && input.providerEventId
      ? input.providerEventId.startsWith(prospectHandoffPrefix)
        ? input.providerEventId
        : `${prospectHandoffPrefix}${input.providerEventId}`
      : input.providerEventId;

  /*
   * Gmail ownership hardening also makes provider_email_id unique per company.
   * An internal handoff is not a second Gmail message, so give its ledger row
   * the same deterministic internal identity instead of reusing the raw Gmail id.
   */
  const effectiveProviderEmailId =
    trustedProspectBookingHandoff
      ? effectiveProviderEventId
      : input.providerEmailId;

  const promotedProspectLead =
    trustedProspectBookingHandoff && input.prospectConversationId
      ? await fetchPromotedLeadForProspectBookingHandoff({
          companyId: input.companyId,
          prospectConversationId: input.prospectConversationId,
          fromEmail: input.fromEmail,
          providerThreadId: input.providerThreadId,
        })
      : null;

  const rawLead =
    promotedProspectLead ??
    (await findLeadForInboundEmail({
      companyId: input.companyId,
      fromEmail: input.fromEmail,
      subject: input.subject,
      threadId: input.providerThreadId,
    }));

  let lead = rawLead as LeadForInboundEmail | null;

  console.log("[inbound] matched lead", {
    matched: Boolean(lead),
    leadId: lead?.id ?? null,
    status: lead?.status ?? null,
    companyId: lead?.company_id ?? null,
    prospectBookingHandoff: trustedProspectBookingHandoff,
    prospectConversationId: input.prospectConversationId ?? null,
    originalProviderEventId: input.providerEventId ?? null,
    effectiveProviderEventId: effectiveProviderEventId ?? null,
    effectiveProviderEmailId: effectiveProviderEmailId ?? null,
  });

  const { inboundEmail, duplicateWebhookEvent } = await insertInboundEmail({
    companyId: input.companyId,
    leadId: lead?.id ?? null,
    provider: input.provider ?? "resend",
    providerEventId: effectiveProviderEventId,
    providerEmailId: effectiveProviderEmailId,
    fromEmail: input.fromEmail,
    toEmail: input.toEmail,
    subject: input.subject,
    textBody: message,
    htmlBody: input.htmlBody,
  });

  if (inboundEmail.company_id !== input.companyId) {
    throw new Error("inbound_email_company_scope_violation");
  }

  if (duplicateWebhookEvent && inboundEmail.processed) {
    return {
      success: true,
      processed: true,
      duplicateWebhookEvent: true,
      inboundEmailId: inboundEmail.id,
      leadId: inboundEmail.lead_id ?? null,
    };
  }

  /*
   * The inbound_emails ownership link created by Gmail ingestion is canonical.
   * If sender/thread heuristics disagree, trust the explicit lead_id reservation
   * instead of drifting into a different lead or failing the continuation.
   */
  if (inboundEmail.lead_id && lead?.id !== inboundEmail.lead_id) {
    const canonicalLead = await fetchLeadByIdForInbound({
      companyId: input.companyId,
      leadId: inboundEmail.lead_id,
    });

    if (!canonicalLead) {
      throw new Error("inbound_email_points_to_missing_lead");
    }

    console.warn("[inbound] using canonical inbound-email lead ownership", {
      heuristicLeadId: lead?.id ?? null,
      canonicalLeadId: canonicalLead.id,
      inboundEmailId: inboundEmail.id,
    });

    lead = canonicalLead;
  }

  if (!lead) {
    await supabase
      .from("inbound_emails")
      .update({
        processed: false,
        processing_error: "lead_not_found_for_inbound_email",
      })
      .eq("id", inboundEmail.id)
      .eq("company_id", input.companyId);

    return {
      success: true,
      processed: false,
      reason: "lead_not_found_for_inbound_email",
      inboundEmailId: inboundEmail.id,
      parsedMessage: message,
    };
  }

  let matchedLead: LeadForInboundEmail = lead;

  if (matchedLead.company_id !== input.companyId) {
    throw new Error("lead_company_scope_violation");
  }

  const pendingBookingRequirementsAtReply = getPendingBookingRequirements(
    matchedLead.qualification
  );
  const bookingRequirementsBeforeMetadataMerge =
    resolveBookingRequirements(matchedLead);
  let bookingRequirementsAfterMetadataMerge =
    bookingRequirementsBeforeMetadataMerge;
  let suppliedRequiredBookingDetailThisTurn = false;
  let customerMetadataMergedEarlyForBookingRequirements = false;

  if (
    pendingBookingRequirementsAtReply?.status ===
    "awaiting_required_contact"
  ) {
    matchedLead = await mergeInboundCustomerMetadataIntoLead({
      companyId: input.companyId,
      lead: matchedLead,
      message,
      fallbackEmail: input.fromEmail,
    });
    customerMetadataMergedEarlyForBookingRequirements = true;
    bookingRequirementsAfterMetadataMerge =
      resolveBookingRequirements(matchedLead);
    suppliedRequiredBookingDetailThisTurn =
      bookingRequirementsBeforeMetadataMerge.missing.some(
        (requirement) =>
          !bookingRequirementsAfterMetadataMerge.missing.includes(requirement)
      );
  }

  const hasActiveBookingContext =
    matchedLead.status === "booked" ||
    (
      Boolean(matchedLead.calendar_event_id) &&
      Boolean(matchedLead.appointment_time)
    );

  /*
   * ONE BOOKING-COMMAND AUTHORITY.
   *
   * This is the only semantic owner of WHAT the customer wants to do in the
   * booking domain. Pending offers, cancellation, rescheduling, restoration,
   * read-only availability, keep-current, and booking authorization are
   * classified here once. Downstream code may validate/revalidate state, but it
   * must not reinterpret the action.
   */
  let pendingCommandOffers = getPendingSuggestionSlots(
    matchedLead.qualification
  ).map((slot, index) => ({
    optionNumber: index + 1,
    startTime: slot.startTime,
    endTime: slot.endTime ?? null,
  }));

  const recentAssistantMessage =
    String(input.recentAssistantMessage ?? "").trim() ||
    extractImmediateQuotedAssistantMessage(input.textBody);

  const restorableCancelledAppointment =
    getRestorableCancelledAppointment(matchedLead.qualification);

  const hasCancelledBookingContext =
    !hasActiveBookingContext && Boolean(restorableCancelledAppointment);

  const commandLineage = getRescheduleLineage(matchedLead.qualification);
  const commandHasReversibleReschedule = Boolean(
    commandLineage &&
      commandLineage.lastCompletedReschedule.status === "active" &&
      (
        (
          hasActiveBookingContext &&
          matchedLead.appointment_time &&
          slotTimesMatchWithinOneMinute(
            matchedLead.appointment_time,
            commandLineage.lastCompletedReschedule.toAppointmentTime
          )
        ) ||
        (
          hasCancelledBookingContext &&
          restorableCancelledAppointment &&
          slotTimesMatchWithinOneMinute(
            restorableCancelledAppointment.previousAppointmentTime,
            commandLineage.lastCompletedReschedule.toAppointmentTime
          )
        )
      )
  );
  const commandHasOriginalBookingHistory = Boolean(
    commandLineage &&
      (
        (
          hasActiveBookingContext &&
          matchedLead.appointment_time &&
          !slotTimesMatchWithinOneMinute(
            matchedLead.appointment_time,
            commandLineage.originalAppointmentTime
          )
        ) ||
        hasCancelledBookingContext
      )
  );
  const commandStoredSchedulingContext =
    getStoredSchedulingContextForAvailabilityOptions(matchedLead.qualification);

  const confirmationConsumerEventId =
    String(effectiveProviderEventId ?? inboundEmail.id).trim() || inboundEmail.id;

  const pendingBookingConfirmationAtReply =
    getPendingBookingConfirmation({
      qualification: matchedLead.qualification,
      consumerEventId: confirmationConsumerEventId,
    });

  const pendingBookingClarificationAtReply =
    getPendingBookingClarification({
      qualification: matchedLead.qualification,
      consumerEventId: confirmationConsumerEventId,
    });

  const bookingCommandContext = {
    hasActiveBooking: hasActiveBookingContext,
    hasCancelledBooking: hasCancelledBookingContext,
    currentAppointmentTime: matchedLead.appointment_time ?? null,
    cancelledAppointmentTime:
      restorableCancelledAppointment?.previousAppointmentTime ?? null,
    timezone: companyTimezone,
    subject: input.subject ?? null,
    recentAssistantMessage,
    conversationContext: input.prospectConversationContext ?? null,
    pendingOfferedSlots: pendingCommandOffers,
    hasReversibleReschedule: commandHasReversibleReschedule,
    hasOriginalBookingHistory: commandHasOriginalBookingHistory,
    priorSchedulingRequest: commandStoredSchedulingContext
      ? {
          displayPreference:
            commandStoredSchedulingContext.displayPreference ?? null,
          requestedStartTime:
            commandStoredSchedulingContext.requestedStartTime ?? null,
          requestedEndTime:
            commandStoredSchedulingContext.requestedEndTime ?? null,
        }
      : null,
    pendingConfirmation: pendingBookingConfirmationAtReply
      ? {
          kind: pendingBookingConfirmationAtReply.kind,
          appointmentTime:
            pendingBookingConfirmationAtReply.appointmentTime,
          requestedAt: pendingBookingConfirmationAtReply.requestedAt,
          requestedByReply:
            pendingBookingConfirmationAtReply.requestedByReply,
        }
      : null,
    pendingClarification: pendingBookingClarificationAtReply
      ? {
          kind: pendingBookingClarificationAtReply.kind,
          missing: pendingBookingClarificationAtReply.missing,
          appointmentTime:
            pendingBookingClarificationAtReply.appointmentTime,
          requestedAt: pendingBookingClarificationAtReply.requestedAt,
          requestedByReply:
            pendingBookingClarificationAtReply.requestedByReply,
        }
      : null,
  };

  let bookingCommand =
    input.preResolvedBookingCommand ??
    (await resolveBookingCommand({
      message,
      context: bookingCommandContext,
    }));

  if (input.preResolvedBookingCommand) {
    console.log("[inbound] consumed pre-resolved booking command", {
      leadId: matchedLead.id,
      prospectConversationId: input.prospectConversationId ?? null,
      kind: bookingCommand.kind,
      confidence: bookingCommand.confidence,
      source: bookingCommand.source,
      providerEventId: effectiveProviderEventId ?? null,
      originalProviderEventId: input.providerEventId ?? null,
    });
  }

  /*
   * A persisted confirmation proposition belongs to exactly one customer turn.
   * Mark it consumed by this provider event after canonical WHAT resolution.
   * Retries of the same provider event may still reuse it; later customer turns
   * cannot accidentally confirm a stale action.
   */
  if (
    pendingBookingConfirmationAtReply &&
    pendingBookingConfirmationAtReply.status === "pending"
  ) {
    const nextQualification = {
      ...(matchedLead.qualification ?? {}),
      pendingBookingConfirmation: {
        ...pendingBookingConfirmationAtReply,
        status: "consumed" as const,
        consumedAt: new Date().toISOString(),
        consumedByProviderEventId: confirmationConsumerEventId,
      },
    };

    const { error: confirmationConsumeError } = await supabase
      .from("leads")
      .update({ qualification: nextQualification })
      .eq("id", matchedLead.id)
      .eq("company_id", input.companyId);

    if (confirmationConsumeError) {
      throw new Error(confirmationConsumeError.message);
    }

    matchedLead = {
      ...matchedLead,
      qualification: nextQualification,
    };
  }

  /*
   * A parameter clarification is also a one-turn proposition. The next customer
   * turn may complete it, reject it, or remain ambiguous; after canonical WHAT
   * resolution it is consumed so unrelated later temporal fragments cannot
   * inherit stale reschedule intent. Retries of the same provider event remain
   * idempotently usable.
   */
  if (
    pendingBookingClarificationAtReply &&
    pendingBookingClarificationAtReply.status === "pending"
  ) {
    const nextQualification = {
      ...(matchedLead.qualification ?? {}),
      pendingBookingClarification: {
        ...pendingBookingClarificationAtReply,
        status: "consumed" as const,
        consumedAt: new Date().toISOString(),
        consumedByProviderEventId: confirmationConsumerEventId,
      },
    };

    const { error: clarificationConsumeError } = await supabase
      .from("leads")
      .update({ qualification: nextQualification })
      .eq("id", matchedLead.id)
      .eq("company_id", input.companyId);

    if (clarificationConsumeError) {
      throw new Error(clarificationConsumeError.message);
    }

    matchedLead = {
      ...matchedLead,
      qualification: nextQualification,
    };
  }


  const pendingRequirementsCurrentCommandIsNonMutating =
    bookingCommand.kind === "none" ||
    bookingCommand.kind === "information" ||
    bookingCommand.kind === "clarify";
  const pendingRequirementsOwnsTurn = Boolean(
    pendingBookingRequirementsAtReply?.status === "awaiting_required_contact" &&
      pendingRequirementsCurrentCommandIsNonMutating &&
      (suppliedRequiredBookingDetailThisTurn ||
        bookingCommand.hasFreshTemporalConstraint !== true)
  );

  if (pendingRequirementsOwnsTurn && pendingBookingRequirementsAtReply) {
    const currentBookingRequirements = bookingRequirementsAfterMetadataMerge;

    if (!currentBookingRequirements.complete) {
      const refreshedBlock = await requireBookingDetailsBeforeNewAppointment({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        toEmail: input.fromEmail,
        subject: input.subject,
        timezone: companyTimezone,
        message,
        actionKind: pendingBookingRequirementsAtReply.actionKind,
        requestedStartTime:
          pendingBookingRequirementsAtReply.requestedStartTime,
        requestedEndTime:
          pendingBookingRequirementsAtReply.requestedEndTime ?? null,
        selectedOptionNumber:
          pendingBookingRequirementsAtReply.selectedOptionNumber ?? null,
      });

      if (refreshedBlock) return refreshedBlock;
    } else {
      /*
       * The customer already authorized this mutation on the earlier turn.
       * Supplying required dispatch details completes the gate; it does not make
       * them repeat the slot/action. Re-project the stored authorization into
       * the existing canonical booking pipeline without reinterpreting language.
       */
      matchedLead.qualification = {
        ...(matchedLead.qualification ?? {}),
        pendingBookingRequirements: {
          ...((matchedLead.qualification ?? {}).pendingBookingRequirements ?? {}),
          status: "requirements_complete",
          completedAt: new Date().toISOString(),
          missing: [],
        },
      };

      if (
        pendingBookingRequirementsAtReply.actionKind === "restore_cancelled" ||
        pendingBookingRequirementsAtReply.actionKind === "restore_previous" ||
        pendingBookingRequirementsAtReply.actionKind === "restore_original"
      ) {
        bookingCommand = {
          kind: pendingBookingRequirementsAtReply.actionKind,
          confidence: 1,
          requiresClarification: false,
          reason:
            "continuing_previously_authorized_booking_after_required_customer_details",
          source: "deterministic",
          selectedOptionNumber: null,
          hasFreshTemporalConstraint: false,
        };
      } else {
        let optionIndex = pendingCommandOffers.findIndex((slot) =>
          slotTimesMatchWithinOneMinute(
            slot.startTime,
            pendingBookingRequirementsAtReply.requestedStartTime
          )
        );

        if (optionIndex < 0) {
          const resumedSlot = {
            startTime: pendingBookingRequirementsAtReply.requestedStartTime,
            endTime:
              pendingBookingRequirementsAtReply.requestedEndTime ?? null,
          };

          matchedLead.qualification = {
            ...(matchedLead.qualification ?? {}),
            pendingSlotSuggestion: {
              ...((matchedLead.qualification ?? {}).pendingSlotSuggestion ?? {}),
              status: "awaiting_customer_confirmation",
              suggestedStartTime: resumedSlot.startTime,
              suggestedEndTime: resumedSlot.endTime,
              suggestedSlots: [resumedSlot],
              suggestionReason: "booking_requirements_resume_target",
            },
          };

          pendingCommandOffers = [
            {
              optionNumber: 1,
              ...resumedSlot,
            },
          ];
          optionIndex = 0;
        }

        bookingCommand = {
          kind: "select_offer",
          confidence: 1,
          requiresClarification: false,
          reason:
            "continuing_previously_authorized_booking_after_required_customer_details",
          source: "deterministic",
          selectedOptionNumber: optionIndex + 1,
          hasFreshTemporalConstraint: false,
        };
      }

      console.log(
        "[inbound] required customer details completed; resuming stored booking action",
        {
          leadId: matchedLead.id,
          resumedActionKind: bookingCommand.kind,
          requestedStartTime:
            pendingBookingRequirementsAtReply.requestedStartTime,
          parsedMessage: message,
        }
      );
    }
  }

  const customerActionIntent =
    hasActiveBookingContext || hasCancelledBookingContext
      ? toLegacyCustomerActionIntent(bookingCommand)
      : null;

  const selectedCommandOffer =
    bookingCommand.kind === "select_offer" &&
    bookingCommand.selectedOptionNumber !== null
      ? pendingCommandOffers.find(
          (slot) => slot.optionNumber === bookingCommand.selectedOptionNumber
        ) ?? null
      : null;

  const preActionPendingSlotMatch = selectedCommandOffer
    ? {
        matched: true,
        startTime: selectedCommandOffer.startTime,
        endTime: selectedCommandOffer.endTime ?? null,
        reason: "matched_canonical_booking_command_offer_reference",
        confidence: "high" as const,
      }
    : null;

  const highConfidencePendingReplacementSelection =
    bookingCommand.kind === "select_offer" &&
    bookingCommand.confidence >= 0.8 &&
    Boolean(selectedCommandOffer);

  console.log("[inbound] canonical booking command", {
    leadId: matchedLead.id,
    kind: bookingCommand.kind,
    confidence: bookingCommand.confidence,
    requiresClarification: bookingCommand.requiresClarification,
    reason: bookingCommand.reason,
    source: bookingCommand.source,
    selectedOptionNumber: bookingCommand.selectedOptionNumber,
    hasFreshTemporalConstraint: bookingCommand.hasFreshTemporalConstraint,
    proposedMutationKind:
      (bookingCommand as BookingCommandResult & {
        proposedMutationKind?: BookingCommandKind | null;
      }).proposedMutationKind ?? null,
    pendingConfirmationKind:
      pendingBookingConfirmationAtReply?.kind ?? null,
    pendingClarificationKind:
      pendingBookingClarificationAtReply?.kind ?? null,
    parsedMessage: message,
  });

  /*
   * MIXED INFORMATION + BOOKING ACTION SIDECAR.
   *
   * The primary customerActionIntent still owns the booking mutation exactly as
   * before. This additive pass only checks whether another independent clause in
   * the SAME active-booking turn is informational. Each clause is judged by the
   * existing semantic action resolver; no policy/topic/test phrase is hard-coded.
   *
   * Example shape (not a rule): an information question followed by a reschedule
   * command. The information clause is answered read-only, then the untouched
   * booking path continues and performs the requested mutation.
   */
  let mixedBookedInformationMessage: string | null = null;
  let mixedBookedInformationAnswerBody: string | null = null;

  if (
    hasActiveBookingContext &&
    customerActionIntent &&
    customerActionIntent.action !== "information_request"
  ) {
    const mixedTurnSegments = splitPotentialMixedTurnSegments(message);

    if (mixedTurnSegments.length > 1) {
      const informationSegments: string[] = [];

      for (const segment of mixedTurnSegments) {
        const segmentCommand = await resolveBookingCommand({
          message: segment,
          context: {
            ...bookingCommandContext,
            hasCancelledBooking: false,
            cancelledAppointmentTime: null,
          },
        });
        const segmentIntent = toLegacyCustomerActionIntent(segmentCommand);

        if (
          segmentCommand.kind === "information" &&
          segmentIntent.requiresClarification !== true &&
          Number(segmentIntent.confidence ?? 0) >= 0.8
        ) {
          informationSegments.push(segment);
        }
      }

      if (informationSegments.length > 0) {
        mixedBookedInformationMessage = informationSegments.join(" ").trim();
      }

      console.log("[inbound] mixed booking turn semantic sidecar", {
        leadId: matchedLead.id,
        primaryAction: customerActionIntent.action,
        segmentCount: mixedTurnSegments.length,
        informationSegmentCount: informationSegments.length,
        mixedBookedInformationMessage,
        parsedMessage: message,
      });
    }
  }

  /*
   * Downstream compatibility booleans are projections of bookingCommand only.
   * No second action parser is allowed to override the canonical command.
   */
  const explicitCancellationRequested = bookingCommand.kind === "cancel";

  if (explicitCancellationRequested) {
    matchedLead = await recoverCanonicalBookingTruthForCancellation({
      companyId: input.companyId,
      lead: matchedLead,
    });
  }

  const bookedCancellationConversation =
    explicitCancellationRequested &&
    Boolean(matchedLead.calendar_event_id) &&
    Boolean(matchedLead.appointment_time);

  const bookedRescheduleConversation =
    matchedLead.status === "booked" &&
    Boolean(matchedLead.calendar_event_id) &&
    Boolean(matchedLead.appointment_time) &&
    (
      bookingCommand.kind === "reschedule" ||
      (
        bookingCommand.kind === "select_offer" &&
        hasActivePendingSlotSuggestion(matchedLead.qualification)
      )
    );

  const bookedActionNeedsClarification =
    hasActiveBookingContext &&
    bookingCommand.kind === "clarify" &&
    bookingCommand.requiresClarification === true &&
    !highConfidencePendingReplacementSelection;

  const previousBookingRollbackRequested =
    (hasActiveBookingContext || hasCancelledBookingContext) &&
    bookingCommand.kind === "restore_previous";

  const originalBookingRestorationRequested =
    (hasActiveBookingContext || hasCancelledBookingContext) &&
    bookingCommand.kind === "restore_original";

  const lineageRestorationRequested =
    previousBookingRollbackRequested || originalBookingRestorationRequested;

  const bookedActionKeepsAppointment =
    hasActiveBookingContext && bookingCommand.kind === "keep_current";

  const bookedInformationRequest =
    hasActiveBookingContext && bookingCommand.kind === "information";

  const cancelledBookingRestoreRequested =
    hasCancelledBookingContext && bookingCommand.kind === "restore_cancelled";

  if (
    highConfidencePendingReplacementSelection &&
    customerActionIntent?.action === "unclear"
  ) {
    console.log("[inbound] pending replacement selection outranked action ambiguity", {
      leadId: matchedLead.id,
      matchReason: preActionPendingSlotMatch?.reason ?? null,
      selectedStartTime: preActionPendingSlotMatch?.startTime ?? null,
      parsedMessage: message,
    });
  }

  if (
    isBlockedLead(matchedLead) &&
    !bookedRescheduleConversation &&
    !bookedCancellationConversation &&
    !bookedActionNeedsClarification &&
    !bookedActionKeepsAppointment &&
    !lineageRestorationRequested &&
    !bookedInformationRequest &&
    !cancelledBookingRestoreRequested
  ) {
    await supabase
      .from("inbound_emails")
      .update({
        processed: false,
        processing_error: `blocked_status_${matchedLead.status}`,
      })
      .eq("id", inboundEmail.id)
      .eq("company_id", input.companyId);

    return {
      success: true,
      processed: false,
      reason: `blocked_status_${matchedLead.status}`,
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
      parsedMessage: message,
    };
  }

  if (bookedRescheduleConversation) {
    console.log("[inbound] explicit booked reschedule conversation", {
      leadId: matchedLead.id,
      currentAppointmentTime: matchedLead.appointment_time,
      currentCalendarEventId: matchedLead.calendar_event_id,
      parsedMessage: message,
      pendingReplacementOptions: getPendingSuggestionSlots(
        matchedLead.qualification
      ).length,
    });
  }

  if (!customerMetadataMergedEarlyForBookingRequirements) {
    matchedLead = await mergeInboundCustomerMetadataIntoLead({
      companyId: input.companyId,
      lead: matchedLead,
      message,
      fallbackEmail: input.fromEmail,
    });
  }

  const updates: Record<string, any> = {
    inbound_email_id: input.providerEmailId ?? inboundEmail.id,
    inbound_thread_id: input.providerThreadId ?? input.providerEventId ?? null,
  };

  /*
   * If this turn contains BOTH an independently-resolved information clause and
   * a booking action, answer only the information clause through the existing
   * read-only Customer Intelligence entry point, then continue into the existing
   * booking branch unchanged.
   *
   * CI failure must never erase an otherwise valid booking command. Booking-truth
   * mutation by CI, however, remains a hard error.
   */
  if (mixedBookedInformationMessage) {
    const bookingTruthBeforeMixedAnswer = {
      appointmentTime: matchedLead.appointment_time ?? null,
      calendarEventId: matchedLead.calendar_event_id ?? null,
      status: matchedLead.status ?? null,
    };

    let mixedInformationAnswered = false;

    try {
      const mixedInfoRequest: DeferredBookedCustomerInformationRequest = {
        companyId: input.companyId,
        fromEmail: input.fromEmail ?? matchedLead.email ?? "",
        subject: input.subject ?? "Re: Your HVAC Request",
        providerThreadId:
          input.providerThreadId ??
          input.providerEventId ??
          matchedLead.id,
        message: mixedBookedInformationMessage,
        appointmentTime: matchedLead.appointment_time ?? null,
        originalRequest:
          matchedLead.input ??
          matchedLead.message ??
          null,
        sendReply: false,
      };

      const mixedInfoAnswer =
        await answerBookedCustomerInformationRequest(mixedInfoRequest);

      mixedInformationAnswered = Boolean(mixedInfoAnswer?.answered);
      mixedBookedInformationAnswerBody =
        typeof mixedInfoAnswer?.body === "string" && mixedInfoAnswer.body.trim()
          ? mixedInfoAnswer.body.trim()
          : null;

      console.log("[inbound] mixed-turn information clause prepared read-only", {
        leadId: matchedLead.id,
        primaryAction: customerActionIntent?.action ?? null,
        informationMessage: mixedBookedInformationMessage,
        category: mixedInfoAnswer?.category ?? null,
        evidenceMode: mixedInfoAnswer?.evidenceMode ?? null,
        usedFreshWeb: mixedInfoAnswer?.usedFreshWeb ?? false,
        answerPrepared: Boolean(mixedBookedInformationAnswerBody),
      });
    } catch (error: any) {
      console.error(
        "[inbound] mixed-turn information answer failed; preserving booking action",
        {
          leadId: matchedLead.id,
          primaryAction: customerActionIntent?.action ?? null,
          informationMessage: mixedBookedInformationMessage,
          error: error?.message ?? error,
        }
      );
    }

    if (mixedInformationAnswered) {
      const bookingTruthAfterMixedAnswer = await fetchLeadByIdForInbound({
        companyId: input.companyId,
        leadId: matchedLead.id,
      });

      if (!bookingTruthAfterMixedAnswer) {
        throw new Error("mixed_information_request_lead_missing_after_ci");
      }

      if (
        (bookingTruthAfterMixedAnswer.appointment_time ?? null) !==
          bookingTruthBeforeMixedAnswer.appointmentTime ||
        (bookingTruthAfterMixedAnswer.calendar_event_id ?? null) !==
          bookingTruthBeforeMixedAnswer.calendarEventId ||
        (bookingTruthAfterMixedAnswer.status ?? null) !==
          bookingTruthBeforeMixedAnswer.status
      ) {
        throw new Error("mixed_customer_intelligence_mutated_booking_truth");
      }
    }
  }


  if (lineageRestorationRequested) {
    const restoreKind =
      bookingCommand.kind === "restore_previous"
        ? ("restore_previous" as const)
        : ("restore_original" as const);

    console.log("[inbound] explicit booking-lineage restoration", {
      leadId: matchedLead.id,
      restoreKind,
      hasActiveBookingContext,
      hasCancelledBookingContext,
      currentAppointmentTime: matchedLead.appointment_time ?? null,
      cancelledAppointmentTime:
        restorableCancelledAppointment?.previousAppointmentTime ?? null,
      parsedMessage: message,
    });

    const restoredBooking = await restoreBookingFromRescheduleLineage({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      updates,
      message,
      restoreKind,
      toEmail: input.fromEmail,
      subject: input.subject,
      timezone: companyTimezone,
      mixedInformationAnswer: mixedBookedInformationAnswerBody,
    });

    if (restoredBooking) {
      return restoredBooking;
    }

    const currentLabel = hasActiveBookingContext
      ? formatCustomerRequestedSlot(
          matchedLead.appointment_time,
          companyTimezone
        )
      : null;

    const restoreLabel =
      restoreKind === "restore_original"
        ? "original appointment"
        : "previous appointment";

    if (input.fromEmail) {
      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          mixedBookedInformationAnswerBody,
          hasActiveBookingContext
            ? `I couldn't find a restorable ${restoreLabel} in the authoritative booking history. Your current appointment${
                currentLabel ? ` for ${currentLabel}` : ""
              } is still scheduled.`
            : `I couldn't find a restorable ${restoreLabel} in the authoritative booking history. There is currently no active appointment on the calendar.`
        ),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    console.warn(
      "[inbound] booking-lineage restoration requested but no restorable target found",
      {
        leadId: matchedLead.id,
        restoreKind,
        hasActiveBookingContext,
        hasCancelledBookingContext,
        currentAppointmentTime: matchedLead.appointment_time ?? null,
        cancelledAppointmentTime:
          restorableCancelledAppointment?.previousAppointmentTime ?? null,
        parsedMessage: message,
      }
    );

    return {
      success: true,
      processed: true,
      booked: hasActiveBookingContext,
      restored: false,
      bookingPreserved: hasActiveBookingContext,
      reason: "booking_lineage_restore_requested_but_no_restorable_target",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
    };
  }

  if (cancelledBookingRestoreRequested) {
    console.log("[inbound] explicit cancelled appointment restoration", {
      leadId: matchedLead.id,
      cancelledAppointmentTime:
        restorableCancelledAppointment?.previousAppointmentTime ?? null,
      previousCalendarEventId:
        restorableCancelledAppointment?.previousCalendarEventId ?? null,
      actionIntent: customerActionIntent,
      parsedMessage: message,
    });

    const restored = await restoreCancelledAppointmentFromHistory({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      updates,
      message,
      toEmail: input.fromEmail,
      subject: input.subject,
      timezone: companyTimezone,
    });

    if (restored) return restored;
  }


  /*
   * CONTEXTUAL AVAILABILITY FOLLOW-UP
   *
   * Example:
   *   Customer: "next Thursday in August 2027 after lunch"
   *   Assistant: "No opening inside that requested window."
   *   Customer asks to see alternatives without adding a new date/time.
   *
   * The newest message contains no new date/time, so resolving it as a fresh
   * scheduling request correctly produces no preference. But the conversation
   * already owns a verified scheduling frame in qualification.schedulingIntent.
   *
   * Reuse that stored frame ONLY as the search anchor, ask availability for
   * real alternatives, persist those exact offered slots, and let the existing
   * pending-slot confirmation path own the next reply.
   *
   * Fresh date/time language never enters this branch.
   */
  const pendingSlotsForAvailabilityRouting = getPendingSuggestionSlots(
    matchedLead.qualification
  );
  const persistedSchedulingContext =
    getStoredSchedulingContextForAvailabilityOptions(
      matchedLead.qualification
    );
  /*
   * Offers are conversation context even when the customer supplied no date
   * preference. Route a further availability inquiry through the same offered-
   * slot exclusion/history path instead of restarting the generic search.
   * This creates no customer date constraint and never authorizes a booking.
   */
  const storedSchedulingContext = persistedSchedulingContext ?? (
    bookingCommand.kind === "show_availability" &&
    bookingCommand.hasFreshTemporalConstraint !== true &&
    pendingSlotsForAvailabilityRouting.length > 0
      ? {
          requestedStartTime: new Date().toISOString(),
          requestedEndTime: null,
          allowedWindows: [] as Array<{ startTime: string; endTime: string | null }>,
          excludedWindows: [] as Array<{ startTime: string; endTime: string | null }>,
          selectionMode: "earliest" as const,
          targetTime: null,
          displayPreference: null,
        }
      : null
  );
  const trailingBareClockHourForActiveContext =
    extractTrailingBareClockHour(message);
  const normalizedAvailabilityRoutingMessage = normalizeSimpleText(message);
  const contextualOfferedClockReference =
    resolveUniquePendingBareClockReference({
      message,
      alternatives: pendingSlotsForAvailabilityRouting,
      timezone: companyTimezone,
    });
  const contextualBareClockCandidate =
    Boolean(storedSchedulingContext) &&
    pendingSlotsForAvailabilityRouting.length === 0 &&
    trailingBareClockHourForActiveContext !== null &&
    !hasGroundedDateEvidence(message) &&
    !hasGroundedClockEvidence(message) &&
    !/\b(?:option|slot|choice|opening|number|num)\b/.test(
      normalizedAvailabilityRoutingMessage
    )
      ? {
          rawHour: trailingBareClockHourForActiveContext as number,
          activeRequestedStartTime:
            storedSchedulingContext?.requestedStartTime ?? null,
          activeRequestedEndTime:
            storedSchedulingContext?.requestedEndTime ?? null,
        }
      : null;

  /*
   * Availability/option routing is a projection of the SAME canonical
   * bookingCommand. There is no independent availability-intent classifier.
   */
  let contextualAvailabilityIntent =
    toLegacyAvailabilityIntent(bookingCommand);

  if (
    contextualBareClockCandidate &&
    contextualAvailabilityIntent.decision !== "information_question"
  ) {
    contextualAvailabilityIntent = {
      ...contextualAvailabilityIntent,
      hasFreshTemporalConstraint: true,
    };
  }

  console.log("[inbound] booking-command availability projection", {
    leadId: matchedLead.id,
    decision: contextualAvailabilityIntent.decision,
    confidence: contextualAvailabilityIntent.confidence,
    reason: contextualAvailabilityIntent.reason,
    hasFreshTemporalConstraint:
      contextualAvailabilityIntent.hasFreshTemporalConstraint,
    selectedOptionNumber: contextualAvailabilityIntent.selectedOptionNumber,
    source: contextualAvailabilityIntent.source,
    parsedMessage: message,
  });

  const contextualOptionsRequest =
    Boolean(storedSchedulingContext) &&
    !hasGroundedTemporalSurfaceEvidence(message) &&
    !contextualBareClockCandidate &&
    contextualAvailabilityIntent?.decision === "availability_inquiry" &&
    contextualAvailabilityIntent.confidence >= 0.7 &&
    contextualAvailabilityIntent.hasFreshTemporalConstraint !== true;

  const unbookedSemanticInformationRequest =
    !hasActiveBookingContext &&
    contextualAvailabilityIntent?.decision === "information_question" &&
    contextualAvailabilityIntent.confidence >= 0.75;

  /*
   * A booked customer asking to SEE appointment availability is still in the
   * scheduling lane even when the Conversation Gate is also active. Do not send
   * appointment availability to Customer Intelligence / web freshness. The one
   * booking-command resolver owns this distinction, while genuine company/general/
   * realtime questions remain information and continue through Conversation Intelligence.
   */
  const bookedReadOnlyAvailabilityInquiry =
    hasActiveBookingContext &&
    contextualAvailabilityIntent?.decision === "availability_inquiry" &&
    contextualAvailabilityIntent.confidence >= 0.7;

  if (contextualOptionsRequest && storedSchedulingContext) {
    /*
     * Repair an already-persisted unbounded frame only when its own retained
     * source wording supplies no calendar constraint. Never clear an explicit
     * future-year/window, an active booking, or a pending selected booking.
     */
    const storedIntent = matchedLead.qualification?.schedulingIntent;
    const sourceTexts = [
      storedIntent?.originalPreference,
      storedIntent?.displayPreference,
      matchedLead.qualification?.activeSchedulingYearContext?.establishedByReply,
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (
      !hasActiveBookingContext &&
      !storedSchedulingContext.requestedEndTime &&
      !matchedLead.qualification?.pendingBookingRequirements &&
      storedIntent?.hasPreference === true &&
      Array.isArray(storedIntent.allowedWindows) &&
      Array.isArray(storedIntent.excludedWindows) &&
      sourceTexts.length > 0 &&
      sourceTexts.every((source) => reconcileUngroundedCalendarPoint(storedIntent, source) !== storedIntent)
    ) {
      const referenceStart = new Date().toISOString();
      const repairedIntent = {
        ...reconcileUngroundedCalendarPoint(storedIntent, sourceTexts[0]),
        hasPreference: true,
        allowedWindows: [{ startTime: referenceStart, endTime: null }],
        temporalGranularity: "window",
      };
      matchedLead.qualification = {
        ...(matchedLead.qualification ?? {}),
        schedulingIntent: repairedIntent,
        activeSchedulingYearContext: null,
      };
      Object.assign(storedSchedulingContext, {
        requestedStartTime: referenceStart,
        requestedEndTime: null,
        allowedWindows: repairedIntent.allowedWindows,
        excludedWindows: [],
        targetTime: null,
        selectionMode: "earliest",
      });
      console.log("[inbound] repaired ungrounded availability frame from retained source evidence", {
        leadId: matchedLead.id,
        requestedStartTime: referenceStart,
      });
    }
    const currentOffered = getPendingSuggestionSlots(
      matchedLead.qualification
    );
    const currentIntent = matchedLead.qualification?.schedulingIntent;
    const frameKey = !persistedSchedulingContext || (currentIntent?.selectionMode === "earliest" &&
      currentIntent?.yearReference === "unspecified" &&
      currentIntent?.customerSpecifiedDate === false &&
      currentIntent?.customerSpecifiedTime === false)
        ? "unbounded_earliest"
        : `${storedSchedulingContext.requestedStartTime}|${storedSchedulingContext.requestedEndTime ?? ""}`;
    const priorHistory = matchedLead.qualification?.availabilityOptionsHistory;
    const priorStarts: string[] = priorHistory?.frameKey === frameKey && Array.isArray(priorHistory.starts)
      ? priorHistory.starts.filter((value: unknown): value is string =>
          typeof value === "string" && Number.isFinite(new Date(value).getTime()))
      : [];
    const previousByStart = new Map<string, AlternativeSlot>();
    for (const slot of [...priorStarts.map((startTime) => ({ startTime })), ...currentOffered]) {
      previousByStart.set(alternativeSlotKey(slot), slot);
    }
    const previouslyOffered = Array.from(previousByStart.values());
    matchedLead.qualification = {
      ...(matchedLead.qualification ?? {}),
      availabilityOptionsHistory: {
        frameKey,
        starts: previouslyOffered.map((slot) => slot.startTime),
      },
    };

    let windowAlternatives: AlternativeSlot[] = [];
    let additionalWindowAlternatives: AlternativeSlot[] = [];

    try {
      /*
       * TRUTH INVARIANT:
       * keep the customer's full stored window authoritative. The previous
       * implementation logged requestedEndTime but failed to pass it into the
       * availability engine, which let "what else do you have?" silently expand
       * a bounded 2–4 PM request into later appointments.
       */
      windowAlternatives = await suggestCadenceAlignedAlternativeSlots({
        companyId: input.companyId,
        requestedStartTime: storedSchedulingContext.requestedStartTime,
        requestedEndTime:
          storedSchedulingContext.requestedEndTime ?? null,
        timezone: companyTimezone,
      });

      additionalWindowAlternatives = excludePreviouslyOfferedSlots({
        alternatives: windowAlternatives,
        previouslyOffered,
      });

      /*
       * If the first availability reply already consumed the earliest slots,
       * continue searching later inside the SAME bounded window before deciding
       * there are no more matching options.
       */
      if (
        additionalWindowAlternatives.length < 3 &&
        previouslyOffered.length > 0
      ) {
        const latestPreviouslyOfferedStart = previouslyOffered
          .map((slot) => new Date(slot.startTime).getTime())
          .filter(Number.isFinite)
          .sort((a, b) => b - a)[0];

        if (Number.isFinite(latestPreviouslyOfferedStart)) {
          const continuedStart = addMinutesToIsoSafe(
            new Date(latestPreviouslyOfferedStart).toISOString(),
            30
          );

          if (
            continuedStart &&
            (!storedSchedulingContext.requestedEndTime || new Date(continuedStart).getTime() <
              new Date(
                storedSchedulingContext.requestedEndTime
              ).getTime())
          ) {
            const continuedWindowAlternatives =
              await suggestCadenceAlignedAlternativeSlots({
                companyId: input.companyId,
                requestedStartTime: continuedStart,
                requestedEndTime:
                  storedSchedulingContext.requestedEndTime ?? null,
                timezone: companyTimezone,
              });

            additionalWindowAlternatives = mergeAlternativeSlots(
              additionalWindowAlternatives,
              excludePreviouslyOfferedSlots({
                alternatives: continuedWindowAlternatives,
                previouslyOffered,
              })
            );
          }
        }
      }
    } catch (error: any) {
      console.error(
        "[inbound] contextual availability option lookup failed",
        {
          leadId: matchedLead.id,
          requestedStartTime:
            storedSchedulingContext.requestedStartTime,
          requestedEndTime:
            storedSchedulingContext.requestedEndTime,
          error: error?.message ?? error,
          parsedMessage: message,
        }
      );

      windowAlternatives = [];
      additionalWindowAlternatives = [];
    }

    const currentWindowKeys = new Set(
      getCleanAlternativeSlots(windowAlternatives).map((slot) =>
        alternativeSlotKey(slot)
      )
    );

    const previouslyOfferedStillAvailable = previouslyOffered.filter(
      (slot) => currentWindowKeys.has(alternativeSlotKey(slot))
    );

    console.log("[inbound] regenerated options from stored scheduling context", {
      leadId: matchedLead.id,
      requestedStartTime: storedSchedulingContext.requestedStartTime,
      requestedEndTime: storedSchedulingContext.requestedEndTime,
      displayPreference: storedSchedulingContext.displayPreference,
      previousOfferedCount: previouslyOffered.length,
      stillAvailablePreviousCount:
        previouslyOfferedStillAvailable.length,
      additionalMatchingWindowCount:
        additionalWindowAlternatives.length,
      semanticDecision: contextualAvailabilityIntent?.decision ?? null,
      semanticConfidence: contextualAvailabilityIntent?.confidence ?? null,
      parsedMessage: message,
    });

    /*
     * If there are genuinely NEW slots inside the customer's requested window,
     * present them as available options. Never route them through the
     * "unavailable" formatter.
     */
    if (additionalWindowAlternatives.length > 0) {
      return sendRequestedWindowOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: additionalWindowAlternatives,
        introOverride: storedSchedulingContext.requestedEndTime
          ? "Here are other real openings within your requested time window:"
          : "Here are other real openings we have:",
        originalRequestedStartTime:
          storedSchedulingContext.requestedStartTime,
        originalRequestedEndTime:
          storedSchedulingContext.requestedEndTime,
        schedulingPreferenceText:
          storedSchedulingContext.displayPreference,
        mixedInformationAnswer: mixedBookedInformationAnswerBody,
      });
    }

    /*
     * "What else do you have?" after one or more real offers means the customer
     * is asking for additional choices. If no additional slot still fits the
     * original bounded window, say that explicitly and only then expand beyond
     * the original window. Never call the original date/window "unavailable"
     * while an already-offered slot inside it is still valid.
     */
    if (previouslyOffered.length > 0) {
      let expandedAlternatives: AlternativeSlot[] = [];

      const expandedSearchStart =
        storedSchedulingContext.requestedEndTime ??
        addMinutesToIsoSafe(
          previouslyOffered
            .map((slot) => slot.endTime ?? slot.startTime)
            .sort(
              (a, b) =>
                new Date(b).getTime() - new Date(a).getTime()
            )[0] ?? storedSchedulingContext.requestedStartTime,
          30
        ) ??
        storedSchedulingContext.requestedStartTime;

      try {
        const broader = await suggestCadenceAlignedAlternativeSlots({
          companyId: input.companyId,
          requestedStartTime: expandedSearchStart,
          timezone: companyTimezone,
        });

        expandedAlternatives = excludePreviouslyOfferedSlots({
          alternatives: broader,
          previouslyOffered,
        });
      } catch (error: any) {
        console.error("[inbound] expanded availability lookup failed", {
          leadId: matchedLead.id,
          expandedSearchStart,
          error: error?.message ?? error,
          parsedMessage: message,
        });
      }

      return sendExpandedAvailabilityOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: expandedAlternatives,
        originalRequestedStartTime:
          storedSchedulingContext.requestedStartTime,
        originalRequestedEndTime:
          storedSchedulingContext.requestedEndTime,
        previouslyOfferedStillAvailable,
      });
    }

    /*
     * No prior offered slots exist. Re-check the exact stored window first. If
     * it now has real availability, say so truthfully. Only an actually empty
     * requested window may use the unavailable response path.
     */
    const cleanWindowAlternatives =
      getCleanAlternativeSlots(windowAlternatives);

    if (cleanWindowAlternatives.length > 0) {
      return sendRequestedWindowOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: cleanWindowAlternatives,
        originalRequestedStartTime:
          storedSchedulingContext.requestedStartTime,
        originalRequestedEndTime:
          storedSchedulingContext.requestedEndTime,
        schedulingPreferenceText:
          storedSchedulingContext.displayPreference,
        mixedInformationAnswer: mixedBookedInformationAnswerBody,
      });
    }

    let broaderAlternatives: AlternativeSlot[] = [];

    try {
      broaderAlternatives = await suggestCadenceAlignedAlternativeSlots({
        companyId: input.companyId,
        requestedStartTime:
          storedSchedulingContext.requestedEndTime ??
          storedSchedulingContext.requestedStartTime,
        timezone: companyTimezone,
      });
    } catch (error: any) {
      console.error("[inbound] broader availability fallback failed", {
        leadId: matchedLead.id,
        error: error?.message ?? error,
        parsedMessage: message,
      });
    }

    return sendUnavailableAndStorePending({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      inboundUpdates: updates,
      toEmail: input.fromEmail,
      subject: input.subject,
      companyTimezone,
      message,
      reason: "slot_unavailable",
      alternatives: broaderAlternatives,
      originalRequestedStartTime:
        storedSchedulingContext.requestedStartTime,
      originalRequestedEndTime:
        storedSchedulingContext.requestedEndTime,
      schedulingPreferenceText:
        storedSchedulingContext.displayPreference,
      mixedInformationAnswer: mixedBookedInformationAnswerBody,
    });
  }

  if (
    (bookedInformationRequest && !bookedReadOnlyAvailabilityInquiry) ||
    unbookedSemanticInformationRequest
  ) {
    const bookingTruthBeforeAnswer = {
      appointmentTime: matchedLead.appointment_time ?? null,
      calendarEventId: matchedLead.calendar_event_id ?? null,
      status: matchedLead.status ?? null,
    };

    const ciAnswer = await answerBookedCustomerInformationRequest({
      companyId: input.companyId,
      fromEmail: input.fromEmail ?? matchedLead.email ?? "",
      subject: input.subject ?? "Re: Your HVAC Request",
      providerThreadId:
        input.providerThreadId ??
        input.providerEventId ??
        matchedLead.id,
      message,
      appointmentTime: matchedLead.appointment_time ?? null,
      originalRequest:
        matchedLead.input ??
        matchedLead.message ??
        null,
    });

    /*
     * Read booking truth back after CI answers. CI is read-only; this check
     * makes any accidental future booking mutation immediately visible.
     */
    const bookingTruthCheck = await fetchLeadByIdForInbound({
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    if (!bookingTruthCheck) {
      throw new Error("booked_information_request_lead_missing_after_ci");
    }

    if (
      (bookingTruthCheck.appointment_time ?? null) !==
        bookingTruthBeforeAnswer.appointmentTime ||
      (bookingTruthCheck.calendar_event_id ?? null) !==
        bookingTruthBeforeAnswer.calendarEventId ||
      (bookingTruthCheck.status ?? null) !==
        bookingTruthBeforeAnswer.status
    ) {
      throw new Error("customer_intelligence_mutated_booking_truth");
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    console.log("[inbound] information request answered read-only", {
      leadId: matchedLead.id,
      actionIntent: customerActionIntent,
      category: ciAnswer.category,
      evidenceMode: ciAnswer.evidenceMode,
      appointmentTime: bookingTruthCheck.appointment_time ?? null,
      calendarEventId: bookingTruthCheck.calendar_event_id ?? null,
      status: bookingTruthCheck.status ?? null,
      parsedMessage: message,
    });

    return {
      success: true,
      processed: true,
      booked: hasActiveBookingContext,
      cancelled: false,
      informationAnswered: true,
      reason: hasActiveBookingContext
        ? "booked_customer_information_request_answered"
        : "customer_information_request_answered",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
    };
  }

  if (bookedActionNeedsClarification) {
    const appointmentLabel = formatCustomerRequestedSlot(
      matchedLead.appointment_time,
      companyTimezone
    );

    const proposedMutationKind =
      (bookingCommand as BookingCommandResult & {
        proposedMutationKind?: BookingCommandKind | null;
      }).proposedMutationKind ?? null;

    /*
     * Only parameter-free destructive/history operations get a one-step
     * YES/NO confirmation. Rescheduling is NOT converted into cancellation
     * merely because authorization was unclear; if a reschedule remains
     * ambiguous, ask the customer to restate the replacement date/time.
     */
    const canPersistSingleActionConfirmation =
      isPersistableConfirmationMutation(proposedMutationKind);
    const canPersistParameterClarification =
      proposedMutationKind === "reschedule";

    const clarificationBody =
      proposedMutationKind === "cancel"
        ? appointmentLabel
          ? `Just to make sure I understood you: do you want me to cancel your appointment for ${appointmentLabel}? Reply YES to cancel it, or NO to leave the appointment scheduled.`
          : "Just to make sure I understood you: do you want me to cancel your appointment? Reply YES to cancel it, or NO to leave the appointment scheduled."
        : proposedMutationKind === "restore_previous"
          ? "Just to make sure I understood you: do you want me to restore the immediately previous appointment from your booking history? Reply YES to restore it, or NO to leave the current appointment as-is."
          : proposedMutationKind === "restore_original"
            ? "Just to make sure I understood you: do you want me to restore your original appointment from the booking history? Reply YES to restore it, or NO to leave the current appointment as-is."
            : proposedMutationKind === "restore_cancelled"
              ? "Just to make sure I understood you: do you want me to restore the most recently cancelled appointment? Reply YES to restore it, or NO to leave it cancelled."
              : proposedMutationKind === "reschedule"
                ? "I understood that you may want to move the current appointment, but I do not have enough confidence to execute the change. Please reply with the replacement date/day and time you want, or tell me to leave the current appointment unchanged."
                : "I’m not confident enough to change your current appointment from that message. Please tell me whether you want to reschedule it, cancel it, restore a prior appointment, or leave it unchanged.";

    if (canPersistSingleActionConfirmation) {
      const requestedAt = new Date();
      const pendingConfirmation: PendingBookingConfirmation = {
        version: 1,
        status: "pending",
        kind: proposedMutationKind,
        appointmentTime: matchedLead.appointment_time ?? null,
        requestedAt: requestedAt.toISOString(),
        requestedByReply: message,
        expiresAt: new Date(
          requestedAt.getTime() + PENDING_BOOKING_CONFIRMATION_TTL_MS
        ).toISOString(),
      };

      const nextQualification = {
        ...(matchedLead.qualification ?? {}),
        pendingBookingConfirmation: pendingConfirmation,
      };

      const { error: confirmationPersistError } = await supabase
        .from("leads")
        .update({ qualification: nextQualification })
        .eq("id", matchedLead.id)
        .eq("company_id", input.companyId);

      if (confirmationPersistError) {
        throw new Error(confirmationPersistError.message);
      }

      matchedLead = {
        ...matchedLead,
        qualification: nextQualification,
      };
    }

    if (canPersistParameterClarification) {
      const requestedAt = new Date();
      const pendingClarification: PendingBookingClarification = {
        version: 1,
        status: "pending",
        kind: "reschedule",
        missing: "temporal_target",
        appointmentTime: matchedLead.appointment_time ?? null,
        requestedAt: requestedAt.toISOString(),
        requestedByReply: message,
        expiresAt: new Date(
          requestedAt.getTime() + PENDING_BOOKING_CLARIFICATION_TTL_MS
        ).toISOString(),
      };

      const nextQualification = {
        ...(matchedLead.qualification ?? {}),
        pendingBookingClarification: pendingClarification,
      };

      const { error: clarificationPersistError } = await supabase
        .from("leads")
        .update({ qualification: nextQualification })
        .eq("id", matchedLead.id)
        .eq("company_id", input.companyId);

      if (clarificationPersistError) {
        throw new Error(clarificationPersistError.message);
      }

      matchedLead = {
        ...matchedLead,
        qualification: nextQualification,
      };
    }

    if (input.fromEmail) {
      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          mixedBookedInformationAnswerBody,
          clarificationBody
        ),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    console.log("[inbound] booked action clarification requested", {
      leadId: matchedLead.id,
      actionIntent: customerActionIntent,
      proposedMutationKind,
      persistedPendingConfirmation: canPersistSingleActionConfirmation,
      persistedPendingClarification: canPersistParameterClarification,
      appointmentTime: matchedLead.appointment_time,
      parsedMessage: message,
    });

    return {
      success: true,
      processed: true,
      booked: true,
      cancelled: false,
      clarificationRequested: true,
      reason: "ambiguous_booked_customer_action",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
    };
  }

  if (bookedActionKeepsAppointment) {
    const appointmentLabel = formatCustomerRequestedSlot(
      matchedLead.appointment_time,
      companyTimezone
    );

    const keepBody = appointmentLabel
      ? `Got it — your appointment for ${appointmentLabel} is still scheduled.`
      : "Got it — your appointment is still scheduled.";

    if (input.fromEmail && hasDisengagementLanguageForAcknowledgement(message)) {
      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          mixedBookedInformationAnswerBody,
          keepBody
        ),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    console.log("[inbound] booking preserved by contextual action intent", {
      leadId: matchedLead.id,
      actionIntent: customerActionIntent,
      appointmentTime: matchedLead.appointment_time,
      calendarEventId: matchedLead.calendar_event_id,
      parsedMessage: message,
    });

    return {
      success: true,
      processed: true,
      booked: true,
      cancelled: false,
      bookingPreserved: true,
      reason: "customer_action_kept_existing_booking",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
    };
  }

  if (bookedCancellationConversation) {
    console.log("[inbound] explicit appointment cancellation conversation", {
      leadId: matchedLead.id,
      currentAppointmentTime: matchedLead.appointment_time,
      currentCalendarEventId: matchedLead.calendar_event_id,
      parsedMessage: message,
    });

    return cancelExistingAppointment({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      updates,
      message,
      providerEventId: input.providerEventId,
      toEmail: input.fromEmail,
      subject: input.subject,
      timezone: companyTimezone,
      mixedInformationAnswer: mixedBookedInformationAnswerBody,
    });
  }

  if (explicitCancellationRequested) {
    if (input.fromEmail) {
      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          mixedBookedInformationAnswerBody,
          "I couldn't find an active appointment on this conversation to cancel."
        ),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    console.warn("[inbound] cancellation requested but no active booking truth found", {
      leadId: matchedLead.id,
      parsedMessage: message,
    });

    return {
      success: true,
      processed: true,
      booked: false,
      cancelled: false,
      reason: "cancellation_requested_without_active_booking_truth",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
    };
  }

  /*
    Stable temporal anchor for the customer's newest message.

    Prefer an authoritative provider/caller receive timestamp when supplied.
    Otherwise use the canonical inbound_emails row creation time captured at
    ingestion. Only fall back to resolver-local "now" if neither value is a
    valid instant. This keeps relative language anchored to the message event,
    not to delayed worker execution.
  */
  const rawSchedulingReferenceTime =
    input.receivedAt ?? inboundEmail.created_at ?? null;

  const messageSchedulingReferenceTime =
    rawSchedulingReferenceTime &&
    !Number.isNaN(new Date(rawSchedulingReferenceTime).getTime())
      ? new Date(rawSchedulingReferenceTime).toISOString()
      : null;

  /*
    BOOKED RESCHEDULE TEMPORAL CONTEXT

    A reschedule turn retains appointment context for omitted date dimensions,
    bare weekdays, time-only changes, and appointment-relative shifts. Explicit
    current/reference-relative language establishes its own frame from the
    message receive time; the appointment date must not redefine "now".

    Examples:
      booked Thu May 20, 2027 2 PM
      "move it to Friday at 3 PM" -> Fri May 21, 2027 3 PM
      "move it to 3 PM"           -> Thu May 20, 2027 3 PM
      "move it to Wednesday"      -> next Wednesday after the booked date

    Anchor at LOCAL START-OF-DAY rather than the appointment clock time so a
    same-day move to an earlier hour remains legal. Explicit absolute calendar
    information in the customer's message is still interpreted by the shared
    resolver and therefore remains authoritative.

    Non-reschedule conversations continue using the provider/inbound timestamp.
  */
  const bookedRescheduleAppointmentDate =
    bookedRescheduleConversation && matchedLead.appointment_time
      ? getLocalCalendarDateForIso(
          matchedLead.appointment_time,
          companyTimezone
        )
      : null;

  const bookedRescheduleSchedulingReferenceTime =
    bookedRescheduleAppointmentDate
      ? zonedTimeToUtc({
          ...bookedRescheduleAppointmentDate,
          hour: 0,
          minute: 0,
          timezone: companyTimezone,
        })
      : null;

  const availabilityInquiryBareWeekdayReferenceTime =
    !hasActiveBookingContext &&
    contextualAvailabilityIntent?.decision === "availability_inquiry" &&
    contextualAvailabilityIntent.confidence >= 0.7 &&
    storedSchedulingContext &&
    getExplicitWeekdayIndex(message) !== null &&
    !hasExplicitCalendarDateSurface(message) &&
    !hasExplicitActiveYearContextEscape(message) &&
    !hasExplicitRelativeWeekdayRelation(message)
      ? storedSchedulingContext.requestedStartTime
      : null;

  // A booked date supplies omitted conversation context, not the meaning of
  // "now". Reuse the same current/reference-relative escape rule that protects
  // the later future-year and offered-slot arbitration stages.
  const newestMessageEstablishesReferenceFrame =
    hasExplicitActiveYearContextEscape(message);

  const schedulingReferenceTime =
    (newestMessageEstablishesReferenceFrame
      ? messageSchedulingReferenceTime ?? new Date().toISOString()
      : null) ??
    bookedRescheduleSchedulingReferenceTime ??
    availabilityInquiryBareWeekdayReferenceTime ??
    messageSchedulingReferenceTime;

  if (availabilityInquiryBareWeekdayReferenceTime) {
    console.log("[inbound] anchored read-only availability weekday to active scheduling context", {
      leadId: matchedLead.id,
      priorRequestedStartTime: storedSchedulingContext?.requestedStartTime ?? null,
      schedulingReferenceTime,
      parsedMessage: message,
    });
  }

  if (
    bookedRescheduleSchedulingReferenceTime &&
    !newestMessageEstablishesReferenceFrame
  ) {
    console.log("[inbound] anchored reschedule temporal context to active appointment", {
      leadId: matchedLead.id,
      currentAppointmentTime: matchedLead.appointment_time,
      appointmentLocalDate: bookedRescheduleAppointmentDate,
      schedulingReferenceTime,
      parsedMessage: message,
    });
  }

  /*
    Resolve semantic scheduling, but never let an ungrounded model-produced
    timestamp outrank an explicit confirmation of options that WE offered.

    Arbitration order is intentionally generic:
      1. Deterministically resolve the active offered-slot context from the
         customer's actual words.
      2. Resolve semantic scheduling.
      3. A high-confidence offered-slot confirmation owns the turn when the
         message contains no explicit date/time surface evidence.
      4. A genuine fresh date/time request can still override the old options.
      5. Time-only requests may inherit one unambiguous active offered date.

    This prevents phrases such as "second one" / "yes book that" from being
    converted into the model's current wall-clock time, while preserving fresh
    corrections such as "actually June 7 at 2 PM" and bare-time inheritance
    such as "make it 3:30 PM".
  */
  const pendingAlternativesAtReply = getPendingSuggestionSlots(
    matchedLead.qualification
  );

  let pendingSlotMatch: PendingSlotMatch =
    bookingCommand.kind === "select_offer"
      ? resolvePendingSlotConfirmation({
          message,
          qualification: matchedLead.qualification,
          timezone: companyTimezone,
        })
      : {
          matched: false,
          startTime: null,
          endTime: null,
          reason: "canonical_booking_command_did_not_select_offer",
          confidence: "low",
        };

  /*
   * Semantic pending-option fallback.
   *
   * Deterministic slot matching remains first. If slang/typos defeat the local
   * phrase parser, the canonical booking-command resolver may still establish that
   * the customer is selecting one of the concrete numbered options supplied in
   * conversation context. The model never books anything: it only supplies a
   * one-based option number, which is range-checked against the exact pending
   * slots we previously persisted before the canonical booking path can act.
   */
  if (
    !pendingSlotMatch.matched &&
    contextualAvailabilityIntent?.decision === "option_selection" &&
    contextualAvailabilityIntent.confidence >= 0.8 &&
    contextualAvailabilityIntent.hasFreshTemporalConstraint !== true
  ) {
    const semanticOptionNumber =
      contextualAvailabilityIntent.selectedOptionNumber ??
      (pendingAlternativesAtReply.length === 1 ? 1 : null);

    if (
      semanticOptionNumber !== null &&
      Number.isInteger(semanticOptionNumber) &&
      semanticOptionNumber >= 1 &&
      semanticOptionNumber <= pendingAlternativesAtReply.length
    ) {
      const semanticSelectedSlot =
        pendingAlternativesAtReply[semanticOptionNumber - 1]!;

      pendingSlotMatch = {
        matched: true,
        startTime: semanticSelectedSlot.startTime,
        endTime: semanticSelectedSlot.endTime ?? null,
        reason: "matched_semantic_pending_option_selection",
        confidence: "high",
      };

      console.log("[inbound] semantic pending option selection matched", {
        leadId: matchedLead.id,
        semanticOptionNumber,
        selectedStartTime: semanticSelectedSlot.startTime,
        parsedMessage: message,
      });
    }
  }

  /*
   * Context-enforced offered-clock ownership.
   *
   * The canonical booking command decides WHAT the customer is doing; persisted pending
   * offers decide WHICH exact slot a shorthand clock refers to. This keeps
   * reference resolution deterministic while preserving the mutation boundary.
   */
  if (
    !pendingSlotMatch.matched &&
    contextualOfferedClockReference &&
    contextualAvailabilityIntent &&
    contextualAvailabilityIntent.confidence >= 0.8 &&
    contextualAvailabilityIntent.hasFreshTemporalConstraint !== true &&
    contextualAvailabilityIntent.decision === "option_selection"
  ) {
    pendingSlotMatch = {
      matched: true,
      startTime: contextualOfferedClockReference.startTime,
      endTime: contextualOfferedClockReference.endTime,
      reason: "matched_contextual_offered_clock_reference",
      confidence: "high",
    };

    console.log("[inbound] contextual offered clock reference matched", {
      leadId: matchedLead.id,
      rawHour: contextualOfferedClockReference.rawHour,
      optionNumber: contextualOfferedClockReference.optionNumber,
      selectedStartTime: contextualOfferedClockReference.startTime,
      semanticDecision: contextualAvailabilityIntent.decision,
      parsedMessage: message,
    });
  }

  const availabilityTimeRefinement =
    bookingCommand.kind === "show_availability" &&
    bookingCommand.hasFreshTemporalConstraint === true &&
    pendingSlotsForAvailabilityRouting.length > 0 &&
    !hasGroundedDateEvidence(message) &&
    !/\b(?:now|today|tomorrow|tonight|yesterday)\b|\b(?:in|within)\s+(?:a\s+|an\s+|a\s+few\s+)?(?:\d+|one|two|three|four|five|six|few|couple(?:\s+of)?)?\s*(?:minutes?|hours?)\b/i.test(message);
  let schedulingIntent = await resolveSchedulingIntent({
    message,
    timezone: companyTimezone,
    referenceTime: schedulingReferenceTime,
    availabilityContext: availabilityTimeRefinement
      ? { offeredSlots: pendingSlotsForAvailabilityRouting }
      : null,
  });

  const rawTemporalOperationBeforeSelectedOfferClockNormalization =
    (schedulingIntent as any)?.temporalOperation ?? null;

  schedulingIntent = await normalizeSelectedOfferRelativeCalendarShiftClock({
    message,
    schedulingIntent,
    bookingCommand,
    pendingAlternatives: pendingSlotsForAvailabilityRouting,
  });

  const temporalOperationBeforeActiveAppointmentClockNormalization =
    (schedulingIntent as any)?.temporalOperation ?? null;

  schedulingIntent = normalizeActiveAppointmentRelativeCalendarShiftClock({
    message,
    schedulingIntent,
    bookingCommand,
    activeAppointmentTime:
      bookedRescheduleConversation && matchedLead.appointment_time
        ? matchedLead.appointment_time
        : null,
    timezone: companyTimezone,
  });

  if (
    temporalOperationBeforeActiveAppointmentClockNormalization?.preserveClock !== true &&
    (schedulingIntent as any)?.temporalOperation?.preserveClock === true &&
    bookingCommand.kind === "reschedule"
  ) {
    console.log(
      "[inbound] booked calendar reschedule inherited local appointment clock",
      {
        leadId: matchedLead.id,
        currentAppointmentTime: matchedLead.appointment_time ?? null,
        temporalOperation: (schedulingIntent as any)?.temporalOperation ?? null,
        parsedMessage: message,
      }
    );
  }

  if (
    bookingCommand.kind === "select_offer" &&
    rawTemporalOperationBeforeSelectedOfferClockNormalization?.preserveClock !== true &&
    (schedulingIntent as any)?.temporalOperation?.preserveClock === true
  ) {
    console.log(
      "[inbound] selected-offer relative calendar edit inherited offered clock",
      {
        leadId: matchedLead.id,
        selectedOptionNumber: bookingCommand.selectedOptionNumber,
        selectedOfferStartTime:
          bookingCommand.selectedOptionNumber !== null
            ? pendingSlotsForAvailabilityRouting[
                bookingCommand.selectedOptionNumber - 1
              ]?.startTime ?? null
            : null,
        temporalOperation: (schedulingIntent as any)?.temporalOperation ?? null,
        parsedMessage: message,
      }
    );
  }

  /*
   * SELECTED OFFER + UNDER-SPECIFIED YEAR-SCOPE RECOVERY
   *
   * A select-offer turn can carry genuine fresh YEAR meaning even when the
   * booking WHAT projection forgets to set hasFreshTemporalConstraint. The
   * scheduling resolver is the WHEN authority, so do not let that stale boolean
   * erase an already-resolved semantic year scope.
   *
   * Recover only the narrow shape that is safe:
   *   - canonical WHAT is select_offer and names one persisted option;
   *   - that exact option is currently resolved;
   *   - the scheduling candidate explicitly resolved a relative/absolute year;
   *   - there is no exact replacement target/clock/bounded window yet; and
   *   - the existing semantic placement arbiter confirms the selected option is
   *     only a reference and placement inside the year is intentionally flexible.
   *
   * No slang/phrase/date catalog lives here. This repairs the authority boundary
   * between WHAT and WHEN; it does not authorize booking or invent availability.
   */
  const preCanonicalSelectedOfferResolvedYear = getResolvedIntentLocalYear({
    intent: schedulingIntent,
    timezone: companyTimezone,
  });
  const preCanonicalSelectedOfferHasExplicitYearSemantics =
    schedulingIntent.hasPreference &&
    (schedulingIntent.yearReference === "relative" ||
      schedulingIntent.yearReference === "absolute");
  const preCanonicalSelectedOfferHasBoundedWindow = Boolean(
    getSingleBoundedSchedulingWindow(schedulingIntent)
  );

  if (
    bookingCommand.kind === "select_offer" &&
    bookingCommand.selectedOptionNumber !== null &&
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    preCanonicalSelectedOfferHasExplicitYearSemantics &&
    Number.isInteger(preCanonicalSelectedOfferResolvedYear) &&
    !schedulingIntent.targetTime &&
    schedulingIntent.customerSpecifiedTime !== true &&
    !preCanonicalSelectedOfferHasBoundedWindow
  ) {
    const targetYear = preCanonicalSelectedOfferResolvedYear as number;
    const currentLocalDate = getNowInTimezone(companyTimezone);
    const yearStartTime = zonedTimeToUtc({
      year: targetYear,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      timezone: companyTimezone,
    });
    const nextYearStartTime = zonedTimeToUtc({
      year: targetYear + 1,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      timezone: companyTimezone,
    });
    const referenceMs = messageSchedulingReferenceTime
      ? new Date(messageSchedulingReferenceTime).getTime()
      : Number.NaN;
    const yearStartMs = new Date(yearStartTime).getTime();
    const effectiveStartMs =
      targetYear === currentLocalDate.year && Number.isFinite(referenceMs)
        ? Math.max(yearStartMs, referenceMs)
        : yearStartMs;

    if (
      Number.isFinite(effectiveStartMs) &&
      new Date(nextYearStartTime).getTime() > effectiveStartMs
    ) {
      const recoveredYearWindowIntent: typeof schedulingIntent = {
        ...schedulingIntent,
        hasPreference: true,
        allowedWindows: [
          {
            startTime: new Date(effectiveStartMs).toISOString(),
            endTime: nextYearStartTime,
          },
        ],
        excludedWindows: [],
        targetTime: null,
        selectionMode: "earliest",
        temporalGranularity: "window",
        customerSpecifiedDate: true,
        customerSpecifiedTime: false,
        localDateTime: null,
        confidence: Math.max(Number(schedulingIntent.confidence ?? 0), 0.9),
        interpretation:
          "Explicit semantic year scope recovered as a bounded scheduling window; exact placement remains intentionally unresolved pending semantic placement arbitration.",
      };

      const recoveredPlacement = await resolveSelectedOfferPlacementContext({
        message,
        schedulingIntent: recoveredYearWindowIntent,
        pendingAlternatives: pendingAlternativesAtReply,
      });

      const selectedOptionMatches =
        recoveredPlacement?.referencesPersistedOffer === true &&
        recoveredPlacement.referencedOptionNumber ===
          bookingCommand.selectedOptionNumber;

      if (
        selectedOptionMatches &&
        recoveredPlacement?.placementMode === "flexible_within_window"
      ) {
        schedulingIntent = recoveredYearWindowIntent;
        contextualAvailabilityIntent = {
          ...contextualAvailabilityIntent,
          hasFreshTemporalConstraint: true,
        };
        pendingSlotMatch = {
          matched: false,
          startTime: null,
          endTime: null,
          reason: "selected_offer_flexible_year_scope_overrides_stale_offer",
          confidence: "high",
        };

        console.log(
          "[inbound] recovered flexible selected-offer year window before canonical arbitration",
          {
            leadId: matchedLead.id,
            selectedOptionNumber: bookingCommand.selectedOptionNumber,
            resolvedYear: targetYear,
            requestedStartTime:
              recoveredYearWindowIntent.allowedWindows[0]?.startTime ?? null,
            requestedEndTime:
              recoveredYearWindowIntent.allowedWindows[0]?.endTime ?? null,
            placementMode: recoveredPlacement.placementMode,
            parsedMessage: message,
          }
        );
      }
    }
  }

  /*
   * Preserve the raw semantic resolver output BEFORE legacy contextual
   * enrichments modify it. The canonical temporal interpreter receives both
   * the raw semantic candidate and the enriched compatibility candidate, so it
   * can validate rather than accidentally treating an already-rewritten value
   * as the original model claim.
   */
  const semanticSchedulingIntent = {
    ...schedulingIntent,
    allowedWindows: (schedulingIntent.allowedWindows ?? []).map((window) => ({
      ...window,
    })),
    excludedWindows: (schedulingIntent.excludedWindows ?? []).map((window) => ({
      ...window,
    })),
    localDateTime: schedulingIntent.localDateTime
      ? { ...schedulingIntent.localDateTime }
      : null,
  };

  /*
   * ACTIVE-FRAME BARE CLOCK CONTINUITY
   *
   * When the conversation has a real scheduling frame but NO numbered pending
   * offers, a trailing bare 1-12 may be a clock correction rather than an option
   * index. Preserve the active customer-requested calendar date and resolve only
   * the omitted AM/PM half-day from that frame's clock. This changes WHEN only;
   * the semantic availability/action classifier still decides whether the turn
   * is read-only or mutation-authorizing.
   */
  if (contextualBareClockCandidate && storedSchedulingContext) {
    const inheritedDate = getLocalCalendarDateForIso(
      storedSchedulingContext.requestedStartTime,
      companyTimezone
    );
    const referenceClock = getLocalClockForIso(
      storedSchedulingContext.requestedStartTime,
      companyTimezone
    );

    if (inheritedDate && referenceClock) {
      const rawHour = contextualBareClockCandidate.rawHour;
      const baseHour = rawHour % 12;
      const referenceMinutes = referenceClock.hour * 60 + referenceClock.minute;

      /*
       * Resolve omitted AM/PM on a circular 24-hour clock, not by raw numeric
       * subtraction. This matters at the 12 boundary: from an evening frame,
       * bare "12" is naturally midnight immediately ahead, not noon six hours
       * behind. For equal-distance candidates, prefer the forward occurrence.
       */
      const clockCandidates = [baseHour, baseHour + 12].flatMap((hour) =>
        [-1, 0, 1].map((dayOffset) => ({
          absoluteMinutes: (hour + dayOffset * 24) * 60,
          hour,
          dayOffset,
        }))
      );

      clockCandidates.sort((a, b) => {
        const aDistance = Math.abs(a.absoluteMinutes - referenceMinutes);
        const bDistance = Math.abs(b.absoluteMinutes - referenceMinutes);
        if (aDistance !== bDistance) return aDistance - bDistance;

        const aIsForward = a.absoluteMinutes >= referenceMinutes;
        const bIsForward = b.absoluteMinutes >= referenceMinutes;
        if (aIsForward !== bIsForward) return aIsForward ? -1 : 1;

        return a.absoluteMinutes - b.absoluteMinutes;
      });

      const resolvedClock = clockCandidates[0]!;
      const resolvedHour = resolvedClock.hour;
      const resolvedDate =
        resolvedClock.dayOffset === 0
          ? inheritedDate
          : addDaysToLocalDate({
              ...inheritedDate,
              days: resolvedClock.dayOffset,
            });

      const inheritedLocalDateTime = {
        ...resolvedDate,
        hour: resolvedHour,
        minute: 0,
      };
      const inheritedStartTime = zonedTimeToUtc({
        ...inheritedLocalDateTime,
        timezone: companyTimezone,
      });

      schedulingIntent = {
        ...schedulingIntent,
        hasPreference: true,
        allowedWindows: [{ startTime: inheritedStartTime, endTime: null }],
        excludedWindows: [],
        targetTime: inheritedStartTime,
        selectionMode: "closest",
        temporalGranularity: "date_time",
        customerSpecifiedDate: false,
        customerSpecifiedTime: true,
        localDateTime: inheritedLocalDateTime,
        displayPreference:
          formatCustomerRequestedPeriod({
            startTime: inheritedStartTime,
            endTime: null,
            timezone: companyTimezone,
          }) ?? schedulingIntent.displayPreference,
        originalPreference:
          schedulingIntent.originalPreference ?? message,
        confidence: Math.max(Number(schedulingIntent.confidence ?? 0), 0.95),
        interpretation:
          "Contextual bare clock inherited the active customer-requested calendar date and resolved only the omitted half-day context.",
      };

      console.log("[inbound] inherited active scheduling frame for bare clock", {
        leadId: matchedLead.id,
        rawHour,
        referenceClock,
        inheritedDate,
        resolvedDate,
        resolvedHour,
        resolvedDayOffset: resolvedClock.dayOffset,
        resolvedStartTime: inheritedStartTime,
        semanticDecision: contextualAvailabilityIntent?.decision ?? null,
        parsedMessage: message,
      });
    }
  }

  const contextualBareRescheduleClock =
    bookedRescheduleConversation
      ? resolveContextualBareHourFromCurrentAppointment({
          message,
          currentAppointmentTime: matchedLead.appointment_time,
          timezone: companyTimezone,
          isRescheduleCommand: bookingCommand.kind === "reschedule",
        })
      : null;

  if (
    contextualBareRescheduleClock &&
    schedulingIntent.hasPreference &&
    schedulingIntent.customerSpecifiedDate === true &&
    (
      schedulingIntent.customerSpecifiedTime === false ||
      contextualBareRescheduleClock.source ===
        "current_appointment_clock_reference"
    )
  ) {
    const schedulingDate =
      schedulingIntent.localDateTime
        ? {
            year: schedulingIntent.localDateTime.year,
            month: schedulingIntent.localDateTime.month,
            day: schedulingIntent.localDateTime.day,
          }
        : getLocalCalendarDateForIso(
            schedulingIntent.targetTime ??
              schedulingIntent.allowedWindows?.[0]?.startTime ??
              "",
            companyTimezone
          );

    if (schedulingDate) {
      const contextualStartTime = zonedTimeToUtc({
        ...schedulingDate,
        hour: contextualBareRescheduleClock.hour,
        minute: contextualBareRescheduleClock.minute,
        timezone: companyTimezone,
      });

      schedulingIntent = {
        ...schedulingIntent,
        hasPreference: true,
        allowedWindows: [
          {
            startTime: contextualStartTime,
            endTime: null,
          },
        ],
        targetTime: contextualStartTime,
        selectionMode: "closest",
        temporalGranularity: "date_time",
        customerSpecifiedDate: true,
        customerSpecifiedTime: true,
        localDateTime: {
          ...schedulingDate,
          hour: contextualBareRescheduleClock.hour,
          minute: contextualBareRescheduleClock.minute,
        },
        interpretation:
          contextualBareRescheduleClock.source ===
          "current_appointment_clock_reference"
            ? "Contextual reschedule preserved the current appointment clock while applying the customer-supplied reschedule date."
            : "Contextual reschedule shorthand merged the customer-supplied bare hour with the resolved reschedule date.",
      };

      console.log("[inbound] merged contextual reschedule clock", {
        leadId: matchedLead.id,
        source: contextualBareRescheduleClock.source,
        rawHour: contextualBareRescheduleClock.rawHour,
        resolvedHour: contextualBareRescheduleClock.hour,
        resolvedMinute: contextualBareRescheduleClock.minute,
        resolvedStartTime: contextualStartTime,
        parsedMessage: message,
      });
    }
  }

  const explicitRelativeWeekdayRelation =
    getExplicitRelativeWeekdayRelation(message);

  if (
    explicitRelativeWeekdayRelation &&
    !hasSharedComposableRelativeWeekdayResolution(schedulingIntent)
  ) {
    const beforeRelativeWeekdayEnforcement = schedulingIntent;

    schedulingIntent = enforceExplicitRelativeWeekdayRelation({
      message,
      timezone: companyTimezone,
      referenceIso: schedulingReferenceTime,
      intent: schedulingIntent,
    });

    console.log("[inbound] enforced explicit relative weekday relation", {
      leadId: matchedLead.id,
      parsedMessage: message,
      relation: explicitRelativeWeekdayRelation.relation,
      weekdayName: explicitRelativeWeekdayRelation.weekdayName,
      beforeTargetTime: beforeRelativeWeekdayEnforcement?.targetTime ?? null,
      afterTargetTime: schedulingIntent?.targetTime ?? null,
      afterLocalDateTime: schedulingIntent?.localDateTime ?? null,
    });
  }

  /*
    Explicit-year weekday invariant.

    This runs ONLY when the customer's newest message:
      - names a weekday;
      - contains explicit relative/absolute year semantics already recognized
        by the resolver;
      - does NOT name a concrete calendar month/date.

    It prevents a contradiction such as:
      "Thursday next year" -> Tuesday, September 7, 2027

    For this narrow shape, the requested weekday is a hard grounded constraint.
    We resolve it to the first occurrence of that weekday in the resolver's
    resolved year. Normal no-year/current-year SOP is untouched because this
    branch requires yearReference === "relative" or "absolute".
  */
  const explicitYearWeekdayIndex = getExplicitWeekdayIndex(message);

  if (
    schedulingIntent.hasPreference &&
    explicitYearWeekdayIndex !== null &&
    !hasExplicitCalendarDateSurface(message) &&
    (schedulingIntent.yearReference === "relative" ||
      schedulingIntent.yearReference === "absolute")
  ) {
    const explicitYearWeekdayResolvedYear = getResolvedIntentLocalYear({
      intent: schedulingIntent,
      timezone: companyTimezone,
    });

    if (explicitYearWeekdayResolvedYear) {
      const firstDayOfYear = {
        year: explicitYearWeekdayResolvedYear,
        month: 1,
        day: 1,
      };

      const firstDayWeekday = getWeekdayIndexForLocalDate(firstDayOfYear);
      const daysUntilRequestedWeekday =
        (explicitYearWeekdayIndex - firstDayWeekday + 7) % 7;

      const resolvedWeekdayDate = addDaysToLocalDate({
        ...firstDayOfYear,
        days: daysUntilRequestedWeekday,
      });

      if (schedulingIntent.customerSpecifiedTime === true) {
        const groundedClock = hasGroundedClockEvidence(message)
          ? extractRequestedTimeParts(message)
          : null;

        const hour =
          groundedClock?.hour ??
          schedulingIntent.localDateTime?.hour ??
          0;
        const minute =
          groundedClock?.minute ??
          schedulingIntent.localDateTime?.minute ??
          0;

        const resolvedStartTime = zonedTimeToUtc({
          ...resolvedWeekdayDate,
          hour,
          minute,
          timezone: companyTimezone,
        });

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: [
            {
              startTime: resolvedStartTime,
              endTime: null,
            },
          ],
          targetTime: resolvedStartTime,
          selectionMode: "closest",
          temporalGranularity: "date_time",
          customerSpecifiedDate: true,
          customerSpecifiedTime: true,
          localDateTime: {
            ...resolvedWeekdayDate,
            hour,
            minute,
          },
          interpretation:
            "Grounded weekday constraint reconciled with the explicitly requested year.",
        };
      } else {
        const resolvedStartTime = zonedTimeToUtc({
          ...resolvedWeekdayDate,
          hour: 0,
          minute: 0,
          timezone: companyTimezone,
        });

        const followingDate = addDaysToLocalDate({
          ...resolvedWeekdayDate,
          days: 1,
        });

        const resolvedEndTime = zonedTimeToUtc({
          ...followingDate,
          hour: 0,
          minute: 0,
          timezone: companyTimezone,
        });

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: [
            {
              startTime: resolvedStartTime,
              endTime: resolvedEndTime,
            },
          ],
          targetTime: null,
          selectionMode: "earliest",
          temporalGranularity: "date_only",
          customerSpecifiedDate: true,
          customerSpecifiedTime: false,
          localDateTime: null,
          interpretation:
            "Grounded weekday constraint reconciled with the explicitly requested year.",
        };
      }

      console.log("[inbound] enforced explicit-year weekday constraint", {
        leadId: matchedLead.id,
        parsedMessage: message,
        requestedWeekdayIndex: explicitYearWeekdayIndex,
        resolvedYear: explicitYearWeekdayResolvedYear,
        resolvedDate: resolvedWeekdayDate,
        yearReference: schedulingIntent.yearReference,
      });
    }
  }

  /*
    Contextual weekday + clock correction.

    Example:
      offered: Thu Jan 7, 2027 at 8:00 / 8:30 / 9:00
      customer: "Thursday at 2 PM"

    This is NOT option 2. It is a fresh 2:00 PM clock request anchored to the
    already-active offered Thursday date.

    Apply this only when:
      - the customer supplied a real clock expression;
      - the customer supplied a weekday but no explicit calendar date;
      - the wording is not an explicit current/reference-relative escape such
        as "next Thursday" or "this Thursday";
      - all active offered slots resolve to one unambiguous local date; and
      - that offered date's weekday matches the customer's weekday.

    With no safe pending date, ordinary resolver behavior is left untouched.
  */
  const contextualClockWeekdayIndex = getExplicitWeekdayIndex(message);
  const contextualClockPendingDate =
    pendingAlternativesAtReply.length > 0
      ? resolveUnambiguousPendingCalendarDate({
          alternatives: pendingAlternativesAtReply,
          timezone: companyTimezone,
        })
      : null;

  const contextualPendingBareClock =
    pendingAlternativesAtReply.length > 0
      ? resolveContextualPendingBareClock({
          message,
          qualification: matchedLead.qualification,
          alternatives: pendingAlternativesAtReply,
          timezone: companyTimezone,
        })
      : null;

  const contextualClockParts = hasGroundedClockEvidence(message)
    ? extractRequestedTimeParts(message)
    : contextualPendingBareClock;

  if (
    contextualClockParts &&
    contextualClockWeekdayIndex !== null &&
    !hasExplicitCalendarDateSurface(message) &&
    !hasExplicitActiveYearContextEscape(message) &&
    !hasExplicitRelativeWeekdayRelation(message) &&
    contextualClockPendingDate
  ) {
    /*
      Contextual weekday + explicit clock.

      This is deliberately isolated from normal scheduling SOP. It only runs
      when the conversation already has one unambiguous pending offered local
      date. Without that pending context, the resolver result is untouched.

      "Thursday 2" is NOT handled here unless the text contains grounded clock
      evidence; the existing contextual option matcher remains responsible for
      ordinal/option references.

      "Thursday at 2 PM" is a fresh clock request:
        1) if the pending date is Thursday, reuse that exact date;
        2) if the pending date contradicts the customer's weekday, preserve
           the pending month/year context and move to the nearest requested
           weekday inside that same month, preferring the next occurrence.

      This prevents a contextual future-year conversation from collapsing back
      to the resolver's unrelated current-year weekday guess while leaving all
      no-context/current-year SOP untouched.
    */
    const pendingWeekday =
      getWeekdayIndexForLocalDate(contextualClockPendingDate);

    let inheritedCalendarDate = contextualClockPendingDate;

    if (pendingWeekday !== contextualClockWeekdayIndex) {
      const forwardDelta =
        (contextualClockWeekdayIndex - pendingWeekday + 7) % 7;

      const backwardDelta =
        forwardDelta === 0 ? 0 : forwardDelta - 7;

      const forwardCandidate =
        forwardDelta === 0
          ? contextualClockPendingDate
          : addDaysToLocalDate({
              ...contextualClockPendingDate,
              days: forwardDelta,
            });

      const backwardCandidate =
        backwardDelta === 0
          ? contextualClockPendingDate
          : addDaysToLocalDate({
              ...contextualClockPendingDate,
              days: backwardDelta,
            });

      const samePendingMonth = (candidate: {
        year: number;
        month: number;
        day: number;
      }) =>
        candidate.year === contextualClockPendingDate.year &&
        candidate.month === contextualClockPendingDate.month;

      if (samePendingMonth(forwardCandidate)) {
        inheritedCalendarDate = forwardCandidate;
      } else if (samePendingMonth(backwardCandidate)) {
        inheritedCalendarDate = backwardCandidate;
      } else {
        inheritedCalendarDate = contextualClockPendingDate;
      }
    }

    const inheritedLocalDateTime = {
      ...inheritedCalendarDate,
      hour: contextualClockParts.hour,
      minute: contextualClockParts.minute,
    };

    const inheritedStartTime = zonedTimeToUtc({
      ...inheritedLocalDateTime,
      timezone: companyTimezone,
    });

    schedulingIntent = {
      ...schedulingIntent,
      hasPreference: true,
      allowedWindows: [
        {
          startTime: inheritedStartTime,
          endTime: null,
        },
      ],
      targetTime: inheritedStartTime,
      selectionMode: "closest",
      temporalGranularity: "date_time",
      customerSpecifiedDate: false,
      customerSpecifiedTime: true,
      localDateTime: inheritedLocalDateTime,
      displayPreference:
        formatCustomerRequestedPeriod({
          startTime: inheritedStartTime,
          endTime: null,
          timezone: companyTimezone,
        }) ?? schedulingIntent.displayPreference,
      interpretation:
        contextualPendingBareClock
          ? "Contextual weekday-and-bare-clock request inherited the active offered calendar context and prior clock half-day context."
          : "Grounded weekday-and-clock request inherited the active offered calendar context.",
    };

    console.log("[inbound] inherited active offered context for weekday clock request", {
      leadId: matchedLead.id,
      requestedWeekdayIndex: contextualClockWeekdayIndex,
      pendingDate: contextualClockPendingDate,
      pendingWeekday,
      inheritedDate: inheritedCalendarDate,
      requestedHour: inheritedLocalDateTime.hour,
      requestedMinute: inheritedLocalDateTime.minute,
      contextualBareClock: Boolean(contextualPendingBareClock),
      contextualClockReference:
        contextualPendingBareClock?.referenceClock ?? null,
      inheritedStartTime,
      parsedMessage: message,
    });
  }

  /*
    Conversation-level year continuity.

    Keep the resolver's ordinary omitted-year rule untouched. It remains the
    default whenever the customer has NOT established a future-year frame.

    Only an explicit customer year constraint establishes/replaces that frame:
      - relative year semantics (for example, a genuine year-relative request)
      - an explicit absolute calendar year

    Once a future-year frame is active, a later omitted-year CALENDAR request
    can continue that year naturally. This is deliberately narrower than
    "anything future": relative dates/weekday expressions such as tomorrow,
    next Tuesday, or next month establish their own frame and clear the carried
    future-year context instead of inheriting it.
  */
  const localNow = getNowInTimezone(companyTimezone);
  const contextualPendingOptionReference =
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    pendingSlotMatch.reason === "matched_contextual_weekday_option_reference";
  const activeYearContextBeforeReply = getActiveSchedulingYearContext(
    matchedLead.qualification
  );

  const resolvedYearFromNewestMessage = getResolvedIntentLocalYear({
    intent: schedulingIntent,
    timezone: companyTimezone,
  });

  const newestMessageHasExplicitYearSemantics =
    schedulingIntent.hasPreference &&
    (schedulingIntent.yearReference === "relative" ||
      schedulingIntent.yearReference === "absolute");

  if (
    !contextualPendingOptionReference &&
    newestMessageHasExplicitYearSemantics &&
    resolvedYearFromNewestMessage
  ) {
    if (resolvedYearFromNewestMessage > localNow.year) {
      const nextYearContext: ActiveSchedulingYearContext = {
        year: resolvedYearFromNewestMessage,
        source:
          schedulingIntent.yearReference === "absolute"
            ? "absolute_year"
            : "relative_year",
        establishedByReply: message,
        establishedAt: new Date().toISOString(),
      };

      setActiveSchedulingYearContextOnLead({
        lead: matchedLead,
        context: nextYearContext,
      });
      await persistLeadQualification({
        companyId: input.companyId,
        lead: matchedLead,
      });

      console.log("[inbound] established active future-year scheduling context", {
        leadId: matchedLead.id,
        year: nextYearContext.year,
        source: nextYearContext.source,
        yearReference: schedulingIntent.yearReference,
        parsedMessage: message,
      });
    } else {
      setActiveSchedulingYearContextOnLead({
        lead: matchedLead,
        context: null,
      });
      await persistLeadQualification({
        companyId: input.companyId,
        lead: matchedLead,
      });

      console.log("[inbound] cleared active future-year scheduling context from explicit year override", {
        leadId: matchedLead.id,
        resolvedYear: resolvedYearFromNewestMessage,
        currentLocalYear: localNow.year,
        yearReference: schedulingIntent.yearReference,
        parsedMessage: message,
      });
    }
  } else if (
    !contextualPendingOptionReference &&
    schedulingIntent.hasPreference &&
    schedulingIntent.customerSpecifiedDate === true
  ) {
    const activeYearContext = activeYearContextBeforeReply;
    const explicitCalendarDate = hasExplicitCalendarDateSurface(message);
    const explicitCurrentYearScope = hasExplicitCurrentYearScope(message);
    const explicitActiveYearContextEscape =
      hasExplicitActiveYearContextEscape(message);

    if (
      !activeYearContext &&
      explicitCalendarDate &&
      !explicitCurrentYearScope &&
      schedulingIntent.yearReference === "unspecified" &&
      resolvedYearFromNewestMessage &&
      resolvedYearFromNewestMessage > localNow.year
    ) {
      const nextYearContext: ActiveSchedulingYearContext = {
        year: resolvedYearFromNewestMessage,
        source: "resolved_future_calendar",
        establishedByReply: message,
        establishedAt: new Date().toISOString(),
      };

      setActiveSchedulingYearContextOnLead({
        lead: matchedLead,
        context: nextYearContext,
      });
      await persistLeadQualification({
        companyId: input.companyId,
        lead: matchedLead,
      });

      console.log("[inbound] established active resolved future-calendar context", {
        leadId: matchedLead.id,
        year: nextYearContext.year,
        parsedMessage: message,
      });
    } else if (
      activeYearContext &&
      activeYearContext.year > localNow.year &&
      schedulingIntent.yearReference === "unspecified" &&
      !explicitActiveYearContextEscape
    ) {
      /*
        Active future-year context is sticky by default. Once the customer has
        established that conversation frame, omitted-year date expressions
        remain inside it unless the customer's own words explicitly establish
        a current/reference-relative frame (tomorrow, next week, this month,
        etc.). This branch is unreachable when no active future-year context
        exists, so the system's ordinary current-year SOP remains untouched.
      */
      const beforeYear = getResolvedIntentLocalYear({
        intent: schedulingIntent,
        timezone: companyTimezone,
      });

      schedulingIntent = inheritActiveSchedulingYearIntoIntent({
        intent: schedulingIntent,
        activeYear: activeYearContext.year,
        timezone: companyTimezone,
      });

      const afterYear = getResolvedIntentLocalYear({
        intent: schedulingIntent,
        timezone: companyTimezone,
      });

      if (afterYear === activeYearContext.year) {
        console.log("[inbound] enforced active future-year scheduling context", {
          leadId: matchedLead.id,
          activeYear: activeYearContext.year,
          contextSource: activeYearContext.source,
          beforeYear,
          afterYear,
          explicitCalendarDate,
          temporalGranularity: schedulingIntent.temporalGranularity,
          parsedMessage: message,
        });
      }
    } else if (
      activeYearContext &&
      schedulingIntent.yearReference === "unspecified" &&
      explicitActiveYearContextEscape
    ) {
      /*
        Clear a carried future-year frame only when the customer's actual text
        explicitly establishes a current/reference-relative frame. Resolver
        classification alone is not enough to revoke conversation context.
      */
      setActiveSchedulingYearContextOnLead({
        lead: matchedLead,
        context: null,
      });
      await persistLeadQualification({
        companyId: input.companyId,
        lead: matchedLead,
      });

      console.log("[inbound] cleared active future-year context for explicit temporal escape", {
        leadId: matchedLead.id,
        explicitCalendarDate,
        explicitCurrentYearScope,
        explicitActiveYearContextEscape,
        temporalGranularity: schedulingIntent.temporalGranularity,
        parsedMessage: message,
      });
    }
  }

  /*
    Contextual same-calendar-day invariant.

    A same-day/date reference inherits the COMPLETE prior customer-requested
    local calendar date (year + month + day). It may change the clock/daypart
    or semantic time window, but it must not rebuild the date from the current
    inbound/reference timestamp.

    Safety scope:
      - requires explicit same-day/date anaphora in the newest customer words;
      - requires one authoritative prior requested local calendar day;
      - refuses to compete with an independently supplied month/date, weekday,
        relative-date frame, or explicit year frame;
      - changes temporal anchoring only. It does not authorize booking,
        cancellation, restoration, rescheduling, Calendar mutation, or any
        Conversation/Booking Gate transition.
  */
  const contextualSameCalendarDayReference =
    hasContextualSameCalendarDayReference(message);

  const contextualSameDayPriorDate =
    contextualSameCalendarDayReference
      ? (
          resolvePendingOriginalRequestedCalendarDate({
            qualification: matchedLead.qualification,
            timezone: companyTimezone,
          }) ??
          resolveStoredSchedulingContextCalendarDate({
            context: storedSchedulingContext,
            timezone: companyTimezone,
          })
        )
      : null;

  const sameDayHasIndependentFreshDateFrame =
    hasExplicitCalendarDateSurface(message) ||
    hasExplicitActiveYearContextEscape(message) ||
    getExplicitWeekdayIndex(message) !== null ||
    extractContextualDayOfMonthFragment(message) !== null ||
    newestMessageHasExplicitYearSemantics;

  if (
    contextualSameCalendarDayReference &&
    contextualSameDayPriorDate &&
    schedulingIntent.hasPreference &&
    !sameDayHasIndependentFreshDateFrame
  ) {
    const semanticWindowShouldRemainWindow =
      schedulingIntent.temporalGranularity === "window" &&
      Array.isArray(schedulingIntent.allowedWindows) &&
      schedulingIntent.allowedWindows.length > 0;

    if (semanticWindowShouldRemainWindow) {
      const originalExcludedWindows = Array.isArray(
        schedulingIntent.excludedWindows
      )
        ? schedulingIntent.excludedWindows
        : [];

      const rebasedAllowedWindows = schedulingIntent.allowedWindows
        .map((window: any) =>
          rebaseTemporalWindowToCalendarDate({
            window,
            targetDate: contextualSameDayPriorDate,
            timezone: companyTimezone,
          })
        )
        .filter(Boolean) as Array<{
        startTime: string;
        endTime: string | null;
      }>;

      const rebasedExcludedWindows = originalExcludedWindows
        .map((window: any) =>
          rebaseTemporalWindowToCalendarDate({
            window,
            targetDate: contextualSameDayPriorDate,
            timezone: companyTimezone,
          })
        )
        .filter(Boolean) as Array<{
        startTime: string;
        endTime: string | null;
      }>;

      if (
        rebasedAllowedWindows.length === schedulingIntent.allowedWindows.length &&
        rebasedExcludedWindows.length === originalExcludedWindows.length
      ) {
        const firstWindow = rebasedAllowedWindows[0]!;

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: rebasedAllowedWindows,
          excludedWindows: rebasedExcludedWindows,
          targetTime: null,
          temporalGranularity: "window",
          customerSpecifiedDate: true,
          localDateTime: null,
          displayPreference:
            formatCustomerRequestedPeriod({
              startTime: firstWindow.startTime,
              endTime: firstWindow.endTime,
              timezone: companyTimezone,
            }) ?? schedulingIntent.displayPreference,
          interpretation:
            "Contextual same-day reference preserved the complete active customer-requested calendar date while retaining the newest semantic time window.",
        };
      }
    } else if (schedulingIntent.customerSpecifiedTime === true) {
      const sourceStartTime =
        schedulingIntent.targetTime ??
        schedulingIntent.allowedWindows?.[0]?.startTime ??
        null;

      const sourceClock = sourceStartTime
        ? getLocalClockForIso(sourceStartTime, companyTimezone)
        : schedulingIntent.localDateTime
          ? {
              hour: schedulingIntent.localDateTime.hour,
              minute: schedulingIntent.localDateTime.minute,
            }
          : null;

      if (sourceClock) {
        const rebasedStartTime = zonedTimeToUtc({
          ...contextualSameDayPriorDate,
          hour: sourceClock.hour,
          minute: sourceClock.minute,
          timezone: companyTimezone,
        });

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: [
            {
              startTime: rebasedStartTime,
              endTime: null,
            },
          ],
          targetTime: rebasedStartTime,
          selectionMode: "closest",
          temporalGranularity: "date_time",
          customerSpecifiedDate: true,
          customerSpecifiedTime: true,
          localDateTime: {
            ...contextualSameDayPriorDate,
            hour: sourceClock.hour,
            minute: sourceClock.minute,
          },
          displayPreference:
            formatCustomerRequestedPeriod({
              startTime: rebasedStartTime,
              endTime: null,
              timezone: companyTimezone,
            }) ?? schedulingIntent.displayPreference,
          interpretation:
            "Contextual same-day reference preserved the complete active customer-requested calendar date while applying the newest customer time.",
        };
      }
    } else {
      const dayStart = zonedTimeToUtc({
        ...contextualSameDayPriorDate,
        hour: 0,
        minute: 0,
        timezone: companyTimezone,
      });
      const followingDate = addDaysToLocalDate({
        ...contextualSameDayPriorDate,
        days: 1,
      });
      const dayEnd = zonedTimeToUtc({
        ...followingDate,
        hour: 0,
        minute: 0,
        timezone: companyTimezone,
      });

      schedulingIntent = {
        ...schedulingIntent,
        allowedWindows: [{ startTime: dayStart, endTime: dayEnd }],
        targetTime: null,
        selectionMode: "earliest",
        temporalGranularity: "date_only",
        customerSpecifiedDate: true,
        customerSpecifiedTime: false,
        localDateTime: null,
        displayPreference:
          formatCustomerRequestedPeriod({
            startTime: dayStart,
            endTime: dayEnd,
            timezone: companyTimezone,
          }) ?? schedulingIntent.displayPreference,
        interpretation:
          "Contextual same-day reference preserved the complete active customer-requested calendar date.",
      };
    }

    console.log("[inbound] inherited complete active date for same-day reference", {
      leadId: matchedLead.id,
      inheritedDate: contextualSameDayPriorDate,
      resolvedTargetTime: schedulingIntent.targetTime,
      resolvedAllowedWindows: schedulingIntent.allowedWindows,
      temporalGranularity: schedulingIntent.temporalGranularity,
      parsedMessage: message,
    });
  }

  const contextualDayOfMonthFragment =
    extractContextualDayOfMonthFragment(message);

  const contextualOriginalRequestedDate =
    contextualDayOfMonthFragment !== null
      ? resolvePendingOriginalRequestedCalendarDate({
          qualification: matchedLead.qualification,
          timezone: companyTimezone,
        }) ??
        (hasActiveBookingContext && matchedLead.appointment_time
          ? getLocalCalendarDateForIso(
              matchedLead.appointment_time,
              companyTimezone
            )
          : null)
      : null;

  if (
    contextualDayOfMonthFragment !== null &&
    contextualOriginalRequestedDate &&
    schedulingIntent.hasPreference &&
    schedulingIntent.customerSpecifiedDate === true
  ) {
    const inheritedCalendarDate = {
      year: contextualOriginalRequestedDate.year,
      month: contextualOriginalRequestedDate.month,
      day: contextualDayOfMonthFragment,
    };

    if (isValidCalendarDateParts(inheritedCalendarDate)) {
      const semanticWindowShouldRemainWindow =
        schedulingIntent.temporalGranularity === "window" &&
        Array.isArray(schedulingIntent.allowedWindows) &&
        schedulingIntent.allowedWindows.length > 0;

      if (semanticWindowShouldRemainWindow) {
        const rebasedAllowedWindows = schedulingIntent.allowedWindows
          .map((window: any) =>
            rebaseTemporalWindowToCalendarDate({
              window,
              targetDate: inheritedCalendarDate,
              timezone: companyTimezone,
            })
          )
          .filter(Boolean) as Array<{
            startTime: string;
            endTime: string | null;
          }>;

        const originalExcludedWindows = Array.isArray(
          schedulingIntent.excludedWindows
        )
          ? schedulingIntent.excludedWindows
          : [];
        const rebasedExcludedWindows = originalExcludedWindows
          .map((window: any) =>
            rebaseTemporalWindowToCalendarDate({
              window,
              targetDate: inheritedCalendarDate,
              timezone: companyTimezone,
            })
          )
          .filter(Boolean) as Array<{
            startTime: string;
            endTime: string | null;
          }>;

        if (
          rebasedAllowedWindows.length ===
            schedulingIntent.allowedWindows.length &&
          rebasedExcludedWindows.length === originalExcludedWindows.length
        ) {
          const firstWindow = rebasedAllowedWindows[0]!;

          schedulingIntent = {
            ...schedulingIntent,
            allowedWindows: rebasedAllowedWindows,
            excludedWindows: rebasedExcludedWindows,
            targetTime: null,
            temporalGranularity: "window",
            customerSpecifiedDate: true,
            customerSpecifiedTime: true,
            localDateTime: null,
            displayPreference:
              formatCustomerRequestedPeriod({
                startTime: firstWindow.startTime,
                endTime: firstWindow.endTime,
                timezone: companyTimezone,
              }) ?? schedulingIntent.displayPreference,
            interpretation:
              "Monthless day-of-month correction preserved the active requested month/year while retaining the customer's semantic time window.",
          };
        }
      } else if (schedulingIntent.customerSpecifiedTime === true) {
        const groundedClock = hasGroundedClockEvidence(message)
          ? extractRequestedTimeParts(message)
          : null;

        const hour =
          groundedClock?.hour ?? schedulingIntent.localDateTime?.hour ?? 0;
        const minute =
          groundedClock?.minute ?? schedulingIntent.localDateTime?.minute ?? 0;

        const inheritedStartTime = zonedTimeToUtc({
          ...inheritedCalendarDate,
          hour,
          minute,
          timezone: companyTimezone,
        });

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: [
            {
              startTime: inheritedStartTime,
              endTime: null,
            },
          ],
          targetTime: inheritedStartTime,
          selectionMode: "closest",
          temporalGranularity: "date_time",
          customerSpecifiedDate: true,
          customerSpecifiedTime: true,
          localDateTime: {
            ...inheritedCalendarDate,
            hour,
            minute,
          },
          displayPreference:
            formatCustomerRequestedPeriod({
              startTime: inheritedStartTime,
              endTime: null,
              timezone: companyTimezone,
            }) ?? schedulingIntent.displayPreference,
          interpretation:
            "Monthless day-of-month correction preserved the active requested month/year context.",
        };
      } else {
        const inheritedStartTime = zonedTimeToUtc({
          ...inheritedCalendarDate,
          hour: 0,
          minute: 0,
          timezone: companyTimezone,
        });
        const nextDate = addDaysToLocalDate({
          ...inheritedCalendarDate,
          days: 1,
        });
        const inheritedEndTime = zonedTimeToUtc({
          ...nextDate,
          hour: 0,
          minute: 0,
          timezone: companyTimezone,
        });

        schedulingIntent = {
          ...schedulingIntent,
          allowedWindows: [
            {
              startTime: inheritedStartTime,
              endTime: inheritedEndTime,
            },
          ],
          targetTime: null,
          selectionMode: "earliest",
          temporalGranularity: "date_only",
          customerSpecifiedDate: true,
          customerSpecifiedTime: false,
          localDateTime: null,
          displayPreference:
            formatCustomerRequestedPeriod({
              startTime: inheritedStartTime,
              endTime: inheritedEndTime,
              timezone: companyTimezone,
            }) ?? schedulingIntent.displayPreference,
          interpretation:
            "Monthless day-of-month correction preserved the active requested month/year context.",
        };
      }

      console.log("[inbound] inherited active month/year for day-of-month correction", {
        leadId: matchedLead.id,
        contextualDayOfMonthFragment,
        originalRequestedDate: contextualOriginalRequestedDate,
        resolvedTargetTime: schedulingIntent.targetTime,
        resolvedLocalDateTime: schedulingIntent.localDateTime,
        parsedMessage: message,
      });
    }
  }

  /*
   * QUALIFIED OFFER SELECTION: option identity + fresh year override.
   *
   * A customer may select a concrete persisted option while simultaneously
   * changing its calendar year (for example, the semantic equivalent of
   * "that option, but in the customer-specified future year"). In that case
   * the old offered instant is only a REFERENCE TEMPLATE for month/day/clock;
   * it is no longer an exact trusted offer and must never bypass availability.
   *
   * This is intentionally driven by semantic state, not phrase matching:
   *   - canonical WHAT must be select_offer
   *   - an exact pending option must have been resolved
   *   - the newest scheduling interpretation must carry explicit relative or
   *     absolute year semantics
   *   - that newest interpretation must resolve to a concrete target year
   *
   * The selected slot is shifted by LOCAL calendar years so DST/local clock
   * semantics remain intact. Then pending-slot authority is revoked and the
   * derived instant flows through the ordinary realtime availability path.
   */
  const selectedOfferHasFreshYearOverride =
    bookingCommand.kind === "select_offer" &&
    pendingSlotMatch.matched &&
    Boolean(pendingSlotMatch.startTime) &&
    newestMessageHasExplicitYearSemantics &&
    Number.isInteger(resolvedYearFromNewestMessage);

  if (selectedOfferHasFreshYearOverride && pendingSlotMatch.startTime) {
    const selectedOfferLocalDate = getLocalCalendarDateForIso(
      pendingSlotMatch.startTime,
      companyTimezone
    );
    const selectedOfferLocalClock = getLocalClockForIso(
      pendingSlotMatch.startTime,
      companyTimezone
    );
    const targetYear = resolvedYearFromNewestMessage as number;

    if (
      selectedOfferLocalDate &&
      selectedOfferLocalClock &&
      selectedOfferLocalDate.year !== targetYear
    ) {
      const yearDelta = targetYear - selectedOfferLocalDate.year;
      const rebasedStartTime = shiftIsoByLocalCalendarYears({
        iso: pendingSlotMatch.startTime,
        years: yearDelta,
        timezone: companyTimezone,
      });

      if (rebasedStartTime) {
        const rebasedLocalDate = getLocalCalendarDateForIso(
          rebasedStartTime,
          companyTimezone
        );
        const rebasedLocalClock = getLocalClockForIso(
          rebasedStartTime,
          companyTimezone
        );

        if (rebasedLocalDate && rebasedLocalClock) {
          schedulingIntent = {
            ...schedulingIntent,
            hasPreference: true,
            allowedWindows: [{ startTime: rebasedStartTime, endTime: null }],
            excludedWindows: [],
            targetTime: rebasedStartTime,
            selectionMode: "closest",
            temporalGranularity: "date_time",
            customerSpecifiedDate: true,
            customerSpecifiedTime: true,
            localDateTime: {
              ...rebasedLocalDate,
              hour: rebasedLocalClock.hour,
              minute: rebasedLocalClock.minute,
            },
            confidence: Math.max(Number(schedulingIntent.confidence ?? 0), 0.95),
            interpretation:
              "Customer selected a persisted option while explicitly changing its calendar year; the option supplied month/day/clock context and the fresh year override produced a new availability-checked request.",
          };

          pendingSlotMatch = {
            matched: false,
            startTime: null,
            endTime: null,
            reason: "selected_option_rebased_by_fresh_year_override",
            confidence: "high",
          };

          console.log("[inbound] rebased selected option by fresh year override", {
            leadId: matchedLead.id,
            originalOfferedStartTime: pendingAlternativesAtReply[
              Math.max(0, (bookingCommand.selectedOptionNumber ?? 1) - 1)
            ]?.startTime ?? null,
            originalLocalYear: selectedOfferLocalDate.year,
            targetYear,
            rebasedStartTime,
            parsedMessage: message,
          });
        }
      } else {
        /*
         * Never fall back to booking the stale exact offer if the requested
         * local-calendar year projection is invalid (for example, an invalid
         * leap-day projection). Fail closed and let downstream clarification /
         * availability handling resolve the request safely.
         */
        pendingSlotMatch = {
          matched: false,
          startTime: null,
          endTime: null,
          reason: "fresh_year_override_could_not_rebase_selected_option",
          confidence: "medium",
        };
      }
    }
  }

  /*
   * SELECTED OFFER + SAME-YEAR FLEXIBLE YEAR WINDOW RECOVERY
   *
   * By this point the scheduling pipeline has finished its year-context
   * enrichment and resolvedYearFromNewestMessage is authoritative semantic
   * WHEN evidence for the newest turn. A selected offer can therefore no longer
   * win merely because the booking WHAT model forgot to copy that fresh year
   * meaning into hasFreshTemporalConstraint.
   *
   * This branch is intentionally narrow and semantic:
   *   - WHAT is select_offer;
   *   - one authoritative pending offer is still matched;
   *   - the newest turn resolved an explicit relative/absolute year;
   *   - the earlier exact-year rebase did not already supersede the pending
   *     offer (if it had, pendingSlotMatch would already be unmatched); and
   *   - the existing placement arbiter confirms that exact placement inside
   *     that year is intentionally flexible.
   *
   * No customer phrase/slang catalog is used here. Exact/specific date-time
   * requests remain untouched because the placement arbiter will classify them
   * as specific rather than flexible.
   */
  const selectedOfferHasResolvedYearScope =
    bookingCommand.kind === "select_offer" &&
    bookingCommand.selectedOptionNumber !== null &&
    (schedulingIntent.yearReference === "relative" ||
      schedulingIntent.yearReference === "absolute") &&
    Number.isInteger(resolvedYearFromNewestMessage);

  const selectedOfferExistingResolvedWindow =
    selectedOfferHasResolvedYearScope
      ? getSingleBoundedSchedulingWindow(schedulingIntent)
      : null;

  const selectedOfferExistingWindowSupersedesPendingOffer =
    selectedOfferHasResolvedYearScope &&
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    Boolean(selectedOfferExistingResolvedWindow) &&
    !schedulingIntent.targetTime &&
    schedulingIntent.customerSpecifiedTime !== true &&
    !schedulingIntent.localDateTime;

  const selectedOfferNeedsFlexibleYearWindowRecovery =
    selectedOfferHasResolvedYearScope &&
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    !selectedOfferExistingResolvedWindow;

  let selectedOfferYearScopeRecoveredAsBroad = false;

  /*
   * If semantic scheduling has ALREADY produced one bounded year-scoped window,
   * that is fresh WHEN meaning. The persisted option remains the offer anchor,
   * but its old exact instant can no longer own the turn. This is the mirror
   * case of the recovery block below, which constructs the window only when
   * the scheduler did not already provide one.
   *
   * Exact replacements remain untouched: any targetTime, customer clock, or
   * concrete localDateTime prevents this path.
   */
  if (selectedOfferExistingWindowSupersedesPendingOffer) {
    contextualAvailabilityIntent = {
      ...contextualAvailabilityIntent,
      hasFreshTemporalConstraint: true,
    };
    selectedOfferYearScopeRecoveredAsBroad = true;
    pendingSlotMatch = {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "selected_offer_existing_year_window_overrides_stale_offer",
      confidence: "high",
    };

    console.log(
      "[inbound] existing selected-offer year window overrode stale exact offer",
      {
        leadId: matchedLead.id,
        selectedOptionNumber: bookingCommand.selectedOptionNumber,
        resolvedYear: resolvedYearFromNewestMessage,
        requestedStartTime: selectedOfferExistingResolvedWindow?.startTime ?? null,
        requestedEndTime: selectedOfferExistingResolvedWindow?.endTime ?? null,
        parsedMessage: message,
      }
    );
  }

  if (selectedOfferNeedsFlexibleYearWindowRecovery) {
    const targetYear = resolvedYearFromNewestMessage as number;
    const yearStartTime = zonedTimeToUtc({
      year: targetYear,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      timezone: companyTimezone,
    });
    const nextYearStartTime = zonedTimeToUtc({
      year: targetYear + 1,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      timezone: companyTimezone,
    });
    const messageReferenceMs = messageSchedulingReferenceTime
      ? new Date(messageSchedulingReferenceTime).getTime()
      : Number.NaN;
    const yearStartMs = new Date(yearStartTime).getTime();
    const effectiveStartMs =
      targetYear === localNow.year && Number.isFinite(messageReferenceMs)
        ? Math.max(yearStartMs, messageReferenceMs)
        : yearStartMs;

    if (
      Number.isFinite(effectiveStartMs) &&
      new Date(nextYearStartTime).getTime() > effectiveStartMs
    ) {
      const recoveredYearWindowIntent: typeof schedulingIntent = {
        ...schedulingIntent,
        hasPreference: true,
        allowedWindows: [
          {
            startTime: new Date(effectiveStartMs).toISOString(),
            endTime: nextYearStartTime,
          },
        ],
        excludedWindows: [],
        targetTime: null,
        selectionMode: "earliest",
        temporalGranularity: "window",
        customerSpecifiedDate: true,
        customerSpecifiedTime: false,
        localDateTime: null,
        confidence: Math.max(Number(schedulingIntent.confidence ?? 0), 0.9),
        interpretation:
          "Explicit semantic year scope recovered after year-context enrichment; exact placement remains subject to semantic placement arbitration.",
      };

      /*
       * If the newest semantic scheduling result contains ONLY a year scope —
       * no exact target, no customer clock, no local date/time, and no narrower
       * allowed/excluded window — then exact placement inside that year is
       * structurally unresolved. The persisted option identifies WHICH offer is
       * being transformed; it must not be misread as a specific placement inside
       * the new year window.
       *
       * This avoids a second model judgment overturning already-resolved WHEN
       * structure. More-specific turns (month/day/clock/sub-window) still use the
       * existing placement arbiter and therefore remain untouched.
       */
      const originalAllowedWindows = Array.isArray(schedulingIntent.allowedWindows)
        ? schedulingIntent.allowedWindows
        : [];
      const originalExcludedWindows = Array.isArray(schedulingIntent.excludedWindows)
        ? schedulingIntent.excludedWindows
        : [];
      const yearScopeIsStructurallyBroad =
        !schedulingIntent.targetTime &&
        schedulingIntent.customerSpecifiedTime !== true &&
        !schedulingIntent.localDateTime &&
        originalAllowedWindows.length === 0 &&
        originalExcludedWindows.length === 0;

      const recoveredPlacement = yearScopeIsStructurallyBroad
        ? {
            referencesPersistedOffer: true,
            referencedOptionNumber: bookingCommand.selectedOptionNumber,
            placementMode: "flexible_within_window" as const,
          }
        : await resolveSelectedOfferPlacementContext({
            message,
            schedulingIntent: recoveredYearWindowIntent,
            pendingAlternatives: pendingAlternativesAtReply,
          });

      if (
        recoveredPlacement?.referencesPersistedOffer === true &&
        recoveredPlacement.referencedOptionNumber ===
          bookingCommand.selectedOptionNumber &&
        recoveredPlacement.placementMode === "flexible_within_window"
      ) {
        schedulingIntent = recoveredYearWindowIntent;
        contextualAvailabilityIntent = {
          ...contextualAvailabilityIntent,
          hasFreshTemporalConstraint: true,
        };
        selectedOfferYearScopeRecoveredAsBroad =
          yearScopeIsStructurallyBroad;
        pendingSlotMatch = {
          matched: false,
          startTime: null,
          endTime: null,
          reason: "selected_offer_flexible_year_scope_after_year_enrichment",
          confidence: "high",
        };

        console.log(
          "[inbound] recovered flexible selected-offer year window after year enrichment",
          {
            leadId: matchedLead.id,
            selectedOptionNumber: bookingCommand.selectedOptionNumber,
            resolvedYear: targetYear,
            requestedStartTime:
              recoveredYearWindowIntent.allowedWindows[0]?.startTime ?? null,
            requestedEndTime:
              recoveredYearWindowIntent.allowedWindows[0]?.endTime ?? null,
            placementMode: recoveredPlacement.placementMode,
            parsedMessage: message,
          }
        );
      }
    }
  }

  const originalSchedulingIntent = semanticSchedulingIntent;
  const temporalEvidenceMessage = getBookingReplyTemporalEvidenceText({
    message,
    phone: matchedLead.phone,
    address: matchedLead.address,
  });
  const groundedTemporalSurfaceEvidence =
    hasGroundedTemporalSurfaceEvidence(temporalEvidenceMessage);

  const contextualPendingOptionOwnsTurn =
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    pendingSlotMatch.reason === "matched_contextual_weekday_option_reference" &&
    !hasGroundedClockEvidence(temporalEvidenceMessage);

  /*
   * Generic offered-slot context precedence.
   *
   * If the customer's newest words uniquely matched an active offered slot,
   * do not throw that context away merely because the semantic scheduler also
   * produced a date/time interpretation.
   *
   * The offered slot owns the turn ONLY when every grounded surface constraint
   * in the message is compatible with that exact slot. This means:
   *
   *   offered Oct 23 8:30 + "8:30"             -> offered slot owns
   *   offered Oct 23 8:30 + "23 8:30"          -> offered slot owns
   *   offered Oct 23 8:30 + "October 23 8:30"  -> offered slot owns
   *   offered Oct 23 8:30 + "October 26 8:30"  -> fresh request wins
   *   offered Oct 23 8:30 + "Friday at 9"      -> fresh request wins
   *
   * This is contextual arbitration only. It does not change availability,
   * Calendar mutation, cancellation, rescheduling, or temporal parsing.
   */
  const compatiblePendingOfferedSlotOwnsTurn =
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    Boolean(pendingSlotMatch.startTime) &&
    pendingOfferedSlotReferenceMatchesMessage({
      message: temporalEvidenceMessage,
      slotStart: pendingSlotMatch.startTime as string,
      timezone: companyTimezone,
    });

  /*
   * Absolute context-safety invariant: a pending offered slot may not survive
   * a contradiction with literal customer temporal surface merely because the
   * semantic scheduling resolver failed closed.
   */
  const pendingMatchConflictsWithLiteralTemporalSurface =
    pendingSlotMatch.matched &&
    Boolean(pendingSlotMatch.startTime) &&
    groundedTemporalSurfaceEvidence &&
    !pendingOfferedSlotReferenceMatchesMessage({
      message: temporalEvidenceMessage,
      slotStart: pendingSlotMatch.startTime as string,
      timezone: companyTimezone,
    });

  /*
   * From this point forward these are CANDIDATES only. No temporal candidate
   * is allowed to mutate booking behavior until the canonical temporal gate
   * below chooses one final result.
   */
  const groundedTimeOnlyEvidence =
    hasGroundedClockEvidence(temporalEvidenceMessage) ||
    ((!pendingSlotMatch.matched ||
      pendingMatchConflictsWithLiteralTemporalSurface) &&
      hasBareClockCandidate(temporalEvidenceMessage));

  const groundedDateEvidenceForTimeOnlyArbitration =
    hasGroundedDateEvidence(temporalEvidenceMessage);

  const groundedTimeOnlyClock = extractRequestedTimeParts(temporalEvidenceMessage);

  const resolvedTimeOnlyClock = (() => {
    if (schedulingIntent.localDateTime) {
      return {
        hour: schedulingIntent.localDateTime.hour,
        minute: schedulingIntent.localDateTime.minute,
      };
    }

    if (!groundedTimeOnlyClock) return null;

    if (groundedTimeOnlyClock.hasMeridian) {
      return {
        hour: groundedTimeOnlyClock.hour,
        minute: groundedTimeOnlyClock.minute,
      };
    }

    const referenceClock = getContextualPendingClockReference({
      qualification: matchedLead.qualification,
      alternatives: pendingAlternativesAtReply,
      timezone: companyTimezone,
    });

    if (!referenceClock) {
      return {
        hour: groundedTimeOnlyClock.hour,
        minute: groundedTimeOnlyClock.minute,
      };
    }

    const base = groundedTimeOnlyClock.rawHour % 12;
    const amHour = base;
    const pmHour = base + 12;
    const requestedMinute = groundedTimeOnlyClock.minute;
    const referenceMinutes = referenceClock.hour * 60 + referenceClock.minute;
    const amDistance = Math.abs(
      referenceMinutes - (amHour * 60 + requestedMinute)
    );
    const pmDistance = Math.abs(
      referenceMinutes - (pmHour * 60 + requestedMinute)
    );

    const hour =
      amDistance < pmDistance
        ? amHour
        : pmDistance < amDistance
          ? pmHour
          : referenceClock.hour >= 12
            ? pmHour
            : amHour;

    return { hour, minute: requestedMinute };
  })();

  /*
   * CANONICAL TEMPORAL GATE
   *
   * Candidate producers above may parse semantics, offered-slot references,
   * relative clocks, same-day/date context, year context, or shorthand clocks.
   * This is the ONLY arbitration boundary allowed to choose the final temporal
   * meaning that downstream booking/availability code consumes.
   *
   * It does not answer company questions, use realtime/web data, authorize a
   * booking mutation, or query Calendar availability.
   */
  const originalRequestedDate =
    resolvePendingOriginalRequestedCalendarDate({
      qualification: matchedLead.qualification,
      timezone: companyTimezone,
    });

  const offeredFallbackDate =
    originalRequestedDate === null
      ? resolveUnambiguousPendingCalendarDate({
          alternatives: pendingAlternativesAtReply,
          timezone: companyTimezone,
        })
      : null;

  const legacyFallbackWindowCandidate = forceExtractBookingWindow(
    message,
    companyTimezone,
    schedulingReferenceTime
  );

  const canonicalTemporalIntent = resolveCanonicalTemporalIntent({
    message: temporalEvidenceMessage,
    originalSchedulingIntent,
    enrichedSchedulingIntent: availabilityTimeRefinement
      ? inheritOfferedDateForTimeWindow({ intent: schedulingIntent, alternatives: pendingSlotsForAvailabilityRouting, timezone: companyTimezone })
      : schedulingIntent,
    pendingSlotCandidate: pendingSlotMatch,
    pendingAlternatives: pendingAlternativesAtReply,
    pendingMatchConflictsWithLiteralTemporalSurface,
    groundedTemporalSurfaceEvidence,
    contextualPendingOptionOwnsTurn,
    compatiblePendingOfferedSlotOwnsTurn,
    groundedTimeOnlyEvidence,
    groundedDateEvidenceForTimeOnlyArbitration,
    resolvedTimeOnlyClock,
    originalRequestedDate,
    offeredFallbackDate,
    bookingCommandKind: bookingCommand.kind,
    bookingCommandHasFreshTemporalConstraint:
      contextualAvailabilityIntent.hasFreshTemporalConstraint,
    storedSchedulingContext,
    activeAppointmentTime:
      hasActiveBookingContext && matchedLead.appointment_time
        ? matchedLead.appointment_time
        : null,
    legacyFallbackWindow: legacyFallbackWindowCandidate,
    timezone: companyTimezone,
    /*
     * "from now" / "in N minutes" must anchor to the actual inbound-message
     * reference instant, not the special booked-reschedule date anchor used by
     * weekday/date interpretation.
     */
    referenceTime: messageSchedulingReferenceTime,
  });

  schedulingIntent = canonicalTemporalIntent.schedulingIntent;
  pendingSlotMatch = canonicalTemporalIntent.pendingSlotMatch;

  const pendingConfirmationOwnsTurn =
    canonicalTemporalIntent.pendingConfirmationOwnsTurn;
  const hasCompleteFreshTemporalOverride =
    canonicalTemporalIntent.hasCompleteFreshTemporalOverride;
  const isTimeOnlySchedulingPreference =
    canonicalTemporalIntent.isTimeOnlySchedulingPreference;
  const forcedBookingWindow =
    canonicalTemporalIntent.forcedBookingWindow;
  const unresolvedTimeOnlyPreference =
    canonicalTemporalIntent.unresolvedTimeOnlyPreference;

  console.log("[inbound] canonical temporal intent finalized", {
    leadId: matchedLead.id,
    source: canonicalTemporalIntent.source,
    reasons: canonicalTemporalIntent.reasons,
    pendingMatchReason: pendingSlotMatch.reason,
    pendingMatched: pendingSlotMatch.matched,
    targetTime: schedulingIntent.targetTime,
    temporalGranularity: schedulingIntent.temporalGranularity,
    customerSpecifiedDate: schedulingIntent.customerSpecifiedDate,
    customerSpecifiedTime: schedulingIntent.customerSpecifiedTime,
    parsedMessage: message,
  });

  console.log("[inbound] scheduling intent resolved", {
    leadId: matchedLead.id,
    hasPreference: schedulingIntent.hasPreference,
    allowedWindows: schedulingIntent.allowedWindows,
    excludedWindows: schedulingIntent.excludedWindows,
    selectionMode: schedulingIntent.selectionMode,
    targetTime: schedulingIntent.targetTime,
    strict: schedulingIntent.strict,
    temporalGranularity: schedulingIntent.temporalGranularity,
    customerSpecifiedDate: schedulingIntent.customerSpecifiedDate,
    customerSpecifiedTime: schedulingIntent.customerSpecifiedTime,
    yearWasExplicit: schedulingIntent.yearWasExplicit,
    yearReference: schedulingIntent.yearReference,
    activeSchedulingYearContext: getActiveSchedulingYearContext(matchedLead.qualification),
    localDateTime: schedulingIntent.localDateTime,
    displayPreference: schedulingIntent.displayPreference,
    originalPreference: schedulingIntent.originalPreference,
    confidence: schedulingIntent.confidence,
  });

  /*
   * SELECTED OFFER + FLEXIBLE FRESH TEMPORAL WINDOW
   *
   * Canonical temporal intent still owns WHEN and bookingCommand still owns WHAT.
   * This branch adds no date grammar and no mutation authority. It runs only when
   * canonical arbitration says a fresh temporal request superseded the old offers,
   * the canonical result is one bounded window with no exact target/clock, and a
   * semantic context-only resolver confirms BOTH that the customer referenced one
   * persisted offer and intentionally left exact placement inside the new window
   * flexible. If semantic context is unavailable or unclear, the existing pipeline
   * below remains untouched.
   */
  const selectedOfferFlexibleWindow =
    hasCompleteFreshTemporalOverride === true
      ? getSingleBoundedSchedulingWindow(schedulingIntent)
      : null;

  const selectedOfferPlacementContext = selectedOfferFlexibleWindow
    ? selectedOfferYearScopeRecoveredAsBroad &&
      bookingCommand.kind === "select_offer" &&
      bookingCommand.selectedOptionNumber !== null
      ? {
          referencesPersistedOffer: true,
          referencedOptionNumber: bookingCommand.selectedOptionNumber,
          placementMode: "flexible_within_window" as const,
        }
      : await resolveSelectedOfferPlacementContext({
          message,
          schedulingIntent,
          pendingAlternatives: pendingAlternativesAtReply,
        })
    : null;

  const flexibleSelectedOfferOptionNumber =
    selectedOfferPlacementContext?.referencesPersistedOffer === true &&
    selectedOfferPlacementContext.placementMode === "flexible_within_window"
      ? selectedOfferPlacementContext.referencedOptionNumber
      : null;

  if (
    selectedOfferFlexibleWindow &&
    flexibleSelectedOfferOptionNumber !== null
  ) {
    matchedLead.qualification = {
      ...(matchedLead.qualification ?? {}),
      schedulingIntent,
    };

    const desiredOptionCount = getCleanAlternativeSlots(
      pendingAlternativesAtReply
    ).length;

    let clarificationOptions: AlternativeSlot[] = [];
    let clarificationAvailabilityLookupFailed = false;

    try {
      clarificationOptions = await suggestRepresentativeVerifiedSlotsAcrossWindow({
        companyId: input.companyId,
        requestedStartTime: selectedOfferFlexibleWindow.startTime,
        requestedEndTime: selectedOfferFlexibleWindow.endTime,
        timezone: companyTimezone,
        previouslyOffered: pendingAlternativesAtReply,
        desiredCount: desiredOptionCount,
      });
    } catch (error: any) {
      clarificationAvailabilityLookupFailed = true;
      console.error(
        "[inbound] flexible selected-offer representative availability lookup failed",
        {
          leadId: matchedLead.id,
          requestedStartTime: selectedOfferFlexibleWindow.startTime,
          requestedEndTime: selectedOfferFlexibleWindow.endTime,
          selectedOptionNumber: flexibleSelectedOfferOptionNumber,
          error: error?.message ?? error,
          parsedMessage: message,
        }
      );
    }

    const cleanClarificationOptions = getCleanAlternativeSlots(
      clarificationOptions
    );
    const selectedOptionLabel = `option ${flexibleSelectedOfferOptionNumber}`;

    console.log("[inbound] selected offer has flexible fresh temporal window", {
      leadId: matchedLead.id,
      selectedOptionNumber: flexibleSelectedOfferOptionNumber,
      requestedStartTime: selectedOfferFlexibleWindow.startTime,
      requestedEndTime: selectedOfferFlexibleWindow.endTime,
      optionCount: cleanClarificationOptions.length,
      availabilityLookupFailed: clarificationAvailabilityLookupFailed,
      placementMode: selectedOfferPlacementContext?.placementMode ?? null,
      parsedMessage: message,
    });

    if (cleanClarificationOptions.length > 0) {
      return sendRequestedWindowOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: cleanClarificationOptions,
        originalRequestedStartTime: selectedOfferFlexibleWindow.startTime,
        originalRequestedEndTime: selectedOfferFlexibleWindow.endTime,
        schedulingPreferenceText:
          schedulingIntent.displayPreference ??
          schedulingIntent.originalPreference ??
          null,
        suggestionReason:
          "selected_offer_with_flexible_temporal_window_requires_choice",
        introOverride:
          `You picked ${selectedOptionLabel}, and your timing is flexible within the new window. I don't want to guess a specific appointment. Here are a few real openings from within that window:`,
        closingPromptOverride:
          "Which one works best? If none do, give me any narrower date or time preference and I'll check again. Nothing has been booked yet.",
        resultReason:
          "selected_offer_flexible_temporal_window_options_sent",
      });
    }

    /*
     * No real candidate was found for the flexible-window display. Supersede the
     * stale offer so a later reply cannot accidentally confirm the old exact slot.
     */
    matchedLead.qualification = {
      ...(matchedLead.qualification ?? {}),
      pendingSlotSuggestion: {
        ...((matchedLead.qualification ?? {}).pendingSlotSuggestion ?? {}),
        status: "superseded",
        supersededAt: new Date().toISOString(),
        supersededByReply: message,
        supersededReason:
          "selected_offer_with_flexible_temporal_window_requires_choice",
      },
    };

    await storePendingSchedulingState({
      companyId: input.companyId,
      lead: matchedLead,
      qualification: matchedLead.qualification,
      updates,
    });

    if (input.fromEmail) {
      const requestedText =
        formatCustomerRequestedPeriod({
          startTime: selectedOfferFlexibleWindow.startTime,
          endTime: selectedOfferFlexibleWindow.endTime,
          timezone: companyTimezone,
        }) ||
        schedulingIntent.displayPreference ||
        schedulingIntent.originalPreference ||
        "the requested window";

      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: [
          `You picked ${selectedOptionLabel}, and your timing is flexible within ${requestedText}, but I couldn't find a real opening to offer from that window right now.`,
          "",
          "Give me any narrower date or time preference and I'll check again. Nothing has been booked yet.",
        ].join("\n"),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
      processingError: clarificationAvailabilityLookupFailed
        ? "flexible_temporal_window_availability_lookup_failed"
        : null,
    });

    return {
      success: true,
      processed: true,
      booked: false,
      clarificationRequested: true,
      reason: "selected_offer_flexible_temporal_window_requires_choice",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
      companyTimezone,
      parsedMessage: message,
      alternatives: [],
    };
  }


  /*
   * READ-ONLY OPEN-ENDED AVAILABILITY INSIDE THE BOOKING PIPELINE
   *
   * Once the information/prospect lane promotes a customer for asking to see
   * appointment options, this pipeline owns the turn even when the customer
   * supplied no date/time constraint. Show canonical real slots, persist those
   * exact slots as pending options, and keep appointment/calendar truth null
   * until the customer explicitly selects or authorizes one.
   */
  const openEndedReadOnlyAvailabilityInquiry =
    !storedSchedulingContext &&
    contextualAvailabilityIntent?.decision === "availability_inquiry" &&
    contextualAvailabilityIntent.confidence >= 0.7 &&
    !hasGroundedTemporalSurfaceEvidence(message) &&
    !pendingSlotMatch.matched;

  if (openEndedReadOnlyAvailabilityInquiry) {
    const availabilitySearchAnchor =
      schedulingReferenceTime ??
      (input.receivedAt &&
      !Number.isNaN(new Date(input.receivedAt).getTime())
        ? new Date(input.receivedAt).toISOString()
        : inboundEmail.created_at &&
            !Number.isNaN(new Date(inboundEmail.created_at).getTime())
          ? new Date(inboundEmail.created_at).toISOString()
          : new Date().toISOString());

    let availabilityOptions: AlternativeSlot[] = [];

    try {
      availabilityOptions = await suggestCadenceAlignedAlternativeSlots({
        companyId: input.companyId,
        requestedStartTime: availabilitySearchAnchor,
        timezone: companyTimezone,
      });
    } catch (error: any) {
      console.error("[inbound] open-ended read-only availability lookup failed", {
        leadId: matchedLead.id,
        availabilitySearchAnchor,
        semanticDecision: contextualAvailabilityIntent?.decision ?? null,
        semanticConfidence: contextualAvailabilityIntent?.confidence ?? null,
        error: error?.message ?? error,
        parsedMessage: message,
      });
    }

    const cleanAvailabilityOptions =
      getCleanAlternativeSlots(availabilityOptions).slice(0, 3);

    console.log("[inbound] open-ended read-only availability inquiry", {
      leadId: matchedLead.id,
      availabilitySearchAnchor,
      optionCount: cleanAvailabilityOptions.length,
      semanticDecision: contextualAvailabilityIntent?.decision ?? null,
      semanticConfidence: contextualAvailabilityIntent?.confidence ?? null,
      parsedMessage: message,
    });

    if (cleanAvailabilityOptions.length > 0) {
      return sendRequestedWindowOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: cleanAvailabilityOptions,
        originalRequestedStartTime: availabilitySearchAnchor,
        originalRequestedEndTime: null,
        schedulingPreferenceText: null,
        readOnlyAvailabilityInquiry: true,
        genericReadOnlyAvailabilityInquiry: true,
        mixedInformationAnswer: mixedBookedInformationAnswerBody,
      });
    }

    if (input.fromEmail) {
      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: [
          "I don't see a confirmed opening in the current availability window right now.",
          "",
          "Tell me a day or time that works for you and I'll check the real openings.",
        ].join("\n"),
        isFollowUp: false,
      });
    }

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    return {
      success: true,
      processed: true,
      booked: false,
      reason: "open_ended_read_only_availability_no_matches",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
      companyTimezone,
      parsedMessage: message,
      alternatives: [],
    };
  }

  /*
   * READ-ONLY AVAILABILITY WITH A FRESH TEMPORAL CONSTRAINT
   *
   * Critical mutation boundary:
   *   "what do you have Saturday?"  -> show Saturday openings; DO NOT book
   *   "book me Saturday"           -> normal booking pipeline
   *
   * A date/time answers WHEN to search. It does not, by itself, authorize a
   * booking mutation. The semantic intent resolver owns that distinction.
   */
  const freshTemporalAvailabilityInquiry =
    contextualAvailabilityIntent?.decision === "availability_inquiry" &&
    contextualAvailabilityIntent.confidence >= 0.7 &&
    !messageConfirmsBooking(message) &&
    (
      hasGroundedTemporalSurfaceEvidence(message) ||
      Boolean(contextualBareClockCandidate)
    ) &&
    schedulingIntent.hasPreference &&
    !pendingSlotMatch.matched;

  if (freshTemporalAvailabilityInquiry) {
    const rawSearchWindows =
      Array.isArray(schedulingIntent.allowedWindows) &&
      schedulingIntent.allowedWindows.length > 0
        ? schedulingIntent.allowedWindows
        : schedulingIntent.targetTime
          ? [
              {
                startTime: schedulingIntent.targetTime,
                endTime: null,
              },
            ]
          : [];

    /*
     * READ-ONLY SAME-LOCAL-DAY WINDOW FIREWALL
     *
     * A time-of-day/daypart-style availability request with no customer-supplied
     * date is scoped to the local calendar day used to anchor that request. An
     * open-ended semantic window must not silently expand into tomorrow merely
     * because the availability engine can continue searching indefinitely.
     *
     * This is shape-based, not phrase-based. Explicit date/range requests and
     * exact target times are untouched.
     */
    const searchWindows = rawSearchWindows.map((window: any) => {
      if (
        schedulingIntent.temporalGranularity !== "window" ||
        schedulingIntent.customerSpecifiedDate !== false ||
        schedulingIntent.yearReference !== "unspecified" ||
        schedulingIntent.targetTime ||
        window?.endTime ||
        !window?.startTime
      ) {
        return window;
      }

      const localDate = getLocalCalendarDateForIso(
        window.startTime,
        companyTimezone
      );
      if (!localDate) return window;

      const nextLocalDate = addDaysToLocalDate({
        ...localDate,
        days: 1,
      });

      const localDayEnd = zonedTimeToUtc({
        ...nextLocalDate,
        hour: 0,
        minute: 0,
        timezone: companyTimezone,
      });

      if (
        new Date(localDayEnd).getTime() <=
        new Date(window.startTime).getTime()
      ) {
        return window;
      }

      return {
        ...window,
        endTime: localDayEnd,
      };
    });

    if (
      searchWindows.length === schedulingIntent.allowedWindows.length &&
      searchWindows.some(
        (window: any, index: number) =>
          window?.endTime !== schedulingIntent.allowedWindows[index]?.endTime
      )
    ) {
      schedulingIntent = {
        ...schedulingIntent,
        allowedWindows: searchWindows,
        targetTime: null,
      };
    }

    const firstSearchWindow = searchWindows[0] ?? null;
    const requestedStartTime =
      schedulingIntent.targetTime ??
      firstSearchWindow?.startTime ??
      null;
    const requestedEndTime =
      firstSearchWindow?.endTime ?? null;

    if (requestedStartTime) {
      matchedLead.qualification = {
        ...(matchedLead.qualification ?? {}),
        schedulingIntent,
      };

      let availabilityOptions: AlternativeSlot[] = [];
      let availabilityLookupFailed = false;

      try {
        for (const window of searchWindows.length > 0
          ? searchWindows
          : [{ startTime: requestedStartTime, endTime: requestedEndTime }]) {
          if (!window?.startTime) continue;

          const found = await suggestCadenceAlignedAlternativeSlots({
            companyId: input.companyId,
            requestedStartTime: window.startTime,
            requestedEndTime: window.endTime ?? null,
            timezone: companyTimezone,
          });

          availabilityOptions = mergeAlternativeSlots(
            availabilityOptions,
            found
          );

          if (availabilityOptions.length >= 3) break;
        }
      } catch (error: any) {
        availabilityLookupFailed = true;
        console.error("[inbound] read-only temporal availability lookup failed", {
          leadId: matchedLead.id,
          requestedStartTime,
          requestedEndTime,
          semanticDecision: contextualAvailabilityIntent?.decision ?? null,
          semanticConfidence: contextualAvailabilityIntent?.confidence ?? null,
          error: error?.message ?? error,
          parsedMessage: message,
        });
      }

      const cleanAvailabilityOptions =
        getCleanAlternativeSlots(availabilityOptions).slice(0, 3);

      console.log("[inbound] read-only temporal availability inquiry", {
        leadId: matchedLead.id,
        requestedStartTime,
        requestedEndTime,
        optionCount: cleanAvailabilityOptions.length,
        semanticDecision: contextualAvailabilityIntent?.decision ?? null,
        semanticConfidence: contextualAvailabilityIntent?.confidence ?? null,
        parsedMessage: message,
      });

      if (cleanAvailabilityOptions.length > 0) {
        return sendRequestedWindowOptionsAndStorePending({
          companyId: input.companyId,
          lead: matchedLead,
          inboundEmailId: inboundEmail.id,
          inboundUpdates: updates,
          toEmail: input.fromEmail,
          subject: input.subject,
          companyTimezone,
          message,
          alternatives: cleanAvailabilityOptions,
          originalRequestedStartTime: requestedStartTime,
          originalRequestedEndTime: requestedEndTime,
          schedulingPreferenceText:
            schedulingIntent.displayPreference ??
            schedulingIntent.originalPreference ??
            null,
          readOnlyAvailabilityInquiry: true,
        });
      }

      let businessHoursStatus: Awaited<
        ReturnType<typeof getCompanyBusinessHoursStatus>
      > | null = null;

      try {
        businessHoursStatus = await getCompanyBusinessHoursStatus({
          companyId: input.companyId,
          atTime: requestedStartTime,
        });
      } catch (error: any) {
        /*
         * This read is explanatory only. The authoritative availability lookup
         * above already determines whether any real slot can be offered. A
         * company-hours read failure must never manufacture availability.
         */
        console.error("[inbound] company business-hours status lookup failed", {
          leadId: matchedLead.id,
          requestedStartTime,
          error: error?.message ?? error,
          parsedMessage: message,
        });
      }

      return sendReadOnlyAvailabilityNoMatches({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        originalRequestedStartTime: requestedStartTime,
        originalRequestedEndTime: requestedEndTime,
        schedulingIntent,
        availabilityLookupFailed,
        businessHoursStatus,
      });
    }
  }

  /*
   * Keep qualification.schedulingIntent aligned with the newest REAL temporal
   * request. Without this, a successful later booking/reschedule could retain
   * the original historical request and allow stale availability context to
   * reappear in a future turn. Pure option-selection/info turns do not erase
   * the last meaningful scheduling frame.
   */
  if (schedulingIntent.hasPreference) {
    matchedLead.qualification = {
      ...(matchedLead.qualification ?? {}),
      schedulingIntent,
    };
  }

  console.log("[inbound] pending slot resolver result", {
    leadId: matchedLead.id,
    matched: pendingSlotMatch.matched,
    reason: pendingSlotMatch.reason,
    confidence: pendingSlotMatch.confidence,
    startTime: pendingSlotMatch.startTime,
    endTime: pendingSlotMatch.endTime,
    pendingAlternativeCount: pendingAlternativesAtReply.length,
    pendingAlternatives: pendingAlternativesAtReply.map((slot, index) => ({
      index: index + 1,
      startTime: slot.startTime,
      endTime: slot.endTime ?? null,
    })),
    parsedMessage: message,
    normalizedMessage: normalizeSimpleText(message),
  });

  if (
    pendingAlternativesAtReply.length > 0 &&
    !pendingSlotMatch.matched &&
    !forcedBookingWindow.start &&
    messageConfirmsBooking(message)
  ) {
    console.warn("[inbound] active_pending_slot_but_no_option_anchor", {
      leadId: matchedLead.id,
      pendingAlternativeCount: pendingAlternativesAtReply.length,
      parsedMessage: message,
      normalizedMessage: normalizeSimpleText(message),
      resolverReason: pendingSlotMatch.reason,
    });
  }

  if (pendingSlotMatch.matched && pendingSlotMatch.startTime) {
    /*
     * TRANSFORMED SELECTED-OFFER AVAILABILITY PREFLIGHT
     *
     * A persisted offer is authoritative only for the exact instant that was
     * actually verified and shown to the customer. If fresh temporal meaning
     * transforms that offer to a different exact instant (year/month/week/day
     * shift, exact rebase, etc.), the transformed instant is NEW availability
     * state. It must be revalidated before we tell the customer it is selected
     * or persist it behind the booking-requirements gate.
     *
     * Plain selection of an unchanged offered slot does not enter this branch,
     * so the already-live Test 1/Test 2 option-confirmation contract is left
     * untouched. Active-booking reschedules also stay on their existing path.
     */
    const pendingMatchedStart = pendingSlotMatch.startTime;
    const transformedSelectedOfferTarget =
      !hasActiveBookingContext &&
      bookingCommand.kind === "select_offer" &&
      bookingCommand.selectedOptionNumber !== null &&
      !pendingAlternativesAtReply.some((slot) =>
        slotTimesMatchWithinOneMinute(slot.startTime, pendingMatchedStart)
      );

    if (transformedSelectedOfferTarget) {
      const transformedEnd = pendingSlotMatch.endTime ?? null;
      const transformedStartMs = new Date(pendingMatchedStart).getTime();
      const transformedEndMs = transformedEnd
        ? new Date(transformedEnd).getTime()
        : Number.NaN;
      const transformedDurationMinutes =
        Number.isFinite(transformedStartMs) &&
        Number.isFinite(transformedEndMs) &&
        transformedEndMs > transformedStartMs
          ? Math.round((transformedEndMs - transformedStartMs) / 60_000)
          : null;

      let transformedAvailabilityOptions: AlternativeSlot[] = [];
      let transformedAvailabilityLookupFailed = false;

      try {
        transformedAvailabilityOptions = await suggestAlternativeSlots({
          companyId: input.companyId,
          requestedStartTime: pendingMatchedStart,
          ...(transformedDurationMinutes
            ? { durationMinutes: transformedDurationMinutes }
            : {}),
          timezone: companyTimezone,
        });
      } catch (error: any) {
        transformedAvailabilityLookupFailed = true;
        console.error(
          "[inbound] transformed selected-offer availability preflight failed",
          {
            leadId: matchedLead.id,
            selectedOptionNumber: bookingCommand.selectedOptionNumber,
            requestedStartTime: pendingMatchedStart,
            requestedEndTime: transformedEnd,
            error: error?.message ?? error,
            parsedMessage: message,
          }
        );
      }

      if (transformedAvailabilityLookupFailed) {
        return sendReadOnlyAvailabilityNoMatches({
          companyId: input.companyId,
          lead: matchedLead,
          inboundEmailId: inboundEmail.id,
          inboundUpdates: updates,
          toEmail: input.fromEmail,
          subject: input.subject,
          companyTimezone,
          message,
          originalRequestedStartTime: pendingMatchedStart,
          originalRequestedEndTime: transformedEnd,
          schedulingIntent,
          availabilityLookupFailed: true,
        });
      }

      const cleanTransformedAvailabilityOptions = getCleanAlternativeSlots(
        transformedAvailabilityOptions
      );
      const transformedExactSlotIsAvailable =
        cleanTransformedAvailabilityOptions.some((slot) =>
          slotTimesMatchWithinOneMinute(slot.startTime, pendingMatchedStart)
        );

      if (!transformedExactSlotIsAvailable) {
        console.warn(
          "[inbound] transformed selected-offer target rejected before requirements",
          {
            leadId: matchedLead.id,
            selectedOptionNumber: bookingCommand.selectedOptionNumber,
            requestedStartTime: pendingMatchedStart,
            requestedEndTime: transformedEnd,
            verifiedAlternativeCount:
              cleanTransformedAvailabilityOptions.length,
            parsedMessage: message,
          }
        );

        if (cleanTransformedAvailabilityOptions.length === 0) {
          return sendReadOnlyAvailabilityNoMatches({
            companyId: input.companyId,
            lead: matchedLead,
            inboundEmailId: inboundEmail.id,
            inboundUpdates: updates,
            toEmail: input.fromEmail,
            subject: input.subject,
            companyTimezone,
            message,
            originalRequestedStartTime: pendingMatchedStart,
            originalRequestedEndTime: transformedEnd,
            schedulingIntent,
          });
        }

        return sendUnavailableAndStorePending({
          companyId: input.companyId,
          lead: matchedLead,
          inboundEmailId: inboundEmail.id,
          inboundUpdates: updates,
          toEmail: input.fromEmail,
          subject: input.subject,
          companyTimezone,
          message,
          reason: "slot_unavailable",
          alternatives: cleanTransformedAvailabilityOptions.slice(0, 3),
          originalRequestedStartTime: pendingMatchedStart,
          originalRequestedEndTime: transformedEnd,
          schedulingPreferenceText:
            schedulingIntent.displayPreference ??
            schedulingIntent.originalPreference ??
            null,
          mixedInformationAnswer: mixedBookedInformationAnswerBody,
        });
      }

      console.log(
        "[inbound] transformed selected-offer target verified before requirements",
        {
          leadId: matchedLead.id,
          selectedOptionNumber: bookingCommand.selectedOptionNumber,
          requestedStartTime: pendingMatchedStart,
          requestedEndTime: transformedEnd,
          parsedMessage: message,
        }
      );
    }

    if (!hasActiveBookingContext) {
      const bookingRequirementsBlock =
        await requireBookingDetailsBeforeNewAppointment({
          companyId: input.companyId,
          lead: matchedLead,
          inboundEmailId: inboundEmail.id,
          inboundUpdates: updates,
          toEmail: input.fromEmail,
          subject: input.subject,
          timezone: companyTimezone,
          message,
          actionKind: "select_offer",
          requestedStartTime: pendingSlotMatch.startTime,
          requestedEndTime: pendingSlotMatch.endTime,
          selectedOptionNumber: bookingCommand.selectedOptionNumber,
        });

      if (bookingRequirementsBlock) return bookingRequirementsBlock;
    }

    console.log("[inbound] pending slot confirmation matched", {
      leadId: matchedLead.id,
      matchReason: pendingSlotMatch.reason,
      confidence: pendingSlotMatch.confidence,
      startTime: pendingSlotMatch.startTime,
      parsedMessage: message,
    });

    const leadAddress = buildLeadAddress(matchedLead);
    const customerMetadata = resolveCustomerMetadata(matchedLead, input.fromEmail);
    const customerLabel = customerMetadata.customerLabel;

    const calendarSummary = leadAddress
      ? `HVAC Appointment - ${customerLabel} - ${leadAddress}`
      : `HVAC Appointment - ${customerLabel}`;

    const selectedStartTime = pendingSlotMatch.startTime;

    /*
      Hard booking rule:
      When the customer selects an offered option ("first one", "second", "#44", etc.),
      the system must not silently move them to another slot. The selected option is the
      source of truth. We book that exact offered start time with the customer-facing
      service duration. If that exact booking truly cannot be created, we reject and keep
      the lead awaiting customer. We never book a live replacement behind the customer's back.
    */
    const selectedEndTime =
      customerExplicitlyGaveEndTime(message) && pendingSlotMatch.endTime
        ? pendingSlotMatch.endTime
        : null;

    const bookingPayload = {
      companyId: input.companyId,
      leadId: matchedLead.id,
      bookingRequirementsVerifiedByCaller: true,
      startTime: selectedStartTime,
      ...(selectedEndTime ? { endTime: selectedEndTime } : {}),
      summary: calendarSummary,
      ...(leadAddress ? { location: leadAddress } : {}),
      trustedSuggestedSlot: true,
      skipAvailabilityCheck: true,
      bypassAvailabilityCheck: true,
      forceOfferedSlotBooking: true,
      description: [
        "Booked automatically from customer confirmation of suggested slot.",
        selectedEndTime
          ? "Duration source: customer explicit end time."
          : "Duration source: company default appointment duration.",
        "Booking rule: customer-selected option must not be silently replaced.",
        "",
        `Customer: ${customerMetadata.customerName ?? customerLabel}`,
        customerMetadata.customerPhone ? `Phone: ${customerMetadata.customerPhone}` : null,
        customerMetadata.customerEmail ? `Email: ${customerMetadata.customerEmail}` : null,
        leadAddress ? `Service address: ${leadAddress}` : null,
        matchedLead.input ? `Original request: ${matchedLead.input}` : null,
        "",
        `Customer reply: ${message}`,
        `Matched reason: ${pendingSlotMatch.reason}`,
        `Selected offered start: ${selectedStartTime}`,
        selectedEndTime ? `Selected booked end: ${selectedEndTime}` : null,
        `Company timezone: ${companyTimezone}`,
        input.fromEmail ? `From: ${input.fromEmail}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      attendeeEmail: customerMetadata.attendeeEmail,
      attendeeName: customerMetadata.attendeeName,
      allowReschedule: bookedRescheduleConversation,
    };

    let booking: any;

    try {
      booking = await createCalendarBooking(bookingPayload as any);
      assertRealCalendarBooking(booking, {
        startTime: selectedStartTime,
        endTime: selectedEndTime,
      });

      if (bookedRescheduleConversation) {
        assertRescheduleReusedExistingCalendarEvent({
          booking,
          lead: matchedLead,
          requestedStartTime: selectedStartTime,
        });
      }
    } catch (err: any) {
      const isAvailabilityFailure =
        err?.message === "slot_unavailable" ||
        err?.message === "outside_business_hours";

      if (!isAvailabilityFailure) throw err;

      const alternatives: AlternativeSlot[] = Array.isArray(err?.alternatives)
        ? err.alternatives
        : getPendingSuggestionSlots(matchedLead.qualification);

      console.warn("[inbound] exact_selected_offered_slot_not_booked", {
        leadId: matchedLead.id,
        selectedStartTime,
        selectedEndTime,
        matchReason: pendingSlotMatch.reason,
        parsedMessage: message,
        error: err?.message ?? "booking_failed",
        alternativeCount: alternatives.length,
      });

      return sendUnavailableAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        reason:
          err?.message === "outside_business_hours"
            ? "outside_business_hours"
            : "slot_unavailable",
        alternatives,
        originalRequestedStartTime: selectedStartTime,
        originalRequestedEndTime: selectedEndTime,
        mixedInformationAnswer: mixedBookedInformationAnswerBody,
      });
    }

    const appointmentTime = booking.appointmentTime;
    const appointmentEndTime = booking.appointmentEndTime ?? selectedEndTime;

    if (!slotTimesMatchWithinOneMinute(appointmentTime, selectedStartTime)) {
      throw new Error("booked_time_does_not_match_selected_offered_slot");
    }

    const nextQualificationBase = {
      ...(matchedLead.qualification ?? {}),
      pendingSlotSuggestion: {
        ...((matchedLead.qualification ?? {}).pendingSlotSuggestion ?? {}),
        status: "confirmed_and_booked",
        confirmedStartTime: appointmentTime,
        confirmedEndTime: appointmentEndTime,
        confirmedByReply: message,
        confirmedAt: new Date().toISOString(),
        matchReason: pendingSlotMatch.reason,
      },
    };

    const nextQualification =
      buildQualificationWithSuccessfulRescheduleLineage({
        lead: matchedLead,
        qualification: nextQualificationBase,
        booking,
        customerReply: message,
      });

    const verifiedLead = await forceMarkLeadBooked({
      companyId: input.companyId,
      leadId: matchedLead.id,
      appointmentTime,
      calendarEventId: booking.calendarEventId,
      qualification: nextQualification,
      updates,
    });

    let finalVerifiedLead = verifiedLead;

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
    });

    if (input.fromEmail) {
      const confirmedTime = new Date(appointmentTime).toLocaleString("en-US", {
        timeZone: companyTimezone,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

      await sendLeadReply({
        companyId: input.companyId,
        leadId: matchedLead.id,
        to: input.fromEmail,
        subject: input.subject ?? "Re: Your HVAC Request",
        body: mergeMixedInformationWithActionReply(
          mixedBookedInformationAnswerBody,
          [
            `Perfect — you're booked for ${confirmedTime}.`,
            "",
            leadAddress ? `Service address: ${leadAddress}` : null,
            "",
          ]
            .filter(Boolean)
            .join("\n")
        ),
        isFollowUp: false,
      });

      // Surgical guard: sendLeadReply can update lead contact fields/status after sending.
      // After a real calendar booking exists, the database source of truth must remain booked.
      // This does not touch booking, calendar creation, matching, ingestion, or dedupe logic.
      finalVerifiedLead = await forceMarkLeadBooked({
        companyId: input.companyId,
        leadId: matchedLead.id,
        appointmentTime,
        calendarEventId: booking.calendarEventId,
        qualification: nextQualification,
        updates,
      });
    }

    console.log("[inbound] exact selected offered slot booked", {
      leadId: matchedLead.id,
      inboundEmailId: inboundEmail.id,
      selectedStartTime,
      selectedEndTime,
      appointmentTime,
      appointmentEndTime,
      calendarEventId: booking.calendarEventId,
      verifiedLeadStatus: finalVerifiedLead.status,
    });

    return {
      success: true,
      processed: true,
      booked: true,
      reason: "pending_suggested_slot_confirmed_and_booked_exact_selected_option",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
      companyTimezone,
      parsedMessage: message,
      matchReason: pendingSlotMatch.reason,
      selectedStartTime,
      selectedEndTime,
      booking,
      verifiedLead: finalVerifiedLead,
    };
  }

  if (
    hasActivePendingSlotSuggestion(matchedLead.qualification) &&
    !pendingSlotMatch.matched &&
    !forcedBookingWindow.start &&
    (!schedulingIntent.hasPreference || unresolvedTimeOnlyPreference)
  ) {
    const alternatives = getPendingSuggestionSlots(matchedLead.qualification);

    return sendBookingClarificationAndKeepPending({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      inboundUpdates: updates,
      toEmail: input.fromEmail,
      subject: input.subject,
      companyTimezone,
      message,
      alternatives,
      resolverReason: pendingSlotMatch.reason,
      resolverConfidence: pendingSlotMatch.confidence,
    });
  }

  const schedulingWindows = schedulingIntent as typeof schedulingIntent & {
    preferredWindows?: Array<{ startTime: string; endTime: string | null }>;
    allowedWindows?: Array<{ startTime: string; endTime: string | null }>;
    startTime?: string | null;
    endTime?: string | null;
  };

  const resolvedWindow =
    schedulingWindows.preferredWindows?.[0] ??
    schedulingWindows.allowedWindows?.[0] ??
    (schedulingWindows.startTime
      ? {
          startTime: schedulingWindows.startTime,
          endTime: schedulingWindows.endTime ?? null,
        }
      : null);

  const schedulingPreferenceText =
    schedulingIntent.originalPreference?.trim() ||
    schedulingIntent.displayPreference?.trim() ||
    null;

  let resolvedWindowStart = resolvedWindow?.startTime ?? null;
  let resolvedWindowEnd = resolvedWindow?.endTime ?? null;

  /*
    A date-only request is an availability window, never an exact midnight
    appointment. If the semantic resolver supplies only the local-day start,
    reconstruct the next local midnight as the exclusive window end so the
    normal requested-window option path handles it.
  */
  if (
    schedulingIntent.temporalGranularity === "date_only" &&
    schedulingIntent.customerSpecifiedDate === true &&
    schedulingIntent.customerSpecifiedTime === false &&
    resolvedWindowStart &&
    !resolvedWindowEnd
  ) {
    const localDate = getLocalCalendarDateForIso(
      resolvedWindowStart,
      companyTimezone
    );

    if (localDate) {
      const nextLocalDate = addDaysToLocalDate({ ...localDate, days: 1 });
      resolvedWindowEnd = zonedTimeToUtc({
        ...nextLocalDate,
        hour: 0,
        minute: 0,
        timezone: companyTimezone,
      });
    }
  }

  const targetTimeMs = schedulingIntent.targetTime
    ? new Date(schedulingIntent.targetTime).getTime()
    : Number.NaN;

  const resolvedWindowStartMs = resolvedWindowStart
    ? new Date(resolvedWindowStart).getTime()
    : Number.NaN;

  const targetTimeMatchesBoundedWindowStart =
    Boolean(resolvedWindowEnd) &&
    Number.isFinite(targetTimeMs) &&
    Number.isFinite(resolvedWindowStartMs) &&
    Math.abs(targetTimeMs - resolvedWindowStartMs) <= 1_000;

  const exactTargetTime = targetTimeMatchesBoundedWindowStart
    ? null
    : schedulingIntent.targetTime ?? null;

  let semanticBookingStartTime =
    schedulingIntent.temporalGranularity === "date_only" &&
    schedulingIntent.customerSpecifiedTime === false
      ? null
      : exactTargetTime ??
        (resolvedWindowStart && !resolvedWindowEnd ? resolvedWindowStart : null);

  let semanticBookingEndTime =
    semanticBookingStartTime && resolvedWindowEnd && exactTargetTime
      ? resolvedWindowEnd
      : null;

  let broadWindowAlternatives: AlternativeSlot[] | null = null;

  if (
    schedulingIntent.hasPreference &&
    !exactTargetTime &&
    resolvedWindowStart &&
    resolvedWindowEnd
  ) {
    const candidateSlots = await suggestCadenceAlignedAlternativeSlots({
      companyId: input.companyId,
      requestedStartTime: resolvedWindowStart,
      timezone: companyTimezone,
    });

    const windowStartMs = new Date(resolvedWindowStart).getTime();
    const windowEndMs = new Date(resolvedWindowEnd).getTime();

    const candidatesInsideRequestedWindow = candidateSlots.filter((slot) => {
      const slotStartMs = new Date(slot.startTime).getTime();
      const slotEndMs = slot.endTime
        ? new Date(slot.endTime).getTime()
        : slotStartMs;

      return (
        Number.isFinite(slotStartMs) &&
        Number.isFinite(slotEndMs) &&
        slotStartMs >= windowStartMs &&
        slotEndMs <= windowEndMs
      );
    });

    if (candidatesInsideRequestedWindow.length > 0) {
      return sendRequestedWindowOptionsAndStorePending({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        companyTimezone,
        message,
        alternatives: candidatesInsideRequestedWindow,
        originalRequestedStartTime: resolvedWindowStart,
        originalRequestedEndTime: resolvedWindowEnd,
        schedulingPreferenceText,
        mixedInformationAnswer: mixedBookedInformationAnswerBody,
      });
    } else {
      broadWindowAlternatives = candidateSlots;
    }
  }

  const intent = {
    wantsBooking: schedulingIntent.hasPreference,
    preferredStartTime: semanticBookingStartTime,
    preferredEndTime: semanticBookingEndTime,
    address: null,
    city: null,
    state: null,
    zip: null,
    confidence:
      schedulingIntent.confidence >= 0.8
        ? "high"
        : schedulingIntent.confidence >= 0.5
          ? "medium"
          : "low" as const,
  };

  console.log("[inbound] parsed booking intent", {
    leadId: matchedLead.id,
    intent,
    schedulingIntent,
  });

  if (intent.address) updates.address = intent.address;
  if (intent.city) updates.city = intent.city;
  if (intent.state) updates.state = intent.state;
  if (intent.zip) updates.zip = intent.zip;

  if (
    schedulingIntent.hasPreference &&
    broadWindowAlternatives &&
    !intent.preferredStartTime
  ) {
    return sendUnavailableAndStorePending({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      inboundUpdates: updates,
      toEmail: input.fromEmail,
      subject: input.subject,
      companyTimezone,
      message,
      reason: "slot_unavailable",
      alternatives: broadWindowAlternatives,
      originalRequestedStartTime: resolvedWindowStart,
      originalRequestedEndTime: resolvedWindowEnd,
      schedulingPreferenceText,
      mixedInformationAnswer: mixedBookedInformationAnswerBody,
    });
  }

  if (!intent.preferredStartTime) {
    updates.status = intent.wantsBooking ? "awaiting_customer" : "contacted";

    const { data: updatedLead, error: updateError } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", matchedLead.id)
      .eq("company_id", input.companyId)
      .select("id, company_id, status")
      .maybeSingle();

    if (updateError) throw new Error(updateError.message);
    if (!updatedLead) throw new Error("lead_update_scope_violation");

    await markInboundProcessed({
      inboundEmailId: inboundEmail.id,
      companyId: input.companyId,
      leadId: matchedLead.id,
      processingError: "no_clear_booking_start_time",
    });

    return {
      success: true,
      processed: true,
      booked: false,
      reason: "no_clear_booking_start_time",
      inboundEmailId: inboundEmail.id,
      leadId: matchedLead.id,
      companyTimezone,
      parsedMessage: message,
      intent,
    };
  }

  if (!hasActiveBookingContext && intent.preferredStartTime) {
    const bookingRequirementsBlock =
      await requireBookingDetailsBeforeNewAppointment({
        companyId: input.companyId,
        lead: matchedLead,
        inboundEmailId: inboundEmail.id,
        inboundUpdates: updates,
        toEmail: input.fromEmail,
        subject: input.subject,
        timezone: companyTimezone,
        message,
        actionKind: "book",
        requestedStartTime: intent.preferredStartTime,
        requestedEndTime: intent.preferredEndTime ?? null,
      });

    if (bookingRequirementsBlock) return bookingRequirementsBlock;
  }

  const explicitEndTime = customerExplicitlyGaveEndTime(message);

  let booking: any;

  try {
    const leadAddress = buildLeadAddress(matchedLead);
    const customerMetadata = resolveCustomerMetadata(matchedLead, input.fromEmail);
    const customerLabel = customerMetadata.customerLabel;

    const calendarSummary = leadAddress
      ? `HVAC Appointment - ${customerLabel} - ${leadAddress}`
      : `HVAC Appointment - ${customerLabel}`;

    booking = await createCalendarBooking({
      companyId: input.companyId,
      leadId: matchedLead.id,
      bookingRequirementsVerifiedByCaller: true,
      startTime: intent.preferredStartTime,
      ...(explicitEndTime && intent.preferredEndTime
        ? { endTime: intent.preferredEndTime }
        : {}),
      summary: calendarSummary,
      ...(leadAddress ? { location: leadAddress } : {}),
      description: [
        "Booked automatically from inbound email reply.",
        explicitEndTime
          ? "Duration source: customer explicit end time."
          : "Duration source: company default appointment duration.",
        "",
        `Customer: ${customerMetadata.customerName ?? customerLabel}`,
        customerMetadata.customerPhone ? `Phone: ${customerMetadata.customerPhone}` : null,
        customerMetadata.customerEmail ? `Email: ${customerMetadata.customerEmail}` : null,
        leadAddress ? `Service address: ${leadAddress}` : null,
        matchedLead.input ? `Original request: ${matchedLead.input}` : null,
        "",
        `Customer reply: ${message}`,
        `Company timezone: ${companyTimezone}`,
        input.fromEmail ? `From: ${input.fromEmail}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      attendeeEmail: customerMetadata.attendeeEmail,
      attendeeName: customerMetadata.attendeeName,
      allowReschedule: bookedRescheduleConversation,
    } as any);

    assertRealCalendarBooking(booking, {
      startTime: intent.preferredStartTime,
      endTime:
        explicitEndTime && intent.preferredEndTime
          ? intent.preferredEndTime
          : null,
    });

    if (bookedRescheduleConversation) {
      assertRescheduleReusedExistingCalendarEvent({
        booking,
        lead: matchedLead,
        requestedStartTime: intent.preferredStartTime,
      });
    }
  } catch (err: any) {
    const isAvailabilityFailure =
      err?.message === "slot_unavailable" ||
      err?.message === "outside_business_hours";

    console.error("[inbound] booking failed", {
      leadId: matchedLead.id,
      error: err?.message ?? err,
      isAvailabilityFailure,
      startTime: intent.preferredStartTime,
      endTime: intent.preferredEndTime,
      parsedMessage: message,
    });

    if (!isAvailabilityFailure) {
      throw err;
    }

    const alternatives: AlternativeSlot[] = Array.isArray(err?.alternatives)
      ? err.alternatives
      : [];

    return sendUnavailableAndStorePending({
      companyId: input.companyId,
      lead: matchedLead,
      inboundEmailId: inboundEmail.id,
      inboundUpdates: updates,
      toEmail: input.fromEmail,
      subject: input.subject,
      companyTimezone,
      message,
      reason:
        err?.message === "outside_business_hours"
          ? "outside_business_hours"
          : "slot_unavailable",
      alternatives,
      originalRequestedStartTime: intent.preferredStartTime,
      originalRequestedEndTime: intent.preferredEndTime ?? null,
      schedulingPreferenceText,
      mixedInformationAnswer: mixedBookedInformationAnswerBody,
    });
  }

  const appointmentTime = booking.appointmentTime;

  const finalQualificationBase = {
    ...(matchedLead.qualification ?? {}),
    pendingSlotSuggestion: {
      status: "confirmed_and_booked",
      confirmedStartTime: appointmentTime,
      confirmedByReply: message,
      confirmedAt: new Date().toISOString(),
      matchReason: "direct_customer_time_booking",
    },
  };

  const finalQualification =
    buildQualificationWithSuccessfulRescheduleLineage({
      lead: matchedLead,
      qualification: finalQualificationBase,
      booking,
      customerReply: message,
    });

  const verifiedLead = await forceMarkLeadBooked({
    companyId: input.companyId,
    leadId: matchedLead.id,
    appointmentTime,
    calendarEventId: booking.calendarEventId,
    qualification: finalQualification,
    updates,
  });

  let finalVerifiedLead = verifiedLead;

  const verifiedAppointmentTime = verifiedLead.appointment_time;

  if (
    !slotTimesMatchWithinOneMinute(
      verifiedAppointmentTime,
      intent.preferredStartTime
    )
  ) {
    throw new Error("verified_lead_time_does_not_match_customer_request");
  }

  await markInboundProcessed({
    inboundEmailId: inboundEmail.id,
    companyId: input.companyId,
    leadId: matchedLead.id,
  });

  if (input.fromEmail) {
    const confirmedTime = new Date(verifiedAppointmentTime).toLocaleString("en-US", {
      timeZone: companyTimezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    const normalizedRequestedTime = formatCustomerRequestedSlot(
      verifiedAppointmentTime,
      companyTimezone
    );

    await sendLeadReply({
      companyId: input.companyId,
      leadId: matchedLead.id,
      to: input.fromEmail,
      subject: input.subject ?? "Re: Your HVAC Request",
      body: mergeMixedInformationWithActionReply(
        mixedBookedInformationAnswerBody,
        booking?.rescheduled
          ? `Your appointment has been moved to ${confirmedTime}.`
          : normalizedRequestedTime
            ? `Your request for ${normalizedRequestedTime} is available. You're booked for ${confirmedTime}.`
            : `Perfect — you're booked for ${confirmedTime}.`
      ),
      isFollowUp: false,
    });

    finalVerifiedLead = await forceMarkLeadBooked({
      companyId: input.companyId,
      leadId: matchedLead.id,
      appointmentTime,
      calendarEventId: booking.calendarEventId,
      qualification: finalQualification,
      updates,
    });
  }

  return {
    success: true,
    processed: true,
    booked: true,
    inboundEmailId: inboundEmail.id,
    leadId: matchedLead.id,
    companyTimezone,
    parsedMessage: message,
    durationSource: explicitEndTime
      ? "customer_explicit_end_time"
      : "company_default_appointment_duration",
    intent,
    booking,
    verifiedLead: finalVerifiedLead,
  };
}
