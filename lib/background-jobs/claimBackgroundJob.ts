import { supabase } from "@/lib/supabase";
import type { BackgroundJob } from "./backgroundJobTypes";
import { recordJobEvent } from "./jobReliability";
export async function claimBackgroundJob(workerId: string) {
  const { data, error } = await supabase.rpc("leadflow_claim_background_job", { p_worker_id: workerId });
  if (error) throw new Error(error.message);
  const claimed = (Array.isArray(data) ? data[0] : data) as BackgroundJob | undefined;
  if (!claimed) return null;
  await recordJobEvent({ jobId: claimed.id, eventType: "claimed", metadata: { workerId } });
  return claimed;
}
