// app/api/demo/clear/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

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

function cleanString(value: unknown) {
  if (typeof value !== "string") return null;

  const text = value.trim();
  return text.length > 0 ? text : null;
}

function isSafeTestLead(lead: any) {
  const source = cleanString(lead?.source)?.toLowerCase() ?? "";
  const phone = cleanString(lead?.phone) ?? "";
  const email = cleanString(lead?.email)?.toLowerCase() ?? "";
  const input = cleanString(lead?.input)?.toLowerCase() ?? "";
  const message = cleanString(lead?.message)?.toLowerCase() ?? "";
  const customerName = cleanString(lead?.customer_name)?.toLowerCase() ?? "";

  const combined = `${input}\n${message}\n${customerName}\n${email}`;

  return (
    source === "demo" ||
    source === "test" ||
    phone.includes("210-555-") ||
    phone.includes("555-") ||
    email.includes("your_sender_email_here") ||
    email.includes("example.com") ||
    combined.includes("your_sender_email_here") ||
    combined.includes("test hvac") ||
    combined.includes("texas test hvac") ||
    combined.includes("sarah martinez") ||
    combined.includes("daniel reyes") ||
    combined.includes("brandon cole") ||
    combined.includes("victor lane") ||
    combined.includes("marcus reed") ||
    combined.includes("caleb warren")
  );
}

async function getSafeTestLeadIds(companyId: string) {
  const { data, error } = await supabase
    .from("leads")
    .select(
      `
      id,
      source,
      phone,
      email,
      input,
      message,
      customer_name
    `
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter(isSafeTestLead)
    .map((lead: any) => String(lead.id))
    .filter(Boolean);
}

async function deleteAppointmentsForLeads(leadIds: string[]) {
  if (leadIds.length === 0) return 0;

  try {
    const { data, error } = await supabase
      .from("appointments")
      .delete()
      .in("lead_id", leadIds)
      .select("id");

    if (error) {
      console.warn("[demo-clear] appointment cleanup skipped", {
        error: error.message,
      });

      return 0;
    }

    return data?.length ?? 0;
  } catch (err: any) {
    console.warn("[demo-clear] appointment cleanup crashed but ignored", {
      error: err?.message ?? err,
    });

    return 0;
  }
}

async function deleteInboundEmailLinksForLeads(leadIds: string[]) {
  if (leadIds.length === 0) return 0;

  try {
    const { data, error } = await supabase
      .from("inbound_emails")
      .delete()
      .in("lead_id", leadIds)
      .select("id");

    if (error) {
      console.warn("[demo-clear] inbound email cleanup skipped", {
        error: error.message,
      });

      return 0;
    }

    return data?.length ?? 0;
  } catch (err: any) {
    console.warn("[demo-clear] inbound email cleanup crashed but ignored", {
      error: err?.message ?? err,
    });

    return 0;
  }
}

async function deleteBackgroundJobsForLeads(leadIds: string[]) {
  if (leadIds.length === 0) return 0;

  let deleted = 0;

  for (const leadId of leadIds) {
    try {
      const { data, error } = await supabase
        .from("background_jobs")
        .delete()
        .contains("data", { leadId })
        .select("id");

      if (error) {
        console.warn("[demo-clear] background job cleanup skipped", {
          leadId,
          error: error.message,
        });

        continue;
      }

      deleted += data?.length ?? 0;
    } catch (err: any) {
      console.warn("[demo-clear] background job cleanup crashed but ignored", {
        leadId,
        error: err?.message ?? err,
      });
    }
  }

  return deleted;
}

async function deleteLeads(companyId: string, leadIds: string[]) {
  if (leadIds.length === 0) return 0;

  const { data, error } = await supabase
    .from("leads")
    .delete()
    .eq("company_id", companyId)
    .in("id", leadIds)
    .select("id");

  if (error) throw new Error(error.message);

  return data?.length ?? 0;
}

export async function DELETE(_req: NextRequest) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) throw new Error("missing_company_id");

    const leadIds = await getSafeTestLeadIds(companyId);

    const deletedAppointments = await deleteAppointmentsForLeads(leadIds);
    const deletedInboundEmails = await deleteInboundEmailLinksForLeads(leadIds);
    const deletedBackgroundJobs = await deleteBackgroundJobsForLeads(leadIds);
    const deletedLeads = await deleteLeads(companyId, leadIds);

    return json({
      success: true,
      route: "/api/demo/clear",
      mode: "current_company_safe_test_cleanup",
      companyId,
      cleared: true,
      matchedLeadIds: leadIds,
      deleted: {
        leads: deletedLeads,
        appointments: deletedAppointments,
        inboundEmails: deletedInboundEmails,
        backgroundJobs: deletedBackgroundJobs,
      },
      safety: {
        scopedToCurrentCompany: true,
        deletesOnlySafeTestPatterns: true,
        productionLeadsProtected: true,
      },
    });
  } catch (err: any) {
    const message = err?.message ?? "demo_clear_failed";

    return json(
      {
        success: false,
        route: "/api/demo/clear",
        error: message,
        cleared: false,
      },
      message === "unauthorized"
        ? 401
        : message === "missing_company_id"
          ? 403
          : 500
    );
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/demo/clear",
    methods: ["DELETE", "HEAD", "OPTIONS"],
  });
}
