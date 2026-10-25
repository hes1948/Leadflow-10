export const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Hours = Record<string, { open: string; close: string } | null>;
export type CompanySettings = {
  id?: string; name?: string | null; phone?: string | null; timezone?: string | null;
  dispatch_radius_miles?: number | null; default_appointment_minutes?: number | null;
  follow_up_delay_hours?: number | null; max_follow_ups?: number | null;
  email_signature?: string | null; business_hours?: Hours | null;
};
export type SettingsDraft = {
  name: string; phone: string; timezone: string; email_signature: string;
  dispatch_radius_miles: string; default_appointment_minutes: string;
  follow_up_delay_hours: string; max_follow_ups: string;
};
export function settingsDraft(settings: CompanySettings): SettingsDraft {
  return {
    name: settings.name ?? "", phone: settings.phone ?? "", timezone: settings.timezone || "America/Chicago",
    email_signature: settings.email_signature ?? "",
    dispatch_radius_miles: String(settings.dispatch_radius_miles ?? 35),
    default_appointment_minutes: String(settings.default_appointment_minutes ?? 60),
    follow_up_delay_hours: String(settings.follow_up_delay_hours ?? 24),
    max_follow_ups: String(settings.max_follow_ups ?? 3),
  };
}
export function buildSettingsPayload(draft: SettingsDraft, hours?: Hours) {
  if (!draft.name.trim()) throw new Error("Enter your company name.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: draft.timezone }).format(); }
  catch { throw new Error("Choose a valid time zone."); }
  function number(field: keyof SettingsDraft, label: string, max: number, integer = false) {
    const value = Number(draft[field]);
    if (!Number.isFinite(value) || value < 1 || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${label} must be ${integer ? "a whole number " : ""}between 1 and ${max}.`);
    }
    return value;
  }
  if (hours) for (const day of DAYS) {
    const window = hours[day];
    if (window && (!/^\d{2}:\d{2}$/.test(window.open) || !/^\d{2}:\d{2}$/.test(window.close)
      || window.open >= window.close || window.open > "23:59" || window.close > "23:59"
      || Number(window.open.slice(3)) > 59 || Number(window.close.slice(3)) > 59)) {
      throw new Error(`Set a closing time after the opening time for ${day}.`);
    }
  }
  return {
    name: draft.name.trim(), phone: draft.phone.trim(), timezone: draft.timezone,
    email_signature: draft.email_signature,
    dispatch_radius_miles: number("dispatch_radius_miles", "Dispatch radius", 1000),
    default_appointment_minutes: number("default_appointment_minutes", "Appointment length", 1440, true),
    follow_up_delay_hours: number("follow_up_delay_hours", "Follow-up delay", 8760),
    max_follow_ups: number("max_follow_ups", "Maximum follow-ups", 100, true),
    ...(hours ? { business_hours: hours } : {}),
  };
}
