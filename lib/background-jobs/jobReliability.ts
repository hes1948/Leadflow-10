// lib/background-jobs/jobReliability.ts

import { supabase } from "@/lib/supabase";

export const WORKER_LEASE_SECONDS = 120;
export const WORKER_HEARTBEAT_SECONDS = 10;
export const STALE_JOB_SECONDS = 90;
export const DEFAULT_MAX_ATTEMPTS = 5;

export function createWorkerId() {
  return `worker_${process.pid}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function secondsFromNowIso(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function calculateRetryDelaySeconds(attempts: number) {
  const safeAttempts = Math.max(1, attempts);
  const base = Math.min(300, 5 * 2 ** (safeAttempts - 1));
  const jitter = Math.floor(Math.random() * 5);
  return base + jitter;
}

export function normalizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return "unknown_error";
  }
}

export async function recordJobEvent(params: {
  jobId: string;
  eventType: string;
  message?: string | null;
  metadata?: Record<string, any>;
}) {
  const { error } = await supabase.from("background_job_events").insert({
    job_id: params.jobId,
    event_type: params.eventType,
    message: params.message ?? null,
    metadata: params.metadata ?? {},
  });

  if (error) {
    console.error("[background-job-event] failed", {
      jobId: params.jobId,
      eventType: params.eventType,
      error: error.message,
    });
  }
}

export async function recoverStaleJobs() {
  const { data, error } = await supabase.rpc("leadflow_recover_background_jobs");
  if (error) throw new Error(error.message);
  return { recovered: Number(data ?? 0) };
}
