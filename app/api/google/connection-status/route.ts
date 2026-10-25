// app/api/google/connection-status/route.ts

import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { connectionReadiness } from "@/lib/google/connectionReadiness";
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

export async function GET() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    const { data, error } = await supabase
      .from("google_connections")
      .select(
        `
        company_id,
        google_account_email,
        refresh_token,
        gmail_ingestion_enabled,
        token_type,
        gmail_watch_active,
        gmail_watch_history_id,
        gmail_watch_expiration,
        gmail_watch_topic,
        updated_at
      `
      )
      .eq("company_id", companyId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const readiness = connectionReadiness(data);

    return json({
      success: true,
      route: "/api/google/connection-status",
      companyId,
      ...readiness,
      gmailWatchActive: Boolean(data?.gmail_watch_active),
      googleAccountEmail: data?.google_account_email ?? null,
      gmailWatchHistoryId: data?.gmail_watch_history_id ?? null,
      gmailWatchExpiration: data?.gmail_watch_expiration ?? null,
      gmailWatchTopic: data?.gmail_watch_topic ?? null,
      updatedAt: data?.updated_at ?? null,
    });
  } catch (err: any) {
    const message = err?.message ?? "google_status_failed";

    return json(
      {
        success: false,
        route: "/api/google/connection-status",
        error: message,
      },
      message === "unauthorized" ? 401 : 500
    );
  }
}
