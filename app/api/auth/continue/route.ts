// Place this file at app/auth/continue/route.ts
// A full-page redirect happens only after the authenticated company and its
// Google connection state have been verified on the server.
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { connectionReadiness } from "@/lib/google/connectionReadiness";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    // Same authenticated-user and tenant boundary as the existing
    // /api/google/connection-status endpoint.
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);
    const { data, error } = await supabase
      .from("google_connections")
      .select(`
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
      `)
      .eq("company_id", companyId)
      .maybeSingle();

    if (error) throw error;
    const status = connectionReadiness(data);

    // Never treat a failed status lookup as Gmail disconnected.
    if (typeof status.connected !== "boolean" || typeof status.ready !== "boolean") {
      throw new Error("invalid_google_readiness_result");
    }

    // Already linked but needing inbox activation or repair goes to Settings.
    const destination = !status.connected
      ? "/onboarding/company/gmail"
      : status.ready
        ? "/dashboard"
        : "/settings";

    const response = NextResponse.redirect(new URL(destination, request.url), 303);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    console.error("bookmorejobs_post_login_routing_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    // Do not redirect to dashboard or onboarding if identity/tenant verification failed.
    return new NextResponse("Unable to verify your company workspace. Please reload to retry, or return to Login.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}