import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export async function GET() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    const { data, error } = await supabase
      .from("google_connections")
      .select("google_account_email, created_at, updated_at")
      .eq("company_id", companyId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return NextResponse.json({
      success: true,
      connected: Boolean(data),
      connection: data ?? null,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message ?? "google_status_failed",
      },
      { status: 500 }
    );
  }
}