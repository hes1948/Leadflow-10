// app/api/auth/create-company/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function cleanEmail(value: unknown) {
  const email = clean(value).toLowerCase();
  return email.length > 0 ? email : null;
}

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

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const userId = clean(body.userId);
    const companyName = clean(body.companyName);
    const companyPhone = clean(body.companyPhone);
    const email = cleanEmail(body.email);

    if (!userId) {
      return json(
        {
          success: false,
          error: "missing_user_id",
        },
        400
      );
    }

    if (!companyName) {
      return json(
        {
          success: false,
          error: "missing_company_name",
        },
        400
      );
    }

    if (!email) {
      return json(
        {
          success: false,
          error: "missing_company_email",
        },
        400
      );
    }

    const { data: existingMembership, error: membershipReadError } = await supabase
      .from("company_users")
      .select("company_id, role")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    if (membershipReadError) {
      return json(
        {
          success: false,
          error: membershipReadError.message,
        },
        500
      );
    }

    if (existingMembership?.company_id) {
      const { data: existingCompany, error: existingCompanyError } = await supabase
        .from("companies")
        .select("*")
        .eq("id", existingMembership.company_id)
        .maybeSingle();

      if (existingCompanyError) {
        return json(
          {
            success: false,
            error: existingCompanyError.message,
          },
          500
        );
      }

      return json({
        success: true,
        company: existingCompany,
        existing: true,
      });
    }

    const emailSignature = [
      `— ${companyName}`,
      "Fast AC Repair Across Texas",
      companyPhone || null,
    ]
      .filter(Boolean)
      .join("\n");

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .insert({
        name: companyName,
        email,
        phone: companyPhone || null,
        timezone: "America/Chicago",
        service_area: {
          state: "TX",
          cities: [],
          zips: [],
        },
        subscription_status: "trial",
        business_hours: {
          monday: { open: "08:00", close: "17:00" },
          tuesday: { open: "08:00", close: "17:00" },
          wednesday: { open: "08:00", close: "17:00" },
          thursday: { open: "08:00", close: "17:00" },
          friday: { open: "08:00", close: "17:00" },
          saturday: null,
          sunday: null,
        },
        default_appointment_minutes: 90,
        follow_up_delay_hours: 24,
        max_follow_ups: 3,
        email_signature: emailSignature,
        primary_color: "#1e3a8a",
      })
      .select()
      .single();

    if (companyError || !company) {
      return json(
        {
          success: false,
          error: companyError?.message ?? "company_creation_failed",
        },
        500
      );
    }

    const { error: companyUserError } = await supabase
      .from("company_users")
      .insert({
        company_id: company.id,
        user_id: userId,
        role: "owner",
      });

    if (companyUserError) {
      await supabase.from("companies").delete().eq("id", company.id);

      return json(
        {
          success: false,
          error: companyUserError.message,
        },
        500
      );
    }

    return json({
      success: true,
      company,
      existing: false,
    });
  } catch (err: any) {
    return json(
      {
        success: false,
        error: err?.message ?? "create_company_failed",
      },
      500
    );
  }
}
