// lib/location/resolveUsZip.ts

import zipcodes from "zipcodes-us";

export type ResolvedUsZip = {
  zip: string;
  city: string;
  state: string;
};

function normalizeZip(value?: string | null): string | null {
  const raw = String(value ?? "").trim();

  const match = raw.match(/\b(\d{5})(?:-\d{4})?\b/);

  return match?.[1] ?? null;
}

function cleanText(value?: unknown): string | null {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
}

/**
 * Resolves a US ZIP code against the local nationwide ZIP dataset supplied by
 * zipcodes-us.
 *
 * Properties:
 * - no network request
 * - no city/state hardcoding
 * - no ZIP-prefix guessing
 * - no AI geography inference
 * - invalid or unknown ZIPs return null
 *
 * The package's documented API is zipcodes.find(zip).
 */
export function resolveUsZip(
  value?: string | null
): ResolvedUsZip | null {
  const zip = normalizeZip(value);

  if (!zip) {
    return null;
  }

  try {
    const result = zipcodes.find(zip);

    if (!result?.isValid) {
      return null;
    }

    const city = cleanText(result.city);
    const state = cleanText(result.stateCode)?.toUpperCase() ?? null;

    if (!city || !state) {
      return null;
    }

    return {
      zip,
      city,
      state,
    };
  } catch (error) {
    console.error("[zip-resolution] lookup failed", {
      zip,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });

    return null;
  }
}
