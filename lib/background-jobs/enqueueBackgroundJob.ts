// lib/background-jobs/enqueueBackgroundJob.ts

import { supabase } from "@/lib/supabase";
import {
  DEFAULT_MAX_ATTEMPTS,
  nowIso,
  recordJobEvent,
} from "@/lib/background-jobs/jobReliability";

type EnqueueBackgroundJobInput<TData = any> = {
  name: string;
  jobId: string;
  data: TData;
  priority?: number;
  maxAttempts?: number;
  runAt?: string;
};

async function getExistingJob(jobId: string) {
  const { data, error } = await supabase
    .from("background_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

export async function enqueueBackgroundJob<TData = any>(
  input: EnqueueBackgroundJobInput<TData>
) {
  if (!input.name) throw new Error("missing_job_name");
  if (!input.jobId) throw new Error("missing_job_id");

  const companyId = String((input.data as any)?.companyId ?? "").trim();
  if (!companyId) throw new Error("missing_job_company_id");
  const now = nowIso();

  const payload = {
    id: input.jobId,
    name: input.name,
    status: "queued",
    data: input.data ?? {},
    attempts: 0,
    max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    priority: input.priority ?? 100,
    run_at: input.runAt ?? now,
    updated_at: now,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("background_jobs")
    .insert(payload)
    .select("*")
    .maybeSingle();

  if (insertError) {
    const isDuplicate =
      String((insertError as any)?.code ?? "") === "23505" ||
      String(insertError.message ?? "").toLowerCase().includes("duplicate");

    if (!isDuplicate) {
      throw new Error(insertError.message);
    }

    const existing = await getExistingJob(input.jobId);

    if (!existing) {
      throw new Error("background_job_duplicate_but_missing");
    }

    if (existing.data?.companyId !== companyId || existing.name !== input.name) {
      throw new Error("background_job_company_scope_mismatch");
    }
    await recordJobEvent({
      jobId: input.jobId,
      eventType: "deduplicated",
      message: "Duplicate enqueue request returned the existing background job.",
      metadata: {
        name: input.name,
        existingStatus: existing.status ?? null,
      },
    });

    return existing;
  }

  if (!inserted) {
    const existing = await getExistingJob(input.jobId);

    if (existing) {
      if (existing.data?.companyId !== companyId || existing.name !== input.name) {
        throw new Error("background_job_company_scope_mismatch");
      }
      return existing;
    }

    throw new Error("background_job_insert_returned_no_row");
  }

  await recordJobEvent({
    jobId: input.jobId,
    eventType: "queued",
    message: "Background job queued.",
    metadata: {
      name: input.name,
      priority: payload.priority,
      maxAttempts: payload.max_attempts,
    },
  });

  return inserted;
}
