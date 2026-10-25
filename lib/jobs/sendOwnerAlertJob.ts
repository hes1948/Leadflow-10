// lib/jobs/sendOwnerAlertJob.ts

import { supabase } from "@/lib/supabase";
import { notifySlack } from "@/lib/actions/notifySlack";
import type { SendOwnerAlertJobData } from "@/lib/background-jobs/backgroundJobTypes";

type CompanyForAlert = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  timezone?: string | null;
};

type LeadForAlert = {
  id: string;
  company_id: string;
  customer_name: string | null;
  email: string | null;
  phone: string | null;
  type: string | null;
  status: string | null;
  priority: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  preferred_time: string | null;
  issue_summary: string | null;
  appointment_time: string | null;
  calendar_event_id: string | null;
  source: string | null;
  created_at: string | null;
};

function clean(value?: string | null) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function getCustomerName(lead: LeadForAlert) {
  return clean(lead.customer_name) || "Unknown customer";
}

function getServiceLabel(type?: string | null) {
  const cleanType = clean(type).toLowerCase();

  if (cleanType === "hvac") return "HVAC";
  if (cleanType === "roofing") return "Roofing";
  if (cleanType === "plumbing") return "Plumbing";
  if (cleanType === "electrical") return "Electrical";

  return "Service";
}

function buildAddress(lead: LeadForAlert) {
  const parts = [
    clean(lead.address),
    clean(lead.city),
    clean(lead.state).toUpperCase(),
    clean(lead.zip),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "Not captured";
}

function formatAppointmentTime(value?: string | null, timezone?: string | null) {
  if (!value) return "Not booked yet";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("en-US", {
    timeZone: timezone || "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildAlertTitle(alertType: SendOwnerAlertJobData["alertType"]) {
  if (alertType === "new_lead") return "🚨 New HVAC lead captured";
  if (alertType === "booked") return "✅ HVAC appointment booked";
  if (alertType === "follow_up_due") return "⏰ Follow-up due";
  if (alertType === "failed_booking") return "⚠️ Booking needs attention";

  return "HVAC lead alert";
}

function buildSlackMessage(params: {
  company: CompanyForAlert;
  lead: LeadForAlert;
  alertType: SendOwnerAlertJobData["alertType"];
  message?: string | null;
}) {
  const { company, lead, alertType, message } = params;

  return [
    buildAlertTitle(alertType),
    "",
    `Company: ${clean(company.name) || "Unknown company"}`,
    `Customer: ${getCustomerName(lead)}`,
    `Phone: ${clean(lead.phone) || "Not captured"}`,
    `Email: ${clean(lead.email) || "Not captured"}`,
    `Service: ${getServiceLabel(lead.type)}`,
    `Urgency: ${clean(lead.priority) || "normal"}`,
    `Status: ${clean(lead.status) || "unknown"}`,
    `Address: ${buildAddress(lead)}`,
    `Preferred time: ${clean(lead.preferred_time) || "Not captured"}`,
    `Appointment: ${formatAppointmentTime(
      lead.appointment_time,
      company.timezone
    )}`,
    lead.calendar_event_id
      ? `Calendar event: ${lead.calendar_event_id}`
      : "Calendar event: Not created yet",
    lead.issue_summary ? `Issue: ${clean(lead.issue_summary)}` : null,
    message ? `Note: ${clean(message)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendOwnerAlertJob(data: SendOwnerAlertJobData) {
  if (!data.companyId) throw new Error("missing_company_id");
  if (!data.leadId) throw new Error("missing_lead_id");

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id, name, email, phone, timezone")
    .eq("id", data.companyId)
    .maybeSingle();

  if (companyError) throw new Error(companyError.message);
  if (!company) throw new Error("company_not_found");

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(
      `
      id,
      company_id,
      customer_name,
      email,
      phone,
      type,
      status,
      priority,
      address,
      city,
      state,
      zip,
      preferred_time,
      issue_summary,
      appointment_time,
      calendar_event_id,
      source,
      created_at
    `
    )
    .eq("id", data.leadId)
    .eq("company_id", data.companyId)
    .maybeSingle();

  if (leadError) throw new Error(leadError.message);
  if (!lead) throw new Error("lead_not_found");

  const slackMessage = buildSlackMessage({
    company,
    lead,
    alertType: data.alertType,
    message: data.message,
  });

  const slackResult = await notifySlack(slackMessage);

  console.log("[owner-alert]", {
    companyId: data.companyId,
    companyName: company.name,
    leadId: data.leadId,
    alertType: data.alertType,
    delivered: slackResult.delivered,
    customerEmail: lead.email ?? null,
    customerPhone: lead.phone ?? null,
    status: lead.status ?? null,
  });

  return {
    success: true,
    leadId: data.leadId,
    alertType: data.alertType,
    delivered: slackResult.delivered,
    provider: "slack",
    result: slackResult,
  };
}