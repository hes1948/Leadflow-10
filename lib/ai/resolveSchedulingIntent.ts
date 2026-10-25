/// lib/ai/resolveSchedulingIntent.ts

import OpenAI from "openai";
import { zonedTimeToUtc } from "@/lib/time/companyTime";

export type SchedulingSelectionMode =
  | "chronological"
  | "earliest"
  | "closest";

export type SchedulingTimeWindow = {
  startTime: string;
  endTime: string | null;
};

export type SchedulingTemporalGranularity =
  | "none"
  | "time_only"
  | "date_only"
  | "date_time"
  | "window";

export type SchedulingYearReference =
  | "unspecified"
  | "relative"
  | "absolute";

export type SchedulingLocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type SchedulingTemporalAnchorKind =
  | "selected_offer"
  | "active_appointment"
  | "active_temporal_context"
  | "reference_now";

/*
 * Relative scheduling edits are represented as OPERATIONS, not guessed final
 * timestamps. The canonical temporal layer resolves the authoritative anchor
 * and performs calendar math deterministically. This is additive/backward-
 * compatible: existing absolute scheduling fields remain unchanged.
 */
export type SchedulingTemporalOperation = {
  kind: "shift";
  anchorKind: SchedulingTemporalAnchorKind;
  optionNumber: number | null;
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  setClock: { hour: number; minute: number } | null;
  preserveClock: boolean;
  confidence: number;
};

export type ResolvedSchedulingIntent = {
  hasPreference: boolean;
  allowedWindows: SchedulingTimeWindow[];
  excludedWindows: SchedulingTimeWindow[];
  selectionMode: SchedulingSelectionMode;
  targetTime: string | null;
  strict: boolean;
  displayPreference: string | null;
  originalPreference: string | null;
  interpretation: string | null;
  confidence: number;

  /*
    These fields describe what temporal dimensions the CUSTOMER actually
    supplied. They are deliberately separate from allowedWindows/targetTime,
    because an inferred timestamp must not masquerade as an explicit date.
  */
  temporalGranularity: SchedulingTemporalGranularity;
  customerSpecifiedDate: boolean;
  customerSpecifiedTime: boolean;

  /*
    Backward-compatible absolute-year signal. This is true only when the
    newest customer message explicitly supplies a concrete calendar year.
  */
  yearWasExplicit: boolean;

  /*
    Distinguishes:
      unspecified -> no year semantics were supplied by the customer
      relative    -> the customer constrained the year relative to the
                     supplied reference instant / temporal anchor
      absolute    -> the customer supplied a concrete calendar year

    This prevents relative-year language from being mistaken for an omitted
    year while keeping omitted-year rollover deterministic.
  */
  yearReference: SchedulingYearReference;

  localDateTime: SchedulingLocalDateTime | null;

  /*
   * Optional semantic operation for relative edits such as:
   * - "option 3 the month after"
   * - "move it forward three days at 2 pm"
   * - "two weeks before my appointment"
   *
   * This field never authorizes a booking mutation; it only describes WHEN.
   */
  temporalOperation?: SchedulingTemporalOperation | null;
};

type ResolveSchedulingIntentInput = {
  message: string;
  timezone: string;
  referenceTime?: string | null;
  availabilityContext?: { offeredSlots: Array<{ startTime: string; endTime?: string | null }> } | null;
};

const MODEL =
  process.env.LEADFLOW_SCHEDULING_MODEL ||
  "gpt-4o-mini";

let client: OpenAI | null = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

function emptyIntent(
  originalPreference: string | null = null
): ResolvedSchedulingIntent {
  return {
    hasPreference: false,
    allowedWindows: [],
    excludedWindows: [],
    selectionMode: "chronological",
    targetTime: null,
    strict: false,
    displayPreference: null,
    originalPreference,
    interpretation: null,
    confidence: 0,
    temporalGranularity: "none",
    customerSpecifiedDate: false,
    customerSpecifiedTime: false,
    yearWasExplicit: false,
    yearReference: "unspecified",
    localDateTime: null,
    temporalOperation: null,
  };
}

function validIso(value: unknown) {
  if (typeof value !== "string") return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

function normalizeWindow(value: any): SchedulingTimeWindow | null {
  if (!value || typeof value !== "object") return null;

  const startTime = validIso(value.startTime);
  if (!startTime) return null;

  const endTime =
    value.endTime === null || value.endTime === undefined
      ? null
      : validIso(value.endTime);

  if (
    endTime &&
    new Date(endTime).getTime() <= new Date(startTime).getTime()
  ) {
    return null;
  }

  return { startTime, endTime };
}

function normalizeLocalDateTime(
  value: any
): SchedulingLocalDateTime | null {
  if (!value || typeof value !== "object") return null;

  const year = Number(value.year);
  const month = Number(value.month);
  const day = Number(value.day);
  const hour = Number(value.hour);
  const minute = Number(value.minute);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return { year, month, day, hour, minute };
}

function normalizeYearReference(
  raw: any
): SchedulingYearReference {
  if (
    raw?.yearReference === "relative" ||
    raw?.yearReference === "absolute"
  ) {
    return raw.yearReference;
  }

  return "unspecified";
}

function normalizeTemporalOperation(
  value: any
): SchedulingTemporalOperation | null {
  if (!value || typeof value !== "object" || value.kind !== "shift") {
    return null;
  }

  const anchorKind = value.anchorKind as SchedulingTemporalAnchorKind;
  if (
    anchorKind !== "selected_offer" &&
    anchorKind !== "active_appointment" &&
    anchorKind !== "active_temporal_context" &&
    anchorKind !== "reference_now"
  ) {
    return null;
  }

  const clampInteger = (raw: unknown, min: number, max: number) => {
    const number = Number(raw);
    if (!Number.isFinite(number)) return 0;
    return Math.max(min, Math.min(max, Math.trunc(number)));
  };

  const optionNumberRaw = Number(value.optionNumber);
  const optionNumber =
    anchorKind === "selected_offer" &&
    Number.isInteger(optionNumberRaw) &&
    optionNumberRaw >= 1 &&
    optionNumberRaw <= 100
      ? optionNumberRaw
      : null;

  if (anchorKind === "selected_offer" && optionNumber === null) {
    return null;
  }

  const setClock = (() => {
    if (!value.setClock || typeof value.setClock !== "object") return null;
    const hour = Number(value.setClock.hour);
    const minute = Number(value.setClock.minute);
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return { hour, minute };
  })();

  const confidenceRaw = Number(value.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;

  const operation: SchedulingTemporalOperation = {
    kind: "shift",
    anchorKind,
    optionNumber,
    years: clampInteger(value.years, -20, 20),
    months: clampInteger(value.months, -240, 240),
    weeks: clampInteger(value.weeks, -1040, 1040),
    days: clampInteger(value.days, -7300, 7300),
    hours: clampInteger(value.hours, -87600, 87600),
    minutes: clampInteger(value.minutes, -5256000, 5256000),
    setClock,
    preserveClock: value.preserveClock !== false,
    confidence,
  };

  const hasShift =
    operation.years !== 0 ||
    operation.months !== 0 ||
    operation.weeks !== 0 ||
    operation.days !== 0 ||
    operation.hours !== 0 ||
    operation.minutes !== 0;

  if (!hasShift && !operation.setClock) return null;
  return operation;
}

function normalizeGranularity(
  raw: any,
  allowedWindows: SchedulingTimeWindow[],
  targetTime: string | null
): SchedulingTemporalGranularity {
  if (
    raw?.temporalGranularity === "time_only" ||
    raw?.temporalGranularity === "date_only" ||
    raw?.temporalGranularity === "date_time" ||
    raw?.temporalGranularity === "window"
  ) {
    return raw.temporalGranularity;
  }

  const specifiedDate = raw?.customerSpecifiedDate === true;
  const specifiedTime = raw?.customerSpecifiedTime === true;

  if (specifiedDate && specifiedTime) return "date_time";
  if (specifiedDate) {
    return allowedWindows.some((window) => Boolean(window.endTime))
      ? "window"
      : "date_only";
  }
  if (specifiedTime) return "time_only";

  if (allowedWindows.some((window) => Boolean(window.endTime))) {
    return "window";
  }

  if (targetTime) return "date_time";

  return "none";
}

function normalizeIntent(
  raw: any,
  originalMessage: string
): ResolvedSchedulingIntent {
  if (!raw || typeof raw !== "object") {
    return emptyIntent(originalMessage);
  }

  const allowedWindows = Array.isArray(raw.allowedWindows)
    ? (raw.allowedWindows.map(normalizeWindow).filter(Boolean) as SchedulingTimeWindow[])
    : [];

  const excludedWindows = Array.isArray(raw.excludedWindows)
    ? (raw.excludedWindows.map(normalizeWindow).filter(Boolean) as SchedulingTimeWindow[])
    : [];

  const normalizedTargetTime =
    raw.targetTime === null || raw.targetTime === undefined
      ? null
      : validIso(raw.targetTime);

  const normalizedTargetTimeMs = normalizedTargetTime
    ? new Date(normalizedTargetTime).getTime()
    : Number.NaN;

  const targetTimeIsBoundedWindowStart =
    Number.isFinite(normalizedTargetTimeMs) &&
    allowedWindows.some((window) => {
      if (!window.endTime) return false;

      const windowStartMs = new Date(window.startTime).getTime();

      return (
        Number.isFinite(windowStartMs) &&
        Math.abs(windowStartMs - normalizedTargetTimeMs) <= 1_000
      );
    });

  const targetTime =
    targetTimeIsBoundedWindowStart ? null : normalizedTargetTime;

  const selectionMode: SchedulingSelectionMode =
    raw.selectionMode === "earliest" || raw.selectionMode === "closest"
      ? raw.selectionMode
      : "chronological";

  const confidenceNumber = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.max(0, Math.min(1, confidenceNumber))
    : 0;

  const customerSpecifiedDate = raw.customerSpecifiedDate === true;
  const customerSpecifiedTime = raw.customerSpecifiedTime === true;
  const temporalGranularity = normalizeGranularity(
    raw,
    allowedWindows,
    targetTime
  );
  const localDateTime = normalizeLocalDateTime(raw.localDateTime);
  const yearReference = normalizeYearReference(raw);
  const temporalOperation = normalizeTemporalOperation(raw.temporalOperation);

  /*
    Do not let selectionMode by itself manufacture a scheduling preference.
    Likewise, a model-generated date used only to anchor a time-only request
    must not be treated as a customer-specified date.
  */
  const hasPreference =
    Boolean(raw.hasPreference) ||
    allowedWindows.length > 0 ||
    excludedWindows.length > 0 ||
    Boolean(targetTime) ||
    customerSpecifiedDate ||
    customerSpecifiedTime ||
    Boolean(temporalOperation);

  return {
    hasPreference,
    allowedWindows: hasPreference ? allowedWindows : [],
    excludedWindows: hasPreference ? excludedWindows : [],
    selectionMode,
    targetTime: hasPreference ? targetTime : null,
    strict: hasPreference ? Boolean(raw.strict) : false,
    displayPreference:
      hasPreference &&
      typeof raw.displayPreference === "string" &&
      raw.displayPreference.trim()
        ? raw.displayPreference.trim()
        : null,
    originalPreference:
      hasPreference &&
      typeof raw.originalPreference === "string" &&
      raw.originalPreference.trim()
        ? raw.originalPreference.trim()
        : hasPreference
          ? originalMessage
          : null,
    interpretation:
      hasPreference &&
      typeof raw.interpretation === "string" &&
      raw.interpretation.trim()
        ? raw.interpretation.trim()
        : null,
    confidence,
    temporalGranularity: hasPreference ? temporalGranularity : "none",
    customerSpecifiedDate: hasPreference ? customerSpecifiedDate : false,
    customerSpecifiedTime: hasPreference ? customerSpecifiedTime : false,
    yearWasExplicit:
      hasPreference && raw.yearWasExplicit === true,
    yearReference:
      hasPreference ? yearReference : "unspecified",
    localDateTime:
      hasPreference && customerSpecifiedTime ? localDateTime : null,
    temporalOperation: hasPreference ? temporalOperation : null,
  };
}

const responseProperties = {
  hasPreference: { type: "boolean" },
  allowedWindows: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        startTime: { type: "string" },
        endTime: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: ["startTime", "endTime"],
    },
  },
  excludedWindows: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        startTime: { type: "string" },
        endTime: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
      },
      required: ["startTime", "endTime"],
    },
  },
  selectionMode: {
    type: "string",
    enum: ["chronological", "earliest", "closest"],
  },
  targetTime: {
    anyOf: [{ type: "string" }, { type: "null" }],
  },
  strict: { type: "boolean" },
  displayPreference: {
    anyOf: [{ type: "string" }, { type: "null" }],
  },
  originalPreference: {
    anyOf: [{ type: "string" }, { type: "null" }],
  },
  interpretation: {
    anyOf: [{ type: "string" }, { type: "null" }],
  },
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1,
  },
  temporalGranularity: {
    type: "string",
    enum: ["none", "time_only", "date_only", "date_time", "window"],
  },
  customerSpecifiedDate: { type: "boolean" },
  customerSpecifiedTime: { type: "boolean" },
  yearWasExplicit: { type: "boolean" },
  yearReference: {
    type: "string",
    enum: ["unspecified", "relative", "absolute"],
  },
  temporalOperation: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["shift"] },
          anchorKind: {
            type: "string",
            enum: [
              "selected_offer",
              "active_appointment",
              "active_temporal_context",
              "reference_now",
            ],
          },
          optionNumber: {
            anyOf: [
              { type: "integer", minimum: 1, maximum: 100 },
              { type: "null" },
            ],
          },
          years: { type: "integer", minimum: -20, maximum: 20 },
          months: { type: "integer", minimum: -240, maximum: 240 },
          weeks: { type: "integer", minimum: -1040, maximum: 1040 },
          days: { type: "integer", minimum: -7300, maximum: 7300 },
          hours: { type: "integer", minimum: -87600, maximum: 87600 },
          minutes: { type: "integer", minimum: -5256000, maximum: 5256000 },
          setClock: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  hour: { type: "integer", minimum: 0, maximum: 23 },
                  minute: { type: "integer", minimum: 0, maximum: 59 },
                },
                required: ["hour", "minute"],
              },
              { type: "null" },
            ],
          },
          preserveClock: { type: "boolean" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "kind",
          "anchorKind",
          "optionNumber",
          "years",
          "months",
          "weeks",
          "days",
          "hours",
          "minutes",
          "setClock",
          "preserveClock",
          "confidence",
        ],
      },
      { type: "null" },
    ],
  },
  localDateTime: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          year: { type: "integer", minimum: 1, maximum: 9999 },
          month: { type: "integer", minimum: 1, maximum: 12 },
          day: { type: "integer", minimum: 1, maximum: 31 },
          hour: { type: "integer", minimum: 0, maximum: 23 },
          minute: { type: "integer", minimum: 0, maximum: 59 },
        },
        required: ["year", "month", "day", "hour", "minute"],
      },
      { type: "null" },
    ],
  },
} as const;

const responseRequired = [
  "hasPreference",
  "allowedWindows",
  "excludedWindows",
  "selectionMode",
  "targetTime",
  "strict",
  "displayPreference",
  "originalPreference",
  "interpretation",
  "confidence",
  "temporalGranularity",
  "customerSpecifiedDate",
  "customerSpecifiedTime",
  "yearWasExplicit",
  "yearReference",
  "temporalOperation",
  "localDateTime",
] as const;

function localDateTimeMatches(
  iso: string,
  local: SchedulingLocalDateTime,
  timezone: string
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
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

  return (
    get("year") === local.year &&
    get("month") === local.month &&
    get("day") === local.day &&
    hour === local.hour &&
    get("minute") === local.minute
  );
}


function getLocalDatePartsForIso(iso: string, timezone: string) {
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

function addLocalCalendarDays(
  local: { year: number; month: number; day: number },
  days: number
) {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/*
  Surgical guard #1: date-only single-day requests must remain a LOCAL
  calendar day. Model-produced UTC boundaries can be off by an hour around
  timezone/DST interpretation and otherwise leak the previous local evening
  into customer-facing availability logic.

  This only touches date_only + no customer clock + one bounded ~24h window.
  Month/range/window semantics are left untouched.
*/
function canonicalizeSingleLocalDateWindow(
  intent: ResolvedSchedulingIntent,
  timezone: string
): ResolvedSchedulingIntent {
  if (
    !intent.hasPreference ||
    intent.temporalGranularity !== "date_only" ||
    intent.customerSpecifiedDate !== true ||
    intent.customerSpecifiedTime !== false ||
    intent.allowedWindows.length !== 1
  ) {
    return intent;
  }

  const window = intent.allowedWindows[0];
  if (!window?.startTime || !window.endTime) return intent;

  const startMs = new Date(window.startTime).getTime();
  const endMs = new Date(window.endTime).getTime();
  const durationMs = endMs - startMs;

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    durationMs < 20 * 60 * 60 * 1000 ||
    durationMs > 28 * 60 * 60 * 1000
  ) {
    return intent;
  }

  // Midpoint is safely inside the intended calendar day even if one boundary
  // was emitted with the wrong UTC offset.
  const midpointIso = new Date(startMs + durationMs / 2).toISOString();
  const localDate = getLocalDatePartsForIso(midpointIso, timezone);
  if (!localDate) return intent;

  const nextLocalDate = addLocalCalendarDays(localDate, 1);
  const canonicalStart = zonedTimeToUtc({
    ...localDate,
    hour: 0,
    minute: 0,
    timezone,
  });
  const canonicalEnd = zonedTimeToUtc({
    ...nextLocalDate,
    hour: 0,
    minute: 0,
    timezone,
  });

  return {
    ...intent,
    allowedWindows: [{ startTime: canonicalStart, endTime: canonicalEnd }],
    targetTime: null,
    localDateTime: null,
  };
}

function getReferenceLocalDate(referenceTimeMs: number, timezone: string) {
  const iso = new Date(referenceTimeMs).toISOString();
  return getLocalDatePartsForIso(iso, timezone);
}


/*
  Generic temporal-dimension reconciliation.

  The model can occasionally return time_only even though the newest message
  itself contains grounded date-bearing language. That contradictory state is
  unsafe because the intentional time_only early return strips targetTime and
  allowedWindows.

  This guard changes ONLY that contradiction:
    - existing time_only result
    - customer time already recognized
    - model says no customer date
    - localDateTime already resolved
    - newest message contains grounded date-bearing surface evidence

  It does not invent a date. It preserves the model-resolved localDateTime and
  only restores the date dimension that the customer's words prove exists.
  True bare-time follow-ups therefore remain time_only.
*/
function hasGroundedDateBearingSurface(message: string) {
  const text = String(message ?? "").trim();
  if (!text) return false;

  const monthName =
    "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const weekday =
    "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";

  const patterns = [
    /\b(?:today|tomorrow|tonight|yesterday)\b/i,
    new RegExp(`\\b${weekday}\\b`, "i"),
    new RegExp(`\\b${monthName}\\b`, "i"),
    /\b(?:this|next|coming|upcoming)\s+(?:day|week|weekend|month|year)\b/i,
    /\b(?:in|within)\s+(?:the\s+)?(?:next\s+)?\d+\s+(?:day|days|week|weeks|month|months|year|years)\b/i,
    /\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/,
    /\b(?:the\s+)?(?:[12]?\d|3[01])(?:st|nd|rd|th)\b/i,
    /\b(?:19|20|21)\d{2}\b/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

/*
 * An unbounded service/availability request cannot authorize a model-created
 * calendar point. In particular, a timestamp copied from "now" must never
 * enter omitted-year rollover and become the same date a year later.
 * Preserve all existing date, clock, duration, relation and daypart paths.
 */
export function reconcileUngroundedCalendarPoint(
  intent: ResolvedSchedulingIntent,
  message: string
): ResolvedSchedulingIntent {
  if (!intent.hasPreference || intent.temporalOperation ||
    intent.allowedWindows.length > 1 || intent.excludedWindows.length > 0) return intent;
  const text = normalizeSharedTemporalSurface(message);
  if (
    hasGroundedDateBearingSurface(text) ||
    hasSharedGroundedClockSurface(text) ||
    /\d/.test(text) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|half|quarter|morning|afternoon|evening|night|breakfast|lunch|dinner|weekend|weekdays|workdays|holiday|holidays|day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|before|after|between|during|until|later|earlier|same|that|then|only|except|excluding|avoid|last|latest|late|final|end)\b/.test(text)
  ) return intent;
  return {
    ...emptyIntent(message),
    selectionMode: "earliest",
    interpretation: "Unbounded scheduling request; availability must supply the next real opening instead of using an ungrounded calendar point.",
  };
}

function reconcileTemporalDimensionsFromSurfaceEvidence(
  intent: ResolvedSchedulingIntent,
  message: string
): ResolvedSchedulingIntent {
  if (
    !intent.hasPreference ||
    intent.temporalGranularity !== "time_only" ||
    intent.customerSpecifiedTime !== true ||
    intent.customerSpecifiedDate !== false ||
    !intent.localDateTime ||
    !hasGroundedDateBearingSurface(message)
  ) {
    return intent;
  }

  return {
    ...intent,
    temporalGranularity: "date_time",
    customerSpecifiedDate: true,
  };
}

/*
  Surgical guard #2: "tomorrow" is anchored deterministically to the
  reference instant's LOCAL calendar date before exact date+time
  canonicalization. This prevents a UTC-date rollover from turning tomorrow
  into the day after tomorrow late in the local evening.

  No other relative-date language is changed here.
*/
function reconcileTomorrowLocalDate(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  if (
    !intent.hasPreference ||
    intent.temporalGranularity !== "date_time" ||
    intent.customerSpecifiedDate !== true ||
    intent.customerSpecifiedTime !== true ||
    !intent.localDateTime ||
    intent.yearReference !== "unspecified" ||
    !/\btomorrow\b/i.test(message)
  ) {
    return intent;
  }

  const referenceLocalDate = getReferenceLocalDate(referenceTimeMs, timezone);
  if (!referenceLocalDate) return intent;

  const tomorrow = addLocalCalendarDays(referenceLocalDate, 1);

  return {
    ...intent,
    localDateTime: {
      ...intent.localDateTime,
      ...tomorrow,
    },
  };
}


const SHARED_RELATIVE_WEEKDAY_INTERPRETATION_PREFIX =
  "[shared-relative-weekday]";

type SharedRelativeWeekdayExpression = {
  weekdayIndex: number;
  weekdayName: string;
  occurrenceDepth: number;
};

/*
 * AUTHORITATIVE WEEKDAY TABLE FOR SHARED NATURAL-LANGUAGE DATE GRAMMAR.
 *
 * Every awkward-but-clear weekday grammar below is table-driven from THIS list.
 * There are no Thursday-only branches. Sunday through Saturday all receive the
 * exact same parser behavior.
 *
 * This file resolves temporal intent only. It does NOT mutate bookings,
 * reschedules, cancellations, Calendar events, Lead booking state, or
 * availability.
 */
const SHARED_WEEKDAYS: Array<{
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

function normalizeSharedTemporalSurface(message: string) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[^\w\s:/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWord(text: string, word: string) {
  const matches = text.match(new RegExp(`\\b${word}\\b`, "gi"));
  return matches?.length ?? 0;
}

function extractSharedWeekdayMentions(message: string) {
  const text = normalizeSharedTemporalSurface(message);
  const mentions = new Set<number>();

  for (const weekday of SHARED_WEEKDAYS) {
    if (new RegExp(`\\b${weekday.pattern}\\b`, "i").test(text)) {
      mentions.add(weekday.index);
    }
  }

  return [...mentions];
}


const SHARED_AWKWARD_WEEKDAY_INTERPRETATION_PREFIX =
  "[shared-awkward-weekday]";

const SHARED_OCCURRENCE_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  first: 1,
  "1": 1,
  "1st": 1,

  two: 2,
  second: 2,
  "2": 2,
  "2nd": 2,

  three: 3,
  third: 3,
  "3": 3,
  "3rd": 3,

  four: 4,
  fourth: 4,
  "4": 4,
  "4th": 4,

  five: 5,
  fifth: 5,
  "5": 5,
  "5th": 5,

  six: 6,
  sixth: 6,
  "6": 6,
  "6th": 6,

  seven: 7,
  seventh: 7,
  "7": 7,
  "7th": 7,

  eight: 8,
  eighth: 8,
  "8": 8,
  "8th": 8,

  nine: 9,
  ninth: 9,
  "9": 9,
  "9th": 9,

  ten: 10,
  tenth: 10,
  "10": 10,
  "10th": 10,
};

const SHARED_OCCURRENCE_NUMBER_PATTERN =
  "(?:one|first|1st|1|two|second|2nd|2|three|third|3rd|3|four|fourth|4th|4|five|fifth|5th|5|six|sixth|6th|6|seven|seventh|7th|7|eight|eighth|8th|8|nine|ninth|9th|9|ten|tenth|10th|10)";

function parseSharedOccurrenceNumber(value: string | null | undefined) {
  if (!value) return null;

  return (
    SHARED_OCCURRENCE_NUMBER_WORDS[
      value.toLowerCase().trim()
    ] ?? null
  );
}

function hasIndependentCalendarFrameForAwkwardWeekday(
  text: string
) {
  return (
    /\b20\d{2}\b/.test(text) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text) ||
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
      text
    ) ||
    /\b(?:today|tomorrow|yesterday)\b/i.test(text)
  );
}

function countSharedWeekdayOccurrences(
  text: string,
  weekdayPattern: string
) {
  return (
    text.match(
      new RegExp(`\\b(?:${weekdayPattern})\\b`, "gi")
    )?.length ?? 0
  );
}

/*
 * Deterministic parser for awkward-but-clear everyday weekday language.
 *
 * This is intentionally narrow. It accepts only surfaces whose arithmetic is
 * unambiguous, and it refuses to guess when the customer supplies:
 *   - multiple DISTINCT weekdays,
 *   - a named month / numeric date / explicit year,
 *   - today / tomorrow / yesterday.
 *
 * Supported examples for every weekday:
 *
 *   Thursday after Thursday after Thursday
 *   Thursday and then after that Thursday
 *   Thursday after another Thursday
 *
 *   two Thursdays from now
 *   3 Thursdays from now
 *   the fourth Thursday from now
 *   a couple Thursdays from now
 *
 *   not next Thursday, the Thursday after that
 *   skip next Thursday, give me the one after
 *   one after next Thursday
 *
 *   Thursday next week
 *   Thursday next next week
 *   Thursday next next next week
 *
 * The return value is the SAME occurrenceDepth consumed by the existing
 * shared weekday-date calculator. No booking, availability, Calendar, or
 * mutation behavior exists here.
 */
function parseSharedAwkwardRelativeWeekday(
  message: string
): SharedRelativeWeekdayExpression | null {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return null;

  if (hasIndependentCalendarFrameForAwkwardWeekday(text)) {
    return null;
  }

  const distinctWeekdays = extractSharedWeekdayMentions(text);
  if (distinctWeekdays.length !== 1) return null;

  const weekday = SHARED_WEEKDAYS.find(
    (candidate) => candidate.index === distinctWeekdays[0]
  );
  if (!weekday) return null;

  const weekdayPattern = weekday.pattern;
  const pluralWeekdayPattern = `(?:${weekdayPattern})s?`;

  /*
   * 1) Recursive same-weekday chain:
   *
   *    Thursday after Thursday after Thursday
   *    Thursday and then after that Thursday
   *    Thursday after another Thursday
   *
   * Every repeated weekday is another occurrence. The bridge MUST explicitly
   * contain "after"; simple lists like "Thursday or Thursday" do not qualify.
   */
  const repeatedChainPattern = new RegExp(
    `\\b(?:${weekdayPattern})\\b` +
      `(?:\\s+(?:(?:and\\s+)?then\\s+)?after\\s+` +
      `(?:(?:the|that|another)\\s+)?` +
      `(?:${weekdayPattern})\\b)+`,
    "i"
  );

  const repeatedChain = repeatedChainPattern.exec(text);

  if (repeatedChain?.[0]) {
    const occurrenceDepth = countSharedWeekdayOccurrences(
      repeatedChain[0],
      weekdayPattern
    );

    if (occurrenceDepth >= 2) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        occurrenceDepth,
      };
    }
  }

  /*
   * 2) Counted weekday occurrences:
   *
   *    two Thursdays from now
   *    3 Thursdays out
   *    the fourth Thursday from now
   *    a couple Thursdays from now
   */
  const couplePattern = new RegExp(
    `\\b(?:a\\s+)?couple(?:\\s+of)?\\s+${pluralWeekdayPattern}\\s+` +
      `(?:from\\s+now|out|ahead)\\b`,
    "i"
  );

  if (couplePattern.test(text)) {
    return {
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      occurrenceDepth: 2,
    };
  }

  const countedPluralPattern = new RegExp(
    `\\b(${SHARED_OCCURRENCE_NUMBER_PATTERN})\\s+` +
      `${pluralWeekdayPattern}\\s+` +
      `(?:from\\s+now|out|ahead)\\b`,
    "i"
  ).exec(text);

  if (countedPluralPattern?.[1]) {
    const occurrenceDepth = parseSharedOccurrenceNumber(
      countedPluralPattern[1]
    );

    if (occurrenceDepth && occurrenceDepth > 0) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        occurrenceDepth,
      };
    }
  }

  const ordinalWeekdayPattern = new RegExp(
    `\\b(?:the\\s+)?(${SHARED_OCCURRENCE_NUMBER_PATTERN})\\s+` +
      `(?:${weekdayPattern})\\s+` +
      `(?:from\\s+now|out|ahead)\\b`,
    "i"
  ).exec(text);

  if (ordinalWeekdayPattern?.[1]) {
    const occurrenceDepth = parseSharedOccurrenceNumber(
      ordinalWeekdayPattern[1]
    );

    if (occurrenceDepth && occurrenceDepth > 0) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        occurrenceDepth,
      };
    }
  }

  /*
   * 3) Explicitly skip next occurrence:
   *
   *    not next Thursday, the Thursday after that
   *    skip next Thursday, give me the one after
   *
   * This is always depth 2 under the existing product semantics.
   */
  const skipNextThenAfter = new RegExp(
    `\\b(?:not|skip|pass\\s+on|forget)\\s+` +
      `(?:the\\s+)?next\\s+(?:${weekdayPattern})\\b` +
      `.{0,80}\\b(?:` +
      `(?:the\\s+)?(?:${weekdayPattern})\\s+after(?:\\s+that)?|` +
      `(?:the\\s+)?one\\s+after(?:\\s+that)?|` +
      `(?:the\\s+)?following\\s+one` +
      `)\\b`,
    "i"
  );

  if (skipNextThenAfter.test(text)) {
    return {
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      occurrenceDepth: 2,
    };
  }

  const oneAfterNext = new RegExp(
    `\\b(?:the\\s+)?one\\s+after\\s+` +
      `(?:the\\s+)?next\\s+(?:${weekdayPattern})\\b`,
    "i"
  );

  if (oneAfterNext.test(text)) {
    return {
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      occurrenceDepth: 2,
    };
  }

  /*
   * 4) Trailing "next" chain:
   *
   *    Thursday next week
   *    Thursday next next week
   *    Thursday next next next week
   *
   * Require the "next" sequence to sit immediately after the weekday so an
   * unrelated later use of "next" cannot alter the date.
   */
  const trailingNextChain = new RegExp(
    `\\b(?:${weekdayPattern})\\b\\s+` +
      `((?:next\\s+)+)(?:week|weeks)?\\b`,
    "i"
  ).exec(text);

  if (trailingNextChain?.[1]) {
    const occurrenceDepth = countWord(
      trailingNextChain[1],
      "next"
    );

    if (occurrenceDepth > 0) {
      return {
        weekdayIndex: weekday.index,
        weekdayName: weekday.name,
        occurrenceDepth,
      };
    }
  }

  return null;
}

/*
 * Generic compositional relative-weekday parser.
 *
 * It does NOT map phrases to hardcoded dates.
 * It derives an occurrence depth:
 *
 *   next Thursday                    -> depth 1
 *   next next Thursday               -> depth 2
 *   Thursday after next              -> depth 2
 *   Thursday after next next         -> depth 3
 *   Thursday after next ... next     -> keeps advancing
 *
 * The actual calendar date is calculated from referenceTime + timezone.
 *
 * "after" contributes one occurrence beyond the referenced "next" chain.
 * Every additional standalone "next" in the same weekday-relative surface
 * contributes one more weekly occurrence. Conversational filler between
 * operators does not change the arithmetic.
 */
function parseSharedComposableRelativeWeekday(
  message: string
): SharedRelativeWeekdayExpression | null {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return null;

  const awkwardButClear =
    parseSharedAwkwardRelativeWeekday(text);

  if (awkwardButClear) {
    return awkwardButClear;
  }

  for (const weekday of SHARED_WEEKDAYS) {
    const weekdayRegex = new RegExp(`\\b${weekday.pattern}\\b`, "i");
    const match = weekdayRegex.exec(text);
    if (!match || match.index === undefined) continue;

    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);

    /*
     * Prefix operators apply only when "next" is in the local temporal phrase
     * immediately leading into the weekday. We allow lightweight filler but
     * stop at another explicit weekday/date separator.
     */
    const prefixTail =
      before
        .split(/\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)
        .pop() ?? before;

    const prefixNextCount = countWord(prefixTail, "next");

    /*
     * Suffix chaining is activated by "after". Once the customer says
     * "<weekday> after ...", every "next" that follows in that same message
     * advances the weekday occurrence. This intentionally tolerates speech
     * filler such as "then the next, yo bro, next".
     */
    const afterMatch = /\bafter\b/i.exec(after);
    const suffixNextCount = afterMatch
      ? countWord(after.slice(afterMatch.index + afterMatch[0].length), "next")
      : 0;

    let occurrenceDepth = 0;

    if (afterMatch && suffixNextCount > 0) {
      occurrenceDepth =
        prefixNextCount +
        suffixNextCount +
        1;
    } else if (prefixNextCount > 0) {
      occurrenceDepth = prefixNextCount;
    }

    if (occurrenceDepth <= 0) continue;

    return {
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      occurrenceDepth,
    };
  }

  return null;
}

function getLocalDateTimePartsForSharedIso(
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
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const rawHour = get("hour");
  const hour = rawHour === 24 ? 0 : rawHour;

  const value = {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
  };

  if (
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    !Number.isInteger(value.day) ||
    !Number.isInteger(value.hour) ||
    !Number.isInteger(value.minute)
  ) {
    return null;
  }

  return value;
}

function getSharedWeekdayIndex(local: {
  year: number;
  month: number;
  day: number;
}) {
  return new Date(
    Date.UTC(local.year, local.month - 1, local.day)
  ).getUTCDay();
}

function resolveSharedWeekdayOccurrenceDate(params: {
  referenceTimeMs: number;
  timezone: string;
  weekdayIndex: number;
  occurrenceDepth: number;
}) {
  const referenceLocal = getReferenceLocalDate(
    params.referenceTimeMs,
    params.timezone
  );
  if (!referenceLocal) return null;

  const currentWeekday = getSharedWeekdayIndex(referenceLocal);

  /*
   * Product-wide semantics:
   *   depth 1 = requested weekday in NEXT Monday-based calendar week.
   *   depth 2 = same weekday one week later.
   *   depth N = keep advancing weekly.
   */
  const daysUntilNextMonday =
    currentWeekday === 0 ? 1 : 8 - currentWeekday;

  const weekdayOffsetFromMonday =
    params.weekdayIndex === 0 ? 6 : params.weekdayIndex - 1;

  return addLocalCalendarDays(
    referenceLocal,
    daysUntilNextMonday +
      weekdayOffsetFromMonday +
      (params.occurrenceDepth - 1) * 7
  );
}

function localCalendarDayNumber(local: {
  year: number;
  month: number;
  day: number;
}) {
  return Math.floor(
    Date.UTC(local.year, local.month - 1, local.day) /
      (24 * 60 * 60 * 1000)
  );
}

function shiftSharedIsoByLocalCalendarDays(
  iso: string,
  timezone: string,
  days: number
) {
  const local = getLocalDateTimePartsForSharedIso(iso, timezone);
  if (!local) return null;

  const shiftedDate = addLocalCalendarDays(local, days);

  return zonedTimeToUtc({
    ...shiftedDate,
    hour: local.hour,
    minute: local.minute,
    timezone,
  });
}

function shiftSharedWindow(
  window: SchedulingTimeWindow,
  timezone: string,
  days: number
): SchedulingTimeWindow | null {
  const startTime = shiftSharedIsoByLocalCalendarDays(
    window.startTime,
    timezone,
    days
  );
  if (!startTime) return null;

  const endTime = window.endTime
    ? shiftSharedIsoByLocalCalendarDays(
        window.endTime,
        timezone,
        days
      )
    : null;

  if (
    endTime &&
    new Date(endTime).getTime() <= new Date(startTime).getTime()
  ) {
    return null;
  }

  return { startTime, endTime };
}


const SHARED_MONTH_POSITION_WEEKDAY_INTERPRETATION_PREFIX =
  "[shared-month-position-weekday]";

const SHARED_MONTHS: Array<{ month: number; pattern: string }> = [
  { month: 1, pattern: "jan(?:uary)?" },
  { month: 2, pattern: "feb(?:ruary)?" },
  { month: 3, pattern: "mar(?:ch)?" },
  { month: 4, pattern: "apr(?:il)?" },
  { month: 5, pattern: "may" },
  { month: 6, pattern: "jun(?:e)?" },
  { month: 7, pattern: "jul(?:y)?" },
  { month: 8, pattern: "aug(?:ust)?" },
  { month: 9, pattern: "sep(?:t(?:ember)?)?" },
  { month: 10, pattern: "oct(?:ober)?" },
  { month: 11, pattern: "nov(?:ember)?" },
  { month: 12, pattern: "dec(?:ember)?" },
];

type SharedMonthPositionWeekdayExpression = {
  month: number;
  weekdayIndex: number;
  weekdayName: string;
  occurrence: number | "last";
};

function parseSharedMonthPositionWeekdayExpression(
  message: string
): SharedMonthPositionWeekdayExpression | null {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return null;

  const monthDef = SHARED_MONTHS.find((candidate) =>
    new RegExp(`\\b${candidate.pattern}\\b`, "i").test(text)
  );
  if (!monthDef) return null;

  const weekdayMentions = extractSharedWeekdayMentions(text);
  if (weekdayMentions.length !== 1) return null;

  const weekday = SHARED_WEEKDAYS.find(
    (candidate) => candidate.index === weekdayMentions[0]
  );
  if (!weekday) return null;

  const positionPattern =
    "(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)";

  let position: string | null = null;

  const directPositionWeekday = new RegExp(
    `\\b${positionPattern}\\s+${weekday.pattern}\\b`,
    "i"
  ).exec(text);

  const weekOfMonth = new RegExp(
    `\\b${positionPattern}\\s+week\\s+of\\s+(?:the\\s+)?month\\b`,
    "i"
  ).exec(text);

  const positionedWeekNearNamedMonth = new RegExp(
    `(?:\\b${monthDef.pattern}\\b.{0,60}\\b${positionPattern}\\s+week\\b|` +
      `\\b${positionPattern}\\s+week\\b.{0,60}\\b${monthDef.pattern}\\b)`,
    "i"
  ).exec(text);

  const weekdayInPositionedWeek = new RegExp(
    `\\b${weekday.pattern}\\b.{0,60}\\b(?:in|of|during)\\s+(?:the\\s+)?${positionPattern}\\s+week\\b`,
    "i"
  ).exec(text);

  position =
    directPositionWeekday?.[1] ??
    weekOfMonth?.[1] ??
    positionedWeekNearNamedMonth?.[1] ??
    positionedWeekNearNamedMonth?.[2] ??
    weekdayInPositionedWeek?.[1] ??
    null;

  if (!position) return null;

  const normalized = position.toLowerCase();
  const occurrence: number | "last" =
    normalized === "last" || normalized === "final"
      ? "last"
      : normalized === "first" || normalized === "1st"
        ? 1
        : normalized === "second" || normalized === "2nd"
          ? 2
          : normalized === "third" || normalized === "3rd"
            ? 3
            : normalized === "fourth" || normalized === "4th"
              ? 4
              : 5;

  return {
    month: monthDef.month,
    weekdayIndex: weekday.index,
    weekdayName: weekday.name,
    occurrence,
  };
}

function resolveSharedMonthPositionWeekdayDate(params: {
  year: number;
  month: number;
  weekdayIndex: number;
  occurrence: number | "last";
}) {
  const daysInMonth = new Date(
    Date.UTC(params.year, params.month, 0)
  ).getUTCDate();

  if (params.occurrence === "last") {
    const weekdayOnLastDay = getSharedWeekdayIndex({
      year: params.year,
      month: params.month,
      day: daysInMonth,
    });

    return {
      year: params.year,
      month: params.month,
      day:
        daysInMonth -
        ((weekdayOnLastDay - params.weekdayIndex + 7) % 7),
    };
  }

  const weekdayOnFirstDay = getSharedWeekdayIndex({
    year: params.year,
    month: params.month,
    day: 1,
  });

  const firstOccurrenceDay =
    1 + ((params.weekdayIndex - weekdayOnFirstDay + 7) % 7);

  const day =
    firstOccurrenceDay + (params.occurrence - 1) * 7;

  if (day > daysInMonth) return null;

  return {
    year: params.year,
    month: params.month,
    day,
  };
}

function resolveSharedMonthPositionWeekdayYear(params: {
  message: string;
  intent: ResolvedSchedulingIntent;
  expression: SharedMonthPositionWeekdayExpression;
  timezone: string;
  referenceTimeMs: number;
}) {
  const text = normalizeSharedTemporalSurface(params.message);
  const referenceLocal = getReferenceLocalDate(
    params.referenceTimeMs,
    params.timezone
  );
  if (!referenceLocal) return null;

  const explicitYear = text.match(/\b(20\d{2})\b/);
  if (explicitYear) return Number(explicitYear[1]);

  if (/\b(?:next|following)\s+year\b/.test(text)) {
    return referenceLocal.year + 1;
  }

  if (/\bthis\s+year\b/.test(text)) {
    return referenceLocal.year;
  }

  if (
    params.intent.localDateTime &&
    (
      params.intent.yearReference === "relative" ||
      params.intent.yearReference === "absolute"
    )
  ) {
    return params.intent.localDateTime.year;
  }

  const currentYearDate =
    resolveSharedMonthPositionWeekdayDate({
      year: referenceLocal.year,
      month: params.expression.month,
      weekdayIndex: params.expression.weekdayIndex,
      occurrence: params.expression.occurrence,
    });

  if (!currentYearDate) return null;

  const hour = params.intent.localDateTime?.hour ?? 23;
  const minute = params.intent.localDateTime?.minute ?? 59;

  const currentYearInstant = zonedTimeToUtc({
    ...currentYearDate,
    hour,
    minute,
    timezone: params.timezone,
  });

  return new Date(currentYearInstant).getTime() > params.referenceTimeMs
    ? referenceLocal.year
    : referenceLocal.year + 1;
}

function reconcileMonthPositionWeekday(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  const expression =
    parseSharedMonthPositionWeekdayExpression(message);

  if (!expression) return intent;

  const year = resolveSharedMonthPositionWeekdayYear({
    message,
    intent,
    expression,
    timezone,
    referenceTimeMs,
  });

  if (!year) {
    return {
      ...emptyIntent(intent.originalPreference ?? message),
      interpretation:
        `${SHARED_MONTH_POSITION_WEEKDAY_INTERPRETATION_PREFIX} failed to resolve year`,
    };
  }

  const targetLocalDate =
    resolveSharedMonthPositionWeekdayDate({
      year,
      month: expression.month,
      weekdayIndex: expression.weekdayIndex,
      occurrence: expression.occurrence,
    });

  if (!targetLocalDate) {
    return {
      ...emptyIntent(intent.originalPreference ?? message),
      interpretation:
        `${SHARED_MONTH_POSITION_WEEKDAY_INTERPRETATION_PREFIX} weekday occurrence does not exist in requested month`,
    };
  }

  const anchorIso =
    intent.targetTime ??
    intent.allowedWindows[0]?.startTime ??
    null;

  const anchorLocal = anchorIso
    ? getLocalDatePartsForIso(anchorIso, timezone)
    : intent.localDateTime
      ? {
          year: intent.localDateTime.year,
          month: intent.localDateTime.month,
          day: intent.localDateTime.day,
        }
      : null;

  const dayDelta = anchorLocal
    ? localCalendarDayNumber(targetLocalDate) -
      localCalendarDayNumber(anchorLocal)
    : 0;

  let allowedWindows = intent.allowedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  const excludedWindows = intent.excludedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  let targetTime = intent.targetTime
    ? shiftSharedIsoByLocalCalendarDays(
        intent.targetTime,
        timezone,
        dayDelta
      )
    : null;

  let localDateTime = intent.localDateTime
    ? {
        ...intent.localDateTime,
        ...targetLocalDate,
      }
    : null;

  if (
    intent.customerSpecifiedTime === true &&
    localDateTime
  ) {
    const exactStart = zonedTimeToUtc({
      ...localDateTime,
      timezone,
    });

    allowedWindows = [{ startTime: exactStart, endTime: null }];
    targetTime = exactStart;
  } else if (intent.customerSpecifiedTime !== true) {
    const nextDate = addLocalCalendarDays(targetLocalDate, 1);

    allowedWindows = [
      {
        startTime: zonedTimeToUtc({
          ...targetLocalDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
        endTime: zonedTimeToUtc({
          ...nextDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
      },
    ];

    targetTime = null;
    localDateTime = null;
  }

  return {
    ...intent,
    hasPreference: true,
    allowedWindows,
    excludedWindows,
    targetTime,
    customerSpecifiedDate: true,
    temporalGranularity:
      intent.customerSpecifiedTime === true
        ? "date_time"
        : intent.temporalGranularity === "window"
          ? "window"
          : "date_only",
    localDateTime,
    interpretation:
      `${SHARED_MONTH_POSITION_WEEKDAY_INTERPRETATION_PREFIX} ` +
      `${expression.occurrence} ${expression.weekdayName} in month ${expression.month} resolved deterministically`,
  };
}


const SHARED_RELATIONAL_WEEKDAY_CHAIN_INTERPRETATION_PREFIX =
  "[shared-relational-weekday-chain]";

type SharedOrderedWeekdayOccurrence = {
  weekdayIndex: number;
  weekdayName: string;
  nextDepth: number;
  start: number;
  end: number;
};

type SharedRelationalWeekdayChainExpression = {
  nodes: SharedOrderedWeekdayOccurrence[];
  anchorMonth: number | null;
  anchorYear: number | null;
  anchorYearReference: SchedulingYearReference;
  anchorOccurrence:
    | { kind: "next"; depth: number }
    | { kind: "ordinal"; occurrence: number | "last" }
    | null;
};

function extractSharedOrderedWeekdayOccurrences(
  message: string
): SharedOrderedWeekdayOccurrence[] {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return [];

  const weekdayAlternation = SHARED_WEEKDAYS
    .map((weekday) => `(?:${weekday.pattern})`)
    .join("|");

  /*
   * Prefix "next" belongs to the weekday node itself. This makes bridges such
   * as "after that next Thursday" reduce cleanly to "after that".
   */
  const matcher = new RegExp(
    `\\b((?:next\\s+)*)(?:${weekdayAlternation})\\b`,
    "gi"
  );

  const occurrences: SharedOrderedWeekdayOccurrence[] = [];
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text))) {
    const full = match[0] ?? "";
    const nextPrefix = match[1] ?? "";
    const weekdaySurface = full
      .replace(/^(?:next\s+)+/i, "")
      .trim();

    const weekday = SHARED_WEEKDAYS.find((candidate) =>
      new RegExp(`^(?:${candidate.pattern})$`, "i").test(
        weekdaySurface
      )
    );

    if (!weekday) continue;

    occurrences.push({
      weekdayIndex: weekday.index,
      weekdayName: weekday.name,
      nextDepth: countWord(nextPrefix, "next"),
      start: match.index,
      end: match.index + full.length,
    });
  }

  return occurrences;
}

function isSharedRelationalAfterBridge(bridge: string) {
  const normalized = normalizeSharedTemporalSurface(bridge);

  return /^(?:(?:and\s+)?(?:then\s+)?)?after(?:\s+(?:that|the|another))?$/.test(
    normalized
  );
}

function extractSharedLongestRelationalWeekdayChain(
  message: string
): SharedOrderedWeekdayOccurrence[] {
  const text = normalizeSharedTemporalSurface(message);
  const occurrences = extractSharedOrderedWeekdayOccurrences(text);

  if (occurrences.length < 2) return [];

  let best: SharedOrderedWeekdayOccurrence[] = [];

  for (let start = 0; start < occurrences.length - 1; start += 1) {
    const chain = [occurrences[start]];

    for (
      let index = start;
      index < occurrences.length - 1;
      index += 1
    ) {
      const current = occurrences[index];
      const next = occurrences[index + 1];

      const bridge = text.slice(current.end, next.start);

      if (!isSharedRelationalAfterBridge(bridge)) {
        break;
      }

      chain.push(next);
    }

    if (chain.length > best.length) {
      best = chain;
    }
  }

  return best.length >= 2 ? best : [];
}

function findSharedMonthNearTerminalWeekday(
  text: string,
  terminal: SharedOrderedWeekdayOccurrence
) {
  const candidates: Array<{
    month: number;
    start: number;
    end: number;
    distance: number;
  }> = [];

  for (const month of SHARED_MONTHS) {
    const matcher = new RegExp(`\\b${month.pattern}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(text))) {
      const start = match.index;
      const end = match.index + match[0].length;

      const distance =
        end <= terminal.start
          ? terminal.start - end
          : start >= terminal.end
            ? start - terminal.end
            : 0;

      /*
       * A month must be local to the terminal anchor, not merely mentioned
       * somewhere else in a long service message.
       */
      if (distance <= 48) {
        candidates.push({
          month: month.month,
          start,
          end,
          distance,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.distance - b.distance);

  if (
    candidates.length > 1 &&
    candidates[0].distance === candidates[1].distance &&
    candidates[0].month !== candidates[1].month
  ) {
    return null;
  }

  return candidates[0];
}

function parseSharedOrdinalImmediatelyBeforeWeekday(
  text: string,
  occurrence: SharedOrderedWeekdayOccurrence
): number | "last" | null {
  const prefix = text
    .slice(Math.max(0, occurrence.start - 28), occurrence.start)
    .trim();

  const match = prefix.match(
    /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last|final)\s*$/
  );

  if (!match?.[1]) return null;

  switch (match[1]) {
    case "first":
    case "1st":
      return 1;
    case "second":
    case "2nd":
      return 2;
    case "third":
    case "3rd":
      return 3;
    case "fourth":
    case "4th":
      return 4;
    case "fifth":
    case "5th":
      return 5;
    case "last":
    case "final":
      return "last";
    default:
      return null;
  }
}

function parseSharedRelationalWeekdayChain(
  message: string
): SharedRelationalWeekdayChainExpression | null {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return null;

  const nodes = extractSharedLongestRelationalWeekdayChain(text);
  if (nodes.length < 2) return null;

  const terminal = nodes[nodes.length - 1];
  const month = findSharedMonthNearTerminalWeekday(
    text,
    terminal
  );

  const explicitYearMatch = text.match(/\b(20\d{2})\b/);
  const explicitYear = explicitYearMatch
    ? Number(explicitYearMatch[1])
    : null;

  let anchorYearReference: SchedulingYearReference =
    explicitYear ? "absolute" : "unspecified";

  let anchorYear = explicitYear;

  if (!explicitYear) {
    if (/\bnext\s+year\b/.test(text)) {
      anchorYearReference = "relative";
    } else if (/\bthis\s+year\b/.test(text)) {
      anchorYearReference = "relative";
    }
  }

  let anchorOccurrence:
    SharedRelationalWeekdayChainExpression["anchorOccurrence"] =
    null;

  const terminalOrdinal =
    parseSharedOrdinalImmediatelyBeforeWeekday(
      text,
      terminal
    );

  if (terminalOrdinal !== null) {
    anchorOccurrence = {
      kind: "ordinal",
      occurrence: terminalOrdinal,
    };
  } else if (terminal.nextDepth > 0) {
    anchorOccurrence = {
      kind: "next",
      depth: terminal.nextDepth,
    };
  }

  /*
   * Safe ownership rules:
   *
   * - With a month anchor, the terminal weekday must itself be grounded by
   *   "next"/"next next"/... or an ordinal such as "third"/"last".
   *   Bare "Thursday June" is not silently guessed.
   *
   * - Without a month anchor, the terminal node must use "next" so the chain
   *   has a deterministic reference-time anchor.
   *
   * These rules let us understand mixed relational chains without turning
   * vague language into invented dates.
   */
  if (month && !anchorOccurrence) return null;
  if (!month && (!anchorOccurrence || anchorOccurrence.kind !== "next")) {
    return null;
  }

  return {
    nodes,
    anchorMonth: month?.month ?? null,
    anchorYear,
    anchorYearReference,
    anchorOccurrence,
  };
}

function resolveSharedFirstWeekdayOnOrAfter(params: {
  localDate: { year: number; month: number; day: number };
  weekdayIndex: number;
}) {
  const currentWeekday = getSharedWeekdayIndex(params.localDate);
  const delta =
    (params.weekdayIndex - currentWeekday + 7) % 7;

  return addLocalCalendarDays(params.localDate, delta);
}

function resolveSharedNthWeekdayStrictlyAfter(params: {
  anchor: { year: number; month: number; day: number };
  weekdayIndex: number;
  occurrenceDepth: number;
}) {
  const anchorWeekday = getSharedWeekdayIndex(params.anchor);

  let firstDelta =
    (params.weekdayIndex - anchorWeekday + 7) % 7;

  if (firstDelta === 0) firstDelta = 7;

  return addLocalCalendarDays(
    params.anchor,
    firstDelta +
      Math.max(0, params.occurrenceDepth - 1) * 7
  );
}

function resolveSharedMonthScopedNextWeekday(params: {
  referenceTimeMs: number;
  timezone: string;
  month: number;
  weekdayIndex: number;
  occurrenceDepth: number;
  explicitYear: number | null;
  forceYear:
    | "next_year"
    | "this_year"
    | null;
}) {
  const referenceLocal = getReferenceLocalDate(
    params.referenceTimeMs,
    params.timezone
  );
  if (!referenceLocal) return null;

  const candidateYears: number[] = [];

  if (params.explicitYear) {
    candidateYears.push(params.explicitYear);
  } else if (params.forceYear === "next_year") {
    candidateYears.push(referenceLocal.year + 1);
  } else if (params.forceYear === "this_year") {
    candidateYears.push(referenceLocal.year);
  } else {
    candidateYears.push(referenceLocal.year, referenceLocal.year + 1);
  }

  for (const year of candidateYears) {
    let startDay = 1;

    if (
      year === referenceLocal.year &&
      params.month === referenceLocal.month
    ) {
      /*
       * "next Thursday in June" while already in June means a Thursday
       * strictly AFTER the reference date, not one that has already passed.
       */
      startDay = referenceLocal.day + 1;
    }

    if (startDay > 31) continue;

    const daysInMonth = new Date(
      Date.UTC(year, params.month, 0)
    ).getUTCDate();

    if (startDay > daysInMonth) continue;

    const first = resolveSharedFirstWeekdayOnOrAfter({
      localDate: {
        year,
        month: params.month,
        day: startDay,
      },
      weekdayIndex: params.weekdayIndex,
    });

    if (
      first.year !== year ||
      first.month !== params.month
    ) {
      continue;
    }

    const resolved = addLocalCalendarDays(
      first,
      Math.max(0, params.occurrenceDepth - 1) * 7
    );

    if (
      resolved.year !== year ||
      resolved.month !== params.month
    ) {
      continue;
    }

    if (
      !params.explicitYear &&
      params.forceYear === null
    ) {
      const resolvedEndOfDay = zonedTimeToUtc({
        ...resolved,
        hour: 23,
        minute: 59,
        timezone: params.timezone,
      });

      if (
        new Date(resolvedEndOfDay).getTime() <=
        params.referenceTimeMs
      ) {
        continue;
      }
    }

    return resolved;
  }

  return null;
}

function resolveSharedRelationalWeekdayChainDate(params: {
  expression: SharedRelationalWeekdayChainExpression;
  message: string;
  timezone: string;
  referenceTimeMs: number;
}) {
  const terminal =
    params.expression.nodes[
      params.expression.nodes.length - 1
    ];

  let cursor:
    | { year: number; month: number; day: number }
    | null = null;

  if (params.expression.anchorMonth) {
    if (!params.expression.anchorOccurrence) return null;

    const explicitYear =
      params.expression.anchorYearReference === "absolute"
        ? params.expression.anchorYear
        : null;

    const forceYear =
      /\bnext\s+year\b/.test(
        normalizeSharedTemporalSurface(params.message)
      )
        ? "next_year"
        : /\bthis\s+year\b/.test(
              normalizeSharedTemporalSurface(params.message)
            )
          ? "this_year"
          : null;

    if (
      params.expression.anchorOccurrence.kind ===
      "ordinal"
    ) {
      const referenceLocal = getReferenceLocalDate(
        params.referenceTimeMs,
        params.timezone
      );
      if (!referenceLocal) return null;

      const years = explicitYear
        ? [explicitYear]
        : forceYear === "next_year"
          ? [referenceLocal.year + 1]
          : forceYear === "this_year"
            ? [referenceLocal.year]
            : [referenceLocal.year, referenceLocal.year + 1];

      for (const year of years) {
        const candidate =
          resolveSharedMonthPositionWeekdayDate({
            year,
            month: params.expression.anchorMonth,
            weekdayIndex: terminal.weekdayIndex,
            occurrence:
              params.expression.anchorOccurrence.occurrence,
          });

        if (!candidate) continue;

        if (!explicitYear && forceYear === null) {
          const candidateEnd = zonedTimeToUtc({
            ...candidate,
            hour: 23,
            minute: 59,
            timezone: params.timezone,
          });

          if (
            new Date(candidateEnd).getTime() <=
            params.referenceTimeMs
          ) {
            continue;
          }
        }

        cursor = candidate;
        break;
      }
    } else {
      cursor = resolveSharedMonthScopedNextWeekday({
        referenceTimeMs: params.referenceTimeMs,
        timezone: params.timezone,
        month: params.expression.anchorMonth,
        weekdayIndex: terminal.weekdayIndex,
        occurrenceDepth:
          params.expression.anchorOccurrence.depth,
        explicitYear,
        forceYear,
      });
    }
  } else {
    if (
      !params.expression.anchorOccurrence ||
      params.expression.anchorOccurrence.kind !== "next"
    ) {
      return null;
    }

    cursor = resolveSharedWeekdayOccurrenceDate({
      referenceTimeMs: params.referenceTimeMs,
      timezone: params.timezone,
      weekdayIndex: terminal.weekdayIndex,
      occurrenceDepth:
        params.expression.anchorOccurrence.depth,
    });
  }

  if (!cursor) return null;

  /*
   * Relational chains are right-associative:
   *
   *   Thursday after Wednesday after next Thursday
   *
   * means:
   *
   *   Thursday AFTER (
   *     Wednesday AFTER (
   *       next Thursday
   *     )
   *   )
   *
   * Each preceding weekday is therefore resolved strictly after the date
   * produced by the node to its right.
   */
  for (
    let index = params.expression.nodes.length - 2;
    index >= 0;
    index -= 1
  ) {
    const node = params.expression.nodes[index];

    cursor = resolveSharedNthWeekdayStrictlyAfter({
      anchor: cursor,
      weekdayIndex: node.weekdayIndex,
      occurrenceDepth: Math.max(1, node.nextDepth),
    });
  }

  return cursor;
}

function hasSharedGroundedClockSurface(message: string) {
  const text = normalizeSharedTemporalSurface(message);

  return (
    /\b(?:at|around|about|roughly|approximately)?\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(
      text
    ) ||
    /\b(?:noon|midnight)\b/i.test(text)
  );
}

function parseSharedGroundedClockSurface(message: string) {
  const text = normalizeSharedTemporalSurface(message);

  if (/\bnoon\b/.test(text)) {
    return { hour: 12, minute: 0 };
  }

  if (/\bmidnight\b/.test(text)) {
    return { hour: 0, minute: 0 };
  }

  const match = text.match(
    /\b(?:at|around|about|roughly|approximately)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i
  );

  if (!match?.[1] || !match?.[3]) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3].replace(/\./g, "").toLowerCase();

  if (
    !Number.isInteger(hour) ||
    hour < 1 ||
    hour > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (meridiem === "pm") {
    if (hour !== 12) hour += 12;
  } else {
    return null;
  }

  return { hour, minute };
}

function formatSharedResolvedChainDate(
  localDate: { year: number; month: number; day: number },
  clock: { hour: number; minute: number } | null
) {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(
    new Date(
      Date.UTC(
        localDate.year,
        localDate.month - 1,
        localDate.day
      )
    )
  );

  if (!clock) return dateLabel;

  const hour12 = clock.hour % 12 || 12;
  const minute = String(clock.minute).padStart(2, "0");
  const meridiem = clock.hour >= 12 ? "PM" : "AM";

  return `${dateLabel} at ${hour12}:${minute} ${meridiem}`;
}

function reconcileRelationalWeekdayChain(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  const expression =
    parseSharedRelationalWeekdayChain(message);

  if (!expression) return intent;

  const targetLocalDate =
    resolveSharedRelationalWeekdayChainDate({
      expression,
      message,
      timezone,
      referenceTimeMs,
    });

  if (!targetLocalDate) {
    /*
     * Fail closed. Once the deterministic parser owns a syntactically valid
     * chain but cannot resolve its anchor, do not let a model silently drop
     * intermediate weekday relations and invent a different date.
     */
    return {
      ...emptyIntent(intent.originalPreference ?? message),
      interpretation:
        `${SHARED_RELATIONAL_WEEKDAY_CHAIN_INTERPRETATION_PREFIX} ` +
        `recognized relational weekday chain but could not resolve anchor safely`,
    };
  }

  const groundedClock =
    hasSharedGroundedClockSurface(message)
      ? parseSharedGroundedClockSurface(message)
      : null;

  const customerSpecifiedTime =
    groundedClock !== null;

  let allowedWindows: SchedulingTimeWindow[] = [];
  let targetTime: string | null = null;
  let localDateTime: SchedulingLocalDateTime | null = null;

  if (groundedClock) {
    localDateTime = {
      ...targetLocalDate,
      ...groundedClock,
    };

    targetTime = zonedTimeToUtc({
      ...localDateTime,
      timezone,
    });

    allowedWindows = [
      {
        startTime: targetTime,
        endTime: null,
      },
    ];
  } else {
    const nextDate = addLocalCalendarDays(
      targetLocalDate,
      1
    );

    allowedWindows = [
      {
        startTime: zonedTimeToUtc({
          ...targetLocalDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
        endTime: zonedTimeToUtc({
          ...nextDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
      },
    ];
  }

  const chainDescription = expression.nodes
    .map((node) => {
      const nextPrefix =
        node.nextDepth > 0
          ? `${"next ".repeat(node.nextDepth)}`
          : "";

      return `${nextPrefix}${node.weekdayName}`.trim();
    })
    .join(" after ");

  const yearWasExplicit =
    expression.anchorYearReference === "absolute";

  return {
    ...intent,
    hasPreference: true,
    allowedWindows,
    /*
     * Do not invent exclusions from a model interpretation whose DATE was
     * superseded by the deterministic relational chain.
     */
    excludedWindows: [],
    selectionMode:
      customerSpecifiedTime ? "closest" : "chronological",
    targetTime,
    displayPreference: formatSharedResolvedChainDate(
      targetLocalDate,
      groundedClock
    ),
    originalPreference:
      intent.originalPreference ?? message,
    interpretation:
      `${SHARED_RELATIONAL_WEEKDAY_CHAIN_INTERPRETATION_PREFIX} ` +
      `${chainDescription} -> ` +
      `${targetLocalDate.year}-${String(targetLocalDate.month).padStart(2, "0")}-${String(targetLocalDate.day).padStart(2, "0")} ` +
      `resolved right-to-left from deterministic anchor`,
    confidence: 1,
    temporalGranularity:
      customerSpecifiedTime ? "date_time" : "date_only",
    customerSpecifiedDate: true,
    customerSpecifiedTime,
    yearWasExplicit,
    yearReference:
      expression.anchorYearReference,
    localDateTime,
  };
}


const SHARED_PLAIN_WEEKDAY_INTERPRETATION_PREFIX =
  "[shared-plain-weekday-reference]";

type SharedPlainWeekdayExpression = {
  weekdayIndex: number;
  weekdayName: string;
};

function parseSharedPlainWeekdayReference(
  message: string
): SharedPlainWeekdayExpression | null {
  const text = normalizeSharedTemporalSurface(message);
  if (!text) return null;

  const mentions = extractSharedWeekdayMentions(text);
  if (mentions.length !== 1) return null;

  /*
   * This resolver owns ONLY a bare weekday reference such as:
   *   "Friday"
   *   "Friday at 3 PM"
   *   "move it to Friday at 3 PM"
   *
   * It intentionally stands down whenever the customer supplies a richer
   * independent calendar frame. Existing specialized resolvers retain
   * ownership of those expressions.
   */
  if (
    parseSharedComposableRelativeWeekday(text) ||
    parseSharedMonthPositionWeekdayExpression(text)
  ) {
    return null;
  }

  const monthName =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

  const independentCalendarSurface =
    monthName.test(text) ||
    /\b20\d{2}\b/.test(text) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text) ||
    /\b(?:today|tomorrow|yesterday)\b/.test(text) ||
    /\b(?:next|after|before|following|previous|last)\s+(?:day|week|month|year|sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i.test(
      text
    ) ||
    /\b(?:in|after)\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)\b/i.test(
      text
    ) ||
    /\b(?:the\s+)?(?:1st|2nd|3rd|[4-9]th|1\dth|2\dth|3[01](?:st|nd|rd|th))\b/i.test(
      text
    );

  if (independentCalendarSurface) return null;

  const weekdayIndex = mentions[0];
  const weekday = SHARED_WEEKDAYS.find(
    (candidate) => candidate.index === weekdayIndex
  );

  if (!weekday) return null;

  return {
    weekdayIndex,
    weekdayName: weekday.name,
  };
}

function resolveSharedNearestWeekdayFromReference(params: {
  referenceTimeMs: number;
  timezone: string;
  weekdayIndex: number;
}) {
  const referenceLocal = getReferenceLocalDate(
    params.referenceTimeMs,
    params.timezone
  );

  if (!referenceLocal) return null;

  const currentWeekday = getSharedWeekdayIndex(referenceLocal);
  const daysForward =
    (params.weekdayIndex - currentWeekday + 7) % 7;

  return addLocalCalendarDays(referenceLocal, daysForward);
}

function reconcilePlainWeekdayFromReference(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  const expression = parseSharedPlainWeekdayReference(message);
  if (!expression) return intent;

  const targetLocalDate = resolveSharedNearestWeekdayFromReference({
    referenceTimeMs,
    timezone,
    weekdayIndex: expression.weekdayIndex,
  });

  if (!targetLocalDate) return intent;

  /*
   * Preserve the model's already-understood wall-clock/time-window shape,
   * replacing only the calendar DATE with the deterministic weekday derived
   * from referenceTime.
   */
  const anchorIso =
    intent.targetTime ??
    intent.allowedWindows[0]?.startTime ??
    null;

  const anchorLocal = anchorIso
    ? getLocalDatePartsForIso(anchorIso, timezone)
    : intent.localDateTime
      ? {
          year: intent.localDateTime.year,
          month: intent.localDateTime.month,
          day: intent.localDateTime.day,
        }
      : null;

  const dayDelta = anchorLocal
    ? localCalendarDayNumber(targetLocalDate) -
      localCalendarDayNumber(anchorLocal)
    : 0;

  let allowedWindows = intent.allowedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  const excludedWindows = intent.excludedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  let targetTime = intent.targetTime
    ? shiftSharedIsoByLocalCalendarDays(
        intent.targetTime,
        timezone,
        dayDelta
      )
    : null;

  let localDateTime = intent.localDateTime
    ? {
        ...intent.localDateTime,
        ...targetLocalDate,
      }
    : null;

  if (
    intent.customerSpecifiedTime === true &&
    !localDateTime &&
    targetTime
  ) {
    const shiftedLocal = getLocalDateTimePartsForSharedIso(
      targetTime,
      timezone
    );

    if (shiftedLocal) {
      localDateTime = {
        ...shiftedLocal,
        ...targetLocalDate,
      };
    }
  }

  /*
   * Defensive recovery: if the model understood the requested wall-clock
   * components but failed to emit a usable target/window, rebuild that exact
   * local instant on the deterministic weekday.
   */
  if (
    intent.customerSpecifiedTime === true &&
    localDateTime &&
    !targetTime
  ) {
    targetTime = zonedTimeToUtc({
      ...localDateTime,
      timezone,
    });

    allowedWindows = [
      {
        startTime: targetTime,
        endTime: null,
      },
    ];
  }

  if (intent.customerSpecifiedTime !== true) {
    const nextDate = addLocalCalendarDays(targetLocalDate, 1);

    allowedWindows = [
      {
        startTime: zonedTimeToUtc({
          ...targetLocalDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
        endTime: zonedTimeToUtc({
          ...nextDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
      },
    ];

    targetTime = null;
    localDateTime = null;
  }

  return {
    ...intent,
    hasPreference: true,
    allowedWindows,
    excludedWindows,
    targetTime,
    customerSpecifiedDate: true,
    temporalGranularity:
      intent.customerSpecifiedTime === true
        ? intent.temporalGranularity === "window"
          ? "window"
          : "date_time"
        : intent.temporalGranularity === "window"
          ? "window"
          : "date_only",
    localDateTime,
    interpretation:
      `${SHARED_PLAIN_WEEKDAY_INTERPRETATION_PREFIX} ` +
      `${expression.weekdayName} resolved deterministically from referenceTime`,
  };
}

function reconcileComposableRelativeWeekday(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  const expression =
    parseSharedComposableRelativeWeekday(message);

  if (!expression) return intent;

  const targetLocalDate = resolveSharedWeekdayOccurrenceDate({
    referenceTimeMs,
    timezone,
    weekdayIndex: expression.weekdayIndex,
    occurrenceDepth: expression.occurrenceDepth,
  });

  if (!targetLocalDate) {
    return {
      ...emptyIntent(intent.originalPreference ?? message),
      interpretation:
        `${SHARED_RELATIVE_WEEKDAY_INTERPRETATION_PREFIX} failed to resolve reference local date`,
    };
  }

  /*
   * Derive the model's currently resolved local anchor only so we can shift
   * windows while preserving their local wall-clock shape. The DATE itself is
   * replaced by the deterministic compositional weekday occurrence.
   */
  const anchorIso =
    intent.targetTime ??
    intent.allowedWindows[0]?.startTime ??
    null;

  const anchorLocal = anchorIso
    ? getLocalDatePartsForIso(anchorIso, timezone)
    : intent.localDateTime
      ? {
          year: intent.localDateTime.year,
          month: intent.localDateTime.month,
          day: intent.localDateTime.day,
        }
      : null;

  const dayDelta = anchorLocal
    ? localCalendarDayNumber(targetLocalDate) -
      localCalendarDayNumber(anchorLocal)
    : 0;

  const shiftedAllowedWindows = intent.allowedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  const shiftedExcludedWindows = intent.excludedWindows
    .map((window) => shiftSharedWindow(window, timezone, dayDelta))
    .filter(Boolean) as SchedulingTimeWindow[];

  const shiftedTargetTime = intent.targetTime
    ? shiftSharedIsoByLocalCalendarDays(
        intent.targetTime,
        timezone,
        dayDelta
      )
    : null;

  let localDateTime = intent.localDateTime
    ? {
        ...intent.localDateTime,
        ...targetLocalDate,
      }
    : null;

  if (
    intent.customerSpecifiedTime === true &&
    !localDateTime &&
    shiftedTargetTime
  ) {
    const shiftedLocal = getLocalDateTimePartsForSharedIso(
      shiftedTargetTime,
      timezone
    );

    if (shiftedLocal) {
      localDateTime = {
        ...shiftedLocal,
        ...targetLocalDate,
      };
    }
  }

  /*
   * A weekday relation is customer-supplied DATE evidence regardless of what
   * the model called the temporal granularity.
   */
  const temporalGranularity: SchedulingTemporalGranularity =
    intent.customerSpecifiedTime === true
      ? intent.temporalGranularity === "window"
        ? "window"
        : "date_time"
      : intent.temporalGranularity === "window"
        ? "window"
        : "date_only";

  let allowedWindows = shiftedAllowedWindows;
  let targetTime = shiftedTargetTime;

  if (intent.customerSpecifiedTime !== true) {
    const nextDate = addLocalCalendarDays(targetLocalDate, 1);

    allowedWindows = [
      {
        startTime: zonedTimeToUtc({
          ...targetLocalDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
        endTime: zonedTimeToUtc({
          ...nextDate,
          hour: 0,
          minute: 0,
          timezone,
        }),
      },
    ];
    targetTime = null;
    localDateTime = null;
  }

  return {
    ...intent,
    hasPreference: true,
    allowedWindows,
    excludedWindows: shiftedExcludedWindows,
    targetTime,
    customerSpecifiedDate: true,
    temporalGranularity,
    localDateTime,
    interpretation:
      `${
        parseSharedAwkwardRelativeWeekday(message)
          ? SHARED_AWKWARD_WEEKDAY_INTERPRETATION_PREFIX
          : SHARED_RELATIVE_WEEKDAY_INTERPRETATION_PREFIX
      } ` +
      `${expression.weekdayName} occurrence depth ${expression.occurrenceDepth} ` +
      `resolved compositionally from referenceTime`,
  };
}

function enforceLiteralWeekdayConsistency(
  intent: ResolvedSchedulingIntent,
  message: string,
  timezone: string
): ResolvedSchedulingIntent {
  if (
    !intent.hasPreference ||
    intent.customerSpecifiedDate !== true ||
    intent.temporalGranularity === "window"
  ) {
    return intent;
  }

  const mentions = extractSharedWeekdayMentions(message);

  /*
   * One literal weekday gives us a hard invariant. Multiple distinct weekdays
   * may describe ranges/alternatives, so they are intentionally left to the
   * general semantic resolver.
   */
  if (mentions.length !== 1) return intent;

  const expectedWeekday = mentions[0];

  const localDate =
    intent.localDateTime
      ? {
          year: intent.localDateTime.year,
          month: intent.localDateTime.month,
          day: intent.localDateTime.day,
        }
      : intent.targetTime
        ? getLocalDatePartsForIso(intent.targetTime, timezone)
        : intent.allowedWindows[0]?.startTime
          ? getLocalDatePartsForIso(
              intent.allowedWindows[0].startTime,
              timezone
            )
          : null;

  if (!localDate) return intent;

  if (getSharedWeekdayIndex(localDate) === expectedWeekday) {
    return intent;
  }

  console.warn("[scheduling-intent] literal weekday mismatch rejected", {
    message,
    expectedWeekday,
    resolvedLocalDate: localDate,
    targetTime: intent.targetTime,
  });

  return {
    ...emptyIntent(intent.originalPreference ?? message),
    interpretation:
      "Resolved scheduling timestamp contradicted the customer's literal weekday.",
  };
}

function isSharedComposableRelativeWeekdayIntent(
  intent: ResolvedSchedulingIntent | null | undefined
) {
  return Boolean(
    intent?.interpretation?.startsWith(
      SHARED_RELATIVE_WEEKDAY_INTERPRETATION_PREFIX
    )
  );
}

function canonicalizeExactLocalDateTime(
  intent: ResolvedSchedulingIntent,
  timezone: string,
  referenceTimeMs: number
): ResolvedSchedulingIntent {
  if (
    !intent.hasPreference ||
    intent.temporalGranularity !== "date_time" ||
    !intent.customerSpecifiedDate ||
    !intent.customerSpecifiedTime ||
    !intent.localDateTime
  ) {
    return intent;
  }

  let local = { ...intent.localDateTime };

  /*
    Only an actually omitted year is eligible for deterministic "next
    non-past occurrence" handling.

    A relative-year expression is already semantic information supplied by
    the customer. Its resolved local year must not be overwritten merely
    because the customer did not type a four-digit year.

    An absolute year is likewise fixed.
  */
  if (intent.yearReference === "unspecified") {
    const referenceDate = new Date(referenceTimeMs);
    const referenceParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
    }).formatToParts(referenceDate);

    const referenceYear = Number(
      referenceParts.find((part) => part.type === "year")?.value
    );

    if (
      Number.isInteger(referenceYear) &&
      referenceYear >= 1 &&
      referenceYear <= 9999
    ) {
      local = { ...local, year: referenceYear };
    }
  }

  const yearIsFixed =
    intent.yearReference === "relative" ||
    intent.yearReference === "absolute";

  /*
    For a truly omitted year, advance the LOCAL calendar year until the
    requested month/day/time is in the future. For relative/absolute year
    semantics, preserve the resolved year exactly. If that fixed semantic
    result is invalid, fail closed rather than silently changing years.
  */
  for (let attempts = 0; attempts <= 400; attempts += 1) {
    const candidate = zonedTimeToUtc({
      ...local,
      timezone,
    });

    const candidateMs = new Date(candidate).getTime();

    if (
      localDateTimeMatches(candidate, local, timezone) &&
      (yearIsFixed || candidateMs > referenceTimeMs)
    ) {
      return {
        ...intent,
        allowedWindows: [{ startTime: candidate, endTime: null }],
        targetTime: candidate,
        selectionMode: intent.selectionMode,
        localDateTime: local,
      };
    }

    if (yearIsFixed) {
      return {
        ...intent,
        hasPreference: false,
        allowedWindows: [],
        targetTime: null,
        confidence: 0,
      };
    }

    local = {
      ...local,
      year: local.year + 1,
    };

    if (local.year > 9999) break;
  }

  return {
    ...intent,
    hasPreference: false,
    allowedWindows: [],
    targetTime: null,
    confidence: 0,
  };
}

export async function resolveSchedulingIntent({
  message,
  timezone,
  referenceTime,
  availabilityContext,
}: ResolveSchedulingIntentInput): Promise<ResolvedSchedulingIntent> {
  const cleanMessage = String(message ?? "").trim();

  if (!cleanMessage) {
    return emptyIntent();
  }

  const referenceIso = validIso(referenceTime) ?? new Date().toISOString();
  const contextSlots = availabilityContext?.offeredSlots?.filter((slot) => validIso(slot.startTime)) ?? [];
  const availabilityContextInstruction = contextSlots.length === 0 ? "" : [
    "CURRENT AVAILABILITY CONVERSATION CONTEXT (data, not booking authorization):",
    JSON.stringify({ timezone, offeredSlots: contextSlots }),
    "The newest message is refining the time of day of these current offers without supplying a new date. If all offers share one local calendar date, inherit that date including its year; do not replace it with the message date. Explicit date or from-now instructions in the customer message remain authoritative.",
    "A list of offers is not one exact clock anchor. Preserve a requested daypart as a meaningful window. Vague amounts such as a few hours must not become an invented exact offset or arbitrarily narrow window when the customer instead identifies a daypart. If different offered dates leave the referent ambiguous, do not invent one.",
    "Keep customerSpecifiedDate=false for an inherited date. Do not treat the offered clocks as newly customer-specified clocks.",
  ].join("\n");

  if (!process.env.OPENAI_API_KEY) {
    return emptyIntent(cleanMessage);
  }

  try {
    const response = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "resolved_scheduling_intent",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: responseProperties,
            required: responseRequired,
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "Resolve the customer's scheduling language into concrete temporal constraints.",
            `Reference instant: ${referenceIso}.`,
            `Business timezone: ${timezone}.`,
            "Interpret relative dates only from the supplied reference instant and business timezone.",
            "Do not rely on a fixed phrase grammar.",
            "A scheduling preference may appear inside a correction, restatement, complaint, reminder, rejection of earlier options, or other conversational wrapper.",
            "Treat the temporal meaning inside that wrapper as the customer's active scheduling request unless the customer explicitly cancels or withdraws it.",
            "An explicit date, relative date, weekday, daypart, clock time, date range, or combination of those is a real scheduling preference even if the customer does not use words like book, schedule, appointment, or come.",
            "Do not treat phrases such as 'I said', 'I meant', 'actually', 'no', 'instead', or rejection of prior options as removing an otherwise clear scheduling preference.",
            "Represent every acceptable time region as an ISO-8601 allowed window.",
            "Represent explicit exclusions as ISO-8601 excluded windows.",
            "For an exact requested clock time with an explicit or relative date in the newest message, set allowedWindows to a start-only window, targetTime to that same instant, and selectionMode=closest unless exact-only matching is required.",
            "For a date or broad period without an exact clock time, preserve the full requested local period as an allowed window instead of turning the period boundary into an appointment time.",
            "When a calendar date omits all year semantics, resolve it to the next occurrence that is not in the past in the business timezone.",
            "If the customer expresses a preferred center or approximate target, set targetTime and selectionMode=closest.",
            "If the customer asks for the first possible opening without a bounded date preference, set selectionMode=earliest.",
            "Use strict=true when the customer clearly prohibits substitution outside the requested constraints.",
            "Do not invent a narrower preference than the customer stated.",
            "For broad periods, preserve the full period as a window rather than choosing an arbitrary date.",
            "If the message contains no real scheduling preference, return hasPreference=false and empty windows.",
            "If the scheduling language cannot be resolved safely, fail closed by returning hasPreference=false instead of guessing.",
            "displayPreference must be a concise customer-facing description of the scheduling request, not the entire service message.",
            "originalPreference must preserve the customer's scheduling wording as closely as possible.",
            "All non-null timestamps must include an explicit UTC offset or Z.",
            "CRITICAL RELATIVE-EDIT CONTRACT: when the newest customer message describes changing an offered slot, an active appointment, or an active scheduling point by a relative amount, populate temporalOperation instead of collapsing the language into an arbitrary absolute timestamp/window.",
            "temporalOperation.kind must be 'shift'. Choose anchorKind='selected_offer' when the customer explicitly references an offered option/slot; set optionNumber to that 1-based option. Choose anchorKind='active_appointment' when the customer asks to move/change their booked appointment relative to itself. Choose anchorKind='active_temporal_context' when the customer clearly edits the currently discussed scheduling point but does not explicitly identify an offered option or booked appointment. Choose anchorKind='reference_now' only for expressions explicitly relative to now/current time.",
            "Represent calendar shifts in years/months/weeks/days and elapsed clock shifts in hours/minutes. Preserve sign: forward/later/after/next/following are positive when they semantically modify the anchor; back/earlier/before/prior/previous/last are negative.",
            "For expressions like 'the month after', 'next month', or 'following month' applied to an offer/appointment, use months=1. For 'the month before', 'previous month', or 'last month', use months=-1. Apply the same principle to days, weeks, and years.",
            "If the customer supplies a replacement clock while also shifting the date, set setClock to the intended local 24-hour clock. Example semantic shape: 'move it forward three days at 2 pm' => anchorKind active_appointment, days=3, setClock={hour:14,minute:0}.",
            "If the customer selects an offered option and then shifts it, the offered option is the anchor and MUST NOT be discarded. Example semantic shape: 'option 3 the month after' => anchorKind selected_offer, optionNumber=3, months=1, preserveClock=true.",
            "For a relative edit whose authoritative anchor is not provided to you, DO NOT invent the anchor timestamp. It is valid to return allowedWindows=[], targetTime=null, localDateTime=null while returning a non-null temporalOperation; the downstream canonical temporal layer owns anchor resolution and calendar math.",
            "Set temporalOperation=null for purely absolute requests that do not transform an existing temporal anchor.",
            "CRITICAL RELATIVE-EDIT CONTRACT: when the newest customer message describes changing an offered slot, an active appointment, or an active scheduling point by a relative amount, populate temporalOperation instead of collapsing the language into an arbitrary absolute timestamp/window.",
            "temporalOperation.kind must be 'shift'. Choose anchorKind='selected_offer' when the customer explicitly references an offered option/slot; set optionNumber to that 1-based option. Choose anchorKind='active_appointment' when the customer asks to move/change their booked appointment relative to itself. Choose anchorKind='active_temporal_context' when the customer clearly edits the currently discussed scheduling point but does not explicitly identify an offered option or booked appointment. Choose anchorKind='reference_now' only for expressions explicitly relative to now/current time.",
            "Represent calendar shifts in years/months/weeks/days and elapsed clock shifts in hours/minutes. Preserve sign: forward/later/after/next/following are positive when they semantically modify the anchor; back/earlier/before/prior/previous/last are negative.",
            "For expressions like 'the month after', 'next month', or 'following month' applied to an offer/appointment, use months=1. For 'the month before', 'previous month', or 'last month', use months=-1. Apply the same principle to days, weeks, and years.",
            "If the customer supplies a replacement clock while also shifting the date, set setClock to the intended local 24-hour clock. Example semantic shape: 'move it forward three days at 2 pm' => anchorKind active_appointment, days=3, setClock={hour:14,minute:0}.",
            "If the customer selects an offered option and then shifts it, the offered option is the anchor and MUST NOT be discarded. Example semantic shape: 'option 3 the month after' => anchorKind selected_offer, optionNumber=3, months=1, preserveClock=true.",
            "For a relative edit whose authoritative anchor is not provided to you, DO NOT invent the anchor timestamp. It is valid to return allowedWindows=[], targetTime=null, localDateTime=null while returning a non-null temporalOperation; the downstream canonical temporal layer owns anchor resolution and calendar math.",
            "Set temporalOperation=null for purely absolute requests that do not transform an existing temporal anchor.",

            /*
              Critical conversation-safety contract:
              classify what the customer actually supplied independently from
              whatever date is needed internally to make an ISO timestamp.
            */
            "Set customerSpecifiedDate=true ONLY when the customer's NEWEST message itself supplies a date-bearing constraint: an explicit calendar date, relative date, weekday, month/period, date range, or equivalent date-bearing expression.",
            "Set customerSpecifiedTime=true ONLY when the customer's NEWEST message itself supplies a clock time or daypart/time-bearing constraint.",
            "A bare clock-time follow-up such as '3:30 PM', 'make it 4', or 'do 11 AM' MUST be temporalGranularity=time_only, customerSpecifiedDate=false, customerSpecifiedTime=true.",
            "For time_only input, any date used internally to populate allowedWindows/targetTime/localDateTime is ONLY an anchor and MUST NOT be interpreted as a customer-requested date.",
            "A date with no customer clock time must be temporalGranularity=date_only or window and customerSpecifiedTime=false.",
            "A request containing both a customer-supplied date-bearing constraint and a customer-supplied time must be temporalGranularity=date_time.",
            "Broad periods/ranges must use temporalGranularity=window.",
            "If there is no temporal request, use temporalGranularity=none.",

            /*
              Disciplined year semantics:
              relative is intentionally narrower than "anything vaguely
              future". It requires an actual semantic year constraint.
            */
            "Classify year semantics independently from the numeric year you resolve.",
            "Set yearReference='unspecified' when the NEWEST customer message supplies no year constraint. Do not infer a relative-year constraint merely because a requested month/day would otherwise be in the past.",
            "Set yearReference='relative' ONLY when the NEWEST customer message contains a clear, affirmative temporal constraint that changes or identifies the calendar year relative to the supplied reference instant or to an explicit temporal anchor in that same newest message.",
            "Relative-year meaning must be genuinely year-bearing. General future language, urgency, sequence words, rejection of options, words such as later/after/next by themselves, or an inferred need to move a date forward are NOT sufficient.",
            "Do not treat the isolated word 'next' as a relative-year constraint unless its semantic scope clearly identifies a year or an equivalent year-scale period.",
            "If the scope or meaning of a supposed relative-year expression is ambiguous, use yearReference='unspecified' rather than guessing.",
            "Set yearReference='absolute' ONLY when the NEWEST customer message explicitly supplies a concrete calendar year.",
            "Set yearWasExplicit=true ONLY when yearReference='absolute'. Otherwise set yearWasExplicit=false.",
            "For yearReference='relative', resolve the customer's year relation from the supplied reference instant/business timezone (or the explicit temporal anchor in the newest message when applicable) and place that resolved LOCAL calendar year in localDateTime/windows. Preserve the requested month/day/time; do not collapse the request into the reference year merely because that month/day has not occurred yet.",
            "For yearReference='unspecified', a calendar date with no year semantics means the next occurrence that is not in the past in the business timezone.",
            "Never invent a relative-year relationship from conversational context that is not actually expressed in the newest customer message.",

            "For exact/approximate customer clock-time requests, localDateTime must contain the intended local wall-clock components in the business timezone. For time_only input, its date components are merely an anchor and are NOT evidence that the customer specified a date.",
            "For requests without a customer clock time, localDateTime=null.",
            availabilityContextInstruction,
          ].join("\n"),
        },
        {
          role: "user",
          content: cleanMessage,
        },
      ],
    });

    const rawText = response.choices[0]?.message?.content;

    if (!rawText) {
      return emptyIntent(cleanMessage);
    }

    let firstPass = normalizeIntent(JSON.parse(rawText), cleanMessage);
    const groundedFirstPass = reconcileUngroundedCalendarPoint(firstPass, cleanMessage);
    if (groundedFirstPass !== firstPass) return groundedFirstPass;

    const referenceTimeMs = new Date(referenceIso).getTime();

    // Reconcile contradictory temporal dimensions before existing canonicalization.
    firstPass = reconcileTemporalDimensionsFromSurfaceEvidence(
      firstPass,
      cleanMessage
    );
    firstPass = reconcileRelationalWeekdayChain(
      firstPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    firstPass = reconcileComposableRelativeWeekday(
      firstPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    firstPass = reconcileMonthPositionWeekday(
      firstPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    firstPass = reconcilePlainWeekdayFromReference(
      firstPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    firstPass = canonicalizeSingleLocalDateWindow(firstPass, timezone);
    firstPass = reconcileTomorrowLocalDate(
      firstPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );

    /*
      Exact date+time requests are canonicalized from customer local wall
      clock components immediately. This removes model-generated UTC offset
      errors while preserving explicit/relative year semantics.
    */
    firstPass = canonicalizeExactLocalDateTime(
      firstPass,
      timezone,
      referenceTimeMs
    );
    firstPass = enforceLiteralWeekdayConsistency(
      firstPass,
      cleanMessage,
      timezone
    );

    /*
      A time-only reply is intentionally returned AS time-only. We do not
      manufacture a standalone date from referenceTime. The inbound
      conversation layer can now distinguish it from a complete override and
      inherit/merge the active scheduling date or pending-option context.
    */
    if (firstPass.temporalGranularity === "time_only") {
      return {
        ...firstPass,
        allowedWindows: [],
        targetTime: null,
      };
    }

    const firstPassHasPastOnlyBoundedWindows =
      firstPass.hasPreference &&
      firstPass.allowedWindows.length > 0 &&
      firstPass.allowedWindows.every((window) => {
        const boundaryTimeMs = new Date(
          window.endTime ?? window.startTime
        ).getTime();

        return (
          Number.isFinite(boundaryTimeMs) &&
          boundaryTimeMs <= referenceTimeMs
        );
      });

    if (
      firstPass.hasPreference &&
      !firstPassHasPastOnlyBoundedWindows
    ) {
      return firstPass;
    }

    const retryResponse = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "resolved_scheduling_intent_retry",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: responseProperties,
            required: responseRequired,
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "Perform a second-pass temporal scheduling extraction.",
            `Reference instant: ${referenceIso}.`,
            `Business timezone: ${timezone}.`,
            "Examine the customer's newest message for any actionable temporal scheduling constraint.",
            "Ignore conversational wrappers, corrections, emphasis markup, rejection of previous options, quoted-email context, and service wording except where they change the temporal meaning.",
            "Do not require booking verbs.",
            "Do not rely on a fixed phrase grammar or hardcoded date expressions.",
            "Resolve relative temporal language from the supplied reference instant in the business timezone.",
            "For an exact clock time with a customer-supplied date-bearing constraint, use that exact instant as targetTime and as the start of an allowed window with endTime=null.",
            "For every exact or approximate customer clock-time request, localDateTime MUST contain the customer's intended local wall-clock year, month, day, hour, and minute in the business timezone, before any UTC conversion.",
            "For date-only or broad-period requests with no customer clock time, set localDateTime=null.",
            "For a date or broad period without an exact clock time, preserve the entire requested local period as an allowed window.",
            "When a calendar date omits all year semantics, resolve it to the next occurrence that is not in the past in the business timezone.",
            "Use selectionMode=closest for an exact or approximate target, earliest only for an unbounded request for the first available opening, otherwise chronological.",
            "Preserve the customer's scheduling wording as closely as possible in originalPreference.",
            "displayPreference must be concise and customer-facing.",
            "Return hasPreference=false only when there is genuinely no safely resolvable temporal scheduling request.",
            "All non-null timestamps must include an explicit UTC offset or Z.",
            "Set customerSpecifiedDate=true ONLY if the NEWEST customer message itself contains a date-bearing expression.",
            "Set customerSpecifiedTime=true ONLY if the NEWEST customer message itself contains a time-bearing expression.",
            "A bare time such as '3:30 PM', 'make it 4', or 'do 11 AM' is time_only even if you need an anchor date internally. Never upgrade that inferred anchor date into customerSpecifiedDate=true.",
            "A date-only request is date_only/window, not date_time.",
            "A request with both customer-supplied date and time is date_time.",

            "Classify year semantics independently from the numeric year you resolve.",
            "Set yearReference='unspecified' when the NEWEST customer message supplies no year constraint. Do not infer relative-year meaning merely to make a date future.",
            "Set yearReference='relative' ONLY when the NEWEST customer message contains a clear, affirmative, genuinely year-bearing temporal constraint that identifies or changes the calendar year relative to the supplied reference instant or an explicit temporal anchor in that same newest message.",
            "General future language, urgency, rejection/correction wrappers, sequence words, later/after/next by themselves, and inferred rollover are NOT relative-year evidence.",
            "The isolated word 'next' is insufficient unless its semantic scope clearly identifies a year or equivalent year-scale period.",
            "If relative-year scope is ambiguous, use yearReference='unspecified' rather than guessing.",
            "Set yearReference='absolute' ONLY when the NEWEST customer message explicitly supplies a concrete calendar year.",
            "Set yearWasExplicit=true ONLY for yearReference='absolute'; otherwise false.",
            "For yearReference='relative', resolve the year relation using the supplied reference instant/business timezone or the explicit same-message temporal anchor, and preserve that resolved local year. Do not overwrite it with ordinary omitted-year rollover.",
            "For yearReference='unspecified', use ordinary next-non-past calendar occurrence semantics.",

            "The previous interpretation was either absent or entirely before the reference instant. Re-evaluate the original newest message rather than copying the previous interpretation.",
            availabilityContextInstruction,
          ].join("\n"),
        },
        {
          role: "user",
          content: cleanMessage,
        },
      ],
    });

    const retryRawText = retryResponse.choices[0]?.message?.content;

    if (!retryRawText) {
      return firstPass;
    }

    const retryRaw = JSON.parse(retryRawText);
    let secondPass = normalizeIntent(retryRaw, cleanMessage);
    secondPass = reconcileUngroundedCalendarPoint(secondPass, cleanMessage);

    secondPass = reconcileTemporalDimensionsFromSurfaceEvidence(
      secondPass,
      cleanMessage
    );
    secondPass = reconcileRelationalWeekdayChain(
      secondPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    secondPass = reconcileComposableRelativeWeekday(
      secondPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    secondPass = reconcileMonthPositionWeekday(
      secondPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    secondPass = reconcilePlainWeekdayFromReference(
      secondPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    secondPass = canonicalizeSingleLocalDateWindow(secondPass, timezone);
    secondPass = reconcileTomorrowLocalDate(
      secondPass,
      cleanMessage,
      timezone,
      referenceTimeMs
    );
    secondPass = canonicalizeExactLocalDateTime(
      secondPass,
      timezone,
      referenceTimeMs
    );
    secondPass = enforceLiteralWeekdayConsistency(
      secondPass,
      cleanMessage,
      timezone
    );

    if (secondPass.temporalGranularity === "time_only") {
      console.log("[scheduling-intent] time-only preference preserved", {
        originalPreference: secondPass.originalPreference,
        displayPreference: secondPass.displayPreference,
        customerSpecifiedDate: secondPass.customerSpecifiedDate,
        customerSpecifiedTime: secondPass.customerSpecifiedTime,
        yearReference: secondPass.yearReference,
        localDateTime: secondPass.localDateTime,
      });

      return {
        ...secondPass,
        allowedWindows: [],
        targetTime: null,
      };
    }

    const secondPassHasPastOnlyBoundedWindows =
      secondPass.hasPreference &&
      secondPass.allowedWindows.length > 0 &&
      secondPass.allowedWindows.every((window) => {
        const boundaryTimeMs = new Date(
          window.endTime ?? window.startTime
        ).getTime();

        return (
          Number.isFinite(boundaryTimeMs) &&
          boundaryTimeMs <= referenceTimeMs
        );
      });

    let resolvedSecondPass = secondPass;

    if (
      secondPassHasPastOnlyBoundedWindows &&
      secondPass.yearReference === "unspecified"
    ) {
      /*
        Preserve the first-pass calendar shape during a TRUE omitted-year
        rollover. Relative/absolute year semantics are intentionally excluded
        from this fallback so we never silently change a customer-constrained
        year.

        Exact date+time requests have already been canonicalized above, so
        this block is primarily for date-only and broad bounded periods.
      */
      const rolloverSource =
        firstPassHasPastOnlyBoundedWindows &&
        firstPass.yearReference === "unspecified"
          ? firstPass
          : secondPass;

      const shiftIsoByCalendarYears = (
        value: string,
        years: number
      ): string | null => {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
          return null;
        }

        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(date);

        const get = (type: string) =>
          Number(parts.find((part) => part.type === type)?.value);

        const originalYear = get("year");
        const originalMonth = get("month");
        const originalDay = get("day");
        const rawHour = get("hour");
        const originalHour = rawHour === 24 ? 0 : rawHour;
        const originalMinute = get("minute");

        const shiftedYear = originalYear + years;

        const shifted = zonedTimeToUtc({
          year: shiftedYear,
          month: originalMonth,
          day: originalDay,
          hour: originalHour,
          minute: originalMinute,
          timezone,
        });

        const shiftedDate = new Date(shifted);

        if (Number.isNaN(shiftedDate.getTime())) {
          return null;
        }

        const shiftedParts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(shiftedDate);

        const shiftedGet = (type: string) =>
          Number(shiftedParts.find((part) => part.type === type)?.value);

        const shiftedRawHour = shiftedGet("hour");
        const shiftedHour = shiftedRawHour === 24 ? 0 : shiftedRawHour;

        if (
          shiftedGet("year") !== shiftedYear ||
          shiftedGet("month") !== originalMonth ||
          shiftedGet("day") !== originalDay ||
          shiftedHour !== originalHour ||
          shiftedGet("minute") !== originalMinute
        ) {
          return null;
        }

        return shifted;
      };

      let yearsToAdvance = 1;
      let shiftedAllowedWindows: SchedulingTimeWindow[] | null = null;

      while (yearsToAdvance <= 400) {
        const candidateWindows = rolloverSource.allowedWindows
          .map((window) => {
            const startTime = shiftIsoByCalendarYears(
              window.startTime,
              yearsToAdvance
            );

            const endTime = window.endTime
              ? shiftIsoByCalendarYears(
                  window.endTime,
                  yearsToAdvance
                )
              : null;

            if (!startTime || (window.endTime && !endTime)) {
              return null;
            }

            return {
              startTime,
              endTime,
            };
          })
          .filter(Boolean) as SchedulingTimeWindow[];

        if (
          candidateWindows.length === rolloverSource.allowedWindows.length &&
          candidateWindows.some((window) => {
            const boundary = window.endTime ?? window.startTime;
            return new Date(boundary).getTime() > referenceTimeMs;
          })
        ) {
          shiftedAllowedWindows = candidateWindows;
          break;
        }

        yearsToAdvance += 1;
      }

      if (shiftedAllowedWindows) {
        const shiftedTargetTime = rolloverSource.targetTime
          ? shiftIsoByCalendarYears(
              rolloverSource.targetTime,
              yearsToAdvance
            )
          : null;

        resolvedSecondPass = {
          ...secondPass,
          allowedWindows: shiftedAllowedWindows,
          targetTime: shiftedTargetTime,
          selectionMode:
            rolloverSource === firstPass
              ? firstPass.selectionMode
              : secondPass.selectionMode,
        };
      }
    }

    console.log("[scheduling-intent] second-pass resolution", {
      firstPassHasPreference: firstPass.hasPreference,
      firstPassHasPastOnlyBoundedWindows,
      firstPassAllowedWindows: firstPass.allowedWindows,
      firstPassYearReference: firstPass.yearReference,
      secondPassHasPreference: secondPass.hasPreference,
      secondPassHasPastOnlyBoundedWindows,
      yearWasExplicit: secondPass.yearWasExplicit,
      yearReference: secondPass.yearReference,
      temporalGranularity: resolvedSecondPass.temporalGranularity,
      customerSpecifiedDate: resolvedSecondPass.customerSpecifiedDate,
      customerSpecifiedTime: resolvedSecondPass.customerSpecifiedTime,
      localDateTime: resolvedSecondPass.localDateTime,
      originalPreference: resolvedSecondPass.originalPreference,
      displayPreference: resolvedSecondPass.displayPreference,
      targetTime: resolvedSecondPass.targetTime,
      allowedWindows: resolvedSecondPass.allowedWindows,
      confidence: resolvedSecondPass.confidence,
    });

    return resolvedSecondPass.hasPreference
      ? resolvedSecondPass
      : firstPass;
  } catch (error: any) {
    console.error("[scheduling-intent] semantic resolution failed", {
      error: error?.message ?? error,
    });

    return emptyIntent(cleanMessage);
  }
}