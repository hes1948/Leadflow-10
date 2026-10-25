// app/api/get-leads/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireCompany } from "@/lib/company/resolveCompany";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function json(payload: Record<string, any>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function cleanString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return null;
}

function normalizeState(value: unknown) {
  const state = cleanString(value)?.toUpperCase() ?? null;

  if (!state) return null;

  const valid = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","IA","ID","IL","IN","KS",
    "KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM",
    "NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI",
    "WV","WY","DC",
  ]);

  return valid.has(state) ? state : null;
}

function normalizeZip(value: unknown) {
  return cleanString(value)?.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? null;
}

function buildServiceArea(city?: unknown, state?: unknown, zip?: unknown) {
  const cleanCity = cleanString(city);
  const cleanState = normalizeState(state);
  const cleanZip = normalizeZip(zip);

  return cleanCity && cleanState && cleanZip
    ? `${cleanCity}, ${cleanState} ${cleanZip}`
    : null;
}

function isConfirmedBookedByBackend(pendingSlotSuggestion: any) {
  return (
    pendingSlotSuggestion &&
    typeof pendingSlotSuggestion === "object" &&
    pendingSlotSuggestion.status === "confirmed_and_booked" &&
    Boolean(
      pendingSlotSuggestion.confirmedStartTime ||
        pendingSlotSuggestion.suggestedStartTime
    )
  );
}

function isAppointmentRowBooked(appointment: any) {
  if (!appointment) return false;

  const status = cleanString(appointment.status)?.toLowerCase() ?? null;

  return (
    status === "booked" ||
    status === "confirmed" ||
    status === "scheduled" ||
    Boolean(
      appointment.appointment_time ||
        appointment.start_time ||
        appointment.starts_at ||
        appointment.scheduled_start_time ||
        appointment.calendar_event_id ||
        appointment.google_calendar_event_id ||
        appointment.google_event_id ||
        appointment.event_id
    )
  );
}

function isSafeTestLead(lead: any) {
  const source = cleanString(lead?.source)?.toLowerCase() ?? "";
  const phone = cleanString(lead?.phone) ?? "";
  const email = cleanString(lead?.email)?.toLowerCase() ?? "";
  const input = cleanString(lead?.input)?.toLowerCase() ?? "";
  const message = cleanString(lead?.message)?.toLowerCase() ?? "";
  const customerName = cleanString(lead?.customer_name)?.toLowerCase() ?? "";

  const combined = `${input}\n${message}\n${customerName}\n${email}`;

  return (
    source === "demo" ||
    source === "test" ||
    phone.includes("210-555-") ||
    phone.includes("555-") ||
    email.includes("your_sender_email_here") ||
    email.includes("example.com") ||
    combined.includes("your_sender_email_here") ||
    combined.includes("test hvac") ||
    combined.includes("texas test hvac") ||
    combined.includes("sarah martinez") ||
    combined.includes("daniel reyes") ||
    combined.includes("brandon cole") ||
    combined.includes("victor lane") ||
    combined.includes("marcus reed") ||
    combined.includes("caleb warren")
  );
}

function getLeadUpdatedTime(lead: any) {
  const raw =
    cleanString(lead?.updated_at) ??
    cleanString(lead?.last_contacted_at) ??
    cleanString(lead?.sent_at) ??
    cleanString(lead?.created_at) ??
    "1970-01-01T00:00:00.000Z";

  const date = new Date(raw.endsWith("Z") || raw.includes("+") ? raw : `${raw}Z`);
  const time = date.getTime();

  return Number.isNaN(time) ? 0 : time;
}

function normalizeDuplicateKey(lead: any) {
  const email = cleanString(lead?.email)?.toLowerCase() ?? "";
  const phone = cleanString(lead?.phone)?.replace(/\D/g, "") ?? "";
  const normalizedMessage = cleanString(lead?.message ?? lead?.input)
    ?.toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 220) ?? "";

  return [email, phone, normalizedMessage].filter(Boolean).join("|");
}

function normalizeLead(lead: any, appointment: any = null) {
  const qualification =
    lead?.qualification && typeof lead.qualification === "object"
      ? lead.qualification
      : {};

  const pendingSlotSuggestion =
    qualification?.pendingSlotSuggestion &&
    typeof qualification.pendingSlotSuggestion === "object"
      ? qualification.pendingSlotSuggestion
      : null;

  const rawLeadAppointmentTime = getFirstString(lead?.appointment_time);
  const rawLeadCalendarEventId = getFirstString(lead?.calendar_event_id);

  const appointmentTimeFromAppointment = getFirstString(
    appointment?.appointment_time,
    appointment?.start_time,
    appointment?.starts_at,
    appointment?.scheduled_start_time
  );

  const calendarEventIdFromAppointment = getFirstString(
    appointment?.calendar_event_id,
    appointment?.google_calendar_event_id,
    appointment?.google_event_id,
    appointment?.event_id
  );

  const confirmedSlotTime = getFirstString(
    pendingSlotSuggestion?.confirmedStartTime,
    pendingSlotSuggestion?.suggestedStartTime
  );

  const confirmedSlotEndTime = getFirstString(
    pendingSlotSuggestion?.confirmedEndTime,
    pendingSlotSuggestion?.suggestedEndTime
  );

  const backendConfirmedBooked = isConfirmedBookedByBackend(
    pendingSlotSuggestion
  );

  const appointmentRowBooked = isAppointmentRowBooked(appointment);

  const booked =
    lead?.status === "booked" ||
    Boolean(rawLeadAppointmentTime && rawLeadCalendarEventId) ||
    appointmentRowBooked ||
    backendConfirmedBooked;

  const status = booked
    ? "booked"
    : lead?.status === "booked"
      ? "awaiting_customer"
      : lead?.status || "new";

  const appointmentTime =
    rawLeadAppointmentTime ??
    appointmentTimeFromAppointment ??
    confirmedSlotTime ??
    null;

  const calendarEventId =
    rawLeadCalendarEventId ?? calendarEventIdFromAppointment ?? null;

  const city =
    cleanString(lead?.city) ??
    cleanString(qualification.city) ??
    cleanString(qualification.location?.city) ??
    null;

  const state =
    normalizeState(lead?.state) ??
    normalizeState(qualification.state) ??
    normalizeState(qualification.location?.state);

  const zip =
    normalizeZip(lead?.zip) ??
    normalizeZip(qualification.zip) ??
    normalizeZip(qualification.location?.zip);

  const serviceArea =
    cleanString(lead?.service_area) ??
    cleanString(qualification.serviceArea) ??
    buildServiceArea(city, state, zip);

  return {
    ...lead,
    status,
    appointment_time: appointmentTime,
    calendar_event_id: calendarEventId,
    customer_name: lead?.customer_name ?? qualification.customerName ?? null,
    email: lead?.email ?? qualification.email ?? null,
    phone: lead?.phone ?? qualification.phone ?? null,
    address:
      lead?.address ??
      qualification.address ??
      qualification.location?.address ??
      null,
    city,
    state,
    zip,
    service_area: serviceArea,
    is_safe_test_lead: isSafeTestLead(lead),
    duplicate_key: normalizeDuplicateKey(lead),
    booking_truth: {
      booked,
      displayStatus: status,
      leadStatus: lead?.status ?? null,
      rawLeadAppointmentTime,
      rawLeadCalendarEventId,
      resolvedAppointmentTime: appointmentTime,
      resolvedCalendarEventId: calendarEventId,
      appointmentRowFound: Boolean(appointment),
      appointmentRowBooked,
      appointmentStatus: appointment?.status ?? null,
      appointmentTimeFromAppointment,
      calendarEventIdFromAppointment,
      pendingSlotStatus: pendingSlotSuggestion?.status ?? null,
      backendConfirmedBooked,
      confirmedSlotTime,
      confirmedSlotEndTime,
      source: booked
        ? appointmentRowBooked
          ? "appointments_table"
          : rawLeadAppointmentTime && rawLeadCalendarEventId
            ? "leads_columns"
            : backendConfirmedBooked
              ? "qualification_pending_slot_confirmed_and_booked"
              : "lead_status_booked"
        : "not_booked",
    },
  };
}

async function getAppointmentsByLeadId(leadIds: string[]) {
  if (leadIds.length === 0) return new Map<string, any>();

  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .in("lead_id", leadIds)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[get-leads] appointments lookup skipped", {
        error: error.message,
      });
      return new Map<string, any>();
    }

    const map = new Map<string, any>();

    for (const appointment of data ?? []) {
      const leadId = appointment?.lead_id;
      if (leadId && !map.has(leadId)) {
        map.set(leadId, appointment);
      }
    }

    return map;
  } catch (err: any) {
    console.warn("[get-leads] appointments lookup crashed but ignored", {
      error: err?.message ?? err,
    });
    return new Map<string, any>();
  }
}

function shouldShowLead(lead: any, params: { hideTest: boolean }) {
  const status = cleanString(lead?.status)?.toLowerCase() ?? "";

  if (status === "spam" || status === "duplicate" || status === "closed") {
    return false;
  }

  if (params.hideTest && isSafeTestLead(lead)) {
    return false;
  }

  return true;
}

function removeDuplicateContentLeads(leads: any[]) {
  const seen = new Set<string>();
  const output: any[] = [];

  for (const lead of leads) {
    const key = normalizeDuplicateKey(lead);

    if (key && seen.has(key)) {
      continue;
    }

    if (key) seen.add(key);
    output.push(lead);
  }

  return output;
}

export async function GET(req: NextRequest) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) throw new Error("missing_company_id");

    const company = await requireCompany(companyId);
    const hideTest =
      req.nextUrl.searchParams.get("hideTest") === "1" ||
      req.nextUrl.searchParams.get("hideTest") === "true";

    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("company_id", company.id)
      .order("created_at", { ascending: false })
      .limit(300);

    if (error) throw new Error(error.message);

    const rows = data ?? [];
    const leadIds = rows.map((lead: any) => String(lead.id)).filter(Boolean);
    const appointmentsByLeadId = await getAppointmentsByLeadId(leadIds);

    const normalized = rows
      .map((lead: any) => normalizeLead(lead, appointmentsByLeadId.get(lead.id)))
      .sort((a: any, b: any) => getLeadUpdatedTime(b) - getLeadUpdatedTime(a));

    const leads = removeDuplicateContentLeads(
      normalized.filter((lead: any) => shouldShowLead(lead, { hideTest }))
    ).slice(0, 75);

    const hiddenTestLeads = rows.filter(isSafeTestLead).length;
    const hiddenClosedNoise = rows.filter((lead: any) => {
      const status = cleanString(lead?.status)?.toLowerCase() ?? "";
      return status === "spam" || status === "duplicate" || status === "closed";
    }).length;

    const responseTimes = leads
      .map((lead: any) => lead.response_time_seconds)
      .filter((value: unknown): value is number => typeof value === "number");

    const averageResponseTimeSeconds =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((sum, value) => sum + value, 0) /
              responseTimes.length
          )
        : null;

    return json({
      success: true,
      route: "/api/get-leads",
      mode: "booking_truth_safe_noise_filtered_current_company",
      company,
      averageResponseTimeSeconds,
      leads,
      cleanup: {
        hideTest,
        rawFetched: rows.length,
        returned: leads.length,
        safeTestLeadsDetected: hiddenTestLeads,
        hiddenTestLeads: hideTest ? hiddenTestLeads : 0,
        hiddenClosedNoise,
      },
    });
  } catch (err: any) {
    const message = err?.message ?? "get_leads_failed";

    return json(
      {
        success: false,
        route: "/api/get-leads",
        error: message,
        company: null,
        averageResponseTimeSeconds: null,
        leads: [],
      },
      message === "unauthorized"
        ? 401
        : message === "missing_company_id" || message === "company_not_found"
          ? 403
          : 500
    );
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/get-leads",
    methods: ["GET", "HEAD", "OPTIONS"],
  });
}
