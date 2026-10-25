// app/api/google/gmail/watch/route.ts

import { NextResponse } from "next/server";
import { startGmailInboxWatch } from "@/lib/gmailWatch";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isGoogleAuthFailure(message: string) {
  const text = message.toLowerCase();

  return (
    text.includes("invalid_grant") ||
    text.includes("invalid authentication credentials") ||
    text.includes("expected oauth 2 access token") ||
    text.includes("unauthorized_client") ||
    text.includes("google_reconnect_required")
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

async function handleWatch() {
  let companyId: string | null = null;

  try {
    const user = await getUser();
    companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      throw new Error("missing_company_id");
    }

    const result = await startGmailInboxWatch(companyId);

    return NextResponse.json({
      success: true,
      message: "Gmail watch activated",
      mode: "priority_26_production_watch",
      companyId,
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

    return NextResponse.json(
      {
        success: false,
        mode: "priority_26_production_watch",
        error: message,
        reconnectRequired: isGoogleAuthFailure(message),
      },
      {
        status:
          message === "unauthorized"
            ? 401
            : isGoogleAuthFailure(message)
              ? 409
              : 500,
      }
    );
  }
}

export async function GET() {
  return handleWatch();
}

export async function POST() {
  return handleWatch();
}