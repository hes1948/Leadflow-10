// Saved connection state only; this does not make a live Google API health claim.
export function connectionReadiness(row: {
  refresh_token?: string | null; token_type?: string | null;
  gmail_watch_active?: boolean | null; gmail_watch_expiration?: string | number | null;
  gmail_ingestion_enabled?: boolean | null;
} | null, now = Date.now()) {
  const reconnectRequired = row?.token_type === "RECONNECT_REQUIRED";
  const connected = Boolean(row?.refresh_token) && !reconnectRequired;
  const expiration = Number(row?.gmail_watch_expiration);
  const gmailWatchUnexpired = Number.isFinite(expiration) && expiration > now;
  const gmailIngestionEnabled = row?.gmail_ingestion_enabled === true;
  return {
    connected, reconnectRequired, gmailWatchUnexpired, gmailIngestionEnabled,
    ready: connected && row?.gmail_watch_active === true && gmailWatchUnexpired && gmailIngestionEnabled,
  };
}
