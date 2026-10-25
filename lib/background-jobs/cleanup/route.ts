// app/api/background-jobs/cleanup/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { recoverStaleJobs } from "@/lib/background-jobs/jobReliability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function json(payload: Record<string, any>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function POST() {
  try {
    const staleRecovery = await recoverStaleJobs();

    const oldCompletedBefore = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { error: cleanupError } = await supabase
      .from("background_jobs")
      .delete()
      .eq("status", "completed")
      .lt("completed_at", oldCompletedBefore);

    if (cleanupError) throw new Error(cleanupError.message);

    return json({
      success: true,
      route: "/api/background-jobs/cleanup",
      mode: "phase_1_queue_cleanup",
      staleRecovery,
      completedCleanupBefore: oldCompletedBefore,
    });
  } catch (err: any) {
    return json(
      {
        success: false,
        route: "/api/background-jobs/cleanup",
        error: err?.message ?? "background_job_cleanup_failed",
      },
      500
    );
  }
}

export async function GET() {
  return POST();
}