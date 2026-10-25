import { createHash } from "node:crypto";
import { stampAutomatedReply } from "@/lib/email/automationIdentity";
import { supabase } from "@/lib/supabase";
import { requireExecutionCompany } from "@/lib/background-jobs/executionContext";
import { assertExecutionLease } from "@/lib/background-jobs/companyExecution";

function originalSentBody(raw: string) {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const boundary = /\r?\n\r?\n/.exec(message);
  if (!boundary || boundary.index === undefined) throw new Error("invalid_stored_email");
  const headers = message.slice(0, boundary.index);
  const body = message.slice(boundary.index + boundary[0].length);
  return /^Content-Transfer-Encoding:\s*base64\s*$/im.test(headers)
    ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8") : body;
}

// Gmail does not offer an atomic send idempotency key. Persist the attempt
// BEFORE sending and reconcile uncertain outcomes without blindly resending.
export async function durableGmailSend(
  companyId: string, gmail: any, send: (request: any, options: any) => Promise<any>, request: any
) {
  const context = requireExecutionCompany(companyId);
  if (!context) throw new Error("missing_company_execution_lease");
  await assertExecutionLease(companyId);
  const operationId = createHash("sha256")
    .update(`${companyId}:${context.operationId}:customer-email`).digest("hex");
  const rfcMessageId = `<${operationId}@leadflow.invalid>`;
  const message = Buffer.from(String(request?.requestBody?.raw ?? ""), "base64url").toString("utf8");
  const split = message.search(/\r?\n\r?\n/);
  if (split < 0) throw new Error("invalid_gmail_raw_message");
  const recipient = /^To:\s*(.+)$/im.exec(message.slice(0, split))?.[1]?.trim().toLowerCase();
  if (!recipient) throw new Error("missing_gmail_recipient");
  const raw = stampAutomatedReply(String(request.requestBody.raw), rfcMessageId);
  const requestBody = { ...request.requestBody, raw };
  const { data: inserted, error: insertError } = await supabase.from("leadflow_email_deliveries")
    .insert({ operation_id: operationId, company_id: companyId, rfc_message_id: rfcMessageId,
      recipient, request_body: requestBody }).select("*").maybeSingle();
  if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
  let delivery = inserted;
  if (!delivery) {
    const { data, error } = await supabase.from("leadflow_email_deliveries").select("*")
      .eq("operation_id", operationId).eq("company_id", companyId).maybeSingle();
    if (error) throw new Error(error.message);
    delivery = data;
  }
  if (!delivery || delivery.recipient !== recipient) throw new Error("email_delivery_scope_conflict");
  const storedBody = originalSentBody(delivery.request_body.raw);
  if (delivery.status === "sent") return { data: delivery.provider_result, leadflowBody: storedBody };
  if (delivery.status !== "reserved") {
    const found = await gmail.users.messages.list({ userId: "me",
      q: `in:sent rfc822msgid:${rfcMessageId.slice(1, -1)}`, maxResults: 2 });
    const matches = found.data.messages ?? [];
    if (matches.length !== 1) throw new Error("email_delivery_reconciliation_required");
    const result = { id: matches[0].id, threadId: matches[0].threadId };
    const { error } = await supabase.from("leadflow_email_deliveries")
      .update({ status: "sent", provider_result: result, updated_at: new Date().toISOString() })
      .eq("operation_id", operationId).eq("company_id", companyId);
    if (error) throw new Error(error.message);
    return { data: result, leadflowBody: storedBody };
  }
  await assertExecutionLease(companyId);
  const { data: claimed, error: claimError } = await supabase.from("leadflow_email_deliveries")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("operation_id", operationId).eq("company_id", companyId).eq("status", "reserved")
    .select("operation_id").maybeSingle();
  if (claimError) throw new Error(claimError.message);
  if (!claimed) throw new Error("email_delivery_already_claimed");
  try {
    await assertExecutionLease(companyId);
    const sent = await send({ ...request, userId: "me", requestBody: {
      ...delivery.request_body,
      raw: stampAutomatedReply(delivery.request_body.raw, rfcMessageId),
    } },
      { retry: false, timeout: 20_000 });
    if (!sent?.data?.id) throw new Error("gmail_send_missing_message_id");
    const { error } = await supabase.from("leadflow_email_deliveries")
      .update({ status: "sent", provider_result: { id: sent.data.id, threadId: sent.data.threadId },
        updated_at: new Date().toISOString() }).eq("operation_id", operationId).eq("company_id", companyId);
    if (error) throw new Error(error.message);
    return { ...sent, leadflowBody: storedBody };
  } catch (error: any) {
    const status = Number(error?.response?.status ?? error?.status ?? error?.code);
    const definitelyRejected = [400, 401, 403, 404, 413, 429].includes(status);
    await supabase.from("leadflow_email_deliveries")
      .update({ status: definitelyRejected ? "reserved" : "uncertain", updated_at: new Date().toISOString() })
      .eq("operation_id", operationId).eq("company_id", companyId).eq("status", "sending");
    throw error;
  }
}
