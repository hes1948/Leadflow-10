// app/api/webhooks/twilio/voice/route.ts

import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

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

function getTwilioAuthToken() {
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!token || !token.trim()) {
    throw new Error("missing_env_TWILIO_AUTH_TOKEN");
  }

  return token.trim();
}

function formDataToRecord(formData: FormData) {
  const record: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    record[key] = String(value ?? "");
  }

  return record;
}

function publicWebhookUrl(req: NextRequest) {
  const configured = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const path = "/api/webhooks/twilio/voice";

  if (configured) {
    return `${configured.replace(/\/+$/g, "")}${path}`;
  }

  return req.url;
}

function gatherWebhookUrl(req: NextRequest) {
  const configured = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const path = "/api/webhooks/twilio/voice/gather";

  if (configured) {
    return `${configured.replace(/\/+$/g, "")}${path}`;
  }

  const url = new URL(req.url);
  url.pathname = path;
  url.search = "";
  return url.toString();
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

function initialTwiML(req: NextRequest) {
  const gatherUrl = gatherWebhookUrl(req);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" timeout="5" speechTimeout="auto" numDigits="1" action="${gatherUrl}" method="POST">
    <Say voice="alice">Thanks for calling. Briefly tell us what service you need, or press 1 for urgent service.</Say>
  </Gather>
  <Say voice="alice">We did not receive a response. Please call again or send a text message to this number.</Say>
  <Hangup/>
</Response>`;
}

export async function GET() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/voice",
    mode: "twilio_voice_inbound_pipeline",
    message: "Twilio Voice webhook route is alive. Use POST from Twilio.",
  });
}

export async function POST(req: NextRequest) {
  let params: Record<string, string> = {};

  try {
    params = await parseTwilioForm(req);

    if (!validateSignature(req, params)) {
      console.error("[twilio-voice] invalid signature", {
        route: "/api/webhooks/twilio/voice",
        callSid: params.CallSid ?? null,
        from: params.From ?? null,
      });

      return xml("<Response><Reject/></Response>", 403);
    }

    console.log("[twilio-voice] received call and returning gather prompt", {
      route: "/api/webhooks/twilio/voice",
      callSid: params.CallSid ?? null,
      from: params.From ?? null,
      to: params.To ?? null,
      gatherUrl: gatherWebhookUrl(req),
    });

    return xml(initialTwiML(req));
  } catch (error: any) {
    console.error("[twilio-voice] failed", {
      route: "/api/webhooks/twilio/voice",
      message: error?.message ?? "twilio_voice_webhook_failed",
      callSid: params.CallSid ?? null,
      from: params.From ?? null,
    });

    return xml(initialTwiML(req));
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/webhooks/twilio/voice",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
