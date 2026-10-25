import { NextResponse } from "next/server";
import { verifyGoogleConnectState } from "@/lib/google/oauthState";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { saveCompanyGoogleConnection } from "@/lib/google/companyGoogle";
import { startGmailInboxWatch } from "@/lib/gmailWatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function redirectToSettings(req: Request, params: Record<string, string>) {
  const destination = new URL("/settings", req.url);
  for (const [key, value] of Object.entries(params)) destination.searchParams.set(key, value);
  return NextResponse.redirect(destination, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.has("error")) return redirectToSettings(req, { google: "cancelled" });
  try {
    const code = url.searchParams.get("code");
    if (!code) throw new Error("missing_google_code");
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);
    const verifiedCompanyId = verifyGoogleConnectState(url.searchParams.get("state"), companyId);
    if (verifiedCompanyId !== companyId) throw new Error("google_oauth_company_scope_mismatch");
    await saveCompanyGoogleConnection({ companyId, code });

    // A failed watch does not undo the successful OAuth connection. Settings
    // offers an activation retry without making the customer repeat consent.
    let watchActive = false;
    try {
      const watch = await startGmailInboxWatch(companyId);
      watchActive = Boolean(watch.success && watch.historyId);
    } catch (error) {
      console.error("[google-callback] inbox activation failed", {
        companyId, error: error instanceof Error ? error.message : "watch_failed",
      });
    }
    return redirectToSettings(req, { google: "connected", watch: watchActive ? "active" : "pending" });
  } catch (error) {
    console.error("[google-callback] connection failed", {
      error: error instanceof Error ? error.message : "google_callback_failed",
    });
    return redirectToSettings(req, { google: "failed" });
  }
}
