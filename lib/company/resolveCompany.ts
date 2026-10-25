// lib/company/resolveCompany.ts

import { supabase } from "@/lib/supabase";
import { requireExecutionCompany } from "@/lib/background-jobs/executionContext";

export type CompanyRecord = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  timezone: string;
  service_area: any;
  subscription_status: string;
  business_hours?: any;
  dispatch_radius_miles?: number | null;
  email_signature?: string | null;
  primary_color?: string | null;
  logo_url?: string | null;
  default_appointment_minutes?: number | null;
  follow_up_delay_hours?: number | null;
  max_follow_ups?: number | null;
};

export async function requireCompany(companyId: string | null) {
  const cleanCompanyId = String(companyId ?? "").trim();

  if (!cleanCompanyId) throw new Error("missing_company_id");

  requireExecutionCompany(cleanCompanyId);

  const { data, error } = await supabase
    .from("companies")
    .select(
      `
      id,
      name,
      email,
      phone,
      timezone,
      service_area,
      subscription_status,
      business_hours,
      dispatch_radius_miles,
      email_signature,
      primary_color,
      logo_url,
      default_appointment_minutes,
      follow_up_delay_hours,
      max_follow_ups
    `
    )
    .eq("id", cleanCompanyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("company_not_found");

  const company = data as CompanyRecord;

  return {
    ...company,
    timezone: company.timezone || "America/Chicago",
    service_area: company.service_area ?? {
      state: "TX",
      cities: [],
      zips: [],
    },
    subscription_status: company.subscription_status || "trial",
    business_hours:
      company.business_hours ??
      {
        monday: { open: "08:00", close: "17:00" },
        tuesday: { open: "08:00", close: "17:00" },
        wednesday: { open: "08:00", close: "17:00" },
        thursday: { open: "08:00", close: "17:00" },
        friday: { open: "08:00", close: "17:00" },
        saturday: null,
        sunday: null,
      },
    default_appointment_minutes: Number(company.default_appointment_minutes ?? 60),
    follow_up_delay_hours: Number(company.follow_up_delay_hours ?? 24),
    max_follow_ups: Number(company.max_follow_ups ?? 3),
  } as CompanyRecord;
}

export function isInsideCompanyServiceArea(params: {
  company: CompanyRecord;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}) {
  const area = params.company.service_area ?? {};

  const allowedState = String(area.state ?? "").trim().toUpperCase();
  const leadState = String(params.state ?? "").trim().toUpperCase();

  const allowedCities = Array.isArray(area.cities) ? area.cities : [];
  const allowedZips = Array.isArray(area.zips) ? area.zips : [];

  const city = String(params.city ?? "").trim().toLowerCase();
  const zip = String(params.zip ?? "").trim();

  if (allowedState && leadState && leadState !== allowedState) return false;

  if (allowedZips.length > 0 && zip) {
    return allowedZips.map(String).includes(zip);
  }

  if (allowedCities.length > 0 && city) {
    return allowedCities
      .map((item: string) => String(item).trim().toLowerCase())
      .filter(Boolean)
      .includes(city);
  }

  if (allowedState === "TX") {
    return leadState === "TX" || !leadState;
  }

  return true;
}
