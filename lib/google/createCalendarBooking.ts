// lib/google/createCalendarBooking.ts

import { createHash, randomUUID } from "node:crypto";
import { withCompanyExecution } from "@/lib/background-jobs/companyExecution";
import { executionContext } from "@/lib/background-jobs/executionContext";
import { supabase } from "@/lib/supabase";
import { getCompanyCalendarClient } from "@/lib/google/companyGoogle";
import { requireCompany } from "@/lib/company/resolveCompany";
import {
  createBookingRequirementsError,
  hasExplicitSecondaryServiceLocator,
  isStructurallyCompleteServiceStreetAddress,
  resolveBookingRequirements,
} from "@/lib/booking/bookingRequirements";
import {
  checkAvailability,
  suggestAlternativeSlots,
} from "@/lib/availability/checkAvailability";
import {
  isWithinBusinessHours,
  suggestBusinessHourSlots,
} from "@/lib/businessHours/businessHours";

type CreateCalendarBookingInput = {
  companyId: string | null;
  leadId: string;
  startTime: string;
  endTime?: string | null;
  summary?: string;
  description?: string;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  location?: string | null;
  durationMinutes?: number | null;
  trustedSuggestedSlot?: boolean;
  skipAvailabilityCheck?: boolean;
  bypassAvailabilityCheck?: boolean;
  forceOfferedSlotBooking?: boolean;
  allowReschedule?: boolean;
  forceFreshEventIdentity?: boolean;
  bookingRequirementsVerifiedByCaller?: boolean;
};

function normalizeDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_datetime");
  return date.toISOString();
}

function addMinutes(dateIso: string, minutes: number) {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_datetime");
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function hasConfiguredBusinessHours(value: unknown) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function safePositiveMinutes(value: unknown, fallback: number) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  if (!Number.isInteger(minutes)) return fallback;
  if (minutes < 1) return fallback;
  if (minutes > 1440) return fallback;
  return minutes;
}

function googleCalendarLocalDateTime(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid_google_calendar_datetime");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const hour = get("hour") === "24" ? "00" : get("hour");

  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get(
    "minute"
  )}:${get("second")}`;
}

function clean(value?: string | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function deterministicCalendarEventId(companyId: string, leadId: string) {
  return createHash("sha256")
    .update(`${companyId}:${leadId}`)
    .digest("hex");
}

function isCalendarEventAlreadyExistsError(error: any) {
  const code = Number(error?.code ?? error?.response?.status ?? 0);
  const message = String(error?.message ?? "").toLowerCase();

  return (
    code === 409 ||
    message.includes("already exists") ||
    message.includes("duplicate")
  );
}

async function getCalendarEventById(params: {
  calendar: any;
  calendarEventId: string;
}) {
  const existing = await params.calendar.events.get({
    calendarId: "primary",
    eventId: params.calendarEventId,
  });

  if (!existing?.data?.id) {
    throw new Error("calendar_event_conflict_but_existing_event_missing");
  }

  return existing;
}

function assertFutureAppointment(startIso: string) {
  const startMs = new Date(startIso).getTime();
  if (!Number.isFinite(startMs)) throw new Error("invalid_start_time");
  if (startMs <= Date.now() - 60_000) {
    throw new Error("appointment_start_time_is_in_the_past");
  }
}

async function safeDeleteCalendarEvent(params: {
  calendar: any;
  calendarEventId?: string | null;
}) {
  if (!params.calendarEventId) return;

  try {
    await params.calendar.events.delete({
      calendarId: "primary",
      eventId: params.calendarEventId,
      sendUpdates: "none",
    });
  } catch (error: any) {
    console.error("[calendar-booking] rollback delete failed", {
      calendarEventId: params.calendarEventId,
      error: error?.message ?? error,
    });
  }
}

function calendarEventSnapshotRequestBody(eventData: any) {
  return {
    summary: eventData?.summary ?? undefined,
    description: eventData?.description ?? undefined,
    location: eventData?.location ?? undefined,
    start: eventData?.start ?? undefined,
    end: eventData?.end ?? undefined,
    attendees: Array.isArray(eventData?.attendees)
      ? eventData.attendees
      : undefined,
    extendedProperties: eventData?.extendedProperties ?? undefined,
  };
}

async function safeRestoreCalendarEvent(params: {
  calendar: any;
  calendarEventId: string;
  previousEventData: any;
}) {
  try {
    await params.calendar.events.update({
      calendarId: "primary",
      eventId: params.calendarEventId,
      sendUpdates: "all",
      requestBody: calendarEventSnapshotRequestBody(
        params.previousEventData
      ),
    });
  } catch (error: any) {
    console.error("[calendar-booking] reschedule rollback failed", {
      calendarEventId: params.calendarEventId,
      error: error?.message ?? error,
    });
  }
}

function assertCalendarEventMatchesRequestedSlot(params: {
  eventStart: string;
  eventEnd: string;
  requestedStart: string;
  requestedEnd: string;
}) {
  const toleranceMs = 60_000;

  const startDifference = Math.abs(
    new Date(params.eventStart).getTime() -
      new Date(params.requestedStart).getTime()
  );

  const endDifference = Math.abs(
    new Date(params.eventEnd).getTime() -
      new Date(params.requestedEnd).getTime()
  );

  if (startDifference > toleranceMs) {
    throw new Error("calendar_event_start_mismatch");
  }

  if (endDifference > toleranceMs) {
    throw new Error("calendar_event_end_mismatch");
  }
}


function slotTimesMatchWithinOneMinute(
  a?: string | null,
  b?: string | null
) {
  if (!a || !b) return false;

  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();

  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;

  return Math.abs(aMs - bMs) <= 60_000;
}

function assertCalendarEventOwnership(params: {
  event: any;
  companyId: string;
  leadId: string;
}) {
  const privateProperties =
    params.event?.data?.extendedProperties?.private ?? {};

  /*
    New LeadFlow events carry explicit ownership markers. Older legitimate
    events may predate one or more markers, so missing legacy metadata is not
    itself a failure. Any PRESENT marker that contradicts this company/lead is
    a hard failure.
  */
  if (
    (privateProperties.source &&
      privateProperties.source !== "leadflow") ||
    (privateProperties.companyId &&
      privateProperties.companyId !== params.companyId) ||
    (privateProperties.leadId &&
      privateProperties.leadId !== params.leadId)
  ) {
    throw new Error("calendar_event_ownership_mismatch");
  }
}

function getStrictCalendarEventTimes(event: any) {
  const rawStart = event?.data?.start?.dateTime;
  const rawEnd = event?.data?.end?.dateTime;

  if (!rawStart || !rawEnd) {
    throw new Error("calendar_event_missing_timed_boundaries");
  }

  return {
    start: normalizeDateTime(rawStart),
    end: normalizeDateTime(rawEnd),
  };
}

async function verifyPersistedCalendarBooking(params: {
  calendar: any;
  calendarEventId: string;
  companyId: string;
  leadId: string;
  requestedStart: string;
  requestedEnd?: string | null;
}) {
  const persistedEvent = await getCalendarEventById({
    calendar: params.calendar,
    calendarEventId: params.calendarEventId,
  });

  assertCalendarEventOwnership({
    event: persistedEvent,
    companyId: params.companyId,
    leadId: params.leadId,
  });

  const eventTimes = getStrictCalendarEventTimes(persistedEvent);

  if (
    !slotTimesMatchWithinOneMinute(
      eventTimes.start,
      params.requestedStart
    )
  ) {
    throw new Error("calendar_event_start_mismatch");
  }

  if (params.requestedEnd) {
    assertCalendarEventMatchesRequestedSlot({
      eventStart: eventTimes.start,
      eventEnd: eventTimes.end,
      requestedStart: params.requestedStart,
      requestedEnd: params.requestedEnd,
    });
  }

  return {
    event: persistedEvent,
    eventTimes,
  };
}

export async function createCalendarBooking(input: CreateCalendarBookingInput) {
  if (!input.companyId) throw new Error("missing_company_id");
  return withCompanyExecution(input.companyId, `calendar:${randomUUID()}`,
    () => createCalendarBookingUnlocked(input));
}

async function createCalendarBookingUnlocked({
  companyId,
  leadId,
  startTime,
  endTime,
  summary,
  description,
  attendeeEmail,
  attendeeName,
  location,
  durationMinutes,
  trustedSuggestedSlot,
  skipAvailabilityCheck,
  bypassAvailabilityCheck,
  forceOfferedSlotBooking,
  allowReschedule,
  forceFreshEventIdentity,
  bookingRequirementsVerifiedByCaller,
}: CreateCalendarBookingInput) {
  if (!companyId) throw new Error("missing_company_id");
  if (!leadId) throw new Error("missing_lead_id");
  if (!startTime) throw new Error("missing_start_time");

  const company: any = await requireCompany(companyId);
  const timezone = company.timezone || "America/Chicago";
  const companyBusinessHours = hasConfiguredBusinessHours(company.business_hours)
    ? company.business_hours
    : null;

  const defaultAppointmentMinutes = safePositiveMinutes(
    company.default_appointment_minutes,
    60
  );

  const normalizedStart = normalizeDateTime(startTime);

  let appointmentMinutes: number;
  let normalizedEnd: string;

  if (endTime) {
    normalizedEnd = normalizeDateTime(endTime);
    const durationMs =
      new Date(normalizedEnd).getTime() - new Date(normalizedStart).getTime();

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("invalid_appointment_end_time");
    }

    const explicitMinutes = durationMs / 60_000;
    if (!Number.isInteger(explicitMinutes) || explicitMinutes > 1440) {
      throw new Error("invalid_appointment_duration");
    }

    appointmentMinutes = explicitMinutes;
  } else {
    appointmentMinutes = safePositiveMinutes(
      durationMinutes,
      defaultAppointmentMinutes
    );
    normalizedEnd = addMinutes(normalizedStart, appointmentMinutes);
  }

  assertFutureAppointment(normalizedStart);

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(`
      id,
      company_id,
      email,
      phone,
      customer_name,
      type,
      issue_summary,
      address,
      city,
      state,
      zip,
      status,
      calendar_event_id,
      appointment_time,
      qualification
    `)
    .eq("id", leadId)
    .eq("company_id", company.id)
    .maybeSingle();

  if (leadError) throw new Error(leadError.message);
  if (!lead) throw new Error("lead_not_found_for_company");

  const hasExistingBookedEvent =
    lead.status === "booked" && Boolean(lead.calendar_event_id);

  /*
   * HARD NEW-BOOKING REQUIREMENTS FIREWALL.
   *
   * Availability may be shown without dispatch details, but NO new Google
   * Calendar appointment may be created until authoritative Lead state has a
   * contact name, callback phone, and service street address. Existing booked
   * appointments may still be moved/restored in place without re-demanding
   * information that should already have been collected.
   */
  if (!hasExistingBookedEvent) {
    const bookingRequirements = resolveBookingRequirements(lead);

    if (!bookingRequirements.complete) {
      const qualification =
        lead.qualification && typeof lead.qualification === "object"
          ? lead.qualification
          : {};
      const qualificationLocation =
        qualification.location && typeof qualification.location === "object"
          ? qualification.location
          : {};
      const dispatchConfirmed = Boolean(
        qualification.serviceAddressDispatchConfirmed === true ||
          qualificationLocation.serviceAddressDispatchConfirmed === true ||
          hasExplicitSecondaryServiceLocator(lead.address)
      );
      const structurallyValidAddress =
        isStructurallyCompleteServiceStreetAddress(lead.address, {
          city: lead.city,
          state: lead.state,
          zip: lead.zip,
        });
      const onlyServiceAddressDisagrees =
        bookingRequirements.missing.length === 1 &&
        bookingRequirements.missing[0] === "service_address";
      const callerVerifiedServiceAddressBridge = Boolean(
        bookingRequirementsVerifiedByCaller === true &&
          onlyServiceAddressDisagrees &&
          structurallyValidAddress &&
          dispatchConfirmed
      );

      console.warn("[calendar-booking] new-booking requirements disagreement", {
        leadId,
        missing: bookingRequirements.missing,
        bookingRequirementsVerifiedByCaller:
          bookingRequirementsVerifiedByCaller === true,
        structurallyValidAddress,
        dispatchConfirmed,
        callerVerifiedServiceAddressBridge,
      });

      /*
       * The inbound booking pipeline already owns the conversational requirement
       * gate. Preserve this lower Calendar firewall for every caller, and bridge
       * only the narrow case where that canonical caller has already verified
       * requirements AND authoritative Lead state proves that the sole remaining
       * disagreement is service-address dispatch completeness. Name/phone gaps,
       * malformed addresses, and unconfirmed bare addresses still fail closed.
       */
      if (!callerVerifiedServiceAddressBridge) {
        throw createBookingRequirementsError(bookingRequirements);
      }
    }
  }

  const reschedulingExistingBooking =
    hasExistingBookedEvent &&
    !slotTimesMatchWithinOneMinute(
      lead.appointment_time,
      normalizedStart
    );

  if (hasExistingBookedEvent && !reschedulingExistingBooking) {
    const calendar = await getCompanyCalendarClient(company.id);
    const verifiedExisting = await verifyPersistedCalendarBooking({
      calendar,
      calendarEventId: lead.calendar_event_id,
      companyId: company.id,
      leadId,
      requestedStart: normalizedStart,
      requestedEnd: null,
    });

    return {
      booked: true,
      alreadyBooked: true,
      rescheduled: false,
      companyId: company.id,
      leadId,
      calendarEventId: lead.calendar_event_id,
      appointmentTime: verifiedExisting.eventTimes.start,
      appointmentEndTime: verifiedExisting.eventTimes.end,
      defaultAppointmentMinutes,
      appointmentMinutes,
      availabilityChecked: false,
      businessHoursChecked: false,
      trustedExactOfferedSlot: false,
      googleCalendarMode: "company_connected_account",
      event: verifiedExisting.event.data,
    };
  }

  if (reschedulingExistingBooking && !allowReschedule) {
    throw new Error("lead_already_booked_at_different_time");
  }

  if (
    reschedulingExistingBooking &&
    (!lead.calendar_event_id || !lead.appointment_time)
  ) {
    throw new Error("booked_lead_missing_reschedule_truth");
  }

  if (lead.status === "booked" && !lead.calendar_event_id) {
    throw new Error("lead_marked_booked_without_calendar_event");
  }

  if (companyBusinessHours) {
    const businessHoursCheck = isWithinBusinessHours({
      startTime: normalizedStart,
      endTime: normalizedEnd,
      timezone,
      companyBusinessHours,
    });

    if (!businessHoursCheck.allowed) {
      const alternatives = await suggestBusinessHourSlots({
        requestedStartTime: normalizedStart,
        durationMinutes: appointmentMinutes,
        timezone,
        companyBusinessHours,
        count: 3,
      });

      const error: any = new Error("outside_business_hours");
      error.reason = businessHoursCheck.reason;
      error.requestedStartTime = normalizedStart;
      error.requestedEndTime = normalizedEnd;
      error.alternatives = alternatives;
      throw error;
    }
  }

  const trustedExactOfferedSlot = Boolean(
    trustedSuggestedSlot ||
      skipAvailabilityCheck ||
      bypassAvailabilityCheck ||
      forceOfferedSlotBooking
  );

  /*
    Re-check the exact slot against the same live Calendar availability policy
    used to generate suggestions. Offered-slot provenance never bypasses this.
  */
  const availability = await checkAvailability({
    companyId: company.id,
    startTime: normalizedStart,
    endTime: normalizedEnd,
    ignoreCalendarEventId: reschedulingExistingBooking
      ? lead.calendar_event_id
      : null,
  } as any);

  if (!availability.available) {
    const alternatives = await suggestAlternativeSlots({
      companyId: company.id,
      requestedStartTime: normalizedStart,
      durationMinutes: appointmentMinutes,
      timezone,
      ignoreCalendarEventId: reschedulingExistingBooking
        ? lead.calendar_event_id
        : null,
    } as any);

    const error: any = new Error(
      availability.reason === "outside_business_hours"
        ? "outside_business_hours"
        : "slot_unavailable"
    );
    error.requestedStartTime = normalizedStart;
    error.requestedEndTime = normalizedEnd;
    error.availability = availability;
    error.alternatives = alternatives;
    throw error;
  }

  const calendar = await getCompanyCalendarClient(company.id);

  const serviceLabel =
    lead.type === "hvac"
      ? "HVAC"
      : lead.type === "roofing"
        ? "Roofing"
        : lead.type === "plumbing"
          ? "Plumbing"
          : lead.type === "electrical"
            ? "Electrical"
            : "Service";

  const leadLocation = [lead.address, lead.city, lead.state, lead.zip]
    .filter(Boolean)
    .join(", ");

  const finalLocation = clean(location) || clean(leadLocation) || undefined;

  const eventSummary =
    clean(summary) ||
    `${serviceLabel} Appointment${
      lead.customer_name ? ` - ${lead.customer_name}` : ""
    }`;

  const eventDescription =
    clean(description) ||
    [
      `Company: ${company.name}`,
      lead.issue_summary ? `Issue: ${lead.issue_summary}` : null,
      lead.phone ? `Phone: ${lead.phone}` : null,
      lead.email ? `Email: ${lead.email}` : null,
      `Duration: ${appointmentMinutes} minutes`,
      `Lead ID: ${leadId}`,
    ]
      .filter(Boolean)
      .join("\n");

  const attendeeEmailFinal = clean(attendeeEmail) || clean(lead.email);

  const attendees = attendeeEmailFinal
    ? [
        {
          email: attendeeEmailFinal,
          displayName:
            clean(attendeeName) || clean(lead.customer_name) || undefined,
        },
      ]
    : undefined;

  const googleStartDateTime = googleCalendarLocalDateTime(
    normalizedStart,
    timezone
  );
  const googleEndDateTime = googleCalendarLocalDateTime(normalizedEnd, timezone);

  /*
    Normal bookings keep LeadFlow's deterministic event identity for strong
    idempotency. A cancellation restore is different: the prior deterministic
    event was deliberately deleted, and Google can retain that deleted event
    identity. In that one case the caller may require Google to generate a
    genuinely fresh event id instead of colliding with the deleted event.
  */
  const deterministicEventId = forceFreshEventIdentity
    ? createHash("sha256").update(`restore:${company.id}:${leadId}:${executionContext.getStore()!.operationId}`).digest("hex")
    : deterministicCalendarEventId(company.id, leadId);

  if (reschedulingExistingBooking) {
    const existingEvent = await getCalendarEventById({
      calendar,
      calendarEventId: lead.calendar_event_id,
    });

    assertCalendarEventOwnership({
      event: existingEvent,
      companyId: company.id,
      leadId,
    });

    const previousEventData = existingEvent.data;
    const previousAppointmentTime = normalizeDateTime(
      lead.appointment_time
    );
    const previousAppointmentEndTime =
      getStrictCalendarEventTimes(existingEvent).end;

    const updatedCalendarEvent = await calendar.events.update({
      calendarId: "primary",
      eventId: lead.calendar_event_id,
      sendUpdates: attendees ? "all" : "none",
      requestBody: {
        summary: eventSummary,
        description: eventDescription,
        location: finalLocation,
        start: {
          dateTime: googleStartDateTime,
          timeZone: timezone,
        },
        end: {
          dateTime: googleEndDateTime,
          timeZone: timezone,
        },
        attendees,
        extendedProperties: {
          private: {
            leadId,
            companyId: company.id,
            source: "leadflow",
            appointmentMinutes: String(appointmentMinutes),
          },
        },
      },
    });

    const rescheduledCalendarEventId = clean(
      updatedCalendarEvent?.data?.id
    );

    if (
      !rescheduledCalendarEventId ||
      rescheduledCalendarEventId !== lead.calendar_event_id
    ) {
      await safeRestoreCalendarEvent({
        calendar,
        calendarEventId: lead.calendar_event_id,
        previousEventData,
      });
      throw new Error("reschedule_calendar_event_identity_mismatch");
    }

    let verifiedRescheduled: {
      event: any;
      eventTimes: { start: string; end: string };
    };

    try {
      verifiedRescheduled = await verifyPersistedCalendarBooking({
        calendar,
        calendarEventId: lead.calendar_event_id,
        companyId: company.id,
        leadId,
        requestedStart: normalizedStart,
        requestedEnd: normalizedEnd,
      });
    } catch (error) {
      await safeRestoreCalendarEvent({
        calendar,
        calendarEventId: lead.calendar_event_id,
        previousEventData,
      });
      throw error;
    }

    const { data: rescheduledLead, error: rescheduleLeadError } =
      await supabase
        .from("leads")
        .update({
          status: "booked",
          appointment_time: normalizedStart,
          calendar_event_id: lead.calendar_event_id,
        })
        .eq("id", leadId)
        .eq("company_id", company.id)
        .eq("status", "booked")
        .eq("calendar_event_id", lead.calendar_event_id)
        .eq("appointment_time", lead.appointment_time)
        .select(
          "id, company_id, status, calendar_event_id, appointment_time"
        )
        .maybeSingle();

    if (rescheduleLeadError || !rescheduledLead) {
      await safeRestoreCalendarEvent({
        calendar,
        calendarEventId: lead.calendar_event_id,
        previousEventData,
      });

      if (rescheduleLeadError) {
        throw new Error(rescheduleLeadError.message);
      }

      throw new Error("reschedule_lead_compare_and_swap_failed");
    }

    if (
      rescheduledLead.status !== "booked" ||
      rescheduledLead.calendar_event_id !== lead.calendar_event_id ||
      !slotTimesMatchWithinOneMinute(
        rescheduledLead.appointment_time,
        normalizedStart
      )
    ) {
      await safeRestoreCalendarEvent({
        calendar,
        calendarEventId: lead.calendar_event_id,
        previousEventData,
      });
      throw new Error("reschedule_lead_truth_mismatch");
    }

    return {
      booked: true,
      alreadyBooked: false,
      rescheduled: true,
      previousAppointmentTime,
      previousAppointmentEndTime,
      companyId: company.id,
      leadId,
      calendarEventId: lead.calendar_event_id,
      appointmentTime: verifiedRescheduled.eventTimes.start,
      appointmentEndTime: verifiedRescheduled.eventTimes.end,
      defaultAppointmentMinutes,
      appointmentMinutes,
      availabilityChecked: true,
      businessHoursChecked: Boolean(companyBusinessHours),
      trustedExactOfferedSlot,
      googleCalendarMode: "company_connected_account",
      googleCalendarTimezone: timezone,
      googleCalendarStartDateTime: googleStartDateTime,
      googleCalendarEndDateTime: googleEndDateTime,
      event: verifiedRescheduled.event.data,
    };
  }

  let event: any;
  let calendarEventCreatedByThisCall = false;

  try {
    event = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: attendees ? "all" : "none",
      requestBody: {
        ...(deterministicEventId ? { id: deterministicEventId } : {}),
        summary: eventSummary,
        description: eventDescription,
        location: finalLocation,
        start: {
          dateTime: googleStartDateTime,
          timeZone: timezone,
        },
        end: {
          dateTime: googleEndDateTime,
          timeZone: timezone,
        },
        attendees,
        extendedProperties: {
          private: {
            leadId,
            companyId: company.id,
            source: "leadflow",
            appointmentMinutes: String(appointmentMinutes),
          },
        },
      },
    });

    calendarEventCreatedByThisCall = true;
  } catch (error: any) {
    if (!isCalendarEventAlreadyExistsError(error)) throw error;

    /*
      A fresh-identity booking never supplies an event id, so an "already
      exists" response cannot be safely interpreted as our idempotent event.
      Fail closed rather than reusing a deleted/stale Calendar identity.
    */
    if (!deterministicEventId) {
      throw new Error("fresh_calendar_event_identity_collision");
    }

    /*
      A deterministic-ID collision is idempotent only if the persisted event is
      this lead's event AND its actual start/end match this exact request.
      Different old/stale appointment data must never be reused as success.
    */
    event = await getCalendarEventById({
      calendar,
      calendarEventId: deterministicEventId,
    });
  }

  const calendarEventId = clean(event?.data?.id);
  if (!calendarEventId) throw new Error("calendar_event_missing_after_insert");

  let verifiedCalendar: {
    event: any;
    eventTimes: { start: string; end: string };
  };

  try {
    verifiedCalendar = await verifyPersistedCalendarBooking({
      calendar,
      calendarEventId,
      companyId: company.id,
      leadId,
      requestedStart: normalizedStart,
      requestedEnd: normalizedEnd,
    });
  } catch (error) {
    /*
      Delete only an event created by THIS call. A pre-existing mismatched event
      is preserved and treated as a hard consistency conflict; silently deleting
      someone else's canonical/historical event would be unsafe.
    */
    if (calendarEventCreatedByThisCall) {
      await safeDeleteCalendarEvent({ calendar, calendarEventId });
    }
    throw error;
  }

  event = verifiedCalendar.event;
  const eventTimes = verifiedCalendar.eventTimes;

  const { data: updatedLead, error: updateLeadError } = await supabase
    .from("leads")
    .update({
      status: "booked",
      appointment_time: normalizedStart,
      calendar_event_id: calendarEventId,
    })
    .eq("id", leadId)
    .eq("company_id", company.id)
    .neq("status", "booked")
    .is("calendar_event_id", null)
    .select("id, company_id, status, calendar_event_id, appointment_time")
    .maybeSingle();

  if (updateLeadError) {
    console.error("[calendar-booking] lead persistence failed after verified calendar event", {
      leadId,
      calendarEventId,
      requestedStartTime: normalizedStart,
      error: updateLeadError.message,
    });

    if (calendarEventCreatedByThisCall) {
      await safeDeleteCalendarEvent({ calendar, calendarEventId });
    }
    throw new Error(updateLeadError.message);
  }

  if (!updatedLead) {
    const { data: latestLead, error: latestLeadError } = await supabase
      .from("leads")
      .select("status, calendar_event_id, appointment_time")
      .eq("id", leadId)
      .eq("company_id", company.id)
      .maybeSingle();

    if (latestLeadError) {
      if (calendarEventCreatedByThisCall) {
        await safeDeleteCalendarEvent({ calendar, calendarEventId });
      }
      throw new Error(latestLeadError.message);
    }

    if (latestLead?.status === "booked" && latestLead.calendar_event_id) {
      if (
        calendarEventCreatedByThisCall &&
        latestLead.calendar_event_id !== calendarEventId
      ) {
        await safeDeleteCalendarEvent({ calendar, calendarEventId });
      }

      /*
        A concurrent winner is success only if database truth AND the actual
        persisted Calendar event both equal this request.
      */
      if (
        !slotTimesMatchWithinOneMinute(
          latestLead.appointment_time,
          normalizedStart
        )
      ) {
        throw new Error("concurrent_booking_won_with_different_time");
      }

      const verifiedConcurrent = await verifyPersistedCalendarBooking({
        calendar,
        calendarEventId: latestLead.calendar_event_id,
        companyId: company.id,
        leadId,
        requestedStart: normalizedStart,
        requestedEnd: normalizedEnd,
      });

      return {
        booked: true,
        alreadyBooked: true,
        companyId: company.id,
        leadId,
        calendarEventId: latestLead.calendar_event_id,
        appointmentTime: verifiedConcurrent.eventTimes.start,
        appointmentEndTime: verifiedConcurrent.eventTimes.end,
        defaultAppointmentMinutes,
        appointmentMinutes,
        availabilityChecked: true,
        businessHoursChecked: Boolean(companyBusinessHours),
        trustedExactOfferedSlot,
        googleCalendarMode: "company_connected_account",
        event: verifiedConcurrent.event.data,
      };
    }

    if (calendarEventCreatedByThisCall) {
      await safeDeleteCalendarEvent({ calendar, calendarEventId });
    }

    throw new Error("lead_update_scope_violation");
  }

  if (
    updatedLead.status !== "booked" ||
    !updatedLead.calendar_event_id ||
    !updatedLead.appointment_time
  ) {
    if (calendarEventCreatedByThisCall) {
      await safeDeleteCalendarEvent({ calendar, calendarEventId });
    }
    throw new Error("lead_booking_persistence_verification_failed");
  }

  if (
    updatedLead.calendar_event_id !== calendarEventId ||
    !slotTimesMatchWithinOneMinute(
      updatedLead.appointment_time,
      normalizedStart
    )
  ) {
    if (calendarEventCreatedByThisCall) {
      await safeDeleteCalendarEvent({ calendar, calendarEventId });
    }
    throw new Error("lead_booking_persistence_truth_mismatch");
  }

  return {
    booked: true,
    alreadyBooked: false,
    companyId: company.id,
    leadId,
    calendarEventId,
    appointmentTime: normalizedStart,
    appointmentEndTime: eventTimes.end,
    defaultAppointmentMinutes,
    appointmentMinutes,
    availabilityChecked: true,
    businessHoursChecked: Boolean(companyBusinessHours),
    trustedExactOfferedSlot,
    googleCalendarMode: "company_connected_account",
    googleCalendarTimezone: timezone,
    googleCalendarStartDateTime: googleStartDateTime,
    googleCalendarEndDateTime: googleEndDateTime,
    event: event.data,
  };
}