import { supabase } from "@/lib/supabase";
export async function updateBackgroundJobHeartbeat(params: { jobId: string; workerId: string }) {
  const { data, error } = await supabase.rpc("leadflow_heartbeat_background_job", {
    p_job_id: params.jobId, p_worker_id: params.workerId,
  });
  if (error) console.error("[worker] heartbeat failed", { jobId: params.jobId, error: error.message });
  return !error && data === true;
}
