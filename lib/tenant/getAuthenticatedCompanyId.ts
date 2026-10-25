// lib/tenant/getAuthenticatedCompanyId.ts

import { supabase } from "@/lib/supabase";

export async function getAuthenticatedCompanyId(userId: string) {
  if (!userId) {
    throw new Error("missing_user_id");
  }

  const { data, error } = await supabase
    .from("company_users")
    .select("company_id, role, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("GET_AUTHENTICATED_COMPANY_ID_ERROR:", {
      userId,
      error: error.message,
    });

    throw new Error(error.message);
  }

  if (!data?.company_id) {
    throw new Error("company_not_found");
  }

  return data.company_id as string;
}
