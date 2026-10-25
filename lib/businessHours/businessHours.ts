// lib/businessHours/businessHours.ts 

export type BusinessHoursWindow = { 
  open: string; 
  close: string; 
}; 

export type WeeklyBusinessHours = Record<string, BusinessHoursWindow[]>; 

const DEFAULT_BUSINESS_HOURS: WeeklyBusinessHours = { 
  monday: [{ open: "08:00", close: "18:00" }], 
  tuesday: [{ open: "08:00", close: "18:00" }], 
  wednesday: [{ open: "08:00", close: "18:00" }], 
  thursday: [{ open: "08:00", close: "18:00" }], 
  friday: [{ open: "08:00", close: "18:00" }], 
  saturday: [{ open: "08:00", close: "14:00" }], 
  sunday: [], 
}; 

const DAY_NAMES = [ 
  "sunday", 
  "monday", 
  "tuesday", 
  "wednesday", 
  "thursday", 
  "friday", 
  "saturday", 
]; 

function parseTimeToMinutes(value: string) { 
  const [hourRaw, minuteRaw] = value.split(":"); 
  const hour = Number(hourRaw); 
  const minute = Number(minuteRaw ?? 0); 

  if ( 
    Number.isNaN(hour) || 
    Number.isNaN(minute) || 
    hour < 0 || 
    hour > 23 || 
    minute < 0 || 
    minute > 59 
  ) { 
    throw new Error(`invalid_business_hour_time_${value}`); 
  } 

  return hour * 60 + minute; 
} 

function getLocalParts(dateIso: string, timezone: string) { 
  const date = new Date(dateIso); 

  if (Number.isNaN(date.getTime())) { 
    throw new Error("invalid_datetime"); 
  } 

  const parts = new Intl.DateTimeFormat("en-US", { 
    timeZone: timezone, 
    weekday: "long", 
    hour: "2-digit", 
    minute: "2-digit", 
    hour12: false, 
  }).formatToParts(date); 

  const get = (type: string) => parts.find((part) => part.type === type)?.value; 

  const weekdayName = String(get("weekday") ?? "").toLowerCase(); 
  const rawHour = Number(get("hour")); 
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(get("minute")); 

  return { 
    weekdayName, 
    minuteOfDay: hour * 60 + minute, 
  }; 
} 

function normalizeBusinessHours(companyHours?: any): WeeklyBusinessHours { 
  if (!companyHours || typeof companyHours !== "object") { 
    return DEFAULT_BUSINESS_HOURS; 
  } 

  const output: WeeklyBusinessHours = { ...DEFAULT_BUSINESS_HOURS }; 

  for (const day of DAY_NAMES) { 
    const raw = companyHours[day]; 

    if (raw === null || raw === false || raw === "closed") { 
      output[day] = []; 
      continue; 
    } 

    if (Array.isArray(raw)) { 
      output[day] = raw 
        .filter((window) => window?.open && window?.close) 
        .map((window) => ({ 
          open: String(window.open), 
          close: String(window.close), 
        })); 
    } 
  } 

  return output; 
} 

export function isWithinBusinessHours(params: { 
  startTime: string; 
  endTime: string; 
  timezone: string; 
  companyBusinessHours?: any; 
}) { 
  const hours = normalizeBusinessHours(params.companyBusinessHours); 

  const startParts = getLocalParts(params.startTime, params.timezone); 
  const endParts = getLocalParts(params.endTime, params.timezone); 

  if (startParts.weekdayName !== endParts.weekdayName) { 
    return { 
      allowed: false, 
      reason: "appointment_crosses_business_day_boundary", 
    }; 
  } 

  const windows = hours[startParts.weekdayName] ?? []; 

  if (windows.length === 0) { 
    return { 
      allowed: false, 
      reason: "business_closed_that_day", 
    }; 
  } 

  const matchingWindow = windows.find((window) => { 
    const open = parseTimeToMinutes(window.open); 
    const close = parseTimeToMinutes(window.close); 

    return ( 
      startParts.minuteOfDay >= open && 
      endParts.minuteOfDay <= close && 
      endParts.minuteOfDay > startParts.minuteOfDay 
    ); 
  }); 

  if (!matchingWindow) { 
    return { 
      allowed: false, 
      reason: "outside_business_hours", 
    }; 
  } 

  return { 
    allowed: true, 
    reason: null, 
  }; 
} 

export async function suggestBusinessHourSlots(params: { 
  requestedStartTime: string; 
  durationMinutes: number; 
  timezone: string; 
  companyBusinessHours?: any; 
  count?: number; 
}) { 
  const count = params.count ?? 3; 
  const slots: { startTime: string; endTime: string }[] = []; 

  const requested = new Date(params.requestedStartTime); 

  if (Number.isNaN(requested.getTime())) { 
    throw new Error("invalid_requested_start_time"); 
  }

  const seen = new Set<string>();
  const maxSteps = 14 * 24 * 2;

  for (let i = 0; i <= maxSteps && slots.length < count; i++) {
    const offsets = i === 0 ? [0] : [i, -i];

    for (const offset of offsets) {
      const start = new Date(requested.getTime() + offset * 30 * 60 * 1000);

      if (start.getTime() <= Date.now()) continue;

      const end = new Date(
        start.getTime() + params.durationMinutes * 60 * 1000
      );

      const startIso = start.toISOString();
      const endIso = end.toISOString();

      if (seen.has(startIso)) continue;

      const check = isWithinBusinessHours({
        startTime: startIso,
        endTime: endIso,
        timezone: params.timezone,
        companyBusinessHours: params.companyBusinessHours,
      });

      if (!check.allowed) continue;

      seen.add(startIso);
      slots.push({
        startTime: startIso,
        endTime: endIso,
      });

      if (slots.length >= count) break;
    }
  }

  return slots.sort(
    (a, b) =>
      Math.abs(new Date(a.startTime).getTime() - requested.getTime()) -
      Math.abs(new Date(b.startTime).getTime() - requested.getTime())
  );
} 
