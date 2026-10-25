// lib/availability/checkAvailability.ts

import { supabase } from "@/lib/supabase";
import { getCompanyCalendarClient } from "@/lib/google/companyGoogle";

type CheckAvailabilityInput = {
  companyId: string;
  startTime: string;
  endTime: string;
};

type SuggestAlternativeSlotsInput = {
  companyId: string;
  requestedStartTime: string;
  requestedEndTime?: string | null;
  durationMinutes?: number | null;
  timezone?: string | null;
};

type BusinessHoursDay = {
  open?: string;
  close?: string;
  closed?: boolean;
  enabled?: boolean;
};

type BusinessHours = Record<string, BusinessHoursDay | null | undefined>;

type ResolvedBusinessHoursDay = {
  dayConfig: BusinessHoursDay | null;
  configuredByCompany: boolean;
  explicitlyClosedByCompany: boolean;
  source: "company" | "default";
};

const DEFAULT_TIMEZONE = "America/Chicago";

const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  monday: { open: "08:00", close: "18:00" },
  tuesday: { open: "08:00", close: "18:00" },
  wednesday: { open: "08:00", close: "18:00" },
  thursday: { open: "08:00", close: "18:00" },
  friday: { open: "08:00", close: "18:00" },
  saturday: { open: "08:00", close: "14:00" },
  sunday: { open: "00:00", close: "00:00", closed: true },
};

function parseTimeToMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function addMinutesIso(value: string, minutes: number) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function subtractMinutesIso(value: string, minutes: number) {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - minutes);
  return date.toISOString();
}

function getLocalParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const weekday = String(
    parts.find((part) => part.type === "weekday")?.value ?? ""
  ).toLowerCase();

  const rawHour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  const hour = rawHour === 24 ? 0 : rawHour;

  return {
    weekday,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

function normalizeBusinessHours(raw: any): BusinessHours {
  /*
   * Preserve the company's object exactly enough to distinguish:
   *   - an explicitly configured day,
   *   - an explicitly closed day,
   *   - and a genuinely missing day that may use the product fallback.
   *
   * Do NOT spread defaults over company settings here. Doing that destroys the
   * distinction between "company configured this weekday" and "weekday absent".
   */
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as BusinessHours;
}

function hasValidClock(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  return Boolean(match);
}

function resolveBusinessHoursDay(
  businessHours: BusinessHours,
  weekday: string
): ResolvedBusinessHoursDay {
  /*
   * COMPANY RULE IS AUTHORITATIVE.
   *
   * Explicit company closure forms:
   *   saturday: null
   *   saturday: { closed: true }
   *   saturday: { enabled: false }
   *
   * Explicit company open forms:
   *   saturday: { open: "08:00", close: "14:00" }
   *   saturday: { enabled: true, open: "08:00", close: "14:00" }
   *
   * A missing weekday is NOT interpreted as "company closed". It may use the
   * legacy product fallback schedule for backward compatibility, but callers
   * can still distinguish that from an explicit company rule.
   */
  if (Object.prototype.hasOwnProperty.call(businessHours, weekday)) {
    const configured = businessHours[weekday];

    if (
      configured === null ||
      configured?.closed === true ||
      configured?.enabled === false
    ) {
      return {
        dayConfig: null,
        configuredByCompany: true,
        explicitlyClosedByCompany: true,
        source: "company",
      };
    }

    if (
      configured &&
      hasValidClock(configured.open) &&
      hasValidClock(configured.close)
    ) {
      return {
        dayConfig: {
          open: configured.open,
          close: configured.close,
          closed: false,
          enabled: configured.enabled,
        },
        configuredByCompany: true,
        explicitlyClosedByCompany: false,
        source: "company",
      };
    }

    /*
     * The company tried to configure this weekday but the configuration is
     * malformed/incomplete. Never silently replace that with defaults and never
     * call it closed. Fail verification instead of inventing company policy.
     */
    throw new Error(`invalid_company_business_hours_${weekday}`);
  }

  const fallback = DEFAULT_BUSINESS_HOURS[weekday] ?? null;

  return {
    dayConfig: fallback,
    configuredByCompany: false,
    explicitlyClosedByCompany: false,
    source: "default",
  };
}

function requirePositiveDurationMinutes(
  value: unknown,
  field = "duration_minutes"
) {
  const minutes = Number(value);

  if (
    !Number.isFinite(minutes) ||
    !Number.isInteger(minutes) ||
    minutes <= 0 ||
    minutes > 1440
  ) {
    throw new Error(`invalid_${field}`);
  }

  return minutes;
}

async function getCompany(companyId: string) {
  const { data, error } = await supabase
    .from("companies")
    .select(
      "id, timezone, business_hours, travel_buffer_minutes, default_appointment_minutes"
    )
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("company_not_found");

  return data;
}

function isInsideBusinessHours(params: {
  startTime: string;
  endTime: string;
  timezone: string;
  businessHours: BusinessHours;
}) {
  const start = new Date(params.startTime);
  const end = new Date(params.endTime);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("invalid_datetime");
  }

  const startLocal = getLocalParts(start, params.timezone);
  const endLocal = getLocalParts(end, params.timezone);

  if (startLocal.weekday !== endLocal.weekday) {
    return false;
  }

  const resolvedDay = resolveBusinessHoursDay(
    params.businessHours,
    startLocal.weekday
  );
  const dayConfig = resolvedDay.dayConfig;

  if (!dayConfig || dayConfig.closed) {
    return false;
  }

  if (!hasValidClock(dayConfig.open) || !hasValidClock(dayConfig.close)) {
    throw new Error(`invalid_effective_business_hours_${startLocal.weekday}`);
  }

  const openMinutes = parseTimeToMinutes(dayConfig.open);
  const closeMinutes = parseTimeToMinutes(dayConfig.close);

  return (
    startLocal.minutes >= openMinutes &&
    endLocal.minutes <= closeMinutes &&
    end.getTime() > start.getTime()
  );
}

export async function getCompanyBusinessHoursStatus(input: {
  companyId: string;
  atTime: string;
}) {
  if (!input.companyId) throw new Error("missing_company_id");
  if (!input.atTime) throw new Error("missing_at_time");

  const at = new Date(input.atTime);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_at_time");

  const company = await getCompany(input.companyId);
  const timezone = company.timezone || DEFAULT_TIMEZONE;
  const businessHours = normalizeBusinessHours(company.business_hours);
  const local = getLocalParts(at, timezone);
  const resolvedDay = resolveBusinessHoursDay(businessHours, local.weekday);
  const dayConfig = resolvedDay.dayConfig;

  return {
    timezone,
    weekday: local.weekday,
    closed: !dayConfig || dayConfig.closed === true,
    closedByCompanyRule: resolvedDay.explicitlyClosedByCompany,
    configuredByCompany: resolvedDay.configuredByCompany,
    source: resolvedDay.source,
    open: dayConfig?.open ?? null,
    close: dayConfig?.close ?? null,
  };
}

function overlaps(params: {
  aStart: string;
  aEnd: string;
  bStart: string;
  bEnd: string;
}) {
  return (
    new Date(params.aStart).getTime() < new Date(params.bEnd).getTime() &&
    new Date(params.aEnd).getTime() > new Date(params.bStart).getTime()
  );
}

async function hasCalendarConflict(params: {
  companyId: string;
  startTime: string;
  endTime: string;
  travelBufferMinutes: number;
}) {
  const calendar = await getCompanyCalendarClient(params.companyId);

  const protectedStart = subtractMinutesIso(
    params.startTime,
    params.travelBufferMinutes
  );

  const protectedEnd = addMinutesIso(
    params.endTime,
    params.travelBufferMinutes
  );

  const events = await calendar.events.list({
    calendarId: "primary",
    timeMin: protectedStart,
    timeMax: protectedEnd,
    singleEvents: true,
    orderBy: "startTime",
  });

  const busyEvents = events.data.items ?? [];

  return busyEvents.some((event: any) => {
    // Google marks transparent events as Free; they do not block time.
    if (event?.transparency === "transparent") return false;
    const eventStart = event.start?.dateTime || event.start?.date;
    const eventEnd = event.end?.dateTime || event.end?.date;

    if (!eventStart || !eventEnd) return false;

    const eventProtectedStart = subtractMinutesIso(
      eventStart,
      params.travelBufferMinutes
    );

    const eventProtectedEnd = addMinutesIso(
      eventEnd,
      params.travelBufferMinutes
    );

    return overlaps({
      aStart: params.startTime,
      aEnd: params.endTime,
      bStart: eventProtectedStart,
      bEnd: eventProtectedEnd,
    });
  });
}

export async function checkAvailability(input: CheckAvailabilityInput) {
  if (!input.companyId) throw new Error("missing_company_id");
  if (!input.startTime) throw new Error("missing_start_time");
  if (!input.endTime) throw new Error("missing_end_time");

  const company = await getCompany(input.companyId);
  const timezone = company.timezone || DEFAULT_TIMEZONE;
  const businessHours = normalizeBusinessHours(company.business_hours);
  const travelBufferMinutes = Number(company.travel_buffer_minutes ?? 30);

  const insideHours = isInsideBusinessHours({
    startTime: input.startTime,
    endTime: input.endTime,
    timezone,
    businessHours,
  });

  if (!insideHours) {
    return {
      available: false,
      reason: "outside_business_hours",
      timezone,
      travelBufferMinutes,
    };
  }

  const conflict = await hasCalendarConflict({
    companyId: input.companyId,
    startTime: input.startTime,
    endTime: input.endTime,
    travelBufferMinutes,
  });

  if (conflict) {
    return {
      available: false,
      reason: "calendar_or_travel_buffer_conflict",
      timezone,
      travelBufferMinutes,
    };
  }

  return {
    available: true,
    reason: null,
    timezone,
    travelBufferMinutes,
  };
}

export async function suggestAlternativeSlots(
  input: SuggestAlternativeSlotsInput
) {
  if (!input.companyId) throw new Error("missing_company_id");
  if (!input.requestedStartTime) throw new Error("missing_requested_start_time");

  const company = await getCompany(input.companyId);
  const timezone = input.timezone || company.timezone || DEFAULT_TIMEZONE;
  const businessHours = normalizeBusinessHours(company.business_hours);
  const travelBufferMinutes = Number(company.travel_buffer_minutes ?? 30);

  const companyDefaultAppointmentMinutes = requirePositiveDurationMinutes(
    company.default_appointment_minutes,
    "company_default_appointment_minutes"
  );

  const durationMinutes =
    input.durationMinutes === undefined || input.durationMinutes === null
      ? companyDefaultAppointmentMinutes
      : requirePositiveDurationMinutes(
          input.durationMinutes,
          "duration_minutes"
        );

  const requestedStart = new Date(input.requestedStartTime);

  if (Number.isNaN(requestedStart.getTime())) {
    throw new Error("invalid_requested_start_time");
  }

  const requestedEnd =
    input.requestedEndTime === undefined || input.requestedEndTime === null
      ? null
      : new Date(input.requestedEndTime);

  if (requestedEnd && Number.isNaN(requestedEnd.getTime())) {
    throw new Error("invalid_requested_end_time");
  }

  if (
    requestedEnd &&
    requestedEnd.getTime() <= requestedStart.getTime()
  ) {
    throw new Error("invalid_requested_time_window");
  }

  const alternatives: any[] = [];

  // Search begins at the requested boundary itself. The old implementation
  // started 30 minutes later, which could unnecessarily skip an exact
  // requested opening.
  //
  // When requestedEndTime is supplied, it is an authoritative upper boundary:
  // no suggested appointment may start before requestedStartTime or finish
  // after requestedEndTime. This allows callers to represent arbitrary
  // customer-requested windows without this availability layer hard-coding
  // words such as "today", "tomorrow", weekday names, or dayparts.
  //
  // Without an explicit upper boundary, preserve the existing 21-day search
  // horizon for backward compatibility.
  const searchLimit = 21 * 24 * 2;

  for (let i = 0; i <= searchLimit; i++) {
    const candidateStart = new Date(requestedStart);
    candidateStart.setMinutes(candidateStart.getMinutes() + i * 30);

    const candidateEnd = new Date(candidateStart);
    candidateEnd.setMinutes(
      candidateEnd.getMinutes() + durationMinutes
    );

    if (
      requestedEnd &&
      candidateEnd.getTime() > requestedEnd.getTime()
    ) {
      break;
    }

    const startIso = candidateStart.toISOString();
    const endIso = candidateEnd.toISOString();

    const insideHours = isInsideBusinessHours({
      startTime: startIso,
      endTime: endIso,
      timezone,
      businessHours,
    });

    if (!insideHours) continue;

    const conflict = await hasCalendarConflict({
      companyId: input.companyId,
      startTime: startIso,
      endTime: endIso,
      travelBufferMinutes,
    });

    if (conflict) continue;

    alternatives.push({
      startTime: startIso,
      endTime: endIso,
      timezone,
      travelBufferMinutes,
    });

    if (alternatives.length >= 3) break;
  }

  return alternatives;
}