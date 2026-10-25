// lib/jobs/processNewLeadJob.ts

import { supabase } from "@/lib/supabase";
import { generateLeadReply } from "@/lib/ai/generateLeadReply";
import {
  resolveSchedulingIntent,
  type ResolvedSchedulingIntent,
  type SchedulingTimeWindow,
} from "@/lib/ai/resolveSchedulingIntent";
import { sendLeadReply } from "@/lib/email/sendLeadReply";
import { createCalendarBooking } from "@/lib/google/createCalendarBooking";
import { suggestAlternativeSlots } from "@/lib/availability/checkAvailability";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import type { ProcessNewLeadJobData } from "@/lib/background-jobs/backgroundJobTypes";

type AlternativeSlot = {
  startTime: string;
  endTime: string;
  timezone: string;
  travelBufferMinutes: number | null;
};


function safeJobId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isBlockedLeadStatus(status?: string | null) {
  return (
    status === "booked" ||
    status === "completed" ||
    status === "closed" ||
    status === "duplicate" ||
    status === "outside_service_area" ||
    status === "spam"
  );
}

function normalizeReplyText(replyResult: unknown) {
  if (typeof replyResult === "string") return replyResult;

  if (replyResult && typeof replyResult === "object") {
    const value = replyResult as Record<string, unknown>;

    if (typeof value.reply === "string") return value.reply;
    if (typeof value.message === "string") return value.message;
    if (typeof value.text === "string") return value.text;
  }

  return "";
}

function getFallbackQualification(lead: any) {
  const existing =
    lead.qualification && typeof lead.qualification === "object"
      ? lead.qualification
      : {};

  return {
    serviceType: existing.serviceType ?? lead.type ?? "hvac",
    urgency: existing.urgency ?? lead.priority ?? "normal",
    issueSummary:
      existing.issueSummary ??
      lead.issue_summary ??
      lead.input ??
      lead.message ??
      "",
    preferredTime: existing.preferredTime ?? lead.preferred_time ?? null,
    customerName: existing.customerName ?? lead.customer_name ?? null,
    email: existing.email ?? lead.email ?? null,
    phone: existing.phone ?? lead.phone ?? null,
    isCommercial: existing.isCommercial ?? false,
    rawMessage: existing.rawMessage ?? lead.input ?? lead.message ?? "",
    location: {
      address: existing.location?.address ?? lead.address ?? null,
      city: existing.location?.city ?? lead.city ?? null,
      state: existing.location?.state ?? lead.state ?? null,
      zip: existing.location?.zip ?? lead.zip ?? null,
    },
  };
}

function normalizeExistingQualification(lead: any) {
  return lead.qualification && typeof lead.qualification === "object"
    ? lead.qualification
    : {};
}

function emptySchedulingIntent(): ResolvedSchedulingIntent {
  return {
    hasPreference: false,
    allowedWindows: [],
    excludedWindows: [],
    selectionMode: "chronological",
    targetTime: null,
    strict: false,
    displayPreference: null,
    originalPreference: null,
    interpretation: null,
    confidence: 0,
    temporalGranularity: "none",
    customerSpecifiedDate: false,
    customerSpecifiedTime: false,
    yearWasExplicit: false,
    yearReference: "unspecified",
    localDateTime: null,
  };
}

type ActiveSchedulingYearContext = {
  year: number;
  source: "relative_year" | "absolute_year";
  establishedByReply: string | null;
  establishedAt: string | null;
};

function getLocalYearForIso(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);

  const year = Number(
    parts.find((part) => part.type === "year")?.value
  );

  return Number.isInteger(year) ? year : null;
}

function getResolvedSchedulingYear(
  intent: ResolvedSchedulingIntent,
  timezone: string
) {
  const localYear = Number(intent.localDateTime?.year);

  if (
    Number.isInteger(localYear) &&
    localYear >= 1 &&
    localYear <= 9999
  ) {
    return localYear;
  }

  const anchor =
    intent.targetTime ??
    intent.allowedWindows[0]?.startTime ??
    null;

  return anchor
    ? getLocalYearForIso(anchor, timezone)
    : null;
}

/*
 * First-message -> conversation context bridge.
 *
 * The Sept-17 inbound engine already knows how to preserve an active future
 * year, but the first-message job previously never persisted that context.
 * Establish it here ONLY when the resolver says the customer actually supplied
 * relative/absolute year semantics and the resolved year is future relative to
 * the lead's own reference timestamp. Ordinary current-year requests are left
 * untouched.
 */
function buildActiveSchedulingYearContext(params: {
  intent: ResolvedSchedulingIntent;
  timezone: string;
  referenceTime: string;
  message: string;
}): ActiveSchedulingYearContext | null {
  if (
    params.intent.yearReference !== "relative" &&
    params.intent.yearReference !== "absolute"
  ) {
    return null;
  }

  const resolvedYear = getResolvedSchedulingYear(
    params.intent,
    params.timezone
  );
  const referenceYear = getLocalYearForIso(
    params.referenceTime,
    params.timezone
  );

  if (
    !resolvedYear ||
    !referenceYear ||
    resolvedYear <= referenceYear
  ) {
    return null;
  }

  return {
    year: resolvedYear,
    source:
      params.intent.yearReference === "absolute"
        ? "absolute_year"
        : "relative_year",
    establishedByReply: params.message,
    establishedAt: new Date().toISOString(),
  };
}

async function resolveSchedulingIntentSafely(params: {
  message: string;
  timezone: string;
  referenceTime: string;
}) {
  try {
    const timeout = new Promise<ResolvedSchedulingIntent>((resolve) => {
      setTimeout(() => resolve(emptySchedulingIntent()), 5000);
    });

    return await Promise.race([
      resolveSchedulingIntent(params),
      timeout,
    ]);
  } catch (err: any) {
    console.error("[process-new-lead] scheduling intent resolution failed", {
      error: err?.message ?? err,
    });

    return emptySchedulingIntent();
  }
}



function hasExplicitCalendarDateSurface(message: string) {
  const text = String(message ?? "").toLowerCase();

  return (
    /\b(?:today|tomorrow|day\s+after\s+tomorrow)\b/.test(text) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/.test(
      text
    ) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(
      text
    ) ||
    /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text)
  );
}

function hasExplicitClockSurface(message: string) {
  const text = String(message ?? "").toLowerCase();

  return (
    /\b(?:noon|midnight)\b/.test(text) ||
    /\b(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:am|pm)?\b/.test(text) ||
    /\b(?:1[0-2]|0?[1-9])\s*(?:am|pm)\b/.test(text) ||
    /\b(?:at|around|about|for|by)\s+(?:1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(?:am|pm)?\b/.test(
      text
    )
  );
}

function getExactFirstMessageRequestedStart(params: {
  message: string;
  schedulingIntent: ResolvedSchedulingIntent;
}) {
  /*
   * A first-message booking may auto-book only when BOTH date and clock time
   * are grounded in the customer's own words. The semantic resolver supplies
   * the normalized instant; these surface checks prevent model-only invention.
   */
  if (!hasExplicitCalendarDateSurface(params.message)) return null;
  if (!hasExplicitClockSurface(params.message)) return null;

  const intent = params.schedulingIntent as ResolvedSchedulingIntent & {
    customerSpecifiedDate?: boolean;
    customerSpecifiedTime?: boolean;
    temporalGranularity?: string | null;
  };

  if (!intent.hasPreference) return null;

  if (
    intent.customerSpecifiedDate === false ||
    intent.customerSpecifiedTime === false
  ) {
    return null;
  }

  const candidate = intent.targetTime ?? null;
  if (!candidate) return null;

  const candidateMs = new Date(candidate).getTime();
  if (!Number.isFinite(candidateMs)) return null;

  return new Date(candidateMs).toISOString();
}

function formatCustomerSlot(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_booking_time");

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function bookingTimesMatch(a?: string | null, b?: string | null) {
  if (!a || !b) return false;

  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();

  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  return Math.abs(aMs - bMs) <= 60_000;
}

async function sendVerifiedNewLeadReply(params: {
  companyId: string;
  leadId: string;
  to: string;
  body: string;
}) {
  const result = await sendLeadReply({
    companyId: params.companyId,
    leadId: params.leadId,
    to: params.to,
    subject: "Re: Your HVAC Request",
    body: params.body,
    isFollowUp: false,
  });

  if (!result?.sent) {
    throw new Error("initial_customer_reply_not_sent");
  }

  return result;
}

function formatAlternativeSlot(slot: AlternativeSlot, index: number, timezone: string) {
  const start = new Date(slot.startTime).toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `${index + 1}. ${start}`;
}


const DISPLAY_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const DISPLAY_WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function getResolvedLocalParts(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? null;

  const rawHour = Number(get("hour"));
  const hour = rawHour === 24 ? 0 : rawHour;

  const result = {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: String(get("weekday") ?? "").toLowerCase(),
    hour,
    minute: Number(get("minute")),
  };

  if (
    !Number.isInteger(result.year) ||
    !Number.isInteger(result.month) ||
    !Number.isInteger(result.day) ||
    !Number.isInteger(result.hour) ||
    !Number.isInteger(result.minute)
  ) {
    return null;
  }

  return result;
}

function displayPreferenceMatchesResolvedTruth(params: {
  displayPreference?: string | null;
  resolvedStartTime?: string | null;
  timezone: string;
}) {
  const display = String(params.displayPreference ?? "").trim();
  if (!display || !params.resolvedStartTime) return true;

  const local = getResolvedLocalParts(
    params.resolvedStartTime,
    params.timezone
  );

  if (!local) return true;

  const lower = display.toLowerCase();

  const explicitYear = lower.match(/\b(20\d{2})\b/);
  if (explicitYear && Number(explicitYear[1]) !== local.year) {
    return false;
  }

  const monthDay = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );

  if (monthDay) {
    const month = DISPLAY_MONTHS[monthDay[1]];
    const day = Number(monthDay[2]);

    if (month !== local.month || day !== local.day) {
      return false;
    }
  }

  for (const [weekday, index] of Object.entries(DISPLAY_WEEKDAYS)) {
    if (new RegExp(`\\b${weekday}\\b`).test(lower)) {
      const resolvedWeekday = DISPLAY_WEEKDAYS[local.weekday];
      if (resolvedWeekday !== index) return false;
      break;
    }
  }

  return true;
}

function buildCanonicalSchedulingDisplayPreference(params: {
  intent: ResolvedSchedulingIntent;
  timezone: string;
}) {
  const intent = params.intent;
  const firstWindow = intent.allowedWindows?.[0] ?? null;
  const startTime =
    intent.targetTime ??
    firstWindow?.startTime ??
    null;

  if (!startTime) {
    return intent.displayPreference ?? intent.originalPreference ?? null;
  }

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    return intent.displayPreference ?? intent.originalPreference ?? null;
  }

  const dateText = start.toLocaleDateString("en-US", {
    timeZone: params.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const timeText = start.toLocaleTimeString("en-US", {
    timeZone: params.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (intent.customerSpecifiedTime === true) {
    if (firstWindow?.endTime) {
      const end = new Date(firstWindow.endTime);

      if (!Number.isNaN(end.getTime())) {
        const startLocal = getResolvedLocalParts(
          startTime,
          params.timezone
        );
        const inclusiveEndProbe = new Date(end.getTime() - 1);
        const endLocal = getResolvedLocalParts(
          inclusiveEndProbe.toISOString(),
          params.timezone
        );

        if (
          startLocal &&
          endLocal &&
          startLocal.year === endLocal.year &&
          startLocal.month === endLocal.month &&
          startLocal.day === endLocal.day
        ) {
          const endTimeText = end.toLocaleTimeString("en-US", {
            timeZone: params.timezone,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          return `${dateText}, between ${timeText} and ${endTimeText}`;
        }
      }
    }

    return `${dateText} at ${timeText}`;
  }

  return dateText;
}

function reconcileDisplayPreferenceWithResolvedTruth(params: {
  intent: ResolvedSchedulingIntent;
  timezone: string;
}) {
  const firstWindow = params.intent.allowedWindows?.[0] ?? null;
  const resolvedStartTime =
    params.intent.targetTime ??
    firstWindow?.startTime ??
    null;

  if (
    displayPreferenceMatchesResolvedTruth({
      displayPreference: params.intent.displayPreference,
      resolvedStartTime,
      timezone: params.timezone,
    })
  ) {
    return params.intent;
  }

  const canonical = buildCanonicalSchedulingDisplayPreference({
    intent: params.intent,
    timezone: params.timezone,
  });

  return {
    ...params.intent,
    displayPreference: canonical,
    interpretation:
      params.intent.interpretation ??
      "Customer-facing scheduling text reconciled to resolved calendar truth.",
  };
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  const aStartMs = new Date(aStart).getTime();
  const aEndMs = new Date(aEnd).getTime();
  const bStartMs = new Date(bStart).getTime();
  const bEndMs = new Date(bEnd).getTime();

  if (
    Number.isNaN(aStartMs) ||
    Number.isNaN(aEndMs) ||
    Number.isNaN(bStartMs) ||
    Number.isNaN(bEndMs)
  ) {
    return false;
  }

  return aStartMs < bEndMs && aEndMs > bStartMs;
}

function slotFitsWindow(slot: AlternativeSlot, window: SchedulingTimeWindow) {
  const slotStartMs = new Date(slot.startTime).getTime();
  const slotEndMs = new Date(slot.endTime).getTime();
  const windowStartMs = new Date(window.startTime).getTime();
  const windowEndMs = window.endTime
    ? new Date(window.endTime).getTime()
    : Number.POSITIVE_INFINITY;

  return (
    slotStartMs >= windowStartMs &&
    slotEndMs <= windowEndMs
  );
}

function slotOverlapsWindow(slot: AlternativeSlot, window: SchedulingTimeWindow) {
  if (!window.endTime) return false;

  return overlaps(
    slot.startTime,
    slot.endTime,
    window.startTime,
    window.endTime
  );
}

function slotAllowedBySchedulingIntent(
  slot: AlternativeSlot,
  schedulingIntent: ResolvedSchedulingIntent | null
) {
  if (!schedulingIntent?.hasPreference) return true;

  const allowed =
    schedulingIntent.allowedWindows.length === 0 ||
    schedulingIntent.allowedWindows.some((window: SchedulingTimeWindow) =>
      slotFitsWindow(slot, window)
    );

  if (!allowed) return false;

  const excluded = schedulingIntent.excludedWindows.some(
    (window: SchedulingTimeWindow) =>
      slotOverlapsWindow(slot, window)
  );

  return !excluded;
}

function slotIsPreferred(
  slot: AlternativeSlot,
  schedulingIntent: ResolvedSchedulingIntent | null
) {
  if (!schedulingIntent?.hasPreference) return false;

  const preferredWindows =
    (
      schedulingIntent as ResolvedSchedulingIntent & {
        preferredWindows?: SchedulingTimeWindow[];
      }
    ).preferredWindows ?? [];

  if (preferredWindows.length === 0) return false;

  return preferredWindows.some((window: SchedulingTimeWindow) =>
    slotFitsWindow(slot, window)
  );
}

function rankSchedulingCandidates(
  slots: AlternativeSlot[],
  schedulingIntent: ResolvedSchedulingIntent | null
) {
  const targetMs = schedulingIntent?.targetTime
    ? new Date(schedulingIntent.targetTime).getTime()
    : Number.NaN;

  return [...slots].sort((a, b) => {
    const aPreferred = slotIsPreferred(a, schedulingIntent);
    const bPreferred = slotIsPreferred(b, schedulingIntent);

    if (aPreferred !== bPreferred) {
      return aPreferred ? -1 : 1;
    }

    if (
      schedulingIntent?.selectionMode === "closest" &&
      Number.isFinite(targetMs)
    ) {
      const aDistance = Math.abs(
        new Date(a.startTime).getTime() - targetMs
      );
      const bDistance = Math.abs(
        new Date(b.startTime).getTime() - targetMs
      );

      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }
    }

    return (
      new Date(a.startTime).getTime() -
      new Date(b.startTime).getTime()
    );
  });
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


function roundUpToHalfHourIso(valueMs: number) {
  const intervalMs = 30 * 60 * 1000;
  const roundedMs = Math.ceil(valueMs / intervalMs) * intervalMs;
  return new Date(roundedMs).toISOString();
}

async function findNextAvailableSlots(params: {
  companyId: string;
  timezone: string;
  count?: number;
  schedulingIntent?: ResolvedSchedulingIntent | null;
}) {
  /*
   * SINGLE AVAILABILITY SOURCE OF TRUTH
   *
   * Initial lead replies must use the same shared availability engine used by
   * inbound follow-ups and booking validation. The previous implementation had
   * a second local calendar model based on booked Lead rows, which allowed two
   * parts of LeadFlow to disagree about the same requested window.
   *
   * The shared engine owns business hours, company appointment duration,
   * Google Calendar conflicts, travel buffers, and real slot generation.
   * This wrapper only applies the already-resolved customer scheduling
   * constraints and ranking; it does not invent availability itself.
   */
  const count = params.count ?? 3;
  const schedulingIntent = params.schedulingIntent ?? null;
  const minLeadBoundary = roundUpToHalfHourIso(
    Date.now() + 120 * 60 * 1000
  );
  const minLeadMs = new Date(minLeadBoundary).getTime();

  const windows =
    schedulingIntent?.hasPreference &&
    Array.isArray(schedulingIntent.allowedWindows) &&
    schedulingIntent.allowedWindows.length > 0
      ? schedulingIntent.allowedWindows
      : [
          {
            startTime: minLeadBoundary,
            endTime: null,
          },
        ];

  const collected: AlternativeSlot[] = [];
  const seen = new Set<string>();

  for (const window of windows) {
    const rawStartMs = new Date(window.startTime).getTime();
    if (!Number.isFinite(rawStartMs)) continue;

    const searchStartTime = new Date(
      Math.max(rawStartMs, minLeadMs)
    ).toISOString();

    const endTime = window.endTime ?? null;
    if (
      endTime &&
      new Date(endTime).getTime() <= new Date(searchStartTime).getTime()
    ) {
      continue;
    }

    const sharedSlots = await suggestAlternativeSlots({
      companyId: params.companyId,
      requestedStartTime: searchStartTime,
      requestedEndTime: endTime,
      timezone: params.timezone,
    });

    for (const slot of sharedSlots as AlternativeSlot[]) {
      if (!slot?.startTime || !slot?.endTime) continue;
      if (!slotAllowedBySchedulingIntent(slot, schedulingIntent)) continue;

      const key = `${slot.startTime}|${slot.endTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(slot);
    }
  }

  return rankSchedulingCandidates(
    collected,
    schedulingIntent
  ).slice(0, count);
}

function buildInitialAvailabilityReply(params: {
  baseReplyText: string;
  slots: AlternativeSlot[];
  timezone: string;
  schedulingIntent?: ResolvedSchedulingIntent | null;
}) {
  const cleanBase = params.baseReplyText
    .replace(/We can check availability for today\./gi, "")
    .replace(/We’ll use the contact information provided and follow up shortly\./gi, "")
    .replace(/We'll use the contact information provided and follow up shortly\./gi, "")
    .replace(/— Texas Test HVAC[\s\S]*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const slotLines = params.slots
    .map((slot, index) => formatAlternativeSlot(slot, index, params.timezone))
    .join("\n");

  const displayPreference =
    params.schedulingIntent?.hasPreference &&
    params.schedulingIntent.displayPreference
      ? params.schedulingIntent.displayPreference
      : null;

  if (params.slots.length === 0) {
    if (displayPreference) {
      return [
        cleanBase || "Thanks for reaching out — we can help with your HVAC issue.",
        "",
        `I understood your scheduling request as ${displayPreference}.`,
        "",
        params.schedulingIntent?.strict
          ? "We do not have an open appointment that matches that requested window, so I will not substitute a different time."
          : "We do not have an open appointment showing inside that requested window right now.",
      ].join("\n");
    }

    return [
      cleanBase || "Thanks for reaching out — this sounds urgent.",
      "",
      "We do not have a clean opening showing right now, but we have your request and will follow up with the next confirmed appointment option.",
    ].join("\n");
  }

  return [
    cleanBase || "Thanks for reaching out — this sounds urgent. We can help with your HVAC issue.",
    "",
    displayPreference
      ? `I understood your scheduling request as ${displayPreference}.`
      : null,
    displayPreference ? "" : null,
    displayPreference
      ? "Here are the real openings that match that request:"
      : "Here are the next real openings we can book:",
    "",
    slotLines,
    "",
    "Which one works best?",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function enqueueOwnerAlert(params: {
  companyId: string;
  leadId: string;
  alertType: "new_lead" | "booked" | "follow_up_due" | "failed_booking";
  message?: string | null;
}) {
  try {
    const jobId = safeJobId(
      `send_owner_alert_${params.alertType}_${params.companyId}_${params.leadId}`
    );

    const job = await enqueueBackgroundJob({
      name: "send_owner_alert",
      jobId,
      data: {
        companyId: params.companyId,
        leadId: params.leadId,
        alertType: params.alertType,
        message: params.message ?? null,
      } as any,
    });

    return {
      queued: true,
      jobId: job.id ?? null,
    };
  } catch (err: any) {
    console.error("[process-new-lead] owner alert enqueue failed", {
      companyId: params.companyId,
      leadId: params.leadId,
      alertType: params.alertType,
      error: err?.message ?? err,
    });

    return {
      queued: false,
      error: err?.message ?? "owner_alert_enqueue_failed",
    };
  }
}

export async function processNewLeadJob(data: ProcessNewLeadJobData) {
  if (!data.companyId) throw new Error("missing_company_id");
  if (!data.leadId) throw new Error("missing_lead_id");

  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", data.leadId)
    .eq("company_id", data.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!lead) throw new Error("lead_not_found");

  const message = String(
    lead.input ?? lead.message ?? lead.issue_summary ?? ""
  ).trim();

  if (!message) {
    throw new Error("missing_lead_message");
  }

  const qualification = getFallbackQualification(lead);
  const companyTimezone = await getCompanyTimezone(data.companyId);

  /*
   * Retry recovery invariant:
   * Calendar creation may have succeeded before a transient customer-email
   * failure. A retry must not silently skip a real booking merely because the
   * Lead is already booked. If no successful outbound response is persisted,
   * resend the canonical booked time from the Lead and then stop.
   */
  if (lead.status === "booked") {
    if (!lead.calendar_event_id || !lead.appointment_time) {
      throw new Error("booked_lead_missing_calendar_truth");
    }

    if (!lead.sent_at && lead.email) {
      const recoveryBody = `You're booked for ${formatCustomerSlot(
        String(lead.appointment_time),
        companyTimezone
      )}.`;

      await sendVerifiedNewLeadReply({
        companyId: data.companyId,
        leadId: data.leadId,
        to: lead.email,
        body: recoveryBody,
      });

      const { data: recoveredLead, error: recoveryUpdateError } = await supabase
        .from("leads")
        .update({
          reply: recoveryBody,
          status: "booked",
          appointment_time: lead.appointment_time,
          calendar_event_id: lead.calendar_event_id,
        })
        .eq("id", data.leadId)
        .eq("company_id", data.companyId)
        .select("id, status, appointment_time, calendar_event_id, sent_at")
        .maybeSingle();

      if (recoveryUpdateError) {
        throw new Error(recoveryUpdateError.message);
      }

      if (
        !recoveredLead ||
        recoveredLead.status !== "booked" ||
        recoveredLead.calendar_event_id !== lead.calendar_event_id ||
        !bookingTimesMatch(
          recoveredLead.appointment_time,
          lead.appointment_time
        )
      ) {
        throw new Error("booked_confirmation_recovery_truth_mismatch");
      }

      console.log("[process-new-lead] recovered missing booking confirmation", {
        companyId: data.companyId,
        leadId: data.leadId,
        appointmentTime: recoveredLead.appointment_time,
        calendarEventId: recoveredLead.calendar_event_id,
      });

      return {
        success: true,
        leadId: data.leadId,
        booked: true,
        recoveredMissingConfirmation: true,
        appointmentTime: recoveredLead.appointment_time,
        calendarEventId: recoveredLead.calendar_event_id,
        emailSent: true,
      };
    }

    return {
      success: true,
      skipped: true,
      reason: "blocked_status_booked",
      leadId: data.leadId,
    };
  }

  if (isBlockedLeadStatus(lead.status)) {
    return {
      success: true,
      skipped: true,
      reason: `blocked_status_${lead.status}`,
      leadId: data.leadId,
    };
  }

  const newLeadAlert = await enqueueOwnerAlert({
    companyId: data.companyId,
    leadId: data.leadId,
    alertType: "new_lead",
    message: "New lead captured and queued for first response.",
  });

  /*
   * Prospect-promotion ownership invariant.
   *
   * A Lead carrying prospectInquiryPromotion was created from an already-active
   * customer conversation. That conversation (or an explicit handoff into
   * process_inbound_email) owns the customer-facing response. process_new_lead
   * may still emit the owner alert above, but it must never send a second generic
   * first-touch email or create a competing initial pending-slot set.
   */
  if (
    Boolean(lead.first_response_at) ||
    (lead.qualification?.prospectInquiryPromotion &&
      typeof lead.qualification.prospectInquiryPromotion === "object")
  ) {
    console.log("[process-new-lead] skipped customer reply for prospect-promoted lead", {
      companyId: data.companyId,
      leadId: data.leadId,
      prospectConversationId:
        lead.qualification.prospectInquiryPromotion.conversationId ?? null,
      providerEventId:
        lead.qualification.prospectInquiryPromotion.providerEventId ?? null,
    });

    return {
      success: true,
      skipped: true,
      reason: "prospect_promotion_customer_reply_owned_elsewhere",
      leadId: data.leadId,
      ownerAlert: newLeadAlert,
    };
  }

  const schedulingReferenceTime =
    typeof lead.created_at === "string" && lead.created_at
      ? lead.created_at
      : new Date().toISOString();

  let schedulingIntent = await resolveSchedulingIntentSafely({
    message,
    timezone: companyTimezone,
    referenceTime: schedulingReferenceTime,
  });

  const originalDisplayPreference = schedulingIntent.displayPreference;

  schedulingIntent = reconcileDisplayPreferenceWithResolvedTruth({
    intent: schedulingIntent,
    timezone: companyTimezone,
  });

  if (
    originalDisplayPreference &&
    schedulingIntent.displayPreference !== originalDisplayPreference
  ) {
    console.warn(
      "[process-new-lead] corrected customer-facing scheduling text to resolved truth",
      {
        companyId: data.companyId,
        leadId: data.leadId,
        originalDisplayPreference,
        correctedDisplayPreference: schedulingIntent.displayPreference,
        targetTime: schedulingIntent.targetTime,
        firstAllowedWindow: schedulingIntent.allowedWindows?.[0] ?? null,
      }
    );
  }

  const activeSchedulingYearContext =
    buildActiveSchedulingYearContext({
      intent: schedulingIntent,
      timezone: companyTimezone,
      referenceTime: schedulingReferenceTime,
      message,
    });

  if (activeSchedulingYearContext) {
    console.log(
      "[process-new-lead] established future-year conversation context",
      {
        companyId: data.companyId,
        leadId: data.leadId,
        activeSchedulingYearContext,
        displayPreference: schedulingIntent.displayPreference,
      }
    );
  }

  const exactRequestedStart = getExactFirstMessageRequestedStart({
    message,
    schedulingIntent,
  });

  if (exactRequestedStart) {
    console.log("[process-new-lead] exact first-message booking request", {
      companyId: data.companyId,
      leadId: data.leadId,
      exactRequestedStart,
      originalPreference: schedulingIntent.originalPreference ?? null,
    });

    try {
      const booking = await createCalendarBooking({
        companyId: data.companyId,
        leadId: data.leadId,
        startTime: exactRequestedStart,
        endTime: null,
        attendeeEmail: lead.email ?? null,
        attendeeName: lead.customer_name ?? null,
        description: [
          "Booked automatically from an explicit first-message booking request.",
          "Duration source: company default appointment duration.",
          "",
          lead.email ? `Customer email: ${lead.email}` : null,
          lead.phone ? `Customer phone: ${lead.phone}` : null,
          `Customer request: ${message}`,
          `Company timezone: ${companyTimezone}`,
        ]
          .filter(Boolean)
          .join("\n"),
      });

      if (!booking?.calendarEventId || !booking?.appointmentTime) {
        throw new Error("first_message_booking_missing_calendar_truth");
      }

      if (!bookingTimesMatch(booking.appointmentTime, exactRequestedStart)) {
        throw new Error("first_message_booking_time_mismatch");
      }

      const bookedAt = booking.appointmentTime;
      const confirmationBody = `Your request for ${formatCustomerSlot(
        bookedAt,
        companyTimezone
      )} is available. You're booked for ${formatCustomerSlot(
        bookedAt,
        companyTimezone
      )}.`;

      const now = new Date().toISOString();
      const bookedQualification = {
        ...normalizeExistingQualification(lead),
        ...qualification,
        schedulingIntent,
        ...(activeSchedulingYearContext
          ? { activeSchedulingYearContext }
          : {}),
        pendingSlotSuggestion: {
          status: "confirmed_and_booked",
          confirmedStartTime: bookedAt,
          confirmedByReply: message,
          confirmedAt: now,
          matchReason: "explicit_first_message_date_time_booking",
        },
      };

      if (lead.email) {
        await sendVerifiedNewLeadReply({
          companyId: data.companyId,
          leadId: data.leadId,
          to: lead.email,
          body: confirmationBody,
        });
      }

      /*
       * sendLeadReply owns generic contact metadata and may set a conversational
       * status. Re-assert the verified Calendar booking after the email so the
       * booking state remains authoritative.
       */
      const { data: verifiedBookedLead, error: bookedUpdateError } = await supabase
        .from("leads")
        .update({
          reply: confirmationBody,
          status: "booked",
          appointment_time: bookedAt,
          calendar_event_id: booking.calendarEventId,
          qualification: bookedQualification,
          last_contacted_at: now,
          first_response_at: lead.first_response_at ?? now,
        })
        .eq("id", data.leadId)
        .eq("company_id", data.companyId)
        .select("id, status, appointment_time, calendar_event_id")
        .maybeSingle();

      if (bookedUpdateError) throw new Error(bookedUpdateError.message);
      if (!verifiedBookedLead) {
        throw new Error("first_message_booking_lead_verification_missing");
      }
      if (
        verifiedBookedLead.status !== "booked" ||
        verifiedBookedLead.calendar_event_id !== booking.calendarEventId ||
        !bookingTimesMatch(
          verifiedBookedLead.appointment_time,
          booking.appointmentTime
        )
      ) {
        throw new Error("first_message_booking_lead_truth_mismatch");
      }

      return {
        success: true,
        leadId: data.leadId,
        booked: true,
        directFirstMessageBooking: true,
        appointmentTime: verifiedBookedLead.appointment_time,
        calendarEventId: verifiedBookedLead.calendar_event_id,
        emailSent: Boolean(lead.email),
        ownerAlert: newLeadAlert,
      };
    } catch (err: any) {
      const isAvailabilityFailure =
        err?.message === "slot_unavailable" ||
        err?.message === "outside_business_hours";

      if (!isAvailabilityFailure) {
        console.error("[process-new-lead] exact first-message booking failed", {
          companyId: data.companyId,
          leadId: data.leadId,
          exactRequestedStart,
          error: err?.message ?? err,
        });
        throw err;
      }

      const alternatives: AlternativeSlot[] = Array.isArray(err?.alternatives)
        ? err.alternatives.filter((slot: any) => slot?.startTime)
        : [];

      const requestedLabel = formatCustomerSlot(
        exactRequestedStart,
        companyTimezone
      );
      const alternativesText = alternatives
        .slice(0, 3)
        .map((slot, index) =>
          formatAlternativeSlot(slot, index, companyTimezone)
        )
        .join("\n");

      const unavailableReply = [
        `Your request for ${requestedLabel} is not available.`,
        alternatives.length > 0
          ? "\nHere are the next real openings we can book:"
          : null,
        alternatives.length > 0 ? `\n${alternativesText}` : null,
        "\nWhat day and time works best for you?",
      ]
        .filter(Boolean)
        .join("\n");

      const now = new Date().toISOString();
      const unavailableQualification = {
        ...normalizeExistingQualification(lead),
        ...qualification,
        schedulingIntent,
        ...(activeSchedulingYearContext
          ? { activeSchedulingYearContext }
          : {}),
        pendingSlotSuggestion:
          alternatives.length > 0
            ? {
                status: "awaiting_customer_confirmation",
                originalRequestedStartTime: exactRequestedStart,
                originalRequestedEndTime: null,
                suggestedStartTime: alternatives[0]?.startTime ?? null,
                suggestedEndTime: alternatives[0]?.endTime ?? null,
                suggestedSlots: alternatives.slice(0, 3),
                customerReply: message,
                suggestedAt: now,
                unavailableReason: err?.message,
                source: "initial_exact_booking_unavailable",
              }
            : null,
      };

      const { error: unavailableUpdateError } = await supabase
        .from("leads")
        .update({
          reply: unavailableReply,
          status: "awaiting_customer",
          appointment_time: null,
          calendar_event_id: null,
          qualification: unavailableQualification,
          last_contacted_at: now,
          first_response_at: lead.first_response_at ?? now,
        })
        .eq("id", data.leadId)
        .eq("company_id", data.companyId);

      if (unavailableUpdateError) {
        throw new Error(unavailableUpdateError.message);
      }

      if (lead.email) {
        await sendVerifiedNewLeadReply({
          companyId: data.companyId,
          leadId: data.leadId,
          to: lead.email,
          body: unavailableReply,
        });

        /*
         * Keep the unavailable request explicitly open after sendLeadReply's
         * generic contact-state update. No appointment exists at this point.
         */
        const { data: verifiedAwaitingLead, error: awaitingVerifyError } =
          await supabase
            .from("leads")
            .update({
              status: "awaiting_customer",
              appointment_time: null,
              calendar_event_id: null,
              qualification: unavailableQualification,
            })
            .eq("id", data.leadId)
            .eq("company_id", data.companyId)
            .select("id, status, appointment_time, calendar_event_id")
            .maybeSingle();

        if (awaitingVerifyError) {
          throw new Error(awaitingVerifyError.message);
        }

        if (
          !verifiedAwaitingLead ||
          verifiedAwaitingLead.status !== "awaiting_customer" ||
          verifiedAwaitingLead.appointment_time ||
          verifiedAwaitingLead.calendar_event_id
        ) {
          throw new Error("first_message_unavailable_state_mismatch");
        }
      }

      return {
        success: true,
        leadId: data.leadId,
        booked: false,
        directFirstMessageBooking: true,
        reason: err?.message,
        requestedStartTime: exactRequestedStart,
        alternatives: alternatives.slice(0, 3),
        emailSent: Boolean(lead.email),
        ownerAlert: newLeadAlert,
      };
    }
  }

  const replyResult = await generateLeadReply({
    message,
    qualification: {
      ...qualification,
      preferredTime:
        schedulingIntent.displayPreference ??
        schedulingIntent.originalPreference ??
        qualification.preferredTime ??
        null,
    },
  });

  const generatedReplyText = normalizeReplyText(replyResult).trim();

  if (!generatedReplyText) {
    throw new Error("empty_generated_reply");
  }

  let availableSlots: AlternativeSlot[] = [];

  try {
    availableSlots = await findNextAvailableSlots({
      companyId: data.companyId,
      timezone: companyTimezone,
      count: 3,
      schedulingIntent,
    });
  } catch (err: any) {
    console.error("[process-new-lead] initial availability lookup failed", {
      companyId: data.companyId,
      leadId: data.leadId,
      error: err?.message ?? err,
    });

    availableSlots = [];
  }

  const replyText = buildInitialAvailabilityReply({
    baseReplyText: generatedReplyText,
    slots: availableSlots,
    timezone: companyTimezone,
    schedulingIntent,
  });

  if (!replyText) {
    throw new Error("empty_initial_availability_reply");
  }

  const now = new Date().toISOString();

  const nextQualification = {
    ...normalizeExistingQualification(lead),
    ...qualification,
    schedulingIntent,
    ...(activeSchedulingYearContext
      ? { activeSchedulingYearContext }
      : {}),
    pendingSlotSuggestion:
      availableSlots.length > 0
        ? {
            status: "awaiting_customer_confirmation",
            originalRequestedStartTime:
              schedulingIntent.allowedWindows[0]?.startTime ?? null,
            originalRequestedEndTime:
              schedulingIntent.allowedWindows[0]?.endTime ?? null,
            suggestedStartTime: availableSlots[0]?.startTime ?? null,
            suggestedEndTime: availableSlots[0]?.endTime ?? null,
            suggestedSlots: availableSlots,
            customerReply: null,
            suggestedAt: now,
            unavailableReason: null,
            source: "initial_new_lead_response",
          }
        : null,
  };

  const { error: updateError } = await supabase
    .from("leads")
    .update({
      reply: replyText,
      status: availableSlots.length > 0 ? "awaiting_customer" : "contacted",
      last_contacted_at: now,
      first_response_at: lead.first_response_at ?? now,
      qualification: nextQualification,
    })
    .eq("id", data.leadId)
    .eq("company_id", data.companyId);

  if (updateError) {
    console.error("[process-new-lead] lead update failed before initial email", {
      companyId: data.companyId,
      leadId: data.leadId,
      error: updateError.message,
    });
  }

  let emailResult: any = null;

  if (lead.email) {
    emailResult = await sendVerifiedNewLeadReply({
      companyId: data.companyId,
      leadId: data.leadId,
      to: lead.email,
      body: replyText,
    });
  }

  if (lead.email && !emailResult?.sent) {
    throw new Error("initial_customer_reply_not_sent");
  }

  console.log("[process-new-lead] customer first response completed", {
    companyId: data.companyId,
    leadId: data.leadId,
    emailSent: Boolean(emailResult?.sent),
    availableSlotCount: availableSlots.length,
    exactFirstMessageBooking: false,
  });

  return {
    success: true,
    leadId: data.leadId,
    status: emailResult?.status ?? (availableSlots.length > 0 ? "awaiting_customer" : "contacted"),
    replyGenerated: true,
    initialAvailabilitySlotsOffered: availableSlots.length,
    emailSent: Boolean(emailResult?.sent),
    ownerAlert: newLeadAlert,
  };
}