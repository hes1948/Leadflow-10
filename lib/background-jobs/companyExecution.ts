import { randomUUID } from "node:crypto";
import { supabase } from "@/lib/supabase";
import { executionContext, requireExecutionCompany } from "./executionContext";

export async function assertExecutionLease(companyId: string) {
  const context = requireExecutionCompany(companyId);
  if (!context) throw new Error("missing_company_execution_lease");
  const { data, error } = await supabase.rpc("leadflow_assert_company", {
    p_company_id: companyId, p_holder: context.holder,
  });
  if (error || data !== true) {
    context.lost = true;
    throw new Error("worker_lease_lost");
  }
}

export async function withCompanyExecution<T>(
  companyId: string, operationId: string, run: () => Promise<T>
): Promise<T> {
  if (requireExecutionCompany(companyId)) {
    await assertExecutionLease(companyId);
    return run();
  }
  const holder = `request_${randomUUID()}`;
  const { data, error } = await supabase.rpc("leadflow_acquire_company", {
    p_company_id: companyId, p_holder: holder,
  });
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("company_busy_retry_request");
  const context = { companyId, holder, operationId, lost: false };
  let heartbeatRunning = false;
  const timer = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const { data, error } = await supabase.rpc("leadflow_heartbeat_company", {
        p_company_id: companyId, p_holder: holder,
      });
      if (error || data !== true) context.lost = true;
    } catch { context.lost = true; }
    finally { heartbeatRunning = false; }
  }, 10_000);
  try { return await executionContext.run(context, run); }
  finally {
    clearInterval(timer);
    const { error } = await supabase.rpc("leadflow_release_company", {
      p_company_id: companyId, p_holder: holder,
    });
    if (error) console.error("[company-execution] release failed", { companyId, error: error.message });
  }
}
