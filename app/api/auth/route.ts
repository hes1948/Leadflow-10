// app/api/auth/route.ts

import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { getGoogleConnectUrl } from "@/lib/google/companyGoogle";

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
    const url = getGoogleConnectUrl(companyId);

    return NextResponse.redirect(url, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (err: any) {
    const message = err?.message ?? "google_auth_start_failed";

    return json(
      {
        success: false,
        route: "/api/auth",
        error: message,
      },
      message === "unauthorized" ? 401 : 500
    );
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
