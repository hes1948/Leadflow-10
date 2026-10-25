import { supabase } from "@/lib/supabase";
import { normalizeError, recordJobEvent } from "./jobReliability";
import type { BackgroundJob } from "./backgroundJobTypes";
export async function failBackgroundJob(params: { job: BackgroundJob; workerId: string; error: unknown }) {
  const errorMessage = normalizeError(params.error);
  const terminal = ["gmail_ingestion_disabled", "execution_company_scope_mismatch",
    "background_job_company_scope_mismatch"].includes(errorMessage);
  const { data, error } = await supabase.rpc("leadflow_finish_background_job", {
    p_job_id: params.job.id, p_worker_id: params.workerId, p_error: errorMessage, p_terminal: terminal,
  });
  if (error) throw new Error(error.message);
  await recordJobEvent({ jobId: params.job.id, eventType: data.status, message: errorMessage,
    metadata: { workerId: params.workerId, attempts: data.attempts } });
  return data;
}
