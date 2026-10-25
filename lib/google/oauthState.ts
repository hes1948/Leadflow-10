import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

function signingKey() {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("missing_env_GOOGLE_CLIENT_SECRET");
  return secret;
}
export function createGoogleConnectState(companyId: string) {
  const payload = Buffer.from(JSON.stringify({ companyId, expires: Date.now() + 15 * 60_000,
    nonce: randomUUID() })).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyGoogleConnectState(state: string | null, authenticatedCompanyId: string) {
  const parts = String(state ?? "").split(".");
  if (parts.length !== 2) throw new Error("invalid_google_oauth_state");
  const expected = createHmac("sha256", signingKey()).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("invalid_google_oauth_state");
  }
  const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (data.companyId !== authenticatedCompanyId || !Number.isFinite(data.expires)
    || data.expires < Date.now() || !data.nonce) throw new Error("google_oauth_company_scope_mismatch");
  return data.companyId as string;
}
