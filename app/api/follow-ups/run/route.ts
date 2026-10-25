// app/api/follow-ups/run/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";

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

function getBearerToken(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice("bearer ".length).trim();
}

function isCronAuthorized(req: NextRequest) {
  const expected = process.env.FOLLOW_UP_CRON_SECRET;
  if (!expected) return false;

  const bearer = getBearerToken(req);
  const headerSecret = req.headers.get("x-follow-up-secret");
  const querySecret = req.nextUrl.searchParams.get("secret");

  return bearer === expected || headerSecret === expected || querySecret === expected;
}

async function resolveCompanyIdsForCron() {
  const { data, error } = await supabase
    .from("companies")
    .select("id, subscription_status")
    .neq("subscription_status", "canceled")
    .limit(500);

  if (error) throw new Error(error.message);

  return (data ?? []).map((company) => company.id).filter(Boolean);
}

async function resolveCompanyIdsForUser(userId: string) {
  const companyId = await getAuthenticatedCompanyId(userId);
  if (!companyId) throw new Error("missing_company_id");
  return [companyId];
}

async function enqueueDueFollowUpsForCompany(companyId: string) {
  const now = new Date().toISOString();

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id, max_follow_ups")
    .eq("id", companyId)
    .maybeSingle();

  if (companyError) throw new Error(companyError.message);
  if (!company) throw new Error("company_not_found");

  const maxFollowUps =
    typeof company.max_follow_ups === "number" ? company.max_follow_ups : 3;

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, company_id, status, next_follow_up_at, follow_up_count, email, phone")
    .eq("company_id", companyId)
    .eq("status", "awaiting_customer")
    .lte("next_follow_up_at", now)
    .lt("follow_up_count", maxFollowUps)
    .not("next_follow_up_at", "is", null)
    .limit(50);

  if (error) throw new Error(error.message);

  const jobs = [];

  for (const lead of leads ?? []) {
    const hasContactMethod = Boolean(lead.email || lead.phone);

    if (!hasContactMethod) {
      jobs.push({
        leadId: lead.id,
        queued: false,
        skipped: true,
        reason: "missing_customer_contact_method",
      });
      continue;
    }

    const job = await enqueueBackgroundJob({
      name: "send_follow_up",
      jobId: `send_follow_up:${companyId}:${lead.id}:${lead.next_follow_up_at ?? now}`,
      data: {
        companyId,
        leadId: lead.id,
      } as any,
    });

    jobs.push({
      leadId: lead.id,
      jobId: job.id,
      queued: true,
    });
  }

  return {
    companyId,
    scanned: leads?.length ?? 0,
    queued: jobs.filter((job) => job.queued).length,
    skipped: jobs.filter((job) => job.skipped).length,
    jobs,
  };
}

async function handleRun(req: NextRequest) {
  try {
    const cronMode = isCronAuthorized(req);

    let companyIds: string[];

    if (cronMode) {
      const companyIdFromQuery = req.nextUrl.searchParams.get("companyId");

      companyIds = companyIdFromQuery
        ? [companyIdFromQuery]
        : await resolveCompanyIdsForCron();
    } else {
      const user = await getUser();
      companyIds = await resolveCompanyIdsForUser(user.id);
    }

    const results = [];

    for (const companyId of companyIds) {
      results.push(await enqueueDueFollowUpsForCompany(companyId));
    }

    return json({
      success: true,
      route: "/api/follow-ups/run",
      mode: cronMode ? "cron" : "authenticated_user",
      companiesProcessed: results.length,
      queued: results.reduce((sum, result) => sum + result.queued, 0),
      skipped: results.reduce((sum, result) => sum + result.skipped, 0),
      results,
    });
  } catch (err: any) {
    const message = err?.message ?? "followup_enqueue_failed";

    return json(
      {
        success: false,
        route: "/api/follow-ups/run",
        error: message,
      },
      message === "unauthorized"
        ? 401
        : message === "company_not_found" || message === "missing_company_id"
          ? 403
          : 500
    );
  }
}

export async function GET(req: NextRequest) {
  return handleRun(req);
}

export async function POST(req: NextRequest) {
  return handleRun(req);
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/follow-ups/run",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}