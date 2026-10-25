import { AsyncLocalStorage } from "node:async_hooks";

export type ExecutionContext = {
  companyId: string;
  holder: string;
  operationId: string;
  lost: boolean;
};
export const executionContext = new AsyncLocalStorage<ExecutionContext>();

export function requireExecutionCompany(companyId: string) {
  const context = executionContext.getStore();
  if (context && (context.companyId !== companyId || context.lost)) {
    throw new Error(context.lost ? "worker_lease_lost" : "execution_company_scope_mismatch");
  }
  return context;
}
