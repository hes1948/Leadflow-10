// lib/jobs/bookAppointmentJob.ts

import { supabase } from "@/lib/supabase";
import { createCalendarBooking } from "@/lib/google/createCalendarBooking";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import { requireCompany } from "@/lib/company/resolveCompany";
import type { BookAppointmentJobData } from "@/lib/background-jobs/backgroundJobTypes";

function clean(value?: string | null) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isTerminalStatus(status?: string | null) {
  return (
    status === "booked" ||
    status === "completed" ||
    status === "closed" ||
    status === "duplicate" ||
    status === "spam" ||
    status === "outside_service_area"
  );
}

function getServiceLabel(type?: string | null) {
  const value = clean(type).toLowerCase();

  if (value === "hvac") return "HVAC";
  if (value === "roofing") return "Roofing";
  if (value === "plumbing") return "Plumbing";
  if (value === "electrical") return "Electrical";

  return "Service";
}

function buildServiceAddress(lead: any) {
  const parts = [
    clean(lead.address),
    clean(lead.city),
    clean(lead.state).toUpperCase(),
    clean(lead.zip),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "Not captured";
}

function buildBookingSummary(lead: any, fallback?: string | null) {
  if (fallback && clean(fallback)) return clean(fallback);

  const service = getServiceLabel(lead.type);
  const customerName = clean(lead.customer_name);

  return customerName
    ? `${service} Appointment - ${customerName}`
    : `${service} Appointment`;
}

function buildBookingDescription(params: {
  lead: any;
  fallbackDescription?: string | null;
}) {
  const { lead, fallbackDescription } = params;

  const generated = [
    "Booked automatically from background booking job.",
    "",
    `Customer: ${clean(lead.customer_name) || "Not captured"}`,
    `Phone: ${clean(lead.phone) || "Not captured"}`,
    `Email: ${clean(lead.email) || "Not captured"}`,
    `Service: ${getServiceLabel(lead.type)}`,
    `Service address: ${buildServiceAddress(lead)}`,
    lead.preferred_time
      ? `Preferred time: ${clean(lead.preferred_time)}`
      : null,
    lead.issue_summary ? `Issue: ${clean(lead.issue_summary)}` : null,
    "",
    `Lead ID: ${lead.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  if (!fallbackDescription || !clean(fallbackDescription)) {
    return generated;
  }

  return [clean(fallbackDescription), "", "Lead metadata:", generated].join(
    "\n"
  );
}

async function enqueueOwnerAlert(params: {
  companyId: string;
  leadId: string;
  alertType: "new_lead" | "booked" | "follow_up_due" | "failed_booking";
  message?: string | null;
}) {
  try {
    const job = await enqueueBackgroundJob({
      name: "send_owner_alert",
      jobId: `send_owner_alert:${params.alertType}:${params.companyId}:${params.leadId}:${Date.now()}`,
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
    console.error("[book-appointment-job] owner alert enqueue failed", {
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

function requireCalendarEventId(booking: any) {
  const calendarEventId = String(booking?.calendarEventId ?? "").trim();

  if (!calendarEventId) {
    throw new Error("calendar_event_missing_refusing_booked_status");
  }

  return calendarEventId;
}

function requireAppointmentTime(booking: any) {
  const appointmentTime = String(booking?.appointmentTime ?? "").trim();

  if (!appointmentTime) {
    throw new Error("appointment_time_missing_refusing_booked_status");
  }

  const date = new Date(appointmentTime);

  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_appointment_time_from_calendar_booking");
  }

  return date.toISOString();
}

function requireCompanyAppointmentMinutes(value: unknown) {
  const durationMinutes = Number(value);

  if (
    !Number.isFinite(durationMinutes) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    throw new Error("invalid_company_default_appointment_minutes");
  }

  return durationMinutes;
}

export async function bookAppointmentJob(data: BookAppointmentJobData) {
  if (!data.companyId) throw new Error("missing_company_id");
  if (!data.leadId) throw new Error("missing_lead_id");
  if (!data.startTime) throw new Error("missing_start_time");

  const company = await requireCompany(data.companyId);
  const companyDurationMinutes = requireCompanyAppointmentMinutes(
    company.default_appointment_minutes
  );

  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", data.leadId)
    .eq("company_id", data.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!lead) throw new Error("lead_not_found");

  if (lead.status === "booked" && lead.calendar_event_id) {
    return {
      success: true,
      skipped: true,
      reason: "already_booked",
      leadId: data.leadId,
      calendarEventId: lead.calendar_event_id,
      appointmentTime: lead.appointment_time ?? null,
    };
  }

  if (lead.status === "booked" && !lead.calendar_event_id) {
    throw new Error("lead_marked_booked_without_calendar_event");
  }

  if (isTerminalStatus(lead.status)) {
    return {
      success: true,
      skipped: true,
      reason: `blocked_status_${lead.status}`,
      leadId: data.leadId,
    };
  }

  try {
    const booking = await createCalendarBooking({
      companyId: data.companyId,
      leadId: data.leadId,
      startTime: data.startTime,
      durationMinutes: companyDurationMinutes,
      summary: buildBookingSummary(lead, data.summary),
      description: buildBookingDescription({
        lead,
        fallbackDescription: data.description,
      }),
      attendeeEmail: data.attendeeEmail ?? lead.email ?? null,
      attendeeName: data.attendeeName ?? lead.customer_name ?? null,
    });

    const calendarEventId = requireCalendarEventId(booking);
    const appointmentTime = requireAppointmentTime(booking);

    const { data: verifiedLead, error: verifyError } = await supabase
      .from("leads")
      .select("id, company_id, status, appointment_time, calendar_event_id")
      .eq("id", data.leadId)
      .eq("company_id", data.companyId)
      .maybeSingle();

    if (verifyError) throw new Error(verifyError.message);
    if (!verifiedLead) throw new Error("lead_verification_scope_violation");

    if (
      verifiedLead.status !== "booked" ||
      verifiedLead.calendar_event_id !== calendarEventId ||
      !verifiedLead.appointment_time
    ) {
      throw new Error("calendar_booking_not_persisted_on_lead");
    }

    const ownerAlert = await enqueueOwnerAlert({
      companyId: data.companyId,
      leadId: data.leadId,
      alertType: "booked",
      message: `Appointment booked and Google Calendar event created: ${calendarEventId}`,
    });

    return {
      success: true,
      leadId: data.leadId,
      booking,
      calendarEventId,
      appointmentTime,
      appointmentEndTime: booking?.appointmentEndTime ?? null,
      durationMinutes:
        Number(booking?.appointmentMinutes) || companyDurationMinutes,
      updatedLead: verifiedLead,
      ownerAlert,
    };
  } catch (err: any) {
    await enqueueOwnerAlert({
      companyId: data.companyId,
      leadId: data.leadId,
      alertType: "failed_booking",
      message: err?.message ?? "booking_failed",
    });

    throw err;
  }
}