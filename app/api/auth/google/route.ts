// app/api/auth/google/route.ts

import { NextResponse } from "next/server";
import { getGoogleConnectUrl } from "@/lib/google/companyGoogle";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export async function GET() {
  const user = await getUser();
  const companyId = await getAuthenticatedCompanyId(user.id);

  if (!companyId) {
    return NextResponse.json(
      {
        success: false,
        error: "missing_company_id",
      },
      { status: 403 }
    );
  }

  const url = getGoogleConnectUrl(companyId);

  return NextResponse.redirect(url);
}