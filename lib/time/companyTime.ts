// lib/time/companyTime.ts

export const DEFAULT_TIMEZONE = "America/Chicago";

export type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

export type LocalDateTimeParts = LocalDateParts & {
  hour: number;
  minute: number;
  second: number;
};

function getDateTimeParts(date: Date, timezone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  const rawHour = get("hour");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get("minute"),
    second: get("second"),
  };
}

function getOffsetMs(date: Date, timezone: string) {
  const parts = getDateTimeParts(date, timezone);

  const utcFromLocalParts = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );

  return utcFromLocalParts - date.getTime();
}

export function getNowInTimezone(timezone?: string | null): LocalDateTimeParts {
  return getDateTimeParts(new Date(), timezone || DEFAULT_TIMEZONE);
}

export function addDaysToLocalDate(params: {
  year: number;
  month: number;
  day: number;
  days: number;
}): LocalDateParts {
  const date = new Date(
    Date.UTC(params.year, params.month - 1, params.day + params.days, 12, 0, 0)
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function getWeekdayIndexForLocalDate(params: LocalDateParts) {
  const date = new Date(Date.UTC(params.year, params.month - 1, params.day));
  return date.getUTCDay();
}

export function zonedTimeToUtc(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone?: string | null;
}) {
  const timezone = params.timezone || DEFAULT_TIMEZONE;

  const localAsUtcGuess = new Date(
    Date.UTC(
      params.year,
      params.month - 1,
      params.day,
      params.hour,
      params.minute,
      0,
      0
    )
  );

  const firstOffset = getOffsetMs(localAsUtcGuess, timezone);
  const firstUtc = new Date(localAsUtcGuess.getTime() - firstOffset);

  const secondOffset = getOffsetMs(firstUtc, timezone);

  if (secondOffset !== firstOffset) {
    return new Date(localAsUtcGuess.getTime() - secondOffset).toISOString();
  }

  return firstUtc.toISOString();
}

export function addMinutesUtc(iso: string, minutes: number) {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_datetime");
  }

  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

export function formatInCompanyTimezone(params: {
  iso: string;
  timezone?: string | null;
}) {
  return new Date(params.iso).toLocaleString("en-US", {
    timeZone: params.timezone || DEFAULT_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}