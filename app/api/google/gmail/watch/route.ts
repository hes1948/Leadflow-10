// app/api/google/gmail/watch/route.ts

import { NextResponse } from "next/server";
import { startGmailInboxWatch } from "@/lib/gmailWatch";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { supabase } from "@/lib/supabase";

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

function isGoogleAuthFailure(message: string) {
  const text = String(message ?? "").toLowerCase();

  return (
    text.includes("invalid_grant") ||
    text.includes("invalid authentication credentials") ||
    text.includes("expected oauth 2 access token") ||
    text.includes("unauthorized_client") ||
    text.includes("google_reconnect_required") ||
    text.includes("missing_google_connection") ||
    text.includes("missing_refresh_token")
  );
}

async function markGoogleReconnectRequired(companyId: string, message: string) {
  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: false,
      access_token: null,
      token_type: "RECONNECT_REQUIRED",
      scope: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);

  if (error) {
    console.error("GOOGLE_WATCH_RECONNECT_MARK_FAILED:", error.message);
  }
}

async function assertCompanyHasGoogleConnection(companyId: string) {
  const { data, error } = await supabase
    .from("google_connections")
    .select("company_id, google_account_email, refresh_token")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("missing_google_connection_connect_gmail_first");
  if (!data.refresh_token) throw new Error("missing_refresh_token_reconnect_google");

  return data;
}

async function handleWatch() {
  let companyId: string | null = null;

  try {
    const user = await getUser();
    companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      throw new Error("missing_company_id");
    }

    const connection = await assertCompanyHasGoogleConnection(companyId);
    const result = await startGmailInboxWatch(companyId);

    return json({
      success: true,
      route: "/api/google/gmail/watch",
      message: "Gmail watch activated",
      mode: "multi_company_production_watch_safe",
      companyId,
      googleAccountEmail: connection.google_account_email ?? null,
      topicName: result.topicName,
      historyId: result.historyId,
      expiration: result.expiration,
      result,
    });
  } catch (err: any) {
    const message = err?.message ?? "gmail_watch_failed";

    if (companyId && isGoogleAuthFailure(message)) {
      await markGoogleReconnectRequired(companyId, message);
    }

    return json(
      {
        success: false,
        route: "/api/google/gmail/watch",
        mode: "multi_company_production_watch_safe",
        companyId,
        error: message,
        reconnectRequired: isGoogleAuthFailure(message),
        action: isGoogleAuthFailure(message) ? "connect_or_reconnect_google" : null,
      },
      message === "unauthorized" ? 401 : isGoogleAuthFailure(message) ? 409 : 500
    );
  }
}

export async function GET() {
  return handleWatch();
}

export async function POST() {
  return handleWatch();
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
    route: "/api/google/gmail/watch",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
