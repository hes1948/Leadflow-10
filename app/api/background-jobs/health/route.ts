// app/api/background-jobs/health/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function json(payload: Record<string, any>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

async function countJobs(status: string, companyId: string) {
  const { count, error } = await supabase
    .from("background_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", status)
    .eq("data->>companyId", companyId);

  if (error) throw new Error(error.message);

  return count ?? 0;
}

export async function GET() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);
    const [queued, running, retrying, completed, failed, deadLetter] =
      await Promise.all([
        countJobs("queued", companyId),
        countJobs("running", companyId),
        countJobs("retrying", companyId),
        countJobs("completed", companyId),
        countJobs("failed", companyId),
        countJobs("dead_letter", companyId),
      ]);

    return json({
      success: true,
      route: "/api/background-jobs/health",
      mode: "phase_1_reliability_foundation",
      counts: {
        queued,
        running,
        retrying,
        completed,
        failed,
        dead_letter: deadLetter,
      },
      healthy: deadLetter === 0,
    });
  } catch (error: any) {
    return json(
      {
        success: false,
        route: "/api/background-jobs/health",
        error: error?.message ?? "background_job_health_failed",
      },
      error?.message === "unauthorized" ? 401 : 500
    );
  }
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}
