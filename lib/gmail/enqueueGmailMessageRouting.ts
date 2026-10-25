import { supabase } from "@/lib/supabase";

export async function enqueueGmailMessageRouting(params: {
  companyId: string;
  body: any;
  messageIds: string[];
}) {
  if (!params.companyId) throw new Error("missing_gmail_routing_company_id");
  const ids = [...new Set(params.messageIds)];
  if (ids.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) {
    throw new Error("invalid_gmail_routing_message_id");
  }
  for (let offset = 0; offset < ids.length; offset += 100) {
    const now = new Date().toISOString();
    const rows = ids.slice(offset, offset + 100).map((messageId) => ({
      id: `route_gmail_message:${params.companyId}:${messageId}`,
      name: "route_gmail_message",
      data: { companyId: params.companyId, body: params.body, messageId },
      status: "queued",
      attempts: 0,
      max_attempts: 5,
      priority: 25,
      run_at: now,
      updated_at: now,
    }));
    const { error } = await supabase.from("background_jobs").upsert(rows, {
      onConflict: "id", ignoreDuplicates: true,
    });
    if (error) throw new Error(error.message);

    // Check the durable rows, including conflicts, before acknowledging handoff.
    // Completed/running jobs retain their status during notification replay.
    const { data, error: readError } = await supabase.from("background_jobs")
      .select("id,name,data").in("id", rows.map((row) => row.id));
    if (readError) throw new Error(readError.message);
    const persisted = new Map<string, any>((data ?? []).map((row: any): [string, any] => [row.id, row]));
    for (const row of rows) {
      const existing: any = persisted.get(row.id);
      if (!existing || existing.name !== row.name ||
          existing.data?.companyId !== params.companyId ||
          existing.data?.messageId !== row.data.messageId) {
        throw new Error("gmail_routing_handoff_scope_or_persistence_mismatch");
      }
    }
  }
  return ids.length;
}
