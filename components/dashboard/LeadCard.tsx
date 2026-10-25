// components/dashboard/LeadCard.tsx

type LeadCardProps = {
  lead: {
    id: string;
    input?: string;
    message?: string;

    status?: string;
    priority?: string;
    type?: string;

    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;

    preferred_time?: string | null;

    created_at?: string;
    appointment_time?: string | null;
    calendar_event_id?: string | null;
    sent_at?: string | null;

    booking_truth?: {
      booked?: boolean;
      status?: string | null;
      hasAppointmentTime?: boolean;
      hasCalendarEventId?: boolean;
    };
  };

  active?: boolean;
  onClick?: () => void;
};

function hasValue(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRealBookingProof(lead: LeadCardProps["lead"]) {
  return (
    lead.status === "booked" &&
    (hasValue(lead.appointment_time) || hasValue(lead.calendar_event_id))
  );
}

function getDisplayStatus(lead: LeadCardProps["lead"]) {
  if (hasRealBookingProof(lead)) return "booked";

  if (lead.status === "booked") {
    return "awaiting_customer";
  }

  return lead.status || "new";
}

function statusClass(status: string) {
  if (status === "booked" || status === "completed") {
    return "bg-emerald-50 text-emerald-700";
  }

  if (
    status === "contacted" ||
    status === "sent" ||
    status === "awaiting_customer"
  ) {
    return "bg-blue-50 text-blue-700";
  }

  if (
    status === "outside_service_area" ||
    status === "spam" ||
    status === "duplicate"
  ) {
    return "bg-red-50 text-red-700";
  }

  if (status === "closed") {
    return "bg-slate-900 text-white";
  }

  return "bg-slate-100 text-slate-700";
}

function priorityClass(priority: string) {
  if (priority === "high" || priority === "emergency") {
    return "bg-amber-50 text-amber-700";
  }

  return "bg-slate-100 text-slate-700";
}

function formatServiceArea(lead: LeadCardProps["lead"]) {
  const parts = [];

  if (lead.city) parts.push(lead.city);
  if (lead.state) parts.push(lead.state);

  const cityState = parts.join(", ");

  if (cityState && lead.zip) return `${cityState} ${lead.zip}`;
  if (cityState) return cityState;
  if (lead.zip) return lead.zip;
  if (lead.address) return lead.address;

  return "Not captured";
}

function formatRequestedTime(value?: string | null) {
  if (!value) return "Not captured";
  return value.toUpperCase();
}

function getActionLabel(lead: LeadCardProps["lead"]) {
  const status = getDisplayStatus(lead);

  if (status === "booked") return "Appointment booked";
  if (status === "completed") return "Job completed";
  if (status === "awaiting_customer") return "Waiting on customer";
  if (status === "contacted" || status === "sent") return "Reply sent";
  if (status === "outside_service_area") return "Outside service area";
  if (status === "duplicate") return "Duplicate lead";
  if (status === "spam") return "Spam blocked";
  if (status === "closed") return "Closed";

  return "Needs action";
}

export default function LeadCard({
  lead,
  active = false,
  onClick,
}: LeadCardProps) {
  const message = lead.input || lead.message || "No message";
  const status = getDisplayStatus(lead);
  const priority = lead.priority || "normal";
  const type = lead.type || "lead";

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border p-4 text-left transition ${
        active
          ? "border-slate-950 bg-slate-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-400 hover:shadow-sm"
      }`}
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${priorityClass(
            priority
          )}`}
        >
          {priority}
        </span>

        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${statusClass(
            status
          )}`}
        >
          {status.replaceAll("_", " ")}
        </span>

        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold uppercase text-slate-700">
          {type}
        </span>
      </div>

      <p className="line-clamp-3 text-sm leading-6 text-slate-800">
        {message}
      </p>

      <div className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">
            Service Area
          </p>

          <p className="mt-1 text-sm font-bold text-slate-900">
            {formatServiceArea(lead)}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">
              Priority
            </p>

            <p className="mt-1 text-sm font-bold uppercase text-slate-900">
              {priority}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">
              Requested
            </p>

            <p className="mt-1 text-sm font-bold text-slate-900">
              {formatRequestedTime(lead.preferred_time)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs font-semibold capitalize text-slate-500">
        <span>{getActionLabel(lead)}</span>
      </div>
    </button>
  );
}