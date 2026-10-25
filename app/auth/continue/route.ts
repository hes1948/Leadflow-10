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

    if (
      typeof status.connected !== "boolean" ||
      typeof status.ready !== "boolean"
    ) {
      throw new Error("invalid_google_readiness_result");
    }

    const destination = !status.connected
      ? "/onboarding/company/gmail"
      : status.ready
        ? "/dashboard"
        : "/settings";

    const response = NextResponse.redirect(
      new URL(destination, request.url),
      303
    );

    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    console.error("post_login_routing_failed", error);

    return new NextResponse(
      "Company verification failed. Please return to Login and retry.",
      {
        status: 503,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }
}