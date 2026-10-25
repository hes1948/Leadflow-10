// lib/scheduling/resolveCanonicalTemporalIntent.ts
//
// One canonical temporal interpretation boundary for scheduling.
//
// IMPORTANT:
// - This module does NOT decide whether a turn is informational or booking-related.
// - This module does NOT fetch realtime/web data.
// - This module does NOT query Calendar availability.
// - This module does NOT authorize booking/reschedule/cancel/restore mutations.
// - It only decides WHAT TIME/DATE/WINDOW the customer means inside the
//   scheduling lane, using explicit customer language plus authoritative
//   scheduling context already owned by the conversation.

import type { ResolvedSchedulingIntent } from "@/lib/ai/resolveSchedulingIntent";
import { zonedTimeToUtc } from "@/lib/time/companyTime";

export type CanonicalPendingSlotMatch = {
  matched: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
  confidence: "low" | "medium" | "high";
};

export type CanonicalAlternativeSlot = {
  startTime: string;
  endTime?: string | null;
};

export type CanonicalLocalDate = {
  year: number;
  month: number;
  day: number;
};

export type CanonicalClock = {
  hour: number;
  minute: number;
};

export type CanonicalLegacyFallbackWindow = {
  start: string | null;
  end: string | null;
};

export type CanonicalSchedulingWindow = {
  startTime: string;
  endTime: string | null;
};

export type CanonicalStoredSchedulingContext = {
  requestedStartTime: string;
  requestedEndTime: string | null;
  displayPreference?: string | null;

  /*
   * Optional full-frame fields. Older persisted qualification records may only
   * have requestedStartTime/requestedEndTime, so every field remains optional.
   * When present, these preserve multi-window/exclusion semantics instead of
   * collapsing the active frame to its first window.
   */
  allowedWindows?: CanonicalSchedulingWindow[];
  excludedWindows?: CanonicalSchedulingWindow[];
  selectionMode?: ResolvedSchedulingIntent["selectionMode"];
  targetTime?: string | null;
};

export type CanonicalTemporalIntent = {
  schedulingIntent: ResolvedSchedulingIntent;
  pendingSlotMatch: CanonicalPendingSlotMatch;
  pendingConfirmationOwnsTurn: boolean;
  hasCompleteFreshTemporalOverride: boolean;
  isTimeOnlySchedulingPreference: boolean;
  forcedBookingWindow: CanonicalLegacyFallbackWindow;
  unresolvedTimeOnlyPreference: boolean;
  source:
    | "relative_clock_expression"
    | "relative_adjustment_expression"
    | "calendar_transform_expression"
    | "relative_from_reference"
    | "direct_clock_expression"
    | "relative_clock_ambiguous"
    | "preserved_active_frame"
    | "pending_offered_slot"
    | "fresh_temporal_request"
    | "time_only_context"
    | "semantic_temporal"
    | "legacy_fallback"
    | "none";
  reasons: string[];
};

export type ResolveCanonicalTemporalIntentInput = {
  message: string;

  originalSchedulingIntent: ResolvedSchedulingIntent;
  enrichedSchedulingIntent: ResolvedSchedulingIntent;
  pendingSlotCandidate: CanonicalPendingSlotMatch;
  pendingAlternatives: CanonicalAlternativeSlot[];

  pendingMatchConflictsWithLiteralTemporalSurface: boolean;
  groundedTemporalSurfaceEvidence: boolean;
  contextualPendingOptionOwnsTurn: boolean;
  compatiblePendingOfferedSlotOwnsTurn: boolean;

  groundedTimeOnlyEvidence: boolean;
  groundedDateEvidenceForTimeOnlyArbitration: boolean;
  resolvedTimeOnlyClock: CanonicalClock | null;
  originalRequestedDate: CanonicalLocalDate | null;
  offeredFallbackDate: CanonicalLocalDate | null;

  /*
   * Supplied by the ONE canonical booking-command resolver. This is only a
   * routing/context signal telling temporal interpretation whether the newest
   * turn changed scheduling-time meaning. It does NOT resolve the actual WHEN,
   * authorize mutation, or touch realtime/web data.
   */
  bookingCommandKind?: string | null;
  bookingCommandHasFreshTemporalConstraint?: boolean | null;

  /*
   * Previously persisted scheduling frame. This is authoritative conversation
   * context for omitted dimensions, but it is never evidence that any slot is
   * currently available.
   */
  storedSchedulingContext?: CanonicalStoredSchedulingContext | null;

  /*
   * Authoritative booked appointment anchor. Relative reschedule edits must use
   * this instead of guessing from stale historical scheduling context.
   */
  activeAppointmentTime?: string | null;

  legacyFallbackWindow: CanonicalLegacyFallbackWindow;
  timezone: string;

  /*
   * Provider/inbound scheduling reference instant. Used only for literal
   * customer expressions such as "in 90 minutes" / "2 hours from now".
   * It is never used as evidence of availability.
   */
  referenceTime?: string | null;
};

type RelativeClockSurface = {
  signedMinutes: number;
  anchorRawHour: number;
  anchorHour24: number | null;
  anchorMinute: number;
  matchIndex: number;
  matchEnd: number;
};

type CanonicalClockSurface = {
  rawHour: number;
  minute: number;
  hour24: number | null;
  index: number;
  end: number;
  strength: "strong" | "contextual";
  source:
    | "noon_midnight"
    | "numeric"
    | "spoken"
    | "half_quarter"
    | "contextual_bare";
};

type RelativeAdjustmentSurface = {
  signedMinutes: number;
  index: number;
  end: number;
  anchorClock: CanonicalClockSurface | null;
  anchorless: boolean;
};

type RelativeFromReferenceSurface = {
  signedMinutes: number;
  index: number;
  end: number;
};

type TemporalSurfaceFacts = {
  text: string;
  hasDateSurface: boolean;
  hasClockSurface: boolean;
  hasDaypartSurface: boolean;
  hasRelativeDateSurface: boolean;
  sameDayReference: boolean;
  sameTimeReference: boolean;
  explicitWeekdayIndexes: number[];
  explicitYear: number | null;
  explicitMonth: number | null;
  explicitDayOfMonth: number | null;
  directClock: CanonicalClockSurface | null;
  clockSurfaceCount: number;
  hasWindowConstraintSurface: boolean;
  optionReferenceIndex: number | null;
  relativeAdjustment: RelativeAdjustmentSurface | null;
  relativeFromReference: RelativeFromReferenceSurface | null;
  hasAnyTemporalSurface: boolean;
};

type CalendarTransformSurface = {
  years: number;
  months: number;
  weeks: number;
  days: number;
  index: number;
  end: number;
};

type CanonicalTemporalOperation = NonNullable<
  ResolvedSchedulingIntent["temporalOperation"]
>;

const CLOCK_WORDS: Record<string, number> = {
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

const MINUTE_WORDS: Record<string, number> = {
  oh: 0,
  zero: 0,
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

const ORDINAL_OPTION_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

const WEEKDAY_PATTERNS: Array<{ index: number; pattern: RegExp }> = [
  { index: 0, pattern: /\b(?:sun|sunday)\b/g },
  { index: 1, pattern: /\b(?:mon|monday)\b/g },
  { index: 2, pattern: /\b(?:tue|tues|tuesday)\b/g },
  { index: 3, pattern: /\b(?:wed|wednesday)\b/g },
  { index: 4, pattern: /\b(?:thu|thur|thurs|thursday)\b/g },
  { index: 5, pattern: /\b(?:fri|friday)\b/g },
  { index: 6, pattern: /\b(?:sat|saturday)\b/g },
];

const MONTH_PATTERNS: Array<{ month: number; pattern: RegExp }> = [
  { month: 1, pattern: /\b(?:jan|january)\b/ },
  { month: 2, pattern: /\b(?:feb|february)\b/ },
  { month: 3, pattern: /\b(?:mar|march)\b/ },
  { month: 4, pattern: /\b(?:apr|april)\b/ },
  { month: 5, pattern: /\bmay\b/ },
  { month: 6, pattern: /\b(?:jun|june)\b/ },
  { month: 7, pattern: /\b(?:jul|july)\b/ },
  { month: 8, pattern: /\b(?:aug|august)\b/ },
  { month: 9, pattern: /\b(?:sep|sept|september)\b/ },
  { month: 10, pattern: /\b(?:oct|october)\b/ },
  { month: 11, pattern: /\b(?:nov|november)\b/ },
  { month: 12, pattern: /\b(?:dec|december)\b/ },
];

function normalizeText(value: string) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function slotTimesMatchWithinOneMinute(
  firstIso?: string | null,
  secondIso?: string | null
) {
  if (!firstIso || !secondIso) return false;

  const firstMs = new Date(firstIso).getTime();
  const secondMs = new Date(secondIso).getTime();

  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) {
    return false;
  }

  return Math.abs(firstMs - secondMs) <= 60_000;
}

function emptyPendingMatch(
  reason: string,
  confidence: CanonicalPendingSlotMatch["confidence"] = "high"
): CanonicalPendingSlotMatch {
  return {
    matched: false,
    startTime: null,
    endTime: null,
    reason,
    confidence,
  };
}

function suppressSemanticTemporalIntent(
  original: ResolvedSchedulingIntent,
  interpretation: string
): ResolvedSchedulingIntent {
  return {
    ...original,
    hasPreference: false,
    allowedWindows: [],
    excludedWindows: [],
    targetTime: null,
    temporalGranularity: "none",
    customerSpecifiedDate: false,
    customerSpecifiedTime: false,
    localDateTime: null,
    interpretation,
  };
}

function getLocalDateForIso(
  iso: string | null | undefined,
  timezone: string
): CanonicalLocalDate | null {
  if (!iso) return null;
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

function getLocalClockForIso(
  iso: string | null | undefined,
  timezone: string
): CanonicalClock | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);

  const hour = get("hour");
  const minute = get("minute");

  if (![hour, minute].every(Number.isFinite)) return null;
  return { hour: hour === 24 ? 0 : hour, minute };
}

function getLocalWeekdayIndexForIso(
  iso: string | null | undefined,
  timezone: string
) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  })
    .format(date)
    .toLowerCase();

  const map: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };

  return map[weekday] ?? null;
}

function sameLocalDate(
  first: CanonicalLocalDate | null,
  second: CanonicalLocalDate | null
) {
  return Boolean(
    first &&
      second &&
      first.year === second.year &&
      first.month === second.month &&
      first.day === second.day
  );
}

function getIntentCustomerDate(
  intent: ResolvedSchedulingIntent,
  timezone: string
): CanonicalLocalDate | null {
  if (!intent.customerSpecifiedDate) return null;

  if (intent.localDateTime) {
    return {
      year: intent.localDateTime.year,
      month: intent.localDateTime.month,
      day: intent.localDateTime.day,
    };
  }

  const candidate =
    intent.allowedWindows?.[0]?.startTime ??
    intent.targetTime ??
    null;

  return getLocalDateForIso(candidate, timezone);
}

function getUnambiguousAlternativeDate(
  alternatives: CanonicalAlternativeSlot[],
  timezone: string
): CanonicalLocalDate | null {
  const dates = alternatives
    .map((slot) => getLocalDateForIso(slot.startTime, timezone))
    .filter((date): date is CanonicalLocalDate => Boolean(date));

  if (dates.length === 0) return null;

  const first = dates[0];
  return dates.every((date) => sameLocalDate(date, first))
    ? first
    : null;
}

function getStoredWindows(
  context: CanonicalStoredSchedulingContext | null | undefined
): CanonicalSchedulingWindow[] {
  if (!context) return [];

  const full = Array.isArray(context.allowedWindows)
    ? context.allowedWindows.filter(
        (window) =>
          Boolean(window?.startTime) &&
          Number.isFinite(new Date(window.startTime).getTime()) &&
          (!window.endTime || Number.isFinite(new Date(window.endTime).getTime()))
      )
    : [];

  if (full.length > 0) {
    return full.map((window) => ({
      startTime: window.startTime,
      endTime: window.endTime ?? null,
    }));
  }

  return context.requestedStartTime
    ? [
        {
          startTime: context.requestedStartTime,
          endTime: context.requestedEndTime ?? null,
        },
      ]
    : [];
}

function getStoredExcludedWindows(
  context: CanonicalStoredSchedulingContext | null | undefined
): CanonicalSchedulingWindow[] {
  if (!context || !Array.isArray(context.excludedWindows)) return [];

  return context.excludedWindows
    .filter(
      (window) =>
        Boolean(window?.startTime) &&
        Number.isFinite(new Date(window.startTime).getTime()) &&
        (!window.endTime || Number.isFinite(new Date(window.endTime).getTime()))
    )
    .map((window) => ({
      startTime: window.startTime,
      endTime: window.endTime ?? null,
    }));
}

function getSingleStoredCalendarDate(
  context: CanonicalStoredSchedulingContext | null | undefined,
  timezone: string
): CanonicalLocalDate | null {
  const windows = getStoredWindows(context);
  if (windows.length === 0) return null;

  const dates = windows
    .map((window) => getLocalDateForIso(window.startTime, timezone))
    .filter((date): date is CanonicalLocalDate => Boolean(date));

  if (dates.length !== windows.length || dates.length === 0) return null;
  const first = dates[0];
  return dates.every((date) => sameLocalDate(date, first)) ? first : null;
}

function getStoredPointTime(
  context: CanonicalStoredSchedulingContext | null | undefined
): string | null {
  if (!context) return null;

  if (
    context.targetTime &&
    Number.isFinite(new Date(context.targetTime).getTime())
  ) {
    return context.targetTime;
  }

  const windows = getStoredWindows(context);
  if (windows.length !== 1) return null;

  const only = windows[0];
  if (only.endTime) return null;
  return only.startTime;
}

function isLikelyNegatedAt(text: string, index: number) {
  const before = text.slice(Math.max(0, index - 42), index).toLowerCase();
  return (
    /\b(?:not|never|dont|don't|do not|no|nah)\s+(?:the\s+)?$/.test(before) ||
    /\b(?:not|never|dont|don't|do not)\b[^,.!?;]{0,18}$/.test(before) ||
    /\b(?:anything|everything)\s+but\s+$/.test(before) ||
    /\binstead\s+of\s+$/.test(before)
  );
}

function parseWordOrNumericHour(token: string) {
  const normalized = token.toLowerCase().trim();
  if (/^\d+$/.test(normalized)) {
    const value = Number(normalized);
    return value >= 1 && value <= 12 ? value : null;
  }
  return CLOCK_WORDS[normalized] ?? null;
}

function parseQuantityValue(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  if (/^(?:a|an)$/.test(normalized)) return 1;
  if (/^couple(?:\s+of)?$/.test(normalized)) return 2;
  if (/^half(?:\s+(?:a|an|one))?$/.test(normalized)) return 0.5;
  if (/^quarter(?:\s+(?:of\s+)?(?:a|an|one))?$/.test(normalized)) return 0.25;

  const oneAndHalf = normalized.match(
    /^(?:(\d+(?:\.\d+)?)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+and\s+a\s+half$/
  );
  if (oneAndHalf) {
    const base = oneAndHalf[1]
      ? Number(oneAndHalf[1])
      : CLOCK_WORDS[normalized.split(" ")[0]];
    return Number.isFinite(base) ? Number(base) + 0.5 : null;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  return CLOCK_WORDS[normalized] ?? null;
}

function durationToMinutes(quantityText: string, unitText: string) {
  const amount = parseQuantityValue(quantityText);
  if (!Number.isFinite(amount) || Number(amount) <= 0) return null;
  const isHour = /^h(?:ou)?r/i.test(unitText);
  return Number(amount) * (isHour ? 60 : 1);
}

function calendarUnitVector(unitText: string, amount: number) {
  const unit = unitText.toLowerCase();
  return {
    years: /^years?$/.test(unit) ? amount : 0,
    months: /^months?$/.test(unit) ? amount : 0,
    weeks: /^weeks?$/.test(unit) ? amount : 0,
    days: /^days?$/.test(unit) ? amount : 0,
  };
}

function extractCalendarTransformSurface(
  message: string
): CalendarTransformSurface | null {
  const text = normalizeText(message);
  if (!text) return null;

  const quantity =
    "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\\s+of)?)";
  const candidates: CalendarTransformSurface[] = [];

  const add = (
    match: RegExpMatchArray,
    amount: number,
    unit: string,
    direction: number
  ) => {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) return;
    const vector = calendarUnitVector(unit, amount * direction);
    candidates.push({
      ...vector,
      index: match.index,
      end: match.index + match[0].length,
    });
  };

  // "move it forward three days" / "push it back two weeks"
  const leadingDirection = new RegExp(
    `\\b(?:move|push|shift|slide|bump|put|take|bring)?(?:\\s+(?:it|this|that|appointment|booking|slot))?\\s*(forward|forwards|back|backward|backwards)\\s+(${quantity})\\s*(days?|weeks?|months?|years?)\\b`,
    "g"
  );
  for (const match of text.matchAll(leadingDirection)) {
    const amount = parseQuantityValue(match[2]);
    if (!Number.isFinite(amount) || Number(amount) <= 0) continue;
    add(match, Number(amount), match[3], /^back/.test(match[1]) ? -1 : 1);
  }

  // "three days forward/later" / "two weeks earlier/back"
  const trailingDirection = new RegExp(
    `\\b(${quantity})\\s*(days?|weeks?|months?|years?)\\s+(forward|forwards|later|after|back|backward|backwards|earlier|before)\\b`,
    "g"
  );
  for (const match of text.matchAll(trailingDirection)) {
    const amount = parseQuantityValue(match[1]);
    if (!Number.isFinite(amount) || Number(amount) <= 0) continue;
    const negative = /^(?:back|backward|backwards|earlier|before)$/.test(match[3]);
    add(match, Number(amount), match[2], negative ? -1 : 1);
  }

  // "the month after" / "week before" when the anchor is supplied by context.
  for (const match of text.matchAll(
    /\b(?:the\s+)?(day|week|month|year)\s+(after|before)\b/g
  )) {
    add(match, 1, match[1], match[2] === "before" ? -1 : 1);
  }

  // "next/following month" / "previous/prior/last week".
  for (const match of text.matchAll(
    /\b(next|following|previous|prior|last)\s+(day|week|month|year)\b/g
  )) {
    // A unit positioned inside another calendar period describes a date,
    // not an amount by which to shift the appointment. Do not let the bare
    // qualifier parser steal the leading words of that larger date expression.
    const suffix = text.slice((match.index ?? 0) + match[0].length);
    if (/^\s+(?:of|in)\b/.test(suffix)) continue;

    add(
      match,
      1,
      match[2],
      /^(?:previous|prior|last)$/.test(match[1]) ? -1 : 1
    );
  }

  candidates.sort((a, b) => a.index - b.index || a.end - b.end);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function daysInCalendarMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function applyCalendarShift(
  date: CanonicalLocalDate,
  years: number,
  months: number,
  weeks: number,
  days: number
): CanonicalLocalDate {
  const totalMonths =
    date.year * 12 + (date.month - 1) + years * 12 + months;
  const shiftedYear = Math.floor(totalMonths / 12);
  const shiftedMonthIndex = ((totalMonths % 12) + 12) % 12;
  const shiftedMonth = shiftedMonthIndex + 1;
  const shiftedDay = Math.min(
    date.day,
    daysInCalendarMonth(shiftedYear, shiftedMonth)
  );

  const scratch = new Date(
    Date.UTC(shiftedYear, shiftedMonth - 1, shiftedDay, 0, 0, 0, 0)
  );
  scratch.setUTCDate(scratch.getUTCDate() + weeks * 7 + days);

  return {
    year: scratch.getUTCFullYear(),
    month: scratch.getUTCMonth() + 1,
    day: scratch.getUTCDate(),
  };
}

function operationHasLiteralSupport(params: {
  operation: CanonicalTemporalOperation;
  surface: TemporalSurfaceFacts;
  message: string;
}) {
  const text = normalizeText(params.message);
  const operation = params.operation;
  const dateShift =
    operation.years !== 0 ||
    operation.months !== 0 ||
    operation.weeks !== 0 ||
    operation.days !== 0;
  const clockShift = operation.hours !== 0 || operation.minutes !== 0;

  const unitSupport =
    (!operation.years || /\byears?\b/.test(text)) &&
    (!operation.months || /\bmonths?\b/.test(text)) &&
    (!operation.weeks || /\bweeks?\b/.test(text)) &&
    (!operation.days || /\bdays?\b/.test(text));

  const directionalSupport =
    !dateShift ||
    /\b(?:forward|forwards|ahead|out|back|backward|backwards|later|earlier|after|before|next|following|previous|prior|last)\b/.test(
      text
    );

  const optionSupport =
    operation.anchorKind !== "selected_offer" ||
    (params.surface.optionReferenceIndex !== null &&
      operation.optionNumber === params.surface.optionReferenceIndex + 1);

  const clockSupport =
    (!clockShift || Boolean(params.surface.relativeAdjustment)) &&
    (!operation.setClock || Boolean(params.surface.directClock));

  return unitSupport && directionalSupport && optionSupport && clockSupport;
}

function addClockSurface(
  candidates: CanonicalClockSurface[],
  candidate: CanonicalClockSurface
) {
  const overlapIndex = candidates.findIndex((existing) => {
    const overlaps =
      candidate.index < existing.end && existing.index < candidate.end;
    if (!overlaps) return false;

    /*
     * A contextual bare parser may see the leading "2" inside "2:30" or the
     * leading "eight" inside "eight thirty". Those are one customer clock, not
     * two competing clocks. Collapse overlapping surfaces and keep the stronger,
     * more specific representation.
     */
    return existing.rawHour === candidate.rawHour;
  });

  if (overlapIndex >= 0) {
    const existing = candidates[overlapIndex];
    const existingScore =
      (existing.strength === "strong" ? 100 : 0) +
      (existing.minute !== 0 ? 20 : 0) +
      (existing.hour24 !== null ? 10 : 0) +
      (existing.end - existing.index);
    const candidateScore =
      (candidate.strength === "strong" ? 100 : 0) +
      (candidate.minute !== 0 ? 20 : 0) +
      (candidate.hour24 !== null ? 10 : 0) +
      (candidate.end - candidate.index);

    if (candidateScore > existingScore) {
      candidates[overlapIndex] = candidate;
    }
    return;
  }

  if (
    candidates.some(
      (existing) =>
        existing.index === candidate.index &&
        existing.end === candidate.end &&
        existing.minute === candidate.minute &&
        existing.rawHour === candidate.rawHour
    )
  ) {
    return;
  }

  candidates.push(candidate);
}

function extractClockSurfaces(message: string) {
  const text = normalizeText(message);
  const candidates: CanonicalClockSurface[] = [];

  for (const match of text.matchAll(/\b(noon|midnight)\b/g)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const noon = match[1] === "noon";
    addClockSurface(candidates, {
      rawHour: 12,
      minute: 0,
      hour24: noon ? 12 : 0,
      index: match.index,
      end: match.index + match[0].length,
      strength: "strong",
      source: "noon_midnight",
    });
  }

  for (const match of text.matchAll(
    /\b(1[0-2]|0?[1-9])(?::([0-5][0-9]))\s*(am|pm)?\b/g
  )) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const rawHour = Number(match[1]);
    const minute = Number(match[2]);
    const meridian = match[3] ?? null;
    let hour24: number | null = null;
    if (meridian) {
      hour24 = rawHour % 12;
      if (meridian === "pm") hour24 += 12;
    }
    addClockSurface(candidates, {
      rawHour,
      minute,
      hour24,
      index: match.index,
      end: match.index + match[0].length,
      strength: "strong",
      source: "numeric",
    });
  }

  for (const match of text.matchAll(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/g)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const rawHour = Number(match[1]);
    let hour24 = rawHour % 12;
    if (match[2] === "pm") hour24 += 12;
    addClockSurface(candidates, {
      rawHour,
      minute: 0,
      hour24,
      index: match.index,
      end: match.index + match[0].length,
      strength: "strong",
      source: "numeric",
    });
  }

  const hourWord = "(?:1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const minuteWord = "(?:oh\\s+five|oh\\s+ten|five|ten|fifteen|twenty|twenty\\s+five|thirty|thirty\\s+five|forty|forty\\s+five|fifty|fifty\\s+five)";

  for (const match of text.matchAll(
    new RegExp(`\\b(${hourWord})\\s+(${minuteWord})\\s*(am|pm)?\\b`, "g")
  )) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const rawHour = parseWordOrNumericHour(match[1]);
    if (!rawHour) continue;
    const normalizedMinute = match[2].replace(/\s+/g, " ");
    const minute = normalizedMinute.startsWith("oh ")
      ? MINUTE_WORDS[normalizedMinute.slice(3)] ?? null
      : MINUTE_WORDS[normalizedMinute] ?? null;
    if (minute === null) continue;
    let hour24: number | null = null;
    if (match[3]) {
      hour24 = rawHour % 12;
      if (match[3] === "pm") hour24 += 12;
    }
    addClockSurface(candidates, {
      rawHour,
      minute,
      hour24,
      index: match.index,
      end: match.index + match[0].length,
      strength: "strong",
      source: "spoken",
    });
  }

  for (const match of text.matchAll(
    new RegExp(`\\b(half|quarter)\\s+(past|to)\\s+(${hourWord})(?:\\s*(am|pm))?\\b`, "g")
  )) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const rawAnchor = parseWordOrNumericHour(match[3]);
    if (!rawAnchor) continue;
    let rawHour = rawAnchor;
    let minute = match[1] === "half" ? 30 : 15;
    if (match[2] === "to") {
      rawHour = rawAnchor === 1 ? 12 : rawAnchor - 1;
      minute = 45;
    }
    let hour24: number | null = null;
    if (match[4]) {
      hour24 = rawHour % 12;
      if (match[4] === "pm") hour24 += 12;
    }
    addClockSurface(candidates, {
      rawHour,
      minute,
      hour24,
      index: match.index,
      end: match.index + match[0].length,
      strength: "strong",
      source: "half_quarter",
    });
  }

  const contextualBare = new RegExp(
    `\\b(?:at|around|about|by|make\\s+it|give\\s+me|do|book(?:\\s+it)?(?:\\s+for)?|schedule(?:\\s+it)?(?:\\s+for)?|move(?:\\s+it)?(?:\\s+to)?|change(?:\\s+it)?(?:\\s+to)?|switch(?:\\s+it)?(?:\\s+to)?)\\s+(?:the\\s+)?(${hourWord})\\b`,
    "g"
  );

  for (const match of text.matchAll(contextualBare)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const rawHour = parseWordOrNumericHour(match[1]);
    if (!rawHour) continue;
    const whole = match[0];
    const tokenOffset = whole.lastIndexOf(match[1]);
    const tokenIndex = match.index + Math.max(0, tokenOffset);
    addClockSurface(candidates, {
      rawHour,
      minute: 0,
      hour24: null,
      index: tokenIndex,
      end: tokenIndex + match[1].length,
      strength: /\b(?:at|around|about|by)\b/.test(whole)
        ? "strong"
        : "contextual",
      source: "contextual_bare",
    });
  }

  return candidates.sort((a, b) => a.index - b.index || a.end - b.end);
}

function parseClockPrefix(text: string) {
  const normalized = normalizeText(text).replace(/^\s*(?:at\s+)?/, "");
  const surfaces = extractClockSurfaces(normalized);
  const candidate = surfaces.find((surface) => surface.index <= 2) ?? null;
  if (candidate) return candidate;

  /*
   * Relative arithmetic permits a bare anchor immediately after after/before:
   * "1 hour after 12", "30 minutes before four". A bare clock is accepted
   * here only because the surrounding grammar already proves it is a clock
   * anchor, so this cannot steal an offered option number.
   */
  const bare = normalized.match(
    /^(1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*(am|pm))?\b/
  );
  if (!bare) return null;

  const rawHour = parseWordOrNumericHour(bare[1]);
  if (!rawHour) return null;

  let hour24: number | null = null;
  if (bare[2]) {
    hour24 = rawHour % 12;
    if (bare[2] === "pm") hour24 += 12;
  }

  return {
    rawHour,
    minute: 0,
    hour24,
    index: 0,
    end: bare[0].length,
    strength: "strong",
    source: "numeric",
  } satisfies CanonicalClockSurface;
}

function getBestDirectClockSurface(message: string) {
  const text = normalizeText(message);
  const surfaces = extractClockSurfaces(text).filter(
    (surface) => !isLikelyNegatedAt(text, surface.index)
  );
  return surfaces.length > 0 ? surfaces[surfaces.length - 1] : null;
}

function getExplicitOptionReferenceIndex(
  message: string,
  alternativeCount: number
): number | null {
  const text = normalizeText(message);
  const candidates: Array<{ index: number; option: number }> = [];

  for (const match of text.matchAll(
    /\b(?:option|slot|choice|opening|number|num)\s*#?\s*(\d{1,2})\b/g
  )) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const option = Number(match[1]);
    if (option >= 1 && option <= alternativeCount) {
      candidates.push({ index: match.index, option });
    }
  }

  for (const match of text.matchAll(/#\s*(\d{1,2})\b/g)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const option = Number(match[1]);
    if (option >= 1 && option <= alternativeCount) {
      candidates.push({ index: match.index, option });
    }
  }

  for (const match of text.matchAll(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:one|option|slot|choice|opening)\b/g
  )) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const option = ORDINAL_OPTION_WORDS[match[1]];
    if (option >= 1 && option <= alternativeCount) {
      candidates.push({ index: match.index, option });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[candidates.length - 1].option - 1;
}

function pendingSlotExplicitlyNegated(params: {
  message: string;
  pendingSlot: CanonicalPendingSlotMatch;
  alternatives: CanonicalAlternativeSlot[];
}) {
  if (!params.pendingSlot.matched || !params.pendingSlot.startTime) return false;
  const slotIndex = params.alternatives.findIndex((slot) =>
    slotTimesMatchWithinOneMinute(slot.startTime, params.pendingSlot.startTime)
  );
  if (slotIndex < 0) return false;

  const option = slotIndex + 1;
  const ordinal = Object.entries(ORDINAL_OPTION_WORDS).find(
    ([, value]) => value === option
  )?.[0];
  const text = normalizeText(params.message);

  const numericPatterns = [
    new RegExp(`\\b(?:not|dont|don't|do\\s+not|never|nah)\\s+(?:option\\s+|slot\\s+|choice\\s+|#\\s*)?${option}\\b`),
    new RegExp(`\\b(?:anything|everything)\\s+but\\s+(?:option\\s+|slot\\s+|choice\\s+|#\\s*)?${option}\\b`),
  ];

  if (numericPatterns.some((pattern) => pattern.test(text))) return true;

  if (ordinal) {
    const ordinalPattern = new RegExp(
      `\\b(?:not|dont|don't|do\\s+not|never|nah)\\s+(?:the\\s+)?${ordinal}(?:\\s+(?:one|option|slot|choice|opening))?\\b`
    );
    if (ordinalPattern.test(text)) return true;
  }

  return false;
}

function extractRelativeClockSurface(
  message: string
): RelativeClockSurface | null {
  const text = normalizeText(message);
  if (!text) return null;

  const quantity =
    "(?:\\d+(?:\\.\\d+)?|a|an|couple(?:\\s+of)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half(?:\\s+(?:a|an|one))?|quarter(?:\\s+(?:of\\s+)?(?:a|an|one))?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+(?:\\.\\d+)?)\\s+and\\s+a\\s+half)";
  const durationPattern = new RegExp(
    `\\b(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\s+(after|before)\\b`,
    "g"
  );

  const matches: RelativeClockSurface[] = [];

  const hourAndHalfPattern = /\b(?:an|one)\s+hour\s+and\s+a\s+half\s+(after|before)\b/g;
  for (const match of text.matchAll(hourAndHalfPattern)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const tailStart = match.index + match[0].length;
    const tail = text.slice(tailStart);
    const anchor = parseClockPrefix(tail);
    if (!anchor) continue;
    matches.push({
      signedMinutes: 90 * (match[1] === "before" ? -1 : 1),
      anchorRawHour: anchor.rawHour,
      anchorHour24: anchor.hour24,
      anchorMinute: anchor.minute,
      matchIndex: match.index,
      matchEnd: tailStart + anchor.end,
    });
  }

  for (const match of text.matchAll(durationPattern)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const minutes = durationToMinutes(match[1], match[2]);
    if (!minutes) continue;

    const tailStart = match.index + match[0].length;
    const tail = text.slice(tailStart);
    const anchor = parseClockPrefix(tail);
    if (!anchor) continue;

    matches.push({
      signedMinutes: minutes * (match[3] === "before" ? -1 : 1),
      anchorRawHour: anchor.rawHour,
      anchorHour24: anchor.hour24,
      anchorMinute: anchor.minute,
      matchIndex: match.index,
      matchEnd: tailStart + anchor.end,
    });
  }

  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function extractRelativeAdjustmentSurface(
  message: string
): RelativeAdjustmentSurface | null {
  const anchored = extractRelativeClockSurface(message);
  if (anchored) {
    return {
      signedMinutes: anchored.signedMinutes,
      index: anchored.matchIndex,
      end: anchored.matchEnd,
      anchorClock: {
        rawHour: anchored.anchorRawHour,
        minute: anchored.anchorMinute,
        hour24: anchored.anchorHour24,
        index: anchored.matchIndex,
        end: anchored.matchEnd,
        strength: "strong",
        source: "numeric",
      },
      anchorless: false,
    };
  }

  const text = normalizeText(message);
  const quantity =
    "(?:\\d+(?:\\.\\d+)?|a|an|couple(?:\\s+of)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half(?:\\s+(?:a|an|one))?|quarter(?:\\s+(?:of\\s+)?(?:a|an|one))?|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+(?:\\.\\d+)?)\\s+and\\s+a\\s+half)";
  const pattern = new RegExp(
    `\\b(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\s+(later|earlier)\\b`,
    "g"
  );

  const matches: RelativeAdjustmentSurface[] = [];

  for (const match of text.matchAll(/\b(?:an|one)\s+hour\s+and\s+a\s+half\s+(later|earlier)\b/g)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    matches.push({
      signedMinutes: 90 * (match[1] === "earlier" ? -1 : 1),
      index: match.index,
      end: match.index + match[0].length,
      anchorClock: null,
      anchorless: true,
    });
  }

  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const minutes = durationToMinutes(match[1], match[2]);
    if (!minutes) continue;
    matches.push({
      signedMinutes: minutes * (match[3] === "earlier" ? -1 : 1),
      index: match.index,
      end: match.index + match[0].length,
      anchorClock: null,
      anchorless: true,
    });
  }

  /*
   * Also support explicit relative edits against an offered reference:
   * "45 minutes after option 2", "an hour before the second one",
   * "30 minutes after that one". The actual slot identity is resolved later
   * from persisted offers / the existing pending-slot resolver.
   */
  const optionAnchorPattern = new RegExp(
    `\\b(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\s+(after|before)\\s+(?:(?:the\\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+(?:one|option|slot|choice|opening)|(?:option|slot|choice|opening|number|num)\\s*#?\\s*\\d{1,2}|that\\s+one|this\\s+one)\\b`,
    "g"
  );

  for (const match of text.matchAll(optionAnchorPattern)) {
    if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
    const minutes = durationToMinutes(match[1], match[2]);
    if (!minutes) continue;
    matches.push({
      signedMinutes: minutes * (match[3] === "before" ? -1 : 1),
      index: match.index,
      end: match.index + match[0].length,
      anchorClock: null,
      anchorless: true,
    });
  }

  matches.sort((a, b) => a.index - b.index);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function extractRelativeFromReferenceSurface(
  message: string
): RelativeFromReferenceSurface | null {
  const text = normalizeText(message);
  const quantity =
    "(?:\\d+(?:\\.\\d+)?|a|an|couple(?:\\s+of)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half(?:\\s+(?:a|an|one))?|quarter(?:\\s+(?:of\\s+)?(?:a|an|one))?)";
  const patterns = [
    new RegExp(`\\bin\\s+(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\b`, "g"),
    new RegExp(`\\b(${quantity})\\s*(hours?|hrs?|hr|minutes?|mins?|min)\\s+from\\s+now\\b`, "g"),
  ];

  const matches: RelativeFromReferenceSurface[] = [];

  const hourAndHalfFromNowPatterns = [
    /\bin\s+(?:an|one)\s+hour\s+and\s+a\s+half\b/g,
    /\b(?:an|one)\s+hour\s+and\s+a\s+half\s+from\s+now\b/g,
  ];
  for (const specialPattern of hourAndHalfFromNowPatterns) {
    for (const match of text.matchAll(specialPattern)) {
      if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
      matches.push({
        signedMinutes: 90,
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || isLikelyNegatedAt(text, match.index)) continue;
      const minutes = durationToMinutes(match[1], match[2]);
      if (!minutes) continue;
      matches.push({
        signedMinutes: minutes,
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  matches.sort((a, b) => a.index - b.index || a.end - b.end);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function analyzeTemporalSurface(
  message: string,
  alternativeCount: number
): TemporalSurfaceFacts {
  const text = normalizeText(message);
  const clockSurfaces = extractClockSurfaces(text);
  const directClock = clockSurfaces.length > 0
    ? clockSurfaces[clockSurfaces.length - 1]
    : null;
  const relativeAdjustment = extractRelativeAdjustmentSurface(text);
  const relativeFromReference = extractRelativeFromReferenceSurface(text);
  const optionReferenceIndex = getExplicitOptionReferenceIndex(
    text,
    alternativeCount
  );

  const explicitWeekdayIndexes: number[] = [];
  for (const weekday of WEEKDAY_PATTERNS) {
    weekday.pattern.lastIndex = 0;
    if (weekday.pattern.test(text)) explicitWeekdayIndexes.push(weekday.index);
  }

  const month = MONTH_PATTERNS.find(({ pattern }) => pattern.test(text))?.month ?? null;
  const yearMatch = text.match(/\b((?:19|20|21)\d{2})\b/);
  const explicitYear = yearMatch ? Number(yearMatch[1]) : null;

  const ordinalDayMatch = text.match(/\b(?:the\s+)?([12]?\d|3[01])(?:st|nd|rd|th)\b/);
  const monthDayMatch = text.match(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([12]?\d|3[01])(?:st|nd|rd|th)?\b/
  );
  const explicitDayOfMonth = monthDayMatch
    ? Number(monthDayMatch[1])
    : ordinalDayMatch
      ? Number(ordinalDayMatch[1])
      : null;

  const sameDayReference =
    /\b(?:same|that)\s+(?:calendar\s+)?(?:day|date)\b/.test(text) ||
    /\b(?:keep|use|stay\s+on)\s+(?:the\s+)?same\s+(?:calendar\s+)?(?:day|date)\b/.test(text);

  const sameTimeReference =
    /\b(?:same|current|existing|original|previous)\s+(?:time|hour)\b/.test(text) ||
    /\b(?:keep|leave|retain|use)\s+(?:(?:it|that)\s+)?(?:at\s+)?(?:the\s+)?same\s+(?:time|hour)\b/.test(text);

  const hasRelativeDateSurface =
    /\b(?:today|tomorrow|tonight|yesterday|day\s+after\s+tomorrow|next\s+day|following\s+day|coming\s+day)\b/.test(text) ||
    /\b(?:this|next|following|coming|upcoming)\s+(?:week|weekend|month|year)\b/.test(text) ||
    /\b(?:in|within)\s+(?:the\s+)?(?:next\s+)?\d+\s+(?:day|days|week|weeks|month|months|year|years)\b/.test(text);

  const hasDaypartSurface =
    /\b(?:morning|breakfast(?:ish)?|brunch|lunch(?:ish)?|noon|afternoon|dinner(?:ish)?|evening|night|tonight|after\s+lunch|before\s+lunch|after\s+breakfast|before\s+dinner)\b/.test(text);

  const hasNumericDate = /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/.test(text);
  const hasDateSurface =
    explicitWeekdayIndexes.length > 0 ||
    month !== null ||
    explicitDayOfMonth !== null ||
    explicitYear !== null ||
    hasNumericDate ||
    hasRelativeDateSurface ||
    sameDayReference;

  const hasClockSurface = Boolean(directClock) || sameTimeReference;

  /*
   * Window/range grammar belongs to the semantic window resolver, not the
   * exact-clock canonicalizer. This prevents "from 2:00 to 4:00",
   * "before 3 PM", or "2 PM or 3 PM" from collapsing to the last clock.
   */
  const hasRangeConnector =
    /\bbetween\b[^.!?]{0,40}\band\b/.test(text) ||
    /\bfrom\b[^.!?]{0,40}\b(?:to|until|through|thru)\b/.test(text) ||
    /\b(?:before|after|until|by)\s+(?:noon|midnight|1[0-2]|0?[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(text);
  const hasClockDisjunction =
    clockSurfaces.length >= 2 && /\b(?:or|either)\b|\//.test(text);
  const hasWindowConstraintSurface =
    !relativeAdjustment && (hasRangeConnector || hasClockDisjunction);

  const hasRelationalTemporalWord =
    /\b(?:before|after|between|during|until|later|earlier|from\s+now|by)\b/.test(text);

  const hasAnyTemporalSurface =
    hasDateSurface ||
    hasClockSurface ||
    hasDaypartSurface ||
    hasWindowConstraintSurface ||
    hasRelationalTemporalWord ||
    Boolean(relativeAdjustment) ||
    Boolean(relativeFromReference);

  return {
    text,
    hasDateSurface,
    hasClockSurface,
    hasDaypartSurface,
    hasRelativeDateSurface,
    sameDayReference,
    sameTimeReference,
    explicitWeekdayIndexes,
    explicitYear,
    explicitMonth: month,
    explicitDayOfMonth,
    directClock,
    clockSurfaceCount: clockSurfaces.length,
    hasWindowConstraintSurface,
    optionReferenceIndex,
    relativeAdjustment,
    relativeFromReference,
    hasAnyTemporalSurface,
  };
}

function addLocalMinutes(
  date: CanonicalLocalDate,
  hour: number,
  minute: number,
  deltaMinutes: number
) {
  const scratch = new Date(
    Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0)
  );

  scratch.setUTCMinutes(scratch.getUTCMinutes() + deltaMinutes);

  return {
    year: scratch.getUTCFullYear(),
    month: scratch.getUTCMonth() + 1,
    day: scratch.getUTCDate(),
    hour: scratch.getUTCHours(),
    minute: scratch.getUTCMinutes(),
  };
}


function shiftLocalDateByDays(date: CanonicalLocalDate, days: number) {
  const scratch = new Date(Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0));
  scratch.setUTCDate(scratch.getUTCDate() + days);
  return {
    year: scratch.getUTCFullYear(),
    month: scratch.getUTCMonth() + 1,
    day: scratch.getUTCDate(),
  };
}

function resolveAmbiguousClockOccurrenceDate(params: {
  baseDate: CanonicalLocalDate;
  resolvedHour24: number;
  minute: number;
  storedContext: CanonicalStoredSchedulingContext | null;
  timezone: string;
}) {
  const point = getStoredPointTime(params.storedContext);
  if (!point) return params.baseDate;

  const referenceDate = getLocalDateForIso(point, params.timezone);
  const referenceClock = getLocalClockForIso(point, params.timezone);
  if (!referenceDate || !referenceClock || !sameLocalDate(referenceDate, params.baseDate)) {
    return params.baseDate;
  }

  const referenceMinutes = referenceClock.hour * 60 + referenceClock.minute;
  const baseCandidateMinutes = params.resolvedHour24 * 60 + params.minute;
  const candidates = [-1, 0, 1].map((dayOffset) => ({
    dayOffset,
    absoluteMinutes: baseCandidateMinutes + dayOffset * 1440,
  }));

  candidates.sort((a, b) => {
    const aDistance = Math.abs(a.absoluteMinutes - referenceMinutes);
    const bDistance = Math.abs(b.absoluteMinutes - referenceMinutes);
    if (aDistance !== bDistance) return aDistance - bDistance;

    const aForward = a.absoluteMinutes >= referenceMinutes;
    const bForward = b.absoluteMinutes >= referenceMinutes;
    if (aForward !== bForward) return aForward ? -1 : 1;

    return a.absoluteMinutes - b.absoluteMinutes;
  });

  return shiftLocalDateByDays(params.baseDate, candidates[0].dayOffset);
}


function getTimezoneOffsetMinutesAtInstant(instantMs: number, timezone: string) {
  const date = new Date(instantMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  let hour = get("hour");
  if (hour === 24) hour = 0;

  const localAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );

  if (!Number.isFinite(localAsUtc)) return null;
  return Math.round((localAsUtc - instantMs) / 60_000);
}

function localDateTimeHasUniqueUtcMapping(params: {
  local: CanonicalLocalDate & CanonicalClock;
  timezone: string;
}) {
  const naiveMs = Date.UTC(
    params.local.year,
    params.local.month - 1,
    params.local.day,
    params.local.hour,
    params.local.minute,
    0,
    0
  );

  const candidateOffsets = new Set<number>();
  for (const probe of [naiveMs - 86_400_000, naiveMs, naiveMs + 86_400_000]) {
    const offset = getTimezoneOffsetMinutesAtInstant(probe, params.timezone);
    if (offset !== null) candidateOffsets.add(offset);
  }

  let matches = 0;
  for (const offsetMinutes of candidateOffsets) {
    const candidateIso = new Date(
      naiveMs - offsetMinutes * 60_000
    ).toISOString();
    const date = getLocalDateForIso(candidateIso, params.timezone);
    const clock = getLocalClockForIso(candidateIso, params.timezone);
    if (
      date &&
      clock &&
      date.year === params.local.year &&
      date.month === params.local.month &&
      date.day === params.local.day &&
      clock.hour === params.local.hour &&
      clock.minute === params.local.minute
    ) {
      matches += 1;
    }
  }

  return matches === 1;
}

function localDateTimeRoundTrips(params: {
  iso: string;
  expected: CanonicalLocalDate & CanonicalClock;
  timezone: string;
}) {
  const date = getLocalDateForIso(params.iso, params.timezone);
  const clock = getLocalClockForIso(params.iso, params.timezone);
  return Boolean(
    date &&
      clock &&
      date.year === params.expected.year &&
      date.month === params.expected.month &&
      date.day === params.expected.day &&
      clock.hour === params.expected.hour &&
      clock.minute === params.expected.minute
  );
}

function candidateHourInsideWindow(params: {
  candidateHour: number;
  minute: number;
  window: CanonicalSchedulingWindow;
  timezone: string;
}) {
  const startMs = new Date(params.window.startTime).getTime();
  const endMs = params.window.endTime
    ? new Date(params.window.endTime).getTime()
    : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;

  const startDate = getLocalDateForIso(params.window.startTime, params.timezone);
  if (!startDate) return false;

  const candidateIso = zonedTimeToUtc({
    ...startDate,
    hour: params.candidateHour,
    minute: params.minute,
    timezone: params.timezone,
  });
  const candidateMs = new Date(candidateIso).getTime();
  if (!Number.isFinite(candidateMs)) return false;

  return candidateMs >= startMs && candidateMs <= endMs;
}

function resolveClockHour24(params: {
  message: string;
  surface: CanonicalClockSurface;
  storedContext: CanonicalStoredSchedulingContext | null;
  alternatives: CanonicalAlternativeSlot[];
  constrainedModelClock?: CanonicalClock | null;
  timezone: string;
}) {
  if (params.surface.hour24 !== null) return params.surface.hour24;

  const text = normalizeText(params.message);
  const base = params.surface.rawHour % 12;

  if (/\b(?:morning|breakfast(?:ish)?|brunch)\b/.test(text)) return base;
  if (/\b(?:afternoon|lunch(?:ish)?|dinner(?:ish)?|evening|tonight|night)\b/.test(text)) {
    return base + 12;
  }

  const windows = getStoredWindows(params.storedContext);
  if (windows.length > 0) {
    const contextualCandidates = [base, base + 12].filter((candidateHour) =>
      windows.some((window) =>
        candidateHourInsideWindow({
          candidateHour,
          minute: params.surface.minute,
          window,
          timezone: params.timezone,
        })
      )
    );
    if (contextualCandidates.length === 1) return contextualCandidates[0];
  }

  const matchingOfferHours = new Set<number>();
  for (const slot of params.alternatives) {
    const clock = getLocalClockForIso(slot.startTime, params.timezone);
    if (!clock) continue;
    if (
      (clock.hour % 12 || 12) === params.surface.rawHour &&
      clock.minute === params.surface.minute
    ) {
      matchingOfferHours.add(clock.hour);
    }
  }
  if (matchingOfferHours.size === 1) return [...matchingOfferHours][0];

  const storedPoint = getStoredPointTime(params.storedContext);
  if (storedPoint) {
    const referenceClock = getLocalClockForIso(storedPoint, params.timezone);
    if (referenceClock) {
      const candidates = [base, base + 12];
      const refMinutes = referenceClock.hour * 60 + referenceClock.minute;
      const ranked = candidates
        .map((hour) => ({
          hour,
          distance: Math.min(
            Math.abs(hour * 60 + params.surface.minute - refMinutes),
            1440 - Math.abs(hour * 60 + params.surface.minute - refMinutes)
          ),
        }))
        .sort((a, b) => a.distance - b.distance);
      if (ranked.length === 2 && ranked[0].distance < ranked[1].distance) {
        return ranked[0].hour;
      }
    }
  }

  const modelClock = params.constrainedModelClock;
  if (
    modelClock &&
    (modelClock.hour % 12 || 12) === params.surface.rawHour &&
    modelClock.minute === params.surface.minute
  ) {
    return modelClock.hour;
  }

  return null;
}

function resolveRelativeAnchorHour24(params: {
  message: string;
  surface: RelativeClockSurface;
  storedContext: CanonicalStoredSchedulingContext | null;
  alternatives: CanonicalAlternativeSlot[];
  constrainedModelClock?: CanonicalClock | null;
  timezone: string;
}) {
  return resolveClockHour24({
    message: params.message,
    surface: {
      rawHour: params.surface.anchorRawHour,
      minute: params.surface.anchorMinute,
      hour24: params.surface.anchorHour24,
      index: params.surface.matchIndex,
      end: params.surface.matchEnd,
      strength: "strong",
      source: "numeric",
    },
    storedContext: params.storedContext,
    alternatives: params.alternatives,
    constrainedModelClock: params.constrainedModelClock,
    timezone: params.timezone,
  });
}

function getDateForGroundedTemporalRequest(params: {
  surface: TemporalSurfaceFacts;
  enrichedIntent: ResolvedSchedulingIntent;
  storedContext: CanonicalStoredSchedulingContext | null;
  originalRequestedDate: CanonicalLocalDate | null;
  offeredFallbackDate: CanonicalLocalDate | null;
  alternatives: CanonicalAlternativeSlot[];
  timezone: string;
}) {
  const groundedSemanticDate = params.surface.hasDateSurface
    ? getIntentCustomerDate(params.enrichedIntent, params.timezone)
    : null;

  if (groundedSemanticDate) return groundedSemanticDate;

  return (
    getSingleStoredCalendarDate(params.storedContext, params.timezone) ??
    params.originalRequestedDate ??
    params.offeredFallbackDate ??
    getUnambiguousAlternativeDate(params.alternatives, params.timezone)
  );
}

function buildExactIntent(params: {
  base: ResolvedSchedulingIntent;
  localDateTime: CanonicalLocalDate & CanonicalClock;
  timezone: string;
  customerSpecifiedDate: boolean;
  customerSpecifiedTime: boolean;
  interpretation: string;
  displayPreference?: string | null;
}) {
  /*
   * Local wall-clock times at DST transitions can be nonexistent (spring
   * forward) or map to two UTC instants (fall back). Never guess which instant
   * the customer meant. Exact canonicalization requires one unique mapping.
   */
  if (
    !localDateTimeHasUniqueUtcMapping({
      local: params.localDateTime,
      timezone: params.timezone,
    })
  ) {
    return null;
  }

  const startTime = zonedTimeToUtc({
    ...params.localDateTime,
    timezone: params.timezone,
  });

  if (
    !localDateTimeRoundTrips({
      iso: startTime,
      expected: params.localDateTime,
      timezone: params.timezone,
    })
  ) {
    return null;
  }

  return {
    ...params.base,
    hasPreference: true,
    allowedWindows: [{ startTime, endTime: null }],
    excludedWindows: [],
    selectionMode: "closest",
    targetTime: startTime,
    temporalGranularity: "date_time",
    customerSpecifiedDate: params.customerSpecifiedDate,
    customerSpecifiedTime: params.customerSpecifiedTime,
    localDateTime: params.localDateTime,
    displayPreference:
      params.displayPreference ?? params.base.displayPreference ?? params.base.originalPreference,
    interpretation: params.interpretation,
    confidence: Math.max(Number(params.base.confidence ?? 0), 0.99),
  } satisfies ResolvedSchedulingIntent;
}

function resolveAnchoredRelativeClockIntent(params: {
  message: string;
  surface: RelativeClockSurface;
  surfaceFacts: TemporalSurfaceFacts;
  baseIntent: ResolvedSchedulingIntent;
  enrichedIntent: ResolvedSchedulingIntent;
  storedContext: CanonicalStoredSchedulingContext | null;
  originalRequestedDate: CanonicalLocalDate | null;
  offeredFallbackDate: CanonicalLocalDate | null;
  alternatives: CanonicalAlternativeSlot[];
  timezone: string;
}) {
  const inheritedDate = getDateForGroundedTemporalRequest({
    surface: params.surfaceFacts,
    enrichedIntent: params.enrichedIntent,
    storedContext: params.storedContext,
    originalRequestedDate: params.originalRequestedDate,
    offeredFallbackDate: params.offeredFallbackDate,
    alternatives: params.alternatives,
    timezone: params.timezone,
  });

  if (!inheritedDate) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "relative_clock_missing_unambiguous_calendar_date",
    };
  }

  const modelClock = params.enrichedIntent.localDateTime
    ? {
        hour: params.enrichedIntent.localDateTime.hour,
        minute: params.surface.anchorMinute,
      }
    : null;

  const anchorHour = resolveRelativeAnchorHour24({
    message: params.message,
    surface: params.surface,
    storedContext: params.storedContext,
    alternatives: params.alternatives,
    constrainedModelClock: modelClock,
    timezone: params.timezone,
  });

  if (anchorHour === null) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_clock_missing_unambiguous_meridian",
    };
  }

  const anchorCalendarDate =
    !params.surfaceFacts.hasDateSurface && params.surface.anchorHour24 === null
      ? resolveAmbiguousClockOccurrenceDate({
          baseDate: inheritedDate,
          resolvedHour24: anchorHour,
          minute: params.surface.anchorMinute,
          storedContext: params.storedContext,
          timezone: params.timezone,
        })
      : inheritedDate;

  const localDateTime = addLocalMinutes(
    anchorCalendarDate,
    anchorHour,
    params.surface.anchorMinute,
    params.surface.signedMinutes
  );

  if (
    params.surfaceFacts.sameDayReference &&
    !sameLocalDate(inheritedDate, localDateTime)
  ) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_clock_conflicts_with_same_day_constraint",
    };
  }

  const intent = buildExactIntent({
    base: params.baseIntent,
    localDateTime,
    timezone: params.timezone,
    customerSpecifiedDate: params.surfaceFacts.hasDateSurface,
    customerSpecifiedTime: true,
    displayPreference: params.message.trim(),
    interpretation:
      "Canonical temporal interpreter resolved literal before/after clock arithmetic from customer surface evidence before semantic-model clock output.",
  });

  if (!intent) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_clock_resolved_to_nonexistent_local_time",
    };
  }

  return {
    resolved: true,
    intent,
    reason: "relative_clock_resolved_from_customer_surface_and_active_context",
  };
}

function resolveAnchorlessRelativeAdjustmentIntent(params: {
  message: string;
  adjustment: RelativeAdjustmentSurface;
  surfaceFacts: TemporalSurfaceFacts;
  baseIntent: ResolvedSchedulingIntent;
  enrichedIntent: ResolvedSchedulingIntent;
  storedContext: CanonicalStoredSchedulingContext | null;
  pendingSlot: CanonicalPendingSlotMatch;
  alternatives: CanonicalAlternativeSlot[];
  timezone: string;
}) {
  let anchorIso: string | null = null;
  let anchorSource = "";

  if (
    params.surfaceFacts.optionReferenceIndex !== null &&
    params.alternatives[params.surfaceFacts.optionReferenceIndex]
  ) {
    anchorIso = params.alternatives[params.surfaceFacts.optionReferenceIndex].startTime;
    anchorSource = "explicit_offered_option";
  } else if (
    params.pendingSlot.matched &&
    params.pendingSlot.startTime &&
    /\b(?:option|slot|choice|opening|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|that\s+one|this\s+one)\b/.test(
      params.surfaceFacts.text
    )
  ) {
    anchorIso = params.pendingSlot.startTime;
    anchorSource = "matched_offered_option";
  } else {
    const storedPoint = getStoredPointTime(params.storedContext);
    if (storedPoint) {
      anchorIso = storedPoint;
      anchorSource = "active_exact_temporal_point";
    }
  }

  if (!anchorIso) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "relative_adjustment_missing_unique_anchor",
    };
  }

  const anchorDate = getLocalDateForIso(anchorIso, params.timezone);
  const anchorClock = getLocalClockForIso(anchorIso, params.timezone);
  if (!anchorDate || !anchorClock) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_adjustment_invalid_anchor",
    };
  }

  const groundedFreshDate =
    params.surfaceFacts.hasDateSurface && !params.surfaceFacts.sameDayReference
      ? getIntentCustomerDate(params.enrichedIntent, params.timezone)
      : null;

  /*
   * An anchorless edit may change both the calendar dimension and the relative
   * clock dimension in one turn: "tomorrow an hour later", "Saturday 45
   * minutes earlier". Use the grounded fresh date when one exists, but keep the
   * anchor's clock as the arithmetic base. Same-day references deliberately keep
   * the anchor calendar date.
   */
  const arithmeticBaseDate = groundedFreshDate ?? anchorDate;

  const localDateTime = addLocalMinutes(
    arithmeticBaseDate,
    anchorClock.hour,
    anchorClock.minute,
    params.adjustment.signedMinutes
  );

  if (
    params.surfaceFacts.sameDayReference &&
    !sameLocalDate(anchorDate, localDateTime)
  ) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_adjustment_conflicts_with_same_day_constraint",
    };
  }

  const intent = buildExactIntent({
    base: params.baseIntent,
    localDateTime,
    timezone: params.timezone,
    customerSpecifiedDate: params.surfaceFacts.hasDateSurface,
    customerSpecifiedTime: true,
    displayPreference: params.message.trim(),
    interpretation: `Canonical temporal interpreter applied relative clock adjustment to ${anchorSource}.`,
  });

  if (!intent) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_adjustment_resolved_to_nonexistent_local_time",
    };
  }

  return {
    resolved: true,
    intent,
    reason: `relative_adjustment_resolved_from_${anchorSource}`,
  };
}

/*
 * A relative weekday can qualify a shifted appointment context. Keep it as a
 * relation until the canonical layer has applied the calendar-unit change;
 * an upstream timestamp may have dropped that relation or used message time.
 * Resolve only an unambiguous compound edit here. Absolute dates, period
 * placement, alternatives, negations and explicit sequencing keep their
 * existing interpretation paths.
 */
function getShiftedContextFollowingWeekday(params: {
  message: string;
  surface: TemporalSurfaceFacts;
}): number | null {
  const { surface } = params;
  const text = normalizeText(params.message);
  if (
    surface.explicitWeekdayIndexes.length !== 1 ||
    surface.explicitYear !== null ||
    surface.explicitMonth !== null ||
    surface.explicitDayOfMonth !== null ||
    surface.sameDayReference ||
    surface.hasWindowConstraintSurface ||
    /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/.test(text) ||
    /\b(?:not|never|except|instead|or|either|then|now|today|tomorrow|yesterday)\b/.test(text) ||
    /\b(?:this|current)\s+(?:week|month|year)\b/.test(text) ||
    /\b(?:of|in|during)\s+(?:the\s+)?(?:next|following|previous|prior|last)\s+(?:week|month|year)\b/.test(text)
  ) return null;

  const weekday = WEEKDAY_PATTERNS.find(
    (candidate) => candidate.index === surface.explicitWeekdayIndexes[0]
  );
  if (!weekday) return null;
  const mentions = Array.from(text.matchAll(new RegExp(weekday.pattern.source, "g")));
  if (mentions.length !== 1) return null;
  const position = mentions[0].index;
  if (position === undefined) return null;
  return /\b(?:following|next)\s+$/.test(text.slice(0, position))
    ? weekday.index
    : null;
}

/*
 * A weekday related to a demonstrative appointment referent is an edit of
 * that appointment, not a weekday measured from message time. Translate the
 * relation to a local-date shift before any model-produced date can win.
 */
function getAppointmentRelativeWeekdayOperation(params: {
  surface: TemporalSurfaceFacts;
  activeAppointmentTime: string;
  timezone: string;
}): CanonicalTemporalOperation | null {
  const { surface } = params;
  const text = surface.text;
  if (
    surface.explicitWeekdayIndexes.length !== 1 ||
    surface.explicitYear !== null ||
    surface.explicitMonth !== null ||
    surface.explicitDayOfMonth !== null ||
    surface.hasWindowConstraintSurface ||
    /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/.test(text) ||
    /\b(?:not|never|except|instead|or|either|then|now|today|tomorrow|yesterday)\b/.test(text) ||
    /\b(?:days?|weeks?|months?|years?)\b/.test(text)
  ) return null;

  const weekday = WEEKDAY_PATTERNS.find(
    (candidate) => candidate.index === surface.explicitWeekdayIndexes[0]
  );
  if (!weekday) return null;
  const mentions = Array.from(text.matchAll(new RegExp(weekday.pattern.source, "g")));
  if (mentions.length !== 1) return null;
  const mention = mentions[0];
  const suffix = text.slice((mention.index ?? 0) + mention[0].length);
  const relation = suffix.match(
    /^\s+(after|before)\s+(?:that|it|(?:the|my|our|current|existing)\s+(?:appointment|booking|visit|date))\b/
  );
  const prefix = text.slice(0, mention.index ?? 0);
  if (/\b(?:first|second|third|fourth|fifth|penultimate|last\s+but\s+one)\s+$/.test(prefix)) return null;
  const qualifier = prefix.match(/\b(next|following|previous|prior|preceding|last|this)\s+$/);
  // A bare weekday inherits the booked date; explicit ordering is strict.
  // Other suffix relations ("after lunch", "of ...") stay with the existing
  // semantic resolver rather than being mistaken for appointment references.
  if (!relation && /\b(?:after|before|of|during|in|on)\b/.test(suffix)) return null;
  const remaining = relation ? suffix.slice(relation[0].length) : suffix;
  // Do not resolve "that other appointment" or an additional date relation.
  if (/^\s+(?:other|previous|original|cancelled|canceled|next|after|before|of|in|on)\b/.test(remaining)) return null;

  const anchor = getLocalDateForIso(params.activeAppointmentTime, params.timezone);
  if (!anchor) return null;
  const anchorWeekday = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day)).getUTCDay();
  const direction = relation?.[1] ??
    (/^(?:previous|prior|preceding|last)$/.test(qualifier?.[1] ?? "") ? "before" : "after");
  const strict = Boolean(relation) || /^(?:next|following|previous|prior|preceding|last)$/.test(qualifier?.[1] ?? "");
  const distance = direction === "after"
    ? (weekday.index - anchorWeekday + 7) % 7
    : (anchorWeekday - weekday.index + 7) % 7;
  const days = (direction === "after" ? 1 : -1) * (distance || (strict ? 7 : 0));
  return {
    kind: "shift",
    anchorKind: "active_appointment",
    optionNumber: null,
    years: 0,
    months: 0,
    weeks: 0,
    days,
    hours: 0,
    minutes: 0,
    setClock: null,
    preserveClock: true,
    confidence: 1,
  };
}

function resolveTemporalOperationIntent(params: {
  message: string;
  operation: CanonicalTemporalOperation;
  surfaceFacts: TemporalSurfaceFacts;
  baseIntent: ResolvedSchedulingIntent;
  enrichedIntent: ResolvedSchedulingIntent;
  storedContext: CanonicalStoredSchedulingContext | null;
  pendingSlot: CanonicalPendingSlotMatch;
  alternatives: CanonicalAlternativeSlot[];
  activeAppointmentTime?: string | null;
  referenceTime?: string | null;
  timezone: string;
  followingWeekday?: number | null;
}) {
  let anchorIso: string | null = null;
  let anchorSource:
    | CanonicalTemporalOperation["anchorKind"]
    | "matched_offered_option" = params.operation.anchorKind;

  const explicitOptionIndex = params.surfaceFacts.optionReferenceIndex;
  if (explicitOptionIndex !== null && params.alternatives[explicitOptionIndex]) {
    if (
      params.operation.anchorKind === "selected_offer" &&
      params.operation.optionNumber !== explicitOptionIndex + 1
    ) {
      return {
        resolved: false,
        intent: null as ResolvedSchedulingIntent | null,
        reason: "temporal_operation_option_anchor_conflicts_with_literal_option",
      };
    }
    anchorIso = params.alternatives[explicitOptionIndex].startTime;
    anchorSource = "selected_offer";
  } else if (params.operation.anchorKind === "selected_offer") {
    const optionIndex = (params.operation.optionNumber ?? 0) - 1;
    anchorIso = params.alternatives[optionIndex]?.startTime ?? null;
  } else if (params.operation.anchorKind === "active_appointment") {
    anchorIso = params.activeAppointmentTime ?? null;
  } else if (params.operation.anchorKind === "reference_now") {
    anchorIso = params.referenceTime ?? null;
  } else {
    anchorIso =
      params.activeAppointmentTime ??
      (params.pendingSlot.matched ? params.pendingSlot.startTime : null) ??
      getStoredPointTime(params.storedContext);
    anchorSource = params.activeAppointmentTime
      ? "active_appointment"
      : params.pendingSlot.matched && params.pendingSlot.startTime
        ? "matched_offered_option"
        : "active_temporal_context";
  }

  if (!anchorIso || !Number.isFinite(new Date(anchorIso).getTime())) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "temporal_operation_missing_authoritative_anchor",
    };
  }

  const anchorDate = getLocalDateForIso(anchorIso, params.timezone);
  const anchorClock = getLocalClockForIso(anchorIso, params.timezone);
  if (!anchorDate || !anchorClock) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "temporal_operation_invalid_authoritative_anchor",
    };
  }

  let shiftedDate = applyCalendarShift(
    anchorDate,
    params.operation.years,
    params.operation.months,
    params.operation.weeks,
    params.operation.days
  );

  if (params.followingWeekday !== null && params.followingWeekday !== undefined) {
    const shiftedWeekday = new Date(
      Date.UTC(shiftedDate.year, shiftedDate.month - 1, shiftedDate.day)
    ).getUTCDay();
    // Strictly following: a matching weekday advances seven local dates.
    const daysUntilWeekday = (params.followingWeekday - shiftedWeekday + 7) % 7 || 7;
    shiftedDate = applyCalendarShift(shiftedDate, 0, 0, 0, daysUntilWeekday);
  }

  let shiftedLocal = addLocalMinutes(
    shiftedDate,
    anchorClock.hour,
    anchorClock.minute,
    params.operation.hours * 60 + params.operation.minutes
  );

  let requestedClock = params.operation.setClock;
  if (!requestedClock && params.surfaceFacts.directClock) {
    const constrainedModelClock = params.enrichedIntent.localDateTime
      ? {
          hour: params.enrichedIntent.localDateTime.hour,
          minute: params.enrichedIntent.localDateTime.minute,
        }
      : null;
    const hour = resolveClockHour24({
      message: params.message,
      surface: params.surfaceFacts.directClock,
      storedContext: params.storedContext,
      alternatives: params.alternatives,
      constrainedModelClock,
      timezone: params.timezone,
    });
    if (hour !== null) {
      requestedClock = {
        hour,
        minute: params.surfaceFacts.directClock.minute,
      };
    }
  }

  if (requestedClock) {
    shiftedLocal = {
      ...shiftedLocal,
      hour: requestedClock.hour,
      minute: requestedClock.minute,
    };
  } else if (params.operation.preserveClock === false) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "temporal_operation_removed_clock_without_replacement",
    };
  }

  const dateShifted =
    params.operation.years !== 0 ||
    params.operation.months !== 0 ||
    params.operation.weeks !== 0 ||
    params.operation.days !== 0;
  const timeShifted =
    params.operation.hours !== 0 ||
    params.operation.minutes !== 0 ||
    Boolean(requestedClock);

  const intent = buildExactIntent({
    base: params.baseIntent,
    localDateTime: shiftedLocal,
    timezone: params.timezone,
    customerSpecifiedDate: dateShifted,
    customerSpecifiedTime: timeShifted,
    displayPreference: params.message.trim(),
    interpretation: `Canonical temporal interpreter applied structured temporal operation to ${anchorSource}.`,
  });

  if (!intent) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "temporal_operation_resolved_to_ambiguous_or_nonexistent_local_time",
    };
  }

  return {
    resolved: true,
    intent: {
      ...intent,
      yearReference:
        params.operation.years !== 0 ? "relative" : intent.yearReference,
      yearWasExplicit: false,
      temporalOperation: params.operation,
    },
    reason: `temporal_operation_resolved_from_${anchorSource}`,
  };
}

function resolveFromReferenceIntent(params: {
  message: string;
  surface: RelativeFromReferenceSurface;
  baseIntent: ResolvedSchedulingIntent;
  referenceTime: string | null | undefined;
  timezone: string;
}) {
  if (!params.referenceTime) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "relative_from_now_missing_reference_time",
    };
  }

  const referenceMs = new Date(params.referenceTime).getTime();
  if (!Number.isFinite(referenceMs)) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_from_now_invalid_reference_time",
    };
  }

  const startTime = new Date(
    referenceMs + params.surface.signedMinutes * 60_000
  ).toISOString();
  const date = getLocalDateForIso(startTime, params.timezone);
  const clock = getLocalClockForIso(startTime, params.timezone);
  if (!date || !clock) {
    return {
      resolved: false,
      intent: null,
      reason: "relative_from_now_could_not_project_local_time",
    };
  }

  return {
    resolved: true,
    intent: {
      ...params.baseIntent,
      hasPreference: true,
      allowedWindows: [{ startTime, endTime: null }],
      excludedWindows: [],
      selectionMode: "closest",
      targetTime: startTime,
      temporalGranularity: "date_time",
      customerSpecifiedDate: false,
      customerSpecifiedTime: true,
      localDateTime: { ...date, ...clock },
      displayPreference: params.message.trim(),
      interpretation:
        "Canonical temporal interpreter resolved literal duration-from-now against the supplied provider/inbound reference instant.",
      confidence: Math.max(Number(params.baseIntent.confidence ?? 0), 0.99),
    } satisfies ResolvedSchedulingIntent,
    reason: "relative_from_now_resolved_from_reference_time",
  };
}

function resolveDirectClockIntent(params: {
  message: string;
  surface: CanonicalClockSurface;
  surfaceFacts: TemporalSurfaceFacts;
  baseIntent: ResolvedSchedulingIntent;
  enrichedIntent: ResolvedSchedulingIntent;
  storedContext: CanonicalStoredSchedulingContext | null;
  originalRequestedDate: CanonicalLocalDate | null;
  offeredFallbackDate: CanonicalLocalDate | null;
  alternatives: CanonicalAlternativeSlot[];
  timezone: string;
  activeAppointmentDate?: CanonicalLocalDate | null;
}) {
  const appointmentOwnsMissingDate = Boolean(params.activeAppointmentDate) &&
    (!params.surfaceFacts.hasDateSurface || params.surfaceFacts.sameDayReference) &&
    !params.surfaceFacts.hasRelativeDateSurface &&
    params.surfaceFacts.explicitWeekdayIndexes.length === 0 &&
    params.surfaceFacts.explicitYear === null &&
    params.surfaceFacts.explicitMonth === null &&
    params.surfaceFacts.explicitDayOfMonth === null;
  const inheritedDate = appointmentOwnsMissingDate
    ? params.activeAppointmentDate
    : getDateForGroundedTemporalRequest({
    surface: params.surfaceFacts,
    enrichedIntent: params.enrichedIntent,
    storedContext: params.storedContext,
    originalRequestedDate: params.originalRequestedDate,
    offeredFallbackDate: params.offeredFallbackDate,
    alternatives: params.alternatives,
    timezone: params.timezone,
  });

  if (!inheritedDate) {
    return {
      resolved: false,
      intent: null as ResolvedSchedulingIntent | null,
      reason: "direct_clock_missing_unambiguous_calendar_date",
    };
  }

  const constrainedModelClock = params.enrichedIntent.localDateTime
    ? {
        hour: params.enrichedIntent.localDateTime.hour,
        minute: params.enrichedIntent.localDateTime.minute,
      }
    : null;

  const hour24 = resolveClockHour24({
    message: params.message,
    surface: params.surface,
    storedContext: params.storedContext,
    alternatives: params.alternatives,
    constrainedModelClock,
    timezone: params.timezone,
  });

  if (hour24 === null) {
    return {
      resolved: false,
      intent: null,
      reason: "direct_clock_missing_unambiguous_meridian",
    };
  }

  const targetCalendarDate =
    !appointmentOwnsMissingDate && !params.surfaceFacts.hasDateSurface && params.surface.hour24 === null
      ? resolveAmbiguousClockOccurrenceDate({
          baseDate: inheritedDate,
          resolvedHour24: hour24,
          minute: params.surface.minute,
          storedContext: params.storedContext,
          timezone: params.timezone,
        })
      : inheritedDate;

  const localDateTime = {
    ...targetCalendarDate,
    hour: hour24,
    minute: params.surface.minute,
  };

  const intent = buildExactIntent({
    base: params.baseIntent,
    localDateTime,
    timezone: params.timezone,
    customerSpecifiedDate: params.surfaceFacts.hasDateSurface,
    customerSpecifiedTime: true,
    displayPreference: params.message.trim(),
    interpretation:
      "Canonical temporal interpreter grounded the requested clock in customer surface evidence and inherited only an authoritative missing calendar dimension.",
  });

  if (!intent) {
    return {
      resolved: false,
      intent: null,
      reason: "direct_clock_resolved_to_nonexistent_local_time",
    };
  }

  return {
    resolved: true,
    intent,
    reason: "direct_clock_resolved_from_surface_and_active_context",
  };
}

function getStoredFrameDates(
  context: CanonicalStoredSchedulingContext | null,
  timezone: string
) {
  const dates = getStoredWindows(context)
    .map((window) => getLocalDateForIso(window.startTime, timezone))
    .filter((date): date is CanonicalLocalDate => Boolean(date));
  return dates;
}

function explicitClockMatchesStoredExactPoint(params: {
  clock: CanonicalClockSurface;
  message: string;
  context: CanonicalStoredSchedulingContext | null;
  alternatives: CanonicalAlternativeSlot[];
  enrichedIntent: ResolvedSchedulingIntent;
  timezone: string;
}) {
  const point = getStoredPointTime(params.context);
  if (!point) return false;
  const storedClock = getLocalClockForIso(point, params.timezone);
  if (!storedClock) return false;

  const resolvedHour = resolveClockHour24({
    message: params.message,
    surface: params.clock,
    storedContext: params.context,
    alternatives: params.alternatives,
    constrainedModelClock: params.enrichedIntent.localDateTime
      ? {
          hour: params.enrichedIntent.localDateTime.hour,
          minute: params.enrichedIntent.localDateTime.minute,
        }
      : null,
    timezone: params.timezone,
  });

  return (
    resolvedHour !== null &&
    resolvedHour === storedClock.hour &&
    params.clock.minute === storedClock.minute
  );
}

function surfaceClearlyChangesStoredFrame(params: {
  surface: TemporalSurfaceFacts;
  storedContext: CanonicalStoredSchedulingContext | null;
  enrichedIntent: ResolvedSchedulingIntent;
  alternatives: CanonicalAlternativeSlot[];
  timezone: string;
}) {
  if (!params.storedContext) return params.surface.hasAnyTemporalSurface;

  if (params.surface.relativeAdjustment || params.surface.relativeFromReference) {
    return true;
  }

  if (params.surface.hasWindowConstraintSurface) {
    return true;
  }

  if (params.surface.directClock) {
    return !explicitClockMatchesStoredExactPoint({
      clock: params.surface.directClock,
      message: params.surface.text,
      context: params.storedContext,
      alternatives: params.alternatives,
      enrichedIntent: params.enrichedIntent,
      timezone: params.timezone,
    });
  }

  if (params.surface.sameTimeReference && !params.surface.hasDateSurface) {
    return false;
  }

  if (params.surface.hasDaypartSurface) {
    const storedText = normalizeText(params.storedContext.displayPreference ?? "");
    const daypartTokens = [
      "morning",
      "breakfast",
      "brunch",
      "lunch",
      "noon",
      "afternoon",
      "dinner",
      "evening",
      "night",
    ];
    const newest = daypartTokens.filter((token) => params.surface.text.includes(token));
    if (newest.length === 0 || !newest.every((token) => storedText.includes(token))) {
      return true;
    }
  }

  if (params.surface.hasRelativeDateSurface && !params.surface.sameDayReference) {
    return true;
  }

  if (params.surface.hasDateSurface) {
    const storedDates = getStoredFrameDates(params.storedContext, params.timezone);
    const groundedDate = getIntentCustomerDate(params.enrichedIntent, params.timezone);

    if (groundedDate && storedDates.length > 0) {
      return !storedDates.some((date) => sameLocalDate(date, groundedDate));
    }

    if (params.surface.explicitWeekdayIndexes.length > 0 && storedDates.length > 0) {
      const storedWeekdays = new Set(
        getStoredWindows(params.storedContext)
          .map((window) =>
            getLocalWeekdayIndexForIso(window.startTime, params.timezone)
          )
          .filter((value): value is number => value !== null)
      );
      const allMentionedAreAlreadyInFrame = params.surface.explicitWeekdayIndexes.every(
        (weekday) => storedWeekdays.has(weekday)
      );
      if (allMentionedAreAlreadyInFrame) return false;
      return true;
    }

    if (params.surface.sameDayReference) return false;

    if (
      params.surface.explicitMonth !== null ||
      params.surface.explicitDayOfMonth !== null ||
      params.surface.explicitYear !== null
    ) {
      return true;
    }
  }

  return false;
}

function buildPreservedStoredFrameIntent(params: {
  base: ResolvedSchedulingIntent;
  context: CanonicalStoredSchedulingContext;
  timezone: string;
}) {
  const allowedWindows = getStoredWindows(params.context);
  const excludedWindows = getStoredExcludedWindows(params.context);
  const targetTime =
    params.context.targetTime &&
    Number.isFinite(new Date(params.context.targetTime).getTime())
      ? params.context.targetTime
      : allowedWindows.length === 1 && !allowedWindows[0].endTime
        ? allowedWindows[0].startTime
        : null;

  const firstStart = allowedWindows[0]?.startTime ?? params.context.requestedStartTime;
  const startDate = getLocalDateForIso(firstStart, params.timezone);
  const startClock = getLocalClockForIso(firstStart, params.timezone);
  const hasBoundedOrMultipleWindow =
    allowedWindows.length > 1 || allowedWindows.some((window) => Boolean(window.endTime));

  return {
    ...params.base,
    hasPreference: allowedWindows.length > 0 || Boolean(targetTime),
    allowedWindows,
    excludedWindows,
    selectionMode:
      params.context.selectionMode ??
      (hasBoundedOrMultipleWindow ? "earliest" : "closest"),
    targetTime,
    temporalGranularity: hasBoundedOrMultipleWindow ? "window" : "date_time",
    customerSpecifiedDate: false,
    customerSpecifiedTime: false,
    localDateTime:
      !hasBoundedOrMultipleWindow && startDate && startClock
        ? { ...startDate, ...startClock }
        : null,
    displayPreference:
      params.context.displayPreference ??
      params.base.displayPreference ??
      params.base.originalPreference ??
      null,
    interpretation:
      "Canonical temporal interpreter preserved the complete active scheduling frame because the newest availability follow-up introduced no new temporal constraint.",
  } satisfies ResolvedSchedulingIntent;
}

function semanticCandidateIsGrounded(params: {
  surface: TemporalSurfaceFacts;
  commandFresh: boolean;
  enrichedIntent: ResolvedSchedulingIntent;
}) {
  if (!params.enrichedIntent.hasPreference) return false;
  if (params.commandFresh) return true;
  if (params.surface.hasAnyTemporalSurface) return true;
  return false;
}

function makeAmbiguousIntent(
  base: ResolvedSchedulingIntent,
  interpretation: string
) {
  return suppressSemanticTemporalIntent(base, interpretation);
}

export function resolveCanonicalTemporalIntent(
  input: ResolveCanonicalTemporalIntentInput
): CanonicalTemporalIntent {
  let schedulingIntent = input.enrichedSchedulingIntent;
  let pendingSlotMatch = { ...input.pendingSlotCandidate };
  const reasons: string[] = [];
  const storedSchedulingContext = input.storedSchedulingContext ?? null;

  const surface = analyzeTemporalSurface(
    input.message,
    input.pendingAlternatives.length
  );

  const commandFresh =
    input.bookingCommandHasFreshTemporalConstraint === true;

  const readOnlyAvailabilityTurn =
    input.bookingCommandKind === "show_availability";

  /*
   * NEGATION SAFETY
   *
   * A persisted option candidate cannot survive explicit rejection in the
   * newest customer words. This is temporal reference resolution only; it does
   * not authorize or cancel anything.
   */
  if (
    pendingSlotExplicitlyNegated({
      message: input.message,
      pendingSlot: pendingSlotMatch,
      alternatives: input.pendingAlternatives,
    })
  ) {
    pendingSlotMatch = emptyPendingMatch(
      "explicit_customer_negation_rejected_pending_option"
    );
    reasons.push("rejected_explicitly_negated_pending_option");
  }

  if (input.pendingMatchConflictsWithLiteralTemporalSurface) {
    pendingSlotMatch = emptyPendingMatch(
      "pending_option_conflicts_with_literal_customer_temporal_surface"
    );
    reasons.push("rejected_conflicting_pending_option");
  }

  /*
   * DETERMINISTIC TEMPORAL EXPRESSIONS
   *
   * These are parsed from the customer's actual words before any model-produced
   * timestamp may win. Unknown/ambiguous forms fail closed instead of falling
   * back to a contradictory semantic timestamp.
   */
  let deterministicResolved = false;
  let deterministicUnresolved = false;
  let deterministicSource: CanonicalTemporalIntent["source"] | null = null;
  let deterministicReason: string | null = null;

  const rawDeterministicCalendarShift = extractCalendarTransformSurface(
    input.message
  );

  /*
   * A descriptive calendar phrase such as "December next year" is an
   * absolute/semantic date request, not an edit of the active appointment.
   * Bare relative-year grammar becomes a transform only when the turn names
   * an authoritative offer anchor or does not also name a concrete calendar
   * month/day. This prevents transform parsing from stealing normal absolute
   * date phrases while preserving "option 1 next year" and "move it next
   * year".
   */
  const deterministicCalendarShift = (() => {
    const candidate = rawDeterministicCalendarShift;
    if (!candidate) return null;

    const yearOnly =
      candidate.years !== 0 &&
      candidate.months === 0 &&
      candidate.weeks === 0 &&
      candidate.days === 0;
    const descriptiveNamedCalendarDate =
      surface.explicitMonth !== null || surface.explicitDayOfMonth !== null;

    if (
      yearOnly &&
      descriptiveNamedCalendarDate &&
      surface.optionReferenceIndex === null
    ) {
      return null;
    }

    return candidate;
  })();

  const enrichedTemporalOperation =
    input.enrichedSchedulingIntent.temporalOperation ?? null;

  /*
   * ACTIVE-APPOINTMENT PRESERVED-CLOCK PROJECTION
   *
   * processInboundEmail may carry the authoritative active appointment's LOCAL
   * clock structurally in temporalOperation.setClock when a pure calendar-unit
   * reschedule says to keep the same time. That setClock is not a new customer
   * clock claim, so requiring a literal clock surface here would incorrectly
   * discard an otherwise well-grounded operation such as a weeks/months shift.
   *
   * Accept that projection only when all safety facts agree:
   *   - the operation is anchored to the active appointment;
   *   - it contains a real calendar-date shift;
   *   - it contains no elapsed hours/minutes shift;
   *   - preserveClock is explicitly true;
   *   - no new literal customer clock is present; and
   *   - setClock exactly equals the authoritative active appointment's local
   *     clock in the company timezone.
   *
   * The operation must STILL pass every other literal-support check after that
   * verified preservation clock is removed from the support test. This does not
   * weaken option anchors, date-unit grounding, direction grounding, or explicit
   * replacement-clock validation.
   */
  const activeAppointmentClockForPreservation =
    input.activeAppointmentTime
      ? getLocalClockForIso(input.activeAppointmentTime, input.timezone)
      : null;

  const verifiedActiveAppointmentClockProjection = Boolean(
    enrichedTemporalOperation &&
      enrichedTemporalOperation.anchorKind === "active_appointment" &&
      (enrichedTemporalOperation.years !== 0 ||
        enrichedTemporalOperation.months !== 0 ||
        enrichedTemporalOperation.weeks !== 0 ||
        enrichedTemporalOperation.days !== 0) &&
      enrichedTemporalOperation.hours === 0 &&
      enrichedTemporalOperation.minutes === 0 &&
      enrichedTemporalOperation.preserveClock === true &&
      enrichedTemporalOperation.setClock &&
      !surface.directClock &&
      activeAppointmentClockForPreservation &&
      enrichedTemporalOperation.setClock.hour ===
        activeAppointmentClockForPreservation.hour &&
      enrichedTemporalOperation.setClock.minute ===
        activeAppointmentClockForPreservation.minute
  );

  const modelTemporalOperation =
    enrichedTemporalOperation &&
    enrichedTemporalOperation.confidence >= 0.7 &&
    (
      operationHasLiteralSupport({
        operation: enrichedTemporalOperation,
        surface,
        message: input.message,
      }) ||
      (
        verifiedActiveAppointmentClockProjection &&
        operationHasLiteralSupport({
          operation: {
            ...enrichedTemporalOperation,
            setClock: null,
          },
          surface,
          message: input.message,
        })
      )
    )
      ? enrichedTemporalOperation
      : null;

  const appointmentRelativeWeekdayOperation =
    input.bookingCommandKind === "reschedule" &&
    input.activeAppointmentTime &&
    !deterministicCalendarShift
      ? getAppointmentRelativeWeekdayOperation({
          surface,
          activeAppointmentTime: input.activeAppointmentTime,
          timezone: input.timezone,
        })
      : null;

  const calendarTransformOperation: CanonicalTemporalOperation | null =
    appointmentRelativeWeekdayOperation ?? (deterministicCalendarShift
      ? {
          kind: "shift",
          anchorKind:
            surface.optionReferenceIndex !== null
              ? "selected_offer"
              : input.activeAppointmentTime
                ? "active_appointment"
                : "active_temporal_context",
          optionNumber:
            surface.optionReferenceIndex !== null
              ? surface.optionReferenceIndex + 1
              : null,
          years: deterministicCalendarShift.years,
          months: deterministicCalendarShift.months,
          weeks: deterministicCalendarShift.weeks,
          days: deterministicCalendarShift.days,
          hours: modelTemporalOperation?.hours ?? 0,
          minutes: modelTemporalOperation?.minutes ?? 0,
          setClock: modelTemporalOperation?.setClock ?? null,
          preserveClock: modelTemporalOperation?.preserveClock ?? true,
          confidence: Math.max(modelTemporalOperation?.confidence ?? 0, 0.99),
        }
      : modelTemporalOperation);

  if (calendarTransformOperation) {
    const result = resolveTemporalOperationIntent({
      message: input.message,
      operation: calendarTransformOperation,
      surfaceFacts: surface,
      baseIntent: input.enrichedSchedulingIntent,
      enrichedIntent: input.enrichedSchedulingIntent,
      storedContext: storedSchedulingContext,
      pendingSlot: pendingSlotMatch,
      alternatives: input.pendingAlternatives,
      activeAppointmentTime: input.activeAppointmentTime,
      referenceTime: input.referenceTime,
      timezone: input.timezone,
      followingWeekday:
        input.bookingCommandKind === "reschedule" &&
        input.activeAppointmentTime &&
        calendarTransformOperation.anchorKind === "active_appointment" &&
        deterministicCalendarShift
          ? getShiftedContextFollowingWeekday({ message: input.message, surface })
          : null,
    });

    if (result.resolved && result.intent) {
      schedulingIntent = result.intent;
      deterministicResolved = true;
      deterministicSource = "calendar_transform_expression";
      deterministicReason = result.reason;
    } else {
      deterministicUnresolved = true;
      deterministicSource = "relative_clock_ambiguous";
      deterministicReason = result.reason;
    }
  }

  const anchoredRelative = extractRelativeClockSurface(input.message);
  const relativeAdjustment = surface.relativeAdjustment;
  const relativeFromReference = surface.relativeFromReference;

  const latestRelativeKind = (() => {
    const candidates: Array<{
      kind: "adjustment" | "from_reference";
      index: number;
    }> = [];
    if (relativeAdjustment) {
      candidates.push({ kind: "adjustment", index: relativeAdjustment.index });
    }
    if (relativeFromReference) {
      candidates.push({ kind: "from_reference", index: relativeFromReference.index });
    }
    candidates.sort((a, b) => a.index - b.index);
    return candidates.length > 0 ? candidates[candidates.length - 1].kind : null;
  })();

  if (
    !deterministicResolved &&
    !deterministicUnresolved &&
    latestRelativeKind === "adjustment" &&
    relativeAdjustment
  ) {
    if (!relativeAdjustment.anchorless && anchoredRelative) {
      const result = resolveAnchoredRelativeClockIntent({
        message: input.message,
        surface: anchoredRelative,
        surfaceFacts: surface,
        baseIntent: input.enrichedSchedulingIntent,
        enrichedIntent: input.enrichedSchedulingIntent,
        storedContext: storedSchedulingContext,
        originalRequestedDate: input.originalRequestedDate,
        offeredFallbackDate: input.offeredFallbackDate,
        alternatives: input.pendingAlternatives,
        timezone: input.timezone,
      });

      if (result.resolved && result.intent) {
        schedulingIntent = result.intent;
        deterministicResolved = true;
        deterministicSource = "relative_clock_expression";
        deterministicReason = result.reason;
      } else {
        deterministicUnresolved = true;
        deterministicSource = "relative_clock_ambiguous";
        deterministicReason = result.reason;
      }
    } else {
      const result = resolveAnchorlessRelativeAdjustmentIntent({
        message: input.message,
        adjustment: relativeAdjustment,
        surfaceFacts: surface,
        baseIntent: input.enrichedSchedulingIntent,
        enrichedIntent: input.enrichedSchedulingIntent,
        storedContext: storedSchedulingContext,
        pendingSlot: pendingSlotMatch,
        alternatives: input.pendingAlternatives,
        timezone: input.timezone,
      });

      if (result.resolved && result.intent) {
        schedulingIntent = result.intent;
        deterministicResolved = true;
        deterministicSource = "relative_adjustment_expression";
        deterministicReason = result.reason;
      } else {
        deterministicUnresolved = true;
        deterministicSource = "relative_clock_ambiguous";
        deterministicReason = result.reason;
      }
    }
  } else if (
    !deterministicResolved &&
    !deterministicUnresolved &&
    latestRelativeKind === "from_reference" &&
    relativeFromReference
  ) {
    const result = resolveFromReferenceIntent({
      message: input.message,
      surface: relativeFromReference,
      baseIntent: input.enrichedSchedulingIntent,
      referenceTime: input.referenceTime,
      timezone: input.timezone,
    });

    if (result.resolved && result.intent) {
      schedulingIntent = result.intent;
      deterministicResolved = true;
      deterministicSource = "relative_from_reference";
      deterministicReason = result.reason;
    } else {
      deterministicUnresolved = true;
      deterministicSource = "relative_clock_ambiguous";
      deterministicReason = result.reason;
    }
  }

  /*
   * A direct customer clock (2:30, eight thirty, half past two, etc.) is also
   * canonicalized here. A weak bare form such as "do 1" is deliberately left
   * to an already-matched offered option so option numbers are not stolen by the
   * clock parser.
   */
  const directClockIsWeakPendingOptionCollision =
    !deterministicResolved &&
    !deterministicUnresolved &&
    Boolean(surface.directClock) &&
    surface.directClock?.strength === "contextual" &&
    pendingSlotMatch.matched &&
    surface.optionReferenceIndex === null &&
    !surface.hasDaypartSurface &&
    !/:\d{2}\b/.test(surface.text) &&
    !/\b(?:am|pm|noon|midnight|half\s+past|quarter\s+(?:past|to))\b/.test(
      surface.text
    );

  /*
   * If the newest direct clock is already proven compatible with one exact
   * persisted offer, preserve offered-slot ownership. This prevents the
   * canonical clock interpreter from downgrading a working option confirmation
   * into a generic fresh-time request. Relative edits still outrank the offer.
   */
  const directClockIsCompatibleOfferedSelection =
    !deterministicResolved &&
    !deterministicUnresolved &&
    Boolean(surface.directClock) &&
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    input.compatiblePendingOfferedSlotOwnsTurn;

  if (
    !deterministicResolved &&
    !deterministicUnresolved &&
    surface.directClock &&
    surface.clockSurfaceCount === 1 &&
    !surface.hasWindowConstraintSurface &&
    !directClockIsWeakPendingOptionCollision &&
    !directClockIsCompatibleOfferedSelection
  ) {
    const result = resolveDirectClockIntent({
      message: input.message,
      surface: surface.directClock,
      surfaceFacts: surface,
      baseIntent: input.enrichedSchedulingIntent,
      enrichedIntent: input.enrichedSchedulingIntent,
      storedContext: storedSchedulingContext,
      originalRequestedDate: input.originalRequestedDate,
      offeredFallbackDate: input.offeredFallbackDate,
      alternatives: input.pendingAlternatives,
      timezone: input.timezone,
      activeAppointmentDate:
        input.bookingCommandKind === "reschedule"
          ? getLocalDateForIso(input.activeAppointmentTime, input.timezone)
          : null,
    });

    if (result.resolved && result.intent) {
      schedulingIntent = result.intent;
      deterministicResolved = true;
      deterministicSource = "direct_clock_expression";
      deterministicReason = result.reason;
    } else {
      deterministicUnresolved = true;
      deterministicSource = "relative_clock_ambiguous";
      deterministicReason = result.reason;
    }
  }

  if (deterministicResolved) {
    pendingSlotMatch = emptyPendingMatch(
      "canonical_customer_temporal_expression_overrides_pending_option"
    );
    reasons.push(
      deterministicReason ?? "resolved_canonical_customer_temporal_expression"
    );
  }

  if (deterministicUnresolved) {
    schedulingIntent = makeAmbiguousIntent(
      input.enrichedSchedulingIntent,
      "Customer temporal language was explicit but could not be resolved from one unambiguous authoritative scheduling context."
    );
    pendingSlotMatch = emptyPendingMatch(
      deterministicReason ?? "canonical_temporal_expression_requires_clarification",
      "medium"
    );
    reasons.push(
      deterministicReason ?? "canonical_temporal_expression_requires_clarification"
    );
  }

  /*
   * COMPLETE ACTIVE-FRAME PRESERVATION
   *
   * For a read-only availability turn, preserve the whole active frame whenever
   * the customer's literal temporal surface does not actually change that frame —
   * including multiple allowed windows and exclusions — unless the customer's
   * literal surface clearly changes it. Model hallucinations are not allowed to
   * defeat this rule.
   */
  const literalSurfaceChangesFrame = surfaceClearlyChangesStoredFrame({
    surface,
    storedContext: storedSchedulingContext,
    enrichedIntent: input.enrichedSchedulingIntent,
    alternatives: input.pendingAlternatives,
    timezone: input.timezone,
  });

  const preserveStoredFrame =
    !deterministicResolved &&
    !deterministicUnresolved &&
    Boolean(storedSchedulingContext) &&
    readOnlyAvailabilityTurn &&
    !literalSurfaceChangesFrame;

  if (preserveStoredFrame && storedSchedulingContext) {
    schedulingIntent = buildPreservedStoredFrameIntent({
      base: input.enrichedSchedulingIntent,
      context: storedSchedulingContext,
      timezone: input.timezone,
    });
    reasons.push("preserved_complete_active_scheduling_frame");
  }

  /*
   * PERSISTED OFFER OWNERSHIP
   *
   * An exact offered slot owns the temporal referent only when no deterministic
   * fresh customer expression or preserved read-only frame already owns it.
   */
  const pendingConfirmationOwnsTurn =
    !deterministicResolved &&
    !deterministicUnresolved &&
    !preserveStoredFrame &&
    pendingSlotMatch.matched &&
    pendingSlotMatch.confidence === "high" &&
    (
      !input.groundedTemporalSurfaceEvidence ||
      input.contextualPendingOptionOwnsTurn ||
      input.compatiblePendingOfferedSlotOwnsTurn ||
      surface.optionReferenceIndex !== null ||
      directClockIsWeakPendingOptionCollision
    );

  if (pendingConfirmationOwnsTurn) {
    schedulingIntent = suppressSemanticTemporalIntent(
      input.enrichedSchedulingIntent,
      "Active persisted offered-slot reference owns the temporal referent for this turn."
    );
    reasons.push("pending_offer_owns_turn");
  }

  /*
   * SEMANTIC/FUZZY TEMPORAL CANDIDATE VALIDATION
   *
   * The semantic scheduler remains valuable for fuzzy language such as
   * "around lunch", "after breakfastish", month/week ranges, relative weekdays,
   * and composed date phrases. But a semantic candidate is allowed to survive
   * only when the customer's actual surface contains temporal evidence OR the
   * canonical booking command explicitly says the temporal frame is fresh.
   * Model-only dates/times can never create a fresh override.
   */
  const semanticGrounded = semanticCandidateIsGrounded({
    surface,
    commandFresh,
    enrichedIntent: input.enrichedSchedulingIntent,
  });

  if (
    !deterministicResolved &&
    !deterministicUnresolved &&
    !preserveStoredFrame &&
    !pendingConfirmationOwnsTurn
  ) {
    if (input.enrichedSchedulingIntent.hasPreference && !semanticGrounded) {
      schedulingIntent = suppressSemanticTemporalIntent(
        input.enrichedSchedulingIntent,
        "Semantic temporal candidate was discarded because the newest customer words supplied no grounded temporal evidence."
      );
      reasons.push("discarded_ungrounded_semantic_temporal_candidate");
    } else {
      schedulingIntent = input.enrichedSchedulingIntent;
    }
  }

  /*
   * If the semantic resolver claims time_only without an actual customer clock
   * or an explicit same-time reference, it cannot manufacture a clock.
   */
  const semanticTimeOnlyUngrounded =
    !deterministicResolved &&
    !deterministicUnresolved &&
    !pendingConfirmationOwnsTurn &&
    !preserveStoredFrame &&
    schedulingIntent.hasPreference &&
    schedulingIntent.temporalGranularity === "time_only" &&
    !surface.hasClockSurface;

  if (semanticTimeOnlyUngrounded) {
    schedulingIntent = suppressSemanticTemporalIntent(
      schedulingIntent,
      "Ungrounded time-only semantic claim was discarded because the customer supplied no clock or same-time reference."
    );
    reasons.push("discarded_ungrounded_time_only_claim");
  }

  const semanticFreshOverride =
    !deterministicResolved &&
    !deterministicUnresolved &&
    !preserveStoredFrame &&
    !pendingConfirmationOwnsTurn &&
    schedulingIntent.hasPreference &&
    schedulingIntent.temporalGranularity !== "time_only" &&
    semanticGrounded &&
    (
      commandFresh ||
      surface.hasAnyTemporalSurface
    ) &&
    (
      schedulingIntent.allowedWindows.length > 0 ||
      Boolean(schedulingIntent.targetTime) ||
      schedulingIntent.customerSpecifiedDate
    );

  const hasCompleteFreshTemporalOverride =
    deterministicResolved || semanticFreshOverride;

  if (hasCompleteFreshTemporalOverride && !pendingConfirmationOwnsTurn) {
    pendingSlotMatch = emptyPendingMatch(
      deterministicResolved
        ? "canonical_customer_temporal_expression_overrides_pending_options"
        : "grounded_fresh_scheduling_preference_overrides_pending_options"
    );
    reasons.push(
      deterministicResolved
        ? "canonical_temporal_expression_is_fresh_override"
        : "grounded_fresh_temporal_request_overrode_pending_options"
    );
  }

  /*
   * LAST-RESORT LEGACY FALLBACK
   *
   * This is intentionally unable to compete with canonical surface parsing,
   * preserved context, or offered-slot ownership.
   */
  let forcedBookingWindow: CanonicalLegacyFallbackWindow =
    deterministicResolved ||
    deterministicUnresolved ||
    preserveStoredFrame ||
    pendingConfirmationOwnsTurn ||
    schedulingIntent.hasPreference
      ? { start: null, end: null }
      : input.legacyFallbackWindow;

  if (
    !pendingSlotMatch.matched &&
    forcedBookingWindow.start &&
    input.pendingAlternatives.length > 0
  ) {
    const exactOfferedSlot = input.pendingAlternatives.find((slot) =>
      slotTimesMatchWithinOneMinute(
        forcedBookingWindow.start,
        slot.startTime
      )
    );

    if (exactOfferedSlot) {
      pendingSlotMatch = {
        matched: true,
        startTime: exactOfferedSlot.startTime,
        endTime: exactOfferedSlot.endTime ?? null,
        reason: "matched_exact_offered_time_fallback",
        confidence: "high",
      };
      reasons.push("legacy_fallback_matched_exact_persisted_offer");
    }
  }

  const isTimeOnlySchedulingPreference =
    deterministicResolved
      ? !surface.hasDateSurface && Boolean(surface.hasClockSurface || relativeAdjustment)
      : schedulingIntent.hasPreference &&
        schedulingIntent.customerSpecifiedTime === true &&
        schedulingIntent.customerSpecifiedDate === false;

  const unresolvedTimeOnlyPreference =
    deterministicUnresolved ||
    (
      schedulingIntent.hasPreference &&
      schedulingIntent.temporalGranularity === "time_only" &&
      !schedulingIntent.targetTime
    );

  if (unresolvedTimeOnlyPreference) {
    pendingSlotMatch = emptyPendingMatch(
      deterministicReason ?? "time_only_preference_requires_unambiguous_context",
      "medium"
    );
    forcedBookingWindow = { start: null, end: null };
    if (!deterministicReason) {
      reasons.push("time_only_requires_unambiguous_active_context");
    }
  }

  const source: CanonicalTemporalIntent["source"] =
    deterministicSource ??
    (preserveStoredFrame
      ? "preserved_active_frame"
      : pendingConfirmationOwnsTurn && pendingSlotMatch.matched
        ? "pending_offered_slot"
        : semanticFreshOverride
          ? "fresh_temporal_request"
          : isTimeOnlySchedulingPreference && schedulingIntent.hasPreference
            ? "time_only_context"
            : schedulingIntent.hasPreference
              ? "semantic_temporal"
              : forcedBookingWindow.start
                ? "legacy_fallback"
                : "none");

  return {
    schedulingIntent,
    pendingSlotMatch,
    pendingConfirmationOwnsTurn,
    hasCompleteFreshTemporalOverride,
    isTimeOnlySchedulingPreference,
    forcedBookingWindow,
    unresolvedTimeOnlyPreference,
    source,
    reasons,
  };
}