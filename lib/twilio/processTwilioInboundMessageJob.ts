// lib/jobs/processTwilioInboundMessageJob.ts

import { supabase } from "../supabase";
import { requireCompany } from "../company/resolveCompany";
import { extractLeadMetadataFromText } from "../leads/leadMetadata";
import { sendTwilioSms } from "../twilio/sendTwilioSms";

type NormalizedTwilioInbound = {
  provider: "twilio";
  kind: "sms" | "voice";
  providerEventId: string;
  providerMessageId: string | null;
  providerCallSid: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  body: string;
  speechResult: string | null;
  digits: string | null;
  raw: Record<string, string>;
};

type ProcessTwilioInboundMessageJobInput = {
  companyId: string | null;
  inbound: NormalizedTwilioInbound;
};

type LeadRow = {
  id: string;
  company_id: string;
  status: string | null;
  customer_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  input: string | null;
  reply: string | null;
  qualification: Record<string, any> | null;
  appointment_time: string | null;
  calendar_event_id: string | null;
  created_at: string | null;
  last_contacted_at: string | null;
};

function clean(value?: string | null) {
  return String(value ?? "").trim();
}

function normalizePhone(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;

  if (raw.startsWith("+")) return raw;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return raw;
}

function visiblePhone(value?: string | null) {
  const phone = normalizePhone(value);
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return phone;
}

function normalizeBody(value?: string | null) {
  return clean(value)
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyServiceType(text: string) {
  const body = text.toLowerCase();

  if (/\b(ac|a\/c|hvac|air conditioner|heat pump|furnace|thermostat|cooling|heating)\b/.test(body)) {
    return "hvac";
  }

  if (/\b(roof|roofing|shingle|leak|hail|gutter)\b/.test(body)) {
    return "roofing";
  }

  if (/\b(plumb|pipe|toilet|drain|sewer|water heater|leak)\b/.test(body)) {
    return "plumbing";
  }

  if (/\b(electric|breaker|outlet|panel|wiring)\b/.test(body)) {
    return "electrical";
  }

  return "hvac";
}

function priorityFromText(text: string) {
  const body = text.toLowerCase();

  if (
    /\b(emergency|urgent|asap|today|hot fast|no cooling|stopped cooling|leaking badly|flooding)\b/.test(
      body
    )
  ) {
    return "high";
  }

  return "medium";
}

function preferredTimeFromText(text: string) {
  const body = text.toLowerCase();

  if (/\btoday\b/.test(body)) return "today";
  if (/\btomorrow\b/.test(body)) return "tomorrow";
  if (/\bthis week\b/.test(body)) return "this week";

  return null;
}

function buildLeadInput(inbound: NormalizedTwilioInbound) {
  if (inbound.kind === "voice") {
    return [
      "Inbound phone call from Twilio.",
      "",
      `From: ${visiblePhone(inbound.fromPhone) ?? inbound.fromPhone ?? ""}`,
      `To: ${visiblePhone(inbound.toPhone) ?? inbound.toPhone ?? ""}`,
      inbound.speechResult ? `Speech: ${inbound.speechResult}` : null,
      inbound.digits ? `Digits: ${inbound.digits}` : null,
      "",
      inbound.body,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return normalizeBody(inbound.body);
}

function buildInitialSmsReply(company: any, lead: LeadRow) {
  const companyName = clean(company?.name) || "our team";

  return [
    `Thanks — this is ${companyName}. We got your request.`,
    "",
    "To get you booked fast, reply with:",
    "1) service address",
    "2) issue",
    "3) best time today",
    "",
    "If this is urgent, reply URGENT.",
  ].join("\n");
}

function buildExistingLeadReply(company: any, lead: LeadRow) {
  if (lead.status === "booked" && lead.appointment_time) {
    const appointment = new Date(lead.appointment_time);

    return [
      "You are already booked.",
      `Appointment time: ${appointment.toLocaleString("en-US", {
        timeZone: company?.timezone || "America/Chicago",
        dateStyle: "medium",
        timeStyle: "short",
      })}`,
      "Reply here if you need to change anything.",
    ].join("\n");
  }

  return [
    "Got it — we already have your request open.",
    "Reply with the option/time that works best and we’ll keep moving it forward.",
  ].join("\n");
}

async function insertInboundRecord(params: {
  companyId: string;
  inbound: NormalizedTwilioInbound;
}) {
  const { companyId, inbound } = params;

  const { data: existing, error: existingError } = await supabase
    .from("twilio_inbound_messages")
    .select("id, lead_id, provider_event_id")
    .eq("company_id", companyId)
    .eq("provider_event_id", inbound.providerEventId)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);

  if (existing) {
    return {
      duplicate: true,
      id: existing.id as string,
      leadId: (existing as any).lead_id ?? null,
    };
  }

  const { data, error } = await supabase
    .from("twilio_inbound_messages")
    .insert({
      company_id: companyId,
      provider: "twilio",
      kind: inbound.kind,
      provider_event_id: inbound.providerEventId,
      provider_message_id: inbound.providerMessageId,
      provider_call_sid: inbound.providerCallSid,
      from_phone: inbound.fromPhone,
      to_phone: inbound.toPhone,
      body: inbound.body,
      raw_payload: inbound.raw,
      status: "received",
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return {
    duplicate: false,
    id: data.id as string,
    leadId: null,
  };
}

async function findExistingLead(params: {
  companyId: string;
  fromPhone: string | null;
  body: string;
}) {
  const phone = normalizePhone(params.fromPhone);
  if (!phone) return null;

  const phoneLast10 = phone.replace(/\D/g, "").slice(-10);

  const { data, error } = await supabase
    .from("leads")
    .select(
      `
      id,
      company_id,
      status,
      customer_name,
      phone,
      email,
      address,
      city,
      state,
      zip,
      input,
      reply,
      qualification,
      appointment_time,
      calendar_event_id,
      created_at,
      last_contacted_at
    `
    )
    .eq("company_id", params.companyId)
    .or(`phone.eq.${phone},phone.ilike.%${phoneLast10}%`)
    .in("status", ["new", "contacted", "sent", "awaiting_customer", "booked"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);

  const leads = Array.isArray(data) ? (data as LeadRow[]) : [];

  return leads[0] ?? null;
}

async function createTwilioLead(params: {
  companyId: string;
  inbound: NormalizedTwilioInbound;
  leadInput: string;
}) {
  const { companyId, inbound, leadInput } = params;

  const metadata = extractLeadMetadataFromText(leadInput);
  const type = classifyServiceType(leadInput);
  const priority = priorityFromText(leadInput);
  const preferredTime = preferredTimeFromText(leadInput);
  const normalizedFromPhone = normalizePhone(inbound.fromPhone);

  const qualification = {
    rawMessage: leadInput,
    customerName: metadata.customerName,
    email: metadata.email,
    phone: visiblePhone(metadata.phone ?? normalizedFromPhone),
    address: metadata.address,
    city: metadata.city,
    state: metadata.state,
    zip: metadata.zip,
    serviceArea: metadata.serviceArea,
    serviceType: type,
    urgency: priority,
    preferredTime,
    source: inbound.kind === "voice" ? "twilio_voice" : "twilio_sms",
    twilio: {
      kind: inbound.kind,
      providerEventId: inbound.providerEventId,
      fromPhone: inbound.fromPhone,
      toPhone: inbound.toPhone,
      speechResult: inbound.speechResult,
      digits: inbound.digits,
    },
  };

  const { data, error } = await supabase
    .from("leads")
    .insert({
      company_id: companyId,
      input: leadInput,
      message: leadInput,
      source: inbound.kind === "voice" ? "twilio_voice" : "twilio_sms",
      type,
      priority,
      status: "awaiting_customer",
      customer_name: metadata.customerName,
      email: metadata.email,
      phone: visiblePhone(metadata.phone ?? normalizedFromPhone),
      address: metadata.address,
      city: metadata.city,
      state: metadata.state,
      zip: metadata.zip,
      preferred_time: preferredTime,
      issue_summary: leadInput.slice(0, 500),
      qualification,
    })
    .select(
      `
      id,
      company_id,
      status,
      customer_name,
      phone,
      email,
      address,
      city,
      state,
      zip,
      input,
      reply,
      qualification,
      appointment_time,
      calendar_event_id,
      created_at,
      last_contacted_at
    `
    )
    .single();

  if (error) throw new Error(error.message);

  return data as LeadRow;
}

async function markInboundLinked(params: {
  inboundRecordId: string;
  leadId: string;
  status: string;
}) {
  const { error } = await supabase
    .from("twilio_inbound_messages")
    .update({
      lead_id: params.leadId,
      status: params.status,
      processed_at: new Date().toISOString(),
    })
    .eq("id", params.inboundRecordId);

  if (error) throw new Error(error.message);
}

async function updateLeadAfterSms(params: {
  leadId: string;
  reply: string;
}) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("leads")
    .update({
      reply: params.reply,
      last_contacted_at: now,
      sent_at: now,
      last_email_from: "twilio",
    })
    .eq("id", params.leadId)
    .neq("status", "booked");

  if (error) throw new Error(error.message);
}

export async function processTwilioInboundMessageJob(
  input: ProcessTwilioInboundMessageJobInput
) {
  if (!input.companyId) throw new Error("missing_company_id");
  if (!input.inbound) throw new Error("missing_twilio_inbound");

  const company: any = await requireCompany(input.companyId);
  const companyId = company.id as string;
  const inbound = input.inbound;

  const inboundRecord = await insertInboundRecord({
    companyId,
    inbound,
  });

  if (inboundRecord.duplicate) {
    return {
      success: true,
      duplicate: true,
      provider: "twilio",
      kind: inbound.kind,
      providerEventId: inbound.providerEventId,
      leadId: inboundRecord.leadId,
      action: "ignored_duplicate_twilio_event",
    };
  }

  const leadInput = buildLeadInput(inbound);

  const existingLead = await findExistingLead({
    companyId,
    fromPhone: inbound.fromPhone,
    body: leadInput,
  });

  const lead = existingLead ?? (await createTwilioLead({ companyId, inbound, leadInput }));

  const reply = existingLead
    ? buildExistingLeadReply(company, lead)
    : buildInitialSmsReply(company, lead);

  let smsResult: any = null;

  if (inbound.kind === "sms" && inbound.fromPhone) {
    smsResult = await sendTwilioSms({
      to: inbound.fromPhone,
      body: reply,
    });

    await updateLeadAfterSms({
      leadId: lead.id,
      reply,
    });
  }

  await markInboundLinked({
    inboundRecordId: inboundRecord.id,
    leadId: lead.id,
    status: "processed",
  });

  return {
    success: true,
    duplicate: false,
    provider: "twilio",
    kind: inbound.kind,
    providerEventId: inbound.providerEventId,
    leadId: lead.id,
    matchedExistingLead: Boolean(existingLead),
    smsSent: Boolean(smsResult),
    smsResult,
  };
}
