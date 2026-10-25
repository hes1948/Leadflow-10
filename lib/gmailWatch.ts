// lib/gmailWatch.ts

import { supabase } from "@/lib/supabase";
import { randomUUID } from "node:crypto";
import { withCompanyExecution } from "@/lib/background-jobs/companyExecution";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";

const WATCH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

type GmailConnectionRow = {
  company_id: string;
  google_account_email: string | null;
  refresh_token: string | null;
  gmail_watch_active: boolean | null;
  gmail_ingestion_enabled: boolean;
  gmail_watch_history_id: string | null;
  gmail_watch_expiration: number | string | null;
  gmail_watch_topic: string | null;
};

type GmailWatchRenewalRow = Pick<
  GmailConnectionRow,
  | "company_id"
  | "gmail_watch_active"
  | "gmail_watch_expiration"
  | "refresh_token"
>;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
}

function getTopicName(): string {
  const projectId = requireEnv("GOOGLE_CLOUD_PROJECT_ID");
  const topic = process.env.GMAIL_PUBSUB_TOPIC_NAME || "gmail-inbound-leadflow";

  if (topic.startsWith("projects/")) {
    return topic;
  }

  return `projects/${projectId}/topics/${topic}`;
}

function normalizeExpiration(value: unknown) {
  const expiration = Number(value ?? 0);
  return Number.isFinite(expiration) && expiration > 0 ? expiration : null;
}

function isWatchFresh(params: {
  active?: boolean | null;
  expiration?: number | string | null;
  renewBeforeMs?: number;
}) {
  if (!params.active) return false;

  const expiration = normalizeExpiration(params.expiration);
  if (!expiration) return false;

  const renewBeforeMs = Math.max(
    60_000,
    Number(params.renewBeforeMs ?? WATCH_RENEW_BEFORE_MS)
  );

  return expiration > Date.now() + renewBeforeMs;
}

async function getConnection(companyId: string): Promise<GmailConnectionRow> {
  const { data, error } = await supabase
    .from("google_connections")
    .select(
      `
      company_id,
      google_account_email,
      refresh_token,
      gmail_watch_active,
      gmail_ingestion_enabled,
      gmail_watch_history_id,
      gmail_watch_expiration,
      gmail_watch_topic
    `
    )
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data?.refresh_token) throw new Error("google_account_not_connected");

  return data as GmailConnectionRow;
}

async function markWatchInactive(companyId: string, reason: string) {
  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: false,
      scope: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);

  if (error) {
    console.error("[gmail-watch] failed to mark inactive", {
      companyId,
      reason,
      error: error.message,
    });
  }
}

export async function startGmailInboxWatch(companyId: string, options: { resetHistory?: boolean } = {}) {
  return withCompanyExecution(companyId, `gmail-watch:${randomUUID()}`,
    () => startGmailInboxWatchUnlocked(companyId, options));
}

async function startGmailInboxWatchUnlocked(companyId: string, options: { resetHistory?: boolean }) {
  if (!companyId) {
    throw new Error("missing_company_id");
  }

  const connection = await getConnection(companyId);
  if (connection.gmail_ingestion_enabled !== true) {
    throw new Error("gmail_ingestion_disabled");
  }
  const gmail = await getCompanyGmailClient(companyId);
  const topicName = getTopicName();

  let response: any;

  try {
    response = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
  } catch (error: any) {
    await markWatchInactive(
      companyId,
      error?.message ?? "gmail_watch_start_failed"
    );
    throw error;
  }

  const historyId = response.data.historyId ?? null;
  const expiration = normalizeExpiration(response.data.expiration);

  if (!historyId) {
    await markWatchInactive(companyId, "gmail_watch_missing_history_id");
    throw new Error("gmail_watch_missing_history_id");
  }

  if (!expiration) {
    await markWatchInactive(companyId, "gmail_watch_missing_expiration");
    throw new Error("gmail_watch_missing_expiration");
  }

  const now = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: true,
      gmail_watch_history_id: options.resetHistory ? historyId : (connection.gmail_watch_history_id ?? historyId),
      gmail_watch_expiration: expiration,
      gmail_watch_topic: topicName,
      token_type: "Bearer",
      scope: "WATCH_ACTIVE",
      updated_at: now,
    })
    .eq("company_id", companyId)
    .select(
      "company_id, google_account_email, gmail_watch_history_id, gmail_watch_expiration, gmail_watch_topic"
    )
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!updated) {
    throw new Error("gmail_watch_database_update_failed");
  }

  return {
    success: true,
    companyId,
    googleAccountEmail: connection.google_account_email ?? null,
    topicName,
    historyId,
    expiration,
    renewedAt: now,
    raw: response.data,
  };
}

export async function ensureGmailInboxWatchFresh(
  companyId: string,
  renewBeforeMs = WATCH_RENEW_BEFORE_MS
) {
  if (!companyId) throw new Error("missing_company_id");

  const connection = await getConnection(companyId);
  if (connection.gmail_ingestion_enabled !== true) {
    return {
      success: true,
      companyId,
      renewed: false,
      skipped: true,
      reason: "gmail_ingestion_disabled",
    };
  }

  if (
    isWatchFresh({
      active: connection.gmail_watch_active,
      expiration: connection.gmail_watch_expiration,
      renewBeforeMs,
    })
  ) {
    return {
      success: true,
      companyId,
      renewed: false,
      reason: "watch_still_fresh",
      historyId: connection.gmail_watch_history_id ?? null,
      expiration: normalizeExpiration(connection.gmail_watch_expiration),
      topicName: connection.gmail_watch_topic ?? null,
    };
  }

  const result = await startGmailInboxWatch(companyId);

  return {
    ...result,
    renewed: true,
    reason: connection.gmail_watch_active
      ? "watch_expired_or_near_expiration"
      : "watch_inactive",
  };
}

export async function renewAllGmailInboxWatches() {
  const { data, error } = await supabase
    .from("google_connections")
    .select(
      "company_id, gmail_watch_active, gmail_watch_expiration, refresh_token"
    )
    .eq("gmail_ingestion_enabled", true)
    .not("refresh_token", "is", null)
    .limit(500);

  if (error) throw new Error(error.message);

  const connections = (data ?? []) as GmailWatchRenewalRow[];
  const results: any[] = [];

  for (const connection of connections) {
    const companyId = String(connection.company_id ?? "").trim();

    if (!companyId) {
      results.push({
        companyId: null,
        success: false,
        renewed: false,
        error: "missing_company_id",
      });
      continue;
    }

    try {
      const result = await ensureGmailInboxWatchFresh(companyId);

      results.push({
        ...result,
        companyId,
        success: true,
      });
    } catch (error: any) {
      results.push({
        companyId,
        success: false,
        renewed: false,
        error: error?.message ?? "gmail_watch_renewal_failed",
      });
    }
  }

  return {
    success: results.every((item) => item.success),
    checked: results.length,
    renewed: results.filter((item) => item.renewed).length,
    failed: results.filter((item) => !item.success).length,
    results,
  };
}
