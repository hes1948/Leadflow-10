// lib/supabase.ts

import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { executionContext } from "@/lib/background-jobs/executionContext";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

if (typeof window !== "undefined") throw new Error("server_supabase_client_in_browser");

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing backend SUPABASE_SERVICE_ROLE_KEY or Supabase URL");
}

// Node 20 does not always expose native WebSocket.
// Supabase Realtime needs this available globally when the worker starts.
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: async (input, init) => {
      const context = executionContext.getStore();
      if (context?.lost) throw new Error("worker_lease_lost");
      const headers = new Headers(init?.headers);
      if (context) {
        headers.set("x-leadflow-company", context.companyId);
        headers.set("x-leadflow-holder", context.holder);
      }
      return fetch(input, { ...init, headers });
    },
  },
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});