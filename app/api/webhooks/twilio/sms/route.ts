// app/api/webhooks/twilio/sms/route.ts

import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type NormalizedTwilioInboundSms = {
  provider: "twilio";
  kind: "sms";
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

const VALID_US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "IA",
  "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO",
  "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI",
  "WV", "WY", "DC",
]);

function xml(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function json(payload: Record<string, any>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

function clean(value?: string | null) {
  return String(value ?? "").trim();
}

function cleanOneLine(value?: string | null) {
  return clean(value).replace(/\s+/g, " ").trim();
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

function normalizeState(value?: string | null) {
  const state = cleanOneLine(value).toUpperCase();
  if (!state) return null;
  if (!VALID_US_STATES.has(state)) return null;
  return state;
}

function normalizeZip(value?: string | null) {
  return cleanOneLine(value).match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? null;
}

function getFirst(params: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = clean(params[key]);
    if (value) return value;
  }

  return "";
}

function formDataToRecord(formData: FormData) {
  const record: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    record[key] = String(value ?? "");
  }

  return record;
}

function normalizeTwilioInboundSms(
  params: Record<string, string>
): NormalizedTwilioInboundSms {
  const messageSid = getFirst(params, ["MessageSid", "SmsMessageSid", "SmsSid"]);
  const fromPhone = normalizePhone(getFirst(params, ["From"]));
  const toPhone = normalizePhone(getFirst(params, ["To"]));
  const body = normalizeBody(getFirst(params, ["Body"]));

  if (!messageSid) throw new Error("missing_twilio_message_sid");
  if (!fromPhone) throw new Error("missing_twilio_from_phone");
  if (!toPhone) throw new Error("missing_twilio_to_phone");

  return {
    provider: "twilio",
    kind: "sms",
    providerEventId: messageSid,
    providerMessageId: messageSid,
    providerCallSid: null,
    fromPhone,
    toPhone,
    body,
    speechResult: null,
    digits: null,
    raw: params,
  };
}

function readRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`missing_env_${name}`);
  }

  return value.trim();
}

function readOptionalEnv(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function getSupabaseClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_PROJECT_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "missing_supabase_env_use_SUPABASE_URL_and_SUPABASE_SERVICE_ROLE_KEY_or_existing_supabase_env_names"
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function getTwilioAuthToken() {
  return readRequiredEnv("TWILIO_AUTH_TOKEN");
}

function getTwilioClient() {
  const accountSid = readRequiredEnv("TWILIO_ACCOUNT_SID");
  const authToken = readRequiredEnv("TWILIO_AUTH_TOKEN");

  return twilio(accountSid, authToken);
}

function getTwilioOutboundSender() {
  const messagingServiceSid = readOptionalEnv("TWILIO_MESSAGING_SERVICE_SID");
  const fromPhoneNumber = readOptionalEnv("TWILIO_FROM_PHONE_NUMBER");

  if (messagingServiceSid) {
    return {
      messagingServiceSid,
      from: undefined,
    };
  }

  if (fromPhoneNumber) {
    return {
      messagingServiceSid: undefined,
      from: fromPhoneNumber,
    };
  }

  throw new Error(
    "missing_twilio_sender_config_use_TWILIO_MESSAGING_SERVICE_SID_or_TWILIO_FROM_PHONE_NUMBER"
  );
}

async function sendTwilioSms(input: {
  to: string;
  body: string;
  from?: string | null;
  messagingServiceSid?: string | null;
}) {
  const to = normalizePhone(input.to);
  const body = clean(input.body);

  if (!to) throw new Error("missing_sms_to");
  if (!body) throw new Error("missing_sms_body");

  const client = getTwilioClient();
  const defaultSender = getTwilioOutboundSender();

  const messagingServiceSid =
    clean(input.messagingServiceSid) || defaultSender.messagingServiceSid;
  const from = normalizePhone(input.from) || defaultSender.from;

  const message = await client.messages.create({
    to,
    body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from }),
  });

  return {
    success: true,
    provider: "twilio",
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
    messagingServiceSid:
      message.messagingServiceSid ?? messagingServiceSid ?? null,
  };
}

function getCompanyId() {
  return (
    process.env.TWILIO_DEFAULT_COMPANY_ID ||
    process.env.DEFAULT_COMPANY_ID ||
    null
  );
}

function publicWebhookUrl(req: NextRequest) {
  const configured =
    process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const path = "/api/webhooks/twilio/sms";

  if (configured) {
    return `${configured.replace(/\/+$/g, "")}${path}`;
  }

  return req.url;
}

function shouldValidateTwilioSignature() {
  return process.env.TWILIO_VALIDATE_SIGNATURE !== "false";
}

async function parseTwilioForm(req: NextRequest) {
  const formData = await req.formData();
  return formDataToRecord(formData);
}

function validateSignature(req: NextRequest, params: Record<string, string>) {
  if (!shouldValidateTwilioSignature()) return true;

  const signature = req.headers.get("x-twilio-signature") || "";
  const authToken = getTwilioAuthToken();
  const url = publicWebhookUrl(req);

  return twilio.validateRequest(authToken, signature, url, params);
}

function extractName(body: string) {
  const explicitName =
    body.match(
      /\bname\s*:\s*([\s\S]*?)(?=\s*(?:phone\s*:|email\s*:|address\s*:|service\s+address\s*:|$))/i
    )?.[1] ?? null;

  return cleanOneLine(explicitName) || null;
}

function extractPhone(body: string) {
  return (
    body.match(/\bphone\s*:\s*([+\d().\-\s]{7,})/i)?.[1] ??
    body.match(
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/
    )?.[0] ??
    null
  );
}

function extractEmail(body: string) {
  return (
    body.match(
      /\bemail\s*:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i
    )?.[1] ??
    body.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ??
    null
  );
}

function normalizeBodyForAddress(body: string) {
  return String(body ?? "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, " ")
    .trim();
}

function extractFullAddress(body: string) {
  const normalized = normalizeBodyForAddress(body);

  return (
    normalized.match(
      /\b\d+\s+[A-Za-z0-9 .'-]+?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl|Path|Trail|Cir|Circle|Ter|Terrace)\s+[A-Za-z .'-]+,?\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\s+\d{5}(?:-\d{4})?\b/i
    )?.[0] ??
    normalized.match(
      /\b\d+\s+[A-Za-z0-9 .'-]+?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl|Path|Trail|Cir|Circle|Ter|Terrace)\b/i
    )?.[0] ??
    null
  );
}

function extractCityStateZipFromText(text?: string | null) {
  const value = normalizeBodyForAddress(text ?? "");
  if (!value) return { city: null, state: null, zip: null };

  const match = value.match(
    /\b([A-Za-z .'-]+?),?\s+(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\s+(\d{5}(?:-\d{4})?)\b/i
  );

  return {
    city: match?.[1] ? cleanOneLine(match[1]) : null,
    state: normalizeState(match?.[2]),
    zip: normalizeZip(match?.[3]),
  };
}

function extractMetadataFromText(text: string) {
  const body = String(text ?? "");
  const customerName = extractName(body);
  const phone = extractPhone(body);
  const email = extractEmail(body);
  const address = extractFullAddress(body);
  const fallbackLocation = extractCityStateZipFromText(body);

  return {
    customerName: customerName || null,
    email: cleanOneLine(email).toLowerCase() || null,
    phone: cleanOneLine(phone) || null,
    address: cleanOneLine(address) || null,
    city: fallbackLocation.city || null,
    state: normalizeState(fallbackLocation.state),
    zip: normalizeZip(fallbackLocation.zip),
    serviceArea:
      fallbackLocation.city && fallbackLocation.state && fallbackLocation.zip
        ? `${fallbackLocation.city}, ${normalizeState(
            fallbackLocation.state
          )} ${normalizeZip(fallbackLocation.zip)}`
        : null,
  };
}

function classifyServiceType(text: string) {
  const body = text.toLowerCase();

  if (
    /\b(ac|a\/c|hvac|air conditioner|heat pump|furnace|thermostat|cooling|heating)\b/.test(
      body
    )
  ) {
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

/**
 * A complete customer payload is treated as a new lead even when the same
 * verified test phone number previously created another lead.
 *
 * Short replies such as "option 2", "today works", or "urgent" do not satisfy
 * this check and still attach to the existing phone conversation.
 */
function isExplicitNewLeadPayload(text: string) {
  const body = normalizeBody(text);

  if (!body) return false;

  const explicitFieldCount = [
    /\bname\s*:/i,
    /\bphone\s*:/i,
    /\bemail\s*:/i,
    /\b(?:service\s+)?address\s*:/i,
  ].filter((pattern) => pattern.test(body)).length;

  if (explicitFieldCount >= 2) {
    return true;
  }

  const hasAddress = Boolean(extractFullAddress(body));
  const hasEmail = Boolean(extractEmail(body));
  const hasServiceProblem =
    /\b(ac|a\/c|hvac|air conditioner|heat pump|furnace|thermostat|cooling|heating|not cooling|stopped working|quit working|house hot)\b/i.test(
      body
    );

  return hasServiceProblem && hasAddress && hasEmail;
}

async function getCompany(companyId: string) {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("companies")
    .select("id, name, timezone")
    .eq("id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return (
    data ?? {
      id: companyId,
      name: "our team",
      timezone: "America/Chicago",
    }
  );
}

async function insertInboundRecord(params: {
  companyId: string;
  inbound: NormalizedTwilioInboundSms;
}) {
  const supabase = getSupabaseClient();
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
}) {
  const supabase = getSupabaseClient();
  const phone = normalizePhone(params.fromPhone);
  if (!phone) return null;

  const phoneLast10 = phone.replace(/\D/g, "").slice(-10);
  const visible = visiblePhone(phone);

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
    .or(`phone.eq.${phone},phone.eq.${visible},phone.ilike.%${phoneLast10}%`)
    .in("status", ["new", "contacted", "sent", "awaiting_customer", "booked"])
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);

  const leads = Array.isArray(data) ? (data as LeadRow[]) : [];

  return leads[0] ?? null;
}

async function createTwilioLead(params: {
  companyId: string;
  inbound: NormalizedTwilioInboundSms;
  leadInput: string;
}) {
  const supabase = getSupabaseClient();
  const { companyId, inbound, leadInput } = params;

  const metadata = extractMetadataFromText(leadInput);
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
    source: "twilio_sms",
    twilio: {
      kind: inbound.kind,
      providerEventId: inbound.providerEventId,
      fromPhone: inbound.fromPhone,
      toPhone: inbound.toPhone,
    },
  };

  const { data, error } = await supabase
    .from("leads")
    .insert({
      company_id: companyId,
      input: leadInput,
      message: leadInput,
      source: "twilio_sms",
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
  const supabase = getSupabaseClient();

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
  smsSent: boolean;
}) {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const updatePayload: Record<string, any> = {
    reply: params.reply,
    last_email_from: "twilio",
  };

  if (params.smsSent) {
    updatePayload.last_contacted_at = now;
    updatePayload.sent_at = now;
  }

  const { error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", params.leadId)
    .neq("status", "booked");

  if (error) throw new Error(error.message);
}

function buildInitialSmsReply(company: any) {
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
    "",
    "Reply STOP to opt out.",
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
      "",
      "Reply STOP to opt out.",
    ].join("\n");
  }

  return [
    "Got it — we already have your request open.",
    "Reply with the option/time that works best and we’ll keep moving it forward.",
    "",
    "Reply STOP to opt out.",
  ].join("\n");
}

async function processTwilioInboundMessageJob(input: {
  companyId: string | null;
  inbound: NormalizedTwilioInboundSms;
}) {
  if (!input.companyId) throw new Error("missing_company_id");
  if (!input.inbound) throw new Error("missing_twilio_inbound");

  const company: any = await getCompany(input.companyId);
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
      matchedExistingLead: false,
      createdNewLead: false,
      smsSent: false,
      smsResult: null,
      smsError: null,
    };
  }

  const leadInput = normalizeBody(inbound.body);

  const existingLead = await findExistingLead({
    companyId,
    fromPhone: inbound.fromPhone,
  });

  const createNewLead =
    !existingLead || isExplicitNewLeadPayload(leadInput);

  const lead = createNewLead
    ? await createTwilioLead({
        companyId,
        inbound,
        leadInput,
      })
    : existingLead;

  const matchedExistingLead = !createNewLead && Boolean(existingLead);

  const reply = matchedExistingLead
    ? buildExistingLeadReply(company, lead)
    : buildInitialSmsReply(company);

  let smsResult: any = null;
  let smsError: string | null = null;

  try {
    smsResult = await sendTwilioSms({
      to: inbound.fromPhone || "",
      body: reply,
    });
  } catch (error: any) {
    smsError = error?.message ?? "twilio_outbound_sms_failed";

    console.warn("[twilio-sms] outbound reply failed after lead capture", {
      providerEventId: inbound.providerEventId,
      leadId: lead.id,
      fromPhone: inbound.fromPhone,
      error: smsError,
    });
  }

  const smsSent = Boolean(smsResult);

  await updateLeadAfterSms({
    leadId: lead.id,
    reply,
    smsSent,
  });

  await markInboundLinked({
    inboundRecordId: inboundRecord.id,
    leadId: lead.id,
    status: smsSent ? "processed" : "processed_reply_failed",
  });

  return {
    success: true,
    duplicate: false,
    provider: "twilio",
    kind: inbound.kind,
    providerEventId: inbound.providerEventId,
    leadId: lead.id,
    matchedExistingLead,
    createdNewLead: createNewLead,
    smsSent,
    smsResult,
    smsError,
  };
}

export async function GET() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/sms",
    mode: "twilio_sms_inbound_pipeline_self_contained",
    message: "Twilio SMS webhook route is alive. Use POST from Twilio.",
  });
}

export async function POST(req: NextRequest) {
  let params: Record<string, string> = {};

  try {
    params = await parseTwilioForm(req);

    if (!validateSignature(req, params)) {
      console.error("[twilio-sms] invalid signature", {
        route: "/api/webhooks/twilio/sms",
        messageSid: params.MessageSid ?? null,
        from: params.From ?? null,
      });

      return xml("<Response></Response>", 403);
    }

    const inbound = normalizeTwilioInboundSms(params);
    const companyId = getCompanyId();

    const result = await processTwilioInboundMessageJob({
      companyId,
      inbound,
    });

    console.log("[twilio-sms] processed", {
      providerEventId: inbound.providerEventId,
      fromPhone: inbound.fromPhone,
      toPhone: inbound.toPhone,
      leadId: result.leadId,
      duplicate: result.duplicate,
      matchedExistingLead: result.matchedExistingLead,
      createdNewLead: result.createdNewLead,
      smsSent: result.smsSent,
      smsError: result.smsError,
    });

    return xml("<Response></Response>");
  } catch (error: any) {
    console.error("[twilio-sms] failed", {
      route: "/api/webhooks/twilio/sms",
      message: error?.message ?? "twilio_sms_webhook_failed",
      messageSid: params.MessageSid ?? null,
      from: params.From ?? null,
    });

    return xml("<Response></Response>", 200);
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/sms",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
