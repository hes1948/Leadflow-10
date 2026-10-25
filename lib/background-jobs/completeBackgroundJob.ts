import { supabase } from "@/lib/supabase";
import { recordJobEvent } from "./jobReliability";
export async function completeBackgroundJob(params: { jobId: string; workerId: string; result?: any }) {
  const { error } = await supabase.rpc("leadflow_finish_background_job", {
    p_job_id: params.jobId, p_worker_id: params.workerId, p_result: params.result ?? null,
  });
  if (error) throw new Error(error.message);
  await recordJobEvent({ jobId: params.jobId, eventType: "completed", metadata: { workerId: params.workerId } });
}
