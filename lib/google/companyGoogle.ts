// lib/google/companyGoogle.ts

import { google } from "googleapis";
import { createGoogleConnectState } from "@/lib/google/oauthState";
import { randomUUID } from "node:crypto";
import { withCompanyExecution } from "@/lib/background-jobs/companyExecution";
import { supabase } from "@/lib/supabase";
import { requireExecutionCompany } from "@/lib/background-jobs/executionContext";
import { durableGmailSend } from "@/lib/email/durableGmailSend";
import { assertExecutionLease } from "@/lib/background-jobs/companyExecution";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`missing_env_${name}`);
  }

  return value;
}

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function getGoogleRedirectUri() {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `${getBaseUrl()}/api/auth/callback`
  );
}

function normalizeEmail(value?: string | null) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeScope(value?: string | null) {
  const raw = String(value ?? "").trim();

  if (!raw) return GOOGLE_SCOPES.join(" ");

  const parts = new Set(
    raw
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
  );

  for (const scope of GOOGLE_SCOPES) {
    parts.add(scope);
  }

  return Array.from(parts).join(" ");
}

function isInvalidGrantError(err: any) {
  const message = String(err?.message ?? "").toLowerCase();
  const responseError = String(err?.response?.data?.error ?? "").toLowerCase();
  const responseDescription = String(
    err?.response?.data?.error_description ?? ""
  ).toLowerCase();

  return (
    message.includes("invalid_grant") ||
    responseError === "invalid_grant" ||
    responseDescription.includes("invalid_grant")
  );
}

function isGoogleAuthFailure(err: any) {
  const message = String(err?.message ?? err ?? "").toLowerCase();
  const responseError = String(err?.response?.data?.error ?? "").toLowerCase();

  return (
    isInvalidGrantError(err) ||
    responseError === "unauthorized_client" ||
    message.includes("invalid authentication credentials") ||
    message.includes("expected oauth 2 access token") ||
    message.includes("unauthorized_client") ||
    message.includes("google_reconnect_required")
  );
}

async function markGoogleConnectionBroken(companyId: string, err: any) {
  const message = String(
    err?.response?.data?.error_description ||
      err?.response?.data?.error ||
      err?.message ||
      "google_token_invalid"
  );

  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: false,
      access_token: null,
      updated_at: new Date().toISOString(),
      token_type: "RECONNECT_REQUIRED",
      scope: message.slice(0, 500),
    })
    .eq("company_id", companyId);

  if (error) {
    console.error("GOOGLE_CONNECTION_MARK_BROKEN_FAILED:", {
      companyId,
      error: error.message,
    });
  }
}

export function getGoogleOAuthClient() {
  return new google.auth.OAuth2(
    getRequiredEnv("GOOGLE_CLIENT_ID"),
    getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    getGoogleRedirectUri()
  );
}

export function getGoogleConnectUrl(companyId: string) {
  if (!companyId) throw new Error("missing_company_id");

  const oauth2Client = getGoogleOAuthClient();

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state: createGoogleConnectState(companyId),
  });
}

async function getExistingConnection(companyId: string) {
  const { data, error } = await supabase
    .from("google_connections")
    .select(
      `
      company_id,
      google_account_email,
      access_token,
      refresh_token,
      scope,
      token_type,
      expiry_date,
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

  return data;
}

export async function saveCompanyGoogleConnection(params: { companyId: string; code: string }) {
  return withCompanyExecution(params.companyId, `google-connect:${randomUUID()}`,
    () => saveCompanyGoogleConnectionUnlocked(params));
}

async function saveCompanyGoogleConnectionUnlocked(params: {
  companyId: string;
  code: string;
}) {
  if (!params.companyId) throw new Error("missing_company_id");
  if (!params.code) throw new Error("missing_google_code");

  const oauth2Client = getGoogleOAuthClient();
  const { tokens } = await oauth2Client.getToken(params.code);

  const existing = await getExistingConnection(params.companyId);

  const refreshToken = tokens.refresh_token ?? existing?.refresh_token ?? null;

  if (!refreshToken) {
    throw new Error("missing_google_refresh_token_reconnect_with_consent");
  }

  oauth2Client.setCredentials({
    access_token: tokens.access_token ?? existing?.access_token ?? undefined,
    refresh_token: refreshToken,
    expiry_date: tokens.expiry_date ?? existing?.expiry_date ?? undefined,
    token_type: tokens.token_type ?? existing?.token_type ?? "Bearer",
    scope: normalizeScope(tokens.scope ?? existing?.scope),
  });

  const oauth2 = google.oauth2({
    auth: oauth2Client,
    version: "v2",
  });

  const profile = await oauth2.userinfo.get();
  const googleAccountEmail = normalizeEmail(profile.data.email);

  if (!googleAccountEmail) {
    throw new Error("missing_google_account_email");
  }

  if (existing?.google_account_email && normalizeEmail(existing.google_account_email) !== googleAccountEmail && !tokens.refresh_token) {
    throw new Error("missing_new_account_refresh_token_reconnect_with_consent");
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("google_connections")
    .upsert(
      {
        company_id: params.companyId,
        google_account_email: googleAccountEmail,
        access_token: tokens.access_token ?? existing?.access_token ?? null,
        refresh_token: refreshToken,
        scope: normalizeScope(tokens.scope ?? existing?.scope),
        token_type: tokens.token_type ?? existing?.token_type ?? "Bearer",
        expiry_date: tokens.expiry_date ?? existing?.expiry_date ?? null,
        gmail_watch_active: false,
        gmail_ingestion_enabled: normalizeEmail(existing?.google_account_email) === googleAccountEmail
          ? (existing?.gmail_ingestion_enabled ?? true) : true,
        gmail_watch_history_id: normalizeEmail(existing?.google_account_email) === googleAccountEmail
          ? (existing?.gmail_watch_history_id ?? null) : null,
        gmail_watch_expiration: existing?.gmail_watch_expiration ?? null,
        gmail_watch_topic: existing?.gmail_watch_topic ?? null,
        updated_at: now,
      },
      {
        onConflict: "company_id",
      }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);

  const { error: companyUpdateError } = await supabase
    .from("companies")
    .update({
      email: googleAccountEmail,
      updated_at: now,
    })
    .eq("id", params.companyId);

  if (companyUpdateError) {
    console.error("COMPANY_GOOGLE_EMAIL_SYNC_FAILED:", {
      companyId: params.companyId,
      googleAccountEmail,
      error: companyUpdateError.message,
    });
  }

  return data;
}

export async function getCompanyGoogleAuth(companyId: string) {
  requireExecutionCompany(companyId);
  if (!companyId) throw new Error("missing_company_id");

  const { data, error } = await supabase
    .from("google_connections")
    .select("access_token, refresh_token, expiry_date, token_type, scope")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data?.refresh_token) {
    throw new Error("google_account_not_connected");
  }

  const oauth2Client = getGoogleOAuthClient();

  oauth2Client.setCredentials({
    access_token: data.access_token ?? undefined,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date ?? undefined,
    token_type: data.token_type ?? "Bearer",
    scope: normalizeScope(data.scope),
  });

  oauth2Client.on("tokens", async (tokens) => {
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (tokens.access_token) updates.access_token = tokens.access_token;
    if (tokens.expiry_date) updates.expiry_date = tokens.expiry_date;
    if (tokens.refresh_token) updates.refresh_token = tokens.refresh_token;
    if (tokens.scope) updates.scope = normalizeScope(tokens.scope);
    if (tokens.token_type) updates.token_type = tokens.token_type;

    const { error: updateError } = await supabase
      .from("google_connections")
      .update(updates)
      .eq("company_id", companyId);

    if (updateError) {
      console.error("GOOGLE_TOKEN_SAVE_FAILED:", {
        companyId,
        error: updateError.message,
      });
    }
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (err: any) {
    if (isGoogleAuthFailure(err)) {
      await markGoogleConnectionBroken(companyId, err);
      throw new Error("google_reconnect_required_invalid_grant");
    }

    throw err;
  }

  return oauth2Client;
}

export async function getCompanyCalendarClient(companyId: string) {
  const auth = await getCompanyGoogleAuth(companyId);

  const calendar = google.calendar({ version: "v3", auth });
  for (const method of ["insert", "update", "patch", "delete"] as const) {
    const original = (calendar.events[method] as any).bind(calendar.events);
    (calendar.events as any)[method] = async (request: any) => {
      await assertExecutionLease(companyId);
      return original(request, { retry: false, timeout: 20_000 });
    };
  }
  return calendar;
}

async function assertCompanyGmailIngestionOwner(companyId: string) {
  if (!companyId) throw new Error("missing_company_id");

  const { data: connection, error: connectionError } = await supabase
    .from("google_connections")
    .select("company_id, google_account_email, gmail_ingestion_enabled")
    .eq("company_id", companyId)
    .maybeSingle();

  if (connectionError) throw new Error(connectionError.message);
  if (!connection || connection.gmail_ingestion_enabled !== true) {
    throw new Error("gmail_ingestion_disabled");
  }

  const cleanEmail = normalizeEmail(connection.google_account_email);
  if (!cleanEmail) throw new Error("missing_google_connection_email");

  const { data: owners, error: ownerError } = await supabase
    .from("google_connections")
    .select("company_id")
    .ilike("google_account_email", cleanEmail.replace(/[\\%_]/g, "\\$&"))
    .eq("gmail_ingestion_enabled", true)
    .limit(2);

  if (ownerError) throw new Error(ownerError.message);
  if (!owners || owners.length !== 1 || owners[0].company_id !== companyId) {
    throw new Error("gmail_mailbox_owner_ambiguous");
  }
}

export async function getCompanyGmailClient(companyId: string) {
  // Guard every Gmail client acquisition, including replies from queued jobs.
  // Google Auth and Calendar clients keep their existing independent behavior.
  await assertCompanyGmailIngestionOwner(companyId);
  const auth = await getCompanyGoogleAuth(companyId);

  const gmail = google.gmail({ version: "v1", auth });
  const send = gmail.users.messages.send.bind(gmail.users.messages);
  (gmail.users.messages as any).send = (request: any) =>
    durableGmailSend(companyId, gmail, send as any, request);
  return gmail;
}