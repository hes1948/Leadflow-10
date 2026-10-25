// lib/inbound/handleUnavailableSlot.ts

import { google } from "googleapis";
import { supabase } from "@/lib/supabase";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";

type LeadLike = {
  id: string;
  company_id: string;
  email: string | null;
  customer_name?: string | null;
  qualification?: Record<string, any> | null;
};

type HandleUnavailableSlotParams = {
  companyId: string;
  lead: LeadLike;
  requestedStartTime: string;
  requestedEndTime: string;
  customerReply: string;
  providerThreadId?: string | null;
  companyTimezone: string;
};

type BusySlot = {
  start?: string | null;
  end?: string | null;
};

type SuggestedSlot = {
  startTime: string;
  endTime: string;
};

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function formatLocalTime(iso: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function overlapsBusy(candidateStart: Date, candidateEnd: Date, busy: BusySlot[]) {
  return busy.some((item) => {
    if (!item.start || !item.end) return false;

    const busyStart = new Date(item.start);
    const busyEnd = new Date(item.end);

    return candidateStart < busyEnd && candidateEnd > busyStart;
  });
}

function getGoogleAuthFromService(service: any) {
  return (
    service?.context?._options?.auth ??
    service?._options?.auth ??
    service?.options?.auth ??
    null
  );
}

async function getCompanyCalendarClient(companyId: string) {
  const gmail = await getCompanyGmailClient(companyId);
  const auth = getGoogleAuthFromService(gmail);

  if (!auth) {
    throw new Error("google_calendar_auth_missing");
  }

  return google.calendar({
    version: "v3",
    auth,
  });
}

async function findNearestAvailableSlot(params: {
  companyId: string;
  requestedStartTime: string;
  requestedEndTime: string;
  companyTimezone: string;
}): Promise<SuggestedSlot> {
  const calendar = await getCompanyCalendarClient(params.companyId);

  const requestedStart = new Date(params.requestedStartTime);
  const requestedEnd = new Date(params.requestedEndTime);

  if (Number.isNaN(requestedStart.getTime())) {
    throw new Error("invalid_requested_start_time");
  }

  if (Number.isNaN(requestedEnd.getTime())) {
    throw new Error("invalid_requested_end_time");
  }

  const durationMinutes = Math.max(
    30,
    Math.round((requestedEnd.getTime() - requestedStart.getTime()) / 60_000)
  );

  const searchStart = addMinutes(requestedStart, 15);
  const searchEnd = addMinutes(requestedStart, 60 * 24 * 7);

  const freeBusy = await calendar.freebusy.query({
    requestBody: {
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString(),
      timeZone: params.companyTimezone,
      items: [{ id: "primary" }],
    },
  });

  const busy = freeBusy.data.calendars?.primary?.busy ?? [];

  for (let minutesAfter = 15; minutesAfter <= 60 * 24 * 7; minutesAfter += 15) {
    const candidateStart = addMinutes(requestedStart, minutesAfter);
    const candidateEnd = addMinutes(candidateStart, durationMinutes);

    const localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: params.companyTimezone,
        hour: "numeric",
        hour12: false,
      }).format(candidateStart)
    );

    if (localHour < 8 || localHour >= 18) continue;

    if (!overlapsBusy(candidateStart, candidateEnd, busy)) {
      return {
        startTime: candidateStart.toISOString(),
        endTime: candidateEnd.toISOString(),
      };
    }
  }

  throw new Error("no_nearby_available_slot_found");
}

function buildRawEmail(params: {
  to: string;
  subject: string;
  body: string;
}) {
  const raw = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\r\n");

  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sendGmailPlainEmail(params: {
  companyId: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
}) {
  const gmail = await getCompanyGmailClient(params.companyId);

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: buildRawEmail({
        to: params.to,
        subject: params.subject,
        body: params.body,
      }),
      threadId: params.threadId ?? undefined,
    },
  });

  return response.data;
}

export async function handleUnavailableSlot(params: HandleUnavailableSlotParams) {
  if (!params.lead.id) throw new Error("missing_lead_id");
  if (!params.lead.email) throw new Error("missing_customer_email");

  const suggestion = await findNearestAvailableSlot({
    companyId: params.companyId,
    requestedStartTime: params.requestedStartTime,
    requestedEndTime: params.requestedEndTime,
    companyTimezone: params.companyTimezone,
  });

  const requestedLabel = formatLocalTime(
    params.requestedStartTime,
    params.companyTimezone
  );

  const suggestedLabel = formatLocalTime(
    suggestion.startTime,
    params.companyTimezone
  );

  const customerName = params.lead.customer_name
    ? params.lead.customer_name
    : "there";

  const body = `Hi ${customerName},

That requested time is not available:

${requestedLabel}

The nearest available appointment we have is:

${suggestedLabel}

Reply "yes" or "that works" and we’ll book it for you.

— Texas Test HVAC
Fast AC Repair Across Texas
210-555-0000`;

  const sent = await sendGmailPlainEmail({
    companyId: params.companyId,
    to: params.lead.email,
    subject: "Re: Your HVAC Request",
    body,
    threadId: params.providerThreadId ?? null,
  });

  const nextQualification = {
    ...(params.lead.qualification ?? {}),
    pendingSlotSuggestion: {
      status: "awaiting_customer_confirmation",
      originalRequestedStartTime: params.requestedStartTime,
      originalRequestedEndTime: params.requestedEndTime,
      suggestedStartTime: suggestion.startTime,
      suggestedEndTime: suggestion.endTime,
      customerReply: params.customerReply,
      suggestedAt: new Date().toISOString(),
    },
  };

  const { error } = await supabase
    .from("leads")
    .update({
      status: "awaiting_customer",
      qualification: nextQualification,
      last_email_subject: "Re: Your HVAC Request",
      last_email_to: params.lead.email,
      last_email_from: "thebrickberet@gmail.com",
      last_contacted_at: new Date().toISOString(),
    })
    .eq("id", params.lead.id)
    .eq("company_id", params.companyId);

  if (error) throw new Error(error.message);

  return {
    success: true,
    booked: false,
    suggested: true,
    reason: "requested_slot_unavailable_suggestion_sent",
    requestedStartTime: params.requestedStartTime,
    requestedEndTime: params.requestedEndTime,
    suggestedStartTime: suggestion.startTime,
    suggestedEndTime: suggestion.endTime,
    outboundEmailId: sent.id ?? null,
  };
}