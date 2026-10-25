// components/dashboard/LeadPipeline.tsx

type LeadPipelineProps = {
  leads: {
    id: string;
    status?: string;
    appointment_time?: string | null;
    calendar_event_id?: string | null;
    response_time_seconds?: number | null;
  }[];
};

function hasValue(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRealBookedLead(lead: LeadPipelineProps["leads"][number]) {
  return (
    lead.status === "booked" &&
    (hasValue(lead.appointment_time) || hasValue(lead.calendar_event_id))
  );
}

function getDisplayStatus(lead: LeadPipelineProps["leads"][number]) {
  if (isRealBookedLead(lead)) return "booked";
  if (lead.status === "booked") return "awaiting_customer";
  if (lead.status === "sent") return "contacted";
  return lead.status || "new";
}

function countStatus(leads: LeadPipelineProps["leads"], statuses: string[]) {
  return leads.filter((lead) => statuses.includes(getDisplayStatus(lead))).length;
}

function getAverageResponseTime(leads: LeadPipelineProps["leads"]) {
  const responseTimes = leads
    .map((lead) => lead.response_time_seconds)
    .filter((value): value is number => typeof value === "number");

  if (responseTimes.length === 0) return null;

  return Math.round(
    responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
  );
}

function formatSeconds(seconds: number | null) {
  if (seconds === null) return "—";

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}

export default function LeadPipeline({ leads }: LeadPipelineProps) {
  const newCount = countStatus(leads, ["new"]);
  const awaitingCount = countStatus(leads, ["awaiting_customer"]);
  const contactedCount = countStatus(leads, ["contacted", "sent"]);
  const bookedCount = leads.filter(isRealBookedLead).length;
  const blockedCount = countStatus(leads, [
    "outside_service_area",
    "duplicate",
    "spam",
  ]);

  const averageResponseTime = getAverageResponseTime(leads);

  return (
    <div className="grid gap-4 md:grid-cols-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">New Leads</p>
        <p className="mt-2 text-3xl font-black text-slate-950">{newCount}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Awaiting Customer</p>
        <p className="mt-2 text-3xl font-black text-slate-950">
          {awaitingCount}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Contacted</p>
        <p className="mt-2 text-3xl font-black text-slate-950">
          {contactedCount}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Booked Jobs</p>
        <p className="mt-2 text-3xl font-black text-slate-950">{bookedCount}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Blocked</p>
        <p className="mt-2 text-3xl font-black text-slate-950">
          {blockedCount}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm font-bold text-slate-500">Avg Response</p>
        <p className="mt-2 text-3xl font-black text-slate-950">
          {formatSeconds(averageResponseTime)}
        </p>
      </div>
    </div>
  );
}