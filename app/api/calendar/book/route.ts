// app/api/calendar/book/route.ts

import { NextResponse } from "next/server";
import { createCalendarBooking } from "@/lib/google/createCalendarBooking";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

function optionalString(value: unknown) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function optionalPositiveDuration(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const duration = Number(value);

  if (
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 1440
  ) {
    throw new Error("invalid_duration_minutes");
  }

  return duration;
}

function statusForError(message: string) {
  if (message === "unauthorized") return 401;
  if (message === "company_busy_retry_request") return 409;

  if (
    message === "company_not_found" ||
    message === "missing_company_id" ||
    message === "google_account_not_connected"
  ) {
    return 403;
  }

  if (
    message === "invalid_booking_payload" ||
    message === "missing_lead_id" ||
    message === "missing_start_time" ||
    message === "invalid_duration_minutes" ||
    message === "invalid_datetime" ||
    message === "invalid_start_time" ||
    message === "appointment_start_time_is_in_the_past" ||
    message === "lead_not_found_for_company" ||
    message === "company_id_must_come_from_authenticated_session"
  ) {
    return 400;
  }

  if (
    message === "slot_unavailable" ||
    message === "outside_business_hours"
  ) {
    return 409;
  }

  return 500;
}

export async function POST(req: Request) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      throw new Error("missing_company_id");
    }

    const body = await req.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("invalid_booking_payload");
    }

    if ("companyId" in body || "company_id" in body) {
      throw new Error("company_id_must_come_from_authenticated_session");
    }

    if (!body.leadId || typeof body.leadId !== "string") {
      throw new Error("missing_lead_id");
    }

    const leadId = body.leadId.trim();

    if (!leadId) {
      throw new Error("missing_lead_id");
    }

    if (!body.startTime || typeof body.startTime !== "string") {
      throw new Error("missing_start_time");
    }

    const startTime = body.startTime.trim();

    if (!startTime) {
      throw new Error("missing_start_time");
    }

    const durationMinutes = optionalPositiveDuration(body.durationMinutes);

    const result = await createCalendarBooking({
      companyId,
      leadId,
      startTime,
      durationMinutes,
      summary: optionalString(body.summary) ?? undefined,
      description: optionalString(body.description) ?? undefined,
      attendeeEmail: optionalString(body.attendeeEmail),
      attendeeName: optionalString(body.attendeeName),
      location: optionalString(body.location),
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    const message = err?.message ?? "calendar_booking_failed";

    const response: Record<string, unknown> = {
      success: false,
      error: message,
    };

    if (err?.reason !== undefined) {
      response.reason = err.reason;
    }

    if (err?.requestedStartTime !== undefined) {
      response.requestedStartTime = err.requestedStartTime;
    }

    if (err?.requestedEndTime !== undefined) {
      response.requestedEndTime = err.requestedEndTime;
    }

    if (err?.alternatives !== undefined) {
      response.alternatives = err.alternatives;
    }

    if (err?.availability !== undefined) {
      response.availability = err.availability;
    }

    return NextResponse.json(response, {
      status: statusForError(message),
    });
  }
}
