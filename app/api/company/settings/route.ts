// app/api/company/settings/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

const SETTINGS_SELECT = `
  id,
  name,
  email,
  phone,
  timezone,
  service_area,
  business_hours,
  dispatch_radius_miles,
  email_signature,
  primary_color,
  logo_url,
  default_appointment_minutes,
  follow_up_delay_hours,
  max_follow_ups
`;

function optionalString(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function requirePositiveNumber(
  value: unknown,
  field: string,
  options?: {
    integer?: boolean;
    min?: number;
    max?: number;
  }
) {
  const number = Number(value);
  const min = options?.min ?? 1;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;

  if (
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (options?.integer && !Number.isInteger(number))
  ) {
    throw new Error(`invalid_${field}`);
  }

  return number;
}

function buildSettingsUpdate(body: any) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_settings_payload");
  }

  const update: Record<string, unknown> = {};

  if ("name" in body) {
    const name = optionalString(body.name);

    if (!name) {
      throw new Error("invalid_name");
    }

    update.name = name;
  }

  if ("email" in body) {
    update.email = optionalString(body.email);
  }

  if ("phone" in body) {
    update.phone = optionalString(body.phone);
  }

  if ("timezone" in body) {
    const timezone = optionalString(body.timezone);

    if (!timezone) {
      throw new Error("invalid_timezone");
    }

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      throw new Error("invalid_timezone");
    }

    update.timezone = timezone;
  }

  if ("service_area" in body) {
    update.service_area = body.service_area ?? null;
  }

  if ("business_hours" in body) {
    update.business_hours = body.business_hours ?? null;
  }

  if ("dispatch_radius_miles" in body) {
    update.dispatch_radius_miles = requirePositiveNumber(
      body.dispatch_radius_miles,
      "dispatch_radius_miles",
      {
        min: 1,
        max: 1000,
      }
    );
  }

  if ("email_signature" in body) {
    update.email_signature = optionalString(body.email_signature);
  }

  if ("primary_color" in body) {
    update.primary_color = optionalString(body.primary_color);
  }

  if ("logo_url" in body) {
    update.logo_url = optionalString(body.logo_url);
  }

  if ("default_appointment_minutes" in body) {
    update.default_appointment_minutes = requirePositiveNumber(
      body.default_appointment_minutes,
      "default_appointment_minutes",
      {
        integer: true,
        min: 1,
        max: 1440,
      }
    );
  }

  if ("follow_up_delay_hours" in body) {
    update.follow_up_delay_hours = requirePositiveNumber(
      body.follow_up_delay_hours,
      "follow_up_delay_hours",
      {
        min: 1,
        max: 8760,
      }
    );
  }

  if ("max_follow_ups" in body) {
    update.max_follow_ups = requirePositiveNumber(
      body.max_follow_ups,
      "max_follow_ups",
      {
        integer: true,
        min: 1,
        max: 100,
      }
    );
  }

  if (Object.keys(update).length === 0) {
    throw new Error("no_settings_to_update");
  }

  return update;
}

function statusForError(message: string) {
  if (message === "unauthorized") return 401;
  if (message === "company_not_found") return 404;

  if (
    message === "invalid_settings_payload" ||
    message === "no_settings_to_update" ||
    message.startsWith("invalid_")
  ) {
    return 400;
  }

  return 500;
}

export async function GET() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    const { data, error } = await supabase
      .from("companies")
      .select(SETTINGS_SELECT)
      .eq("id", companyId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("company_not_found");

    return NextResponse.json(
      {
        success: true,
        settings: data,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (err: any) {
    const message = err?.message ?? "settings_fetch_failed";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status: statusForError(message),
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    const body = await req.json();
    const update = buildSettingsUpdate(body);

    const { data, error } = await supabase
      .from("companies")
      .update(update)
      .eq("id", companyId)
      .select(SETTINGS_SELECT)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("company_not_found");

    return NextResponse.json(
      {
        success: true,
        settings: data,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (err: any) {
    const message = err?.message ?? "settings_update_failed";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status: statusForError(message),
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  }
}
