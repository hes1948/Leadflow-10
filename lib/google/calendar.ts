// lib/google/calendar.ts

import { google } from "googleapis";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
}

export function getGoogleCalendarClient() {
  const auth = new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    requireEnv("GOOGLE_REDIRECT_URI")
  );

  auth.setCredentials({
    refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN"),
  });

  return google.calendar({
    version: "v3",
    auth,
  });
}