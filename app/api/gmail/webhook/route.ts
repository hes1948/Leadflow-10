// app/api/gmail/webhook/route.ts

import { NextRequest, NextResponse } from "next/server";
import { enqueueGmailPubSubWebhook } from "@/lib/gmail/processGmailPubSubWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

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

async function readBody(req: NextRequest) {
  const text = await req.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function handleWebhook(req: NextRequest) {
  const body = await readBody(req);

  console.log("[gmail-webhook-legacy] HIT", {
    route: "/api/gmail/webhook",
    hasBody: Boolean(body && Object.keys(body).length > 0),
    hasMessage: Boolean(body?.message),
    hasData: Boolean(body?.message?.data),
    pubsubMessageId: body?.message?.messageId ?? null,
    publishTime: body?.message?.publishTime ?? null,
  });

  try {
    const result = await enqueueGmailPubSubWebhook(body);

    return json({
      success: true,
      route: "/api/gmail/webhook",
      canonicalRoute: "/api/webhooks/gmail-pubsub",
      mode: "legacy_gmail_webhook_alias",
      result,
    });
  } catch (err: any) {
    const message = err?.message ?? "gmail_webhook_route_failed";

    console.error("[gmail-webhook-legacy] route failed", {
      route: "/api/gmail/webhook",
      message,
      pubsubMessageId: body?.message?.messageId ?? null,
    });

    return json(
      {
        success: false,
        route: "/api/gmail/webhook",
        canonicalRoute: "/api/webhooks/gmail-pubsub",
        mode: "legacy_gmail_webhook_alias",
        error: message,
      },
      500
    );
  }
}

export async function GET() {
  return json({
    success: true,
    route: "/api/gmail/webhook",
    canonicalRoute: "/api/webhooks/gmail-pubsub",
    mode: "legacy_gmail_webhook_alias",
    message: "Legacy Gmail webhook alias is alive",
  });
}

export async function POST(req: NextRequest) {
  return handleWebhook(req);
}

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/gmail/webhook",
    canonicalRoute: "/api/webhooks/gmail-pubsub",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}