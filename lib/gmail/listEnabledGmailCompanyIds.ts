// Enumerate every enabled mailbox in bounded, stable pages. A connection added
// behind the cursor is picked up by the next maintenance cycle.
export async function* listEnabledGmailCompanyIds(db: {
  from: (table: string) => any;
}): AsyncGenerator<string> {
  const pageSize = 500;
  let after: string | null = null;

  while (true) {
    let query = db.from("google_connections")
      .select("company_id")
      .eq("gmail_ingestion_enabled", true)
      .not("refresh_token", "is", null)
      .order("company_id", { ascending: true })
      .limit(pageSize);
    if (after !== null) query = query.gt("company_id", after);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("gmail_maintenance_invalid_page");
    if (data.length === 0) return;

    for (const row of data) {
      const companyId = row?.company_id;
      if (typeof companyId !== "string" || !companyId.trim()) {
        throw new Error("gmail_maintenance_missing_company_id");
      }
      if (after !== null && companyId <= after) {
        throw new Error("gmail_maintenance_cursor_did_not_advance");
      }
      after = companyId;
      yield companyId;
    }
    // Continue until an empty page: Supabase may cap rows below pageSize.
  }
}
