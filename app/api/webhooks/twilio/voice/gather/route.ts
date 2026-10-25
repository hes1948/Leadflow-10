// app/api/webhooks/twilio/voice/gather/route.ts

import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { join } from "path";
import { pathToFileURL } from "url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type NormalizedTwilioInbound = {
  provider: "twilio";
  kind: "voice";
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

function normalizeText(value?: string | null) {
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

function normalizeTwilioInboundVoice(
  params: Record<string, string>
): NormalizedTwilioInbound {
  const callSid = getFirst(params, ["CallSid"]);
  const fromPhone = normalizePhone(getFirst(params, ["From", "Caller"]));
  const toPhone = normalizePhone(getFirst(params, ["To", "Called"]));
  const speechResult = normalizeText(getFirst(params, ["SpeechResult"]));
  const digits = normalizeText(getFirst(params, ["Digits"]));
  const transcriptionText = normalizeText(getFirst(params, ["TranscriptionText"]));

  const body =
    speechResult ||
    transcriptionText ||
    (digits ? `Customer pressed: ${digits}` : "") ||
    "Inbound phone call received.";

  if (!callSid) throw new Error("missing_twilio_call_sid");
  if (!fromPhone) throw new Error("missing_twilio_from_phone");
  if (!toPhone) throw new Error("missing_twilio_to_phone");

  return {
    provider: "twilio",
    kind: "voice",
    providerEventId: callSid,
    providerMessageId: null,
    providerCallSid: callSid,
    fromPhone,
    toPhone,
    body,
    speechResult: speechResult || null,
    digits: digits || null,
    raw: params,
  };
}

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`missing_env_${name}`);
  }

  return value.trim();
}

function getTwilioAuthToken() {
  return getRequiredEnv("TWILIO_AUTH_TOKEN");
}

function getCompanyId() {
  return (
    process.env.TWILIO_DEFAULT_COMPANY_ID ||
    process.env.DEFAULT_COMPANY_ID ||
    null
  );
}

function publicWebhookUrl(req: NextRequest) {
  const configured = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const path = "/api/webhooks/twilio/voice/gather";

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

async function processTwilioInboundMessageJob(input: {
  companyId: string | null;
  inbound: NormalizedTwilioInbound;
}) {
  const modulePath = pathToFileURL(
    join(process.cwd(), "lib", "jobs", "processTwilioInboundMessageJob.ts")
  ).href;

  const mod = await import(modulePath);

  if (typeof mod.processTwilioInboundMessageJob !== "function") {
    throw new Error("missing_processTwilioInboundMessageJob_export");
  }

  return mod.processTwilioInboundMessageJob(input);
}

function finalTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Got it. We received your request and will follow up by text if possible. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

export async function GET() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/voice/gather",
    mode: "twilio_voice_gather_pipeline_no_static_internal_imports",
    message: "Twilio Voice Gather route is alive. Use POST from Twilio.",
  });
}

export async function POST(req: NextRequest) {
  let params: Record<string, string> = {};

  try {
    params = await parseTwilioForm(req);

    if (!validateSignature(req, params)) {
      console.error("[twilio-voice-gather] invalid signature", {
        route: "/api/webhooks/twilio/voice/gather",
        callSid: params.CallSid ?? null,
        from: params.From ?? null,
      });

      return xml("<Response><Reject/></Response>", 403);
    }

    const inbound = normalizeTwilioInboundVoice(params);
    const companyId = getCompanyId();

    const result = await processTwilioInboundMessageJob({
      companyId,
      inbound,
    });

    console.log("[twilio-voice-gather] processed", {
      providerEventId: inbound.providerEventId,
      fromPhone: inbound.fromPhone,
      toPhone: inbound.toPhone,
      leadId: result.leadId,
      duplicate: result.duplicate,
      matchedExistingLead: result.matchedExistingLead,
      speechResult: inbound.speechResult,
      digits: inbound.digits,
    });

    return xml(finalTwiML());
  } catch (error: any) {
    console.error("[twilio-voice-gather] failed", {
      route: "/api/webhooks/twilio/voice/gather",
      message: error?.message ?? "twilio_voice_gather_failed",
      callSid: params.CallSid ?? null,
      from: params.From ?? null,
    });

    return xml(finalTwiML());
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/voice/gather",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
