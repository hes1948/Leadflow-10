import { createClient } from "@supabase/supabase-js";

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const service =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !service) {
  throw new Error("Missing Supabase admin env vars");
}

export const supabaseAdmin = createClient(url, service);