// app/api/webhooks/gmail-pubsub/route.ts

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

  console.log("[gmail-pubsub] HIT", {
    route: "/api/webhooks/gmail-pubsub",
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
      route: "/api/webhooks/gmail-pubsub",
      mode: "multi_company_gmail_pubsub_processor_safe",
      result,
    });
  } catch (err: any) {
    const message = err?.message ?? "gmail_pubsub_route_failed";

    console.error("[gmail-pubsub] route failed", {
      route: "/api/webhooks/gmail-pubsub",
      message,
      pubsubMessageId: body?.message?.messageId ?? null,
    });

    return json(
      {
        success: false,
        route: "/api/webhooks/gmail-pubsub",
        mode: "multi_company_gmail_pubsub_processor_safe",
        error: message,
      },
      500
    );
  }
}

export async function GET() {
  return json({
    success: true,
    route: "/api/webhooks/gmail-pubsub",
    mode: "multi_company_gmail_pubsub_processor_safe",
    message: "Gmail Pub/Sub webhook route is alive",
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
    route: "/api/webhooks/gmail-pubsub",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
