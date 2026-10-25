// components/dashboard/BookingPanel.tsx

"use client";

import { useEffect, useMemo, useState } from "react";

type BookingPanelProps = {
  leadId?: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  defaultAppointmentMinutes?: number | null;
  onBooked?: () => void;
};

const STANDARD_DURATIONS = [30, 60, 90, 120];

function toIsoFromLocal(datetimeLocal: string) {
  const date = new Date(datetimeLocal);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function normalizeDurationNumber(value: unknown, fallback = 60) {
  const duration = Number(value);

  if (
    !Number.isFinite(duration) ||
    !Number.isInteger(duration) ||
    duration <= 0
  ) {
    return fallback;
  }

  return duration;
}

function formatDuration(minutes: number) {
  if (minutes === 60) return "1 hour";
  if (minutes === 90) return "1.5 hours";
  if (minutes === 120) return "2 hours";

  if (minutes < 60) {
    return `${minutes} minutes`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;

    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  return `${minutes} minutes`;
}

export default function BookingPanel({
  leadId,
  customerName,
  customerEmail,
  customerPhone,
  defaultAppointmentMinutes,
  onBooked,
}: BookingPanelProps) {
  const initialDefault =
    defaultAppointmentMinutes != null
      ? normalizeDurationNumber(defaultAppointmentMinutes)
      : null;

  const [scheduledAt, setScheduledAt] = useState("");
  const [companyDefaultMinutes, setCompanyDefaultMinutes] = useState<
    number | null
  >(initialDefault);
  const [durationMinutes, setDurationMinutes] = useState(
    String(initialDefault ?? 60)
  );
  const [defaultDurationLoaded, setDefaultDurationLoaded] = useState(
    initialDefault != null
  );

  const [notes, setNotes] = useState("");
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBookedEventId, setLastBookedEventId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (defaultAppointmentMinutes != null) {
      const normalized = normalizeDurationNumber(defaultAppointmentMinutes);

      setCompanyDefaultMinutes(normalized);
      setDurationMinutes(String(normalized));
      setDefaultDurationLoaded(true);

      return;
    }

    let cancelled = false;

    async function loadCompanySettings() {
      try {
        setDefaultDurationLoaded(false);

        const res = await fetch("/api/company/settings", {
          cache: "no-store",
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || "settings_load_failed");
        }

        const normalized = normalizeDurationNumber(
          data.settings?.default_appointment_minutes
        );

        if (!cancelled) {
          setCompanyDefaultMinutes(normalized);
          setDurationMinutes(String(normalized));
        }
      } catch (err) {
        console.error("Failed to load booking settings:", err);
      } finally {
        if (!cancelled) {
          setDefaultDurationLoaded(true);
        }
      }
    }

    loadCompanySettings();

    return () => {
      cancelled = true;
    };
  }, [defaultAppointmentMinutes]);

  const durationOptions = useMemo(() => {
    const values = new Set<number>(STANDARD_DURATIONS);

    if (companyDefaultMinutes != null) {
      values.add(companyDefaultMinutes);
    }

    const selectedDuration = Number(durationMinutes);

    if (
      Number.isFinite(selectedDuration) &&
      Number.isInteger(selectedDuration) &&
      selectedDuration > 0
    ) {
      values.add(selectedDuration);
    }

    return Array.from(values).sort((a, b) => a - b);
  }, [companyDefaultMinutes, durationMinutes]);

  async function bookJob() {
    if (!leadId || !scheduledAt) return;

    setBooking(true);
    setError(null);
    setLastBookedEventId(null);

    try {
      const startTime = toIsoFromLocal(scheduledAt);

      if (!startTime) {
        throw new Error("Invalid appointment time");
      }

      const duration = Number(durationMinutes);

      if (
        !Number.isFinite(duration) ||
        !Number.isInteger(duration) ||
        duration <= 0
      ) {
        throw new Error("Invalid duration");
      }

      const res = await fetch("/api/calendar/book", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          leadId,
          startTime,
          durationMinutes: duration,
          summary: customerName
            ? `HVAC Appointment - ${customerName}`
            : "HVAC Appointment",
          description:
            notes ||
            [
              "Booked from BookMoreJobs dashboard.",
              `Duration: ${duration} minutes`,
              customerPhone ? `Customer phone: ${customerPhone}` : null,
              customerEmail ? `Customer email: ${customerEmail}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          attendeeEmail: customerEmail ?? null,
          attendeeName: customerName ?? null,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "calendar_booking_failed");
      }

      setLastBookedEventId(data.calendarEventId ?? null);
      setScheduledAt("");
      setNotes("");
      onBooked?.();
    } catch (err: any) {
      console.error("Calendar booking failed:", err);
      setError(err?.message ?? "Booking failed");
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <h4 className="text-sm font-black text-slate-950">
        Book Google Calendar Job
      </h4>

      <p className="mt-1 text-sm text-slate-500">
        Create a real calendar appointment once the customer confirms a time.
      </p>

      <div className="mt-4 space-y-3">
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-4 py-2 text-sm outline-none focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
        />

        <select
          value={durationMinutes}
          onChange={(e) => setDurationMinutes(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-4 py-2 text-sm outline-none focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
        >
          {durationOptions.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {formatDuration(minutes)}
              {companyDefaultMinutes === minutes ? " (company default)" : ""}
            </option>
          ))}
        </select>

        <p className="text-xs font-semibold text-slate-500">
          {defaultDurationLoaded
            ? companyDefaultMinutes != null
              ? `Default company duration: ${companyDefaultMinutes} minutes`
              : "Company default duration unavailable"
            : "Loading company booking settings..."}
        </p>

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes for the technician..."
          className="min-h-[85px] w-full resize-none rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-slate-950 focus:ring-2 focus:ring-slate-200"
        />

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {error}
          </div>
        ) : null}

        {lastBookedEventId ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
            Calendar event created: {lastBookedEventId}
          </div>
        ) : null}

        <button
          onClick={bookJob}
          disabled={!leadId || !scheduledAt || booking}
          className="w-full rounded-xl bg-slate-950 px-4 py-2 text-sm font-bold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {booking
            ? "Creating Calendar Event..."
            : "Book Job in Google Calendar"}
        </button>
      </div>
    </div>
  );
}

