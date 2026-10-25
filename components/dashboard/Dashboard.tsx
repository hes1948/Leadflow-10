"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

const supabase = createSupabaseBrowserClient();
import LeadCard from "@/components/dashboard/LeadCard";
import LeadPipeline from "@/components/dashboard/LeadPipeline";
import BookingPanel from "@/components/dashboard/BookingPanel";
import {
  calculateLeadValue,
  formatRevenue,
} from "@/lib/revenue/calculateLeadValue";

type LeadStatus =
  | "new"
  | "contacted"
  | "awaiting_customer"
  | "booked"
  | "completed"
  | "outside_service_area"
  | "spam"
  | "duplicate"
  | "closed"
  | "sent";

type BookingTruth = {
  booked?: boolean;
  status?: string | null;
  hasAppointmentTime?: boolean;
  hasCalendarEventId?: boolean;
};

type LeadItem = {
  id: string;
  input?: string;
  message?: string;
  reply?: string;
  type?: string;
  priority?: string;
  status?: LeadStatus;
  created_at?: string;
  updated_at?: string | null;
  customer_name?: string | null;
  preferred_time?: string | null;
  issue_summary?: string | null;
  source?: string | null;
  qualification?: any;
  appointment_time?: string | null;
  calendar_event_id?: string | null;
  sent_at?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  service_area?: string | null;
  first_response_at?: string | null;
  response_time_seconds?: number | null;
  follow_up_count?: number | null;
  booking_truth?: BookingTruth;
};

type CompanySettings = {
  id?: string;
  name?: string;
  default_appointment_minutes?: number | null;
};

function hasValue(value?: string | null) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStatus(status?: string | null): LeadStatus {
  if (status === "sent") return "contacted";

  if (
    status === "new" ||
    status === "contacted" ||
    status === "awaiting_customer" ||
    status === "booked" ||
    status === "completed" ||
    status === "outside_service_area" ||
    status === "spam" ||
    status === "duplicate" ||
    status === "closed"
  ) {
    return status;
  }

  return "new";
}

function hasBookingTruth(lead?: LeadItem | null) {
  return typeof lead?.booking_truth?.booked === "boolean";
}

function isRealBookedLead(lead?: LeadItem | null) {
  if (!lead) return false;

  if (hasBookingTruth(lead)) {
    return lead.booking_truth?.booked === true;
  }

  return (
    lead.status === "booked" &&
    (hasValue(lead.appointment_time) || hasValue(lead.calendar_event_id))
  );
}

function getDisplayStatus(lead?: LeadItem | null): LeadStatus {
  if (!lead) return "new";

  if (isRealBookedLead(lead)) return "booked";

  if (hasBookingTruth(lead) && lead.booking_truth?.booked === false) {
    if (lead.status === "booked") return "awaiting_customer";
    return normalizeStatus(lead.status);
  }

  if (lead.status === "booked") return "awaiting_customer";

  return normalizeStatus(lead.status);
}

function statusLabel(status?: LeadStatus) {
  return (status || "new").replaceAll("_", " ");
}

function formatServiceArea(lead?: LeadItem | null) {
  if (!lead) return "Not captured";

  if (lead.service_area) return lead.service_area;

  const cityState = [lead.city, lead.state].filter(Boolean).join(", ");
  if (cityState && lead.zip) return `${cityState} ${lead.zip}`;
  if (cityState) return cityState;
  if (lead.zip) return lead.zip;

  return "Not captured";
}

function formatSeconds(value: number) {
  if (!value || value <= 0) return "Instant";
  if (value < 60) return `${value}s`;

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;

  return `${minutes}m ${seconds}s`;
}

function isThisWeek(dateValue?: string) {
  if (!dateValue) return false;

  const created = new Date(
    dateValue.endsWith("Z") || dateValue.includes("+")
      ? dateValue
      : `${dateValue}Z`,
  );

  if (Number.isNaN(created.getTime())) return false;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return created >= sevenDaysAgo;
}

function leadSortTime(lead: LeadItem) {
  const raw = lead.updated_at || lead.created_at || "1970-01-01T00:00:00.000Z";
  const time = new Date(raw).getTime();

  return Number.isNaN(time) ? 0 : time;
}

function normalizeLead(lead: LeadItem): LeadItem {
  const qualification = lead.qualification ?? {};
  const backendTruth =
    lead.booking_truth && typeof lead.booking_truth === "object"
      ? lead.booking_truth
      : null;

  const city = Object.prototype.hasOwnProperty.call(lead, "city")
    ? lead.city ?? null
    : qualification.city ?? qualification.location?.city ?? null;

  const state = Object.prototype.hasOwnProperty.call(lead, "state")
    ? lead.state ?? null
    : qualification.state ?? qualification.location?.state ?? null;

  const zip = Object.prototype.hasOwnProperty.call(lead, "zip")
    ? lead.zip ?? null
    : qualification.zip ?? qualification.location?.zip ?? null;

  const appointmentTime = hasValue(lead.appointment_time)
    ? lead.appointment_time
    : null;

  const calendarEventId = hasValue(lead.calendar_event_id)
    ? lead.calendar_event_id
    : null;

  const rawLead: LeadItem = {
    ...lead,
    appointment_time: appointmentTime,
    calendar_event_id: calendarEventId,
    customer_name: lead.customer_name ?? qualification.customerName ?? null,
    email: lead.email ?? qualification.email ?? null,
    phone: lead.phone ?? qualification.phone ?? null,
    address:
      lead.address ??
      qualification.address ??
      qualification.location?.address ??
      null,
    city,
    state,
    zip,
    service_area: Object.prototype.hasOwnProperty.call(lead, "service_area")
      ? lead.service_area ?? null
      : qualification.serviceArea ??
        (city && state && zip ? `${city}, ${state} ${zip}` : null),
    booking_truth: backendTruth ?? lead.booking_truth,
  };

  const realBooked = isRealBookedLead(rawLead);
  const displayStatus = realBooked ? "booked" : getDisplayStatus(rawLead);

  return {
    ...rawLead,
    status: displayStatus,
    appointment_time: realBooked ? appointmentTime : null,
    calendar_event_id: realBooked ? calendarEventId : null,
    booking_truth: {
      booked: realBooked,
      status: lead.status ?? backendTruth?.status ?? null,
      hasAppointmentTime:
        backendTruth?.hasAppointmentTime ?? hasValue(appointmentTime),
      hasCalendarEventId:
        backendTruth?.hasCalendarEventId ?? hasValue(calendarEventId),
    },
  };
}

function sortLeads(leads: LeadItem[]) {
  return [...leads].sort((a, b) => leadSortTime(b) - leadSortTime(a));
}

function MetricCard({
  label,
  value,
  helper,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  helper: string;
  tone?: "neutral" | "green" | "blue" | "amber" | "red" | "dark";
}) {
  const accent = tone === "green" ? "text-[#b9eb00]" : tone === "amber" ? "text-amber-300" : tone === "red" ? "text-rose-300" : "text-white";
  return (
    <div className="rounded-2xl border border-[#27536c] bg-gradient-to-br from-[#0d344d] via-[#07263b] to-[#031421] px-5 py-5 shadow-[0_8px_24px_rgba(3,20,33,0.22)] transition-colors hover:border-[#4c91a4]">
      <p className="text-xs font-semibold tracking-wide text-slate-300">{label}</p>
      <p className={`mt-3 text-3xl font-bold tracking-tight ${accent}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-400">{helper}</p>
    </div>
  );
}

export default function Dashboard() {
  const [input, setInput] = useState("");
  const [activeView, setActiveView] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoMessage, setDemoMessage] = useState<string | null>(null);

  const fetchingRef = useRef(false);
  const queuedFetchRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const latestAppliedSeqRef = useRef(0);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const normalizedLeads = useMemo(() => {
    return sortLeads(leads.map(normalizeLead));
  }, [leads]);

  const selected = selectedId
    ? (normalizedLeads.find((lead) => lead.id === selectedId) ?? null)
    : (normalizedLeads[0] ?? null);

  const selectedIsBooked = isRealBookedLead(selected);
  const selectedStatus = getDisplayStatus(selected);

  const demoLeadCount = normalizedLeads.filter(
    (lead) => lead.source === "demo",
  ).length;

  const metrics = useMemo(() => {
    const weekLeads = normalizedLeads.filter((lead) =>
      isThisWeek(lead.created_at),
    );

    const bookedJobs = weekLeads.filter((lead) =>
      isRealBookedLead(lead),
    ).length;

    const awaitingResponse = weekLeads.filter(
      (lead) => getDisplayStatus(lead) === "awaiting_customer",
    ).length;

    const outsideServiceArea = weekLeads.filter(
      (lead) => getDisplayStatus(lead) === "outside_service_area",
    ).length;

    const followUpsSent = weekLeads.reduce(
      (sum, lead) => sum + Number(lead.follow_up_count ?? 0),
      0,
    );

    const responseTimes = weekLeads
      .map((lead) => lead.response_time_seconds)
      .filter((value): value is number => typeof value === "number");

    const averageResponseTime =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((sum, value) => sum + value, 0) /
              responseTimes.length,
          )
        : 0;

    const activeRevenueLeads = weekLeads.filter((lead) => {
      const status = getDisplayStatus(lead);

      return (
        status !== "duplicate" &&
        status !== "spam" &&
        status !== "outside_service_area" &&
        status !== "closed"
      );
    });

    const estimatedRevenue = activeRevenueLeads.reduce(
      (sum, lead) => sum + calculateLeadValue(lead.type),
      0,
    );

    const bookedRevenue = weekLeads
      .filter((lead) => isRealBookedLead(lead))
      .reduce((sum, lead) => sum + calculateLeadValue(lead.type), 0);

    return {
      leadsThisWeek: weekLeads.length,
      bookedJobs,
      awaitingResponse,
      outsideServiceArea,
      followUpsSent,
      averageResponseTime,
      estimatedRevenue,
      bookedRevenue,
    };
  }, [normalizedLeads]);

  const thisWeekBookedRevenue = metrics.bookedRevenue;

  const newLeadCount = useMemo(() => {
    return normalizedLeads.filter((lead) => getDisplayStatus(lead) === "new").length;
  }, [normalizedLeads]);

  const needQuoteCount = useMemo(() => {
    return normalizedLeads.filter((lead) => {
      const status = getDisplayStatus(lead);
      return status === "contacted" || status === "awaiting_customer";
    }).length;
  }, [normalizedLeads]);

  const scheduledCount = useMemo(() => {
    return normalizedLeads.filter((lead) => isRealBookedLead(lead)).length;
  }, [normalizedLeads]);

  const followUpTodayCount = useMemo(() => {
    return normalizedLeads.filter(
      (lead) => getDisplayStatus(lead) === "awaiting_customer",
    ).length;
  }, [normalizedLeads]);

  const priorityLeads = useMemo(() => {
    const priorityStatuses = new Set<LeadStatus>([
      "new",
      "contacted",
      "awaiting_customer",
    ]);

    return normalizedLeads.filter((lead) => {
      const status = getDisplayStatus(lead);

      return (
        priorityStatuses.has(status) &&
        status !== "spam" &&
        status !== "duplicate" &&
        status !== "outside_service_area" &&
        status !== "closed" &&
        status !== "completed" &&
        !isRealBookedLead(lead)
      );
    });
  }, [normalizedLeads]);

  const loadLeads = useCallback(async (autoSelect = false) => {
    if (fetchingRef.current) {
      queuedFetchRef.current = true;
      return;
    }

    fetchingRef.current = true;
    const requestSeq = ++requestSeqRef.current;

    try {
      const res = await fetch(`/api/get-leads?ts=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
      });

      const contentType = res.headers.get("content-type") ?? "";

      if (!contentType.includes("application/json")) {
        const text = await res.text();
        throw new Error(
          `get_leads_non_json_${res.status}_${text.slice(0, 120)}`,
        );
      }

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `get_leads_failed_${res.status}`);
      }

      if (requestSeq < latestAppliedSeqRef.current) {
        return;
      }

      latestAppliedSeqRef.current = requestSeq;

      const freshLeads: LeadItem[] = sortLeads(
        (data.leads ?? []).map(normalizeLead),
      );

      setCompany(data.company ?? null);
      setLeads(freshLeads);

      const currentSelectedId = selectedIdRef.current;
      const selectedStillExists =
        currentSelectedId &&
        freshLeads.some((lead) => lead.id === currentSelectedId);

      if (autoSelect && freshLeads.length > 0) {
        selectedIdRef.current = freshLeads[0].id;
        setSelectedId(freshLeads[0].id);
      } else if (!selectedStillExists) {
        selectedIdRef.current = freshLeads[0]?.id ?? null;
        setSelectedId(freshLeads[0]?.id ?? null);
      }
    } catch (err) {
      console.error("Failed to load leads:", err);
    } finally {
      fetchingRef.current = false;

      if (queuedFetchRef.current) {
        queuedFetchRef.current = false;
        void loadLeads(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadLeads(true);

    const leadsChannel = supabase
      .channel(`leads-realtime-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "leads",
        },
        () => {
          window.setTimeout(() => {
            void loadLeads(false);
          }, 750);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "appointments",
        },
        () => {
          window.setTimeout(() => {
            void loadLeads(false);
          }, 750);
        },
      )
      .subscribe();

    const interval = window.setInterval(() => {
      void loadLeads(false);
    }, 5000);

    const focusHandler = () => {
      void loadLeads(false);
    };

    const visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        void loadLeads(false);
      }
    };

    window.addEventListener("focus", focusHandler);
    document.addEventListener("visibilitychange", visibilityHandler);

    return () => {
      supabase.removeChannel(leadsChannel);
      window.clearInterval(interval);
      window.removeEventListener("focus", focusHandler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [loadLeads]);

  async function createLead() {
    if (!input.trim()) return;

    setLoading(true);

    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          Accept: "application/json",
        },
        body: JSON.stringify({
          message: input,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error ?? "lead_creation_failed");
      }

      setInput("");
      await loadLeads(true);
    } catch (err) {
      console.error("Lead creation failed:", err);
    } finally {
      setLoading(false);
    }
  }

  async function sendReply() {
    if (!selected?.id || !selected.reply) return;

    const recipient =
      selected.email;
    if (!recipient) {
      console.error("Cannot send a reply without this lead's customer email.");
      return;
    }

    setSending(true);

    try {
      const res = await fetch("/api/send-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          Accept: "application/json",
        },
        body: JSON.stringify({
          id: selected.id,
          to: recipient,
          subject: "Re: Your HVAC Request",
          body: selected.reply,
        }),
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error?.message ?? data.error ?? "send_failed");
      }

      await loadLeads(false);
    } catch (err) {
      console.error("Send failed:", err);
    } finally {
      setSending(false);
    }
  }

  async function loadDemoMode() {
    setDemoLoading(true);
    setDemoMessage(null);

    try {
      const res = await fetch("/api/demo/seed", {
        method: "POST",
        headers: {
          Accept: "application/json",
        },
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error ?? "demo_seed_failed");
      }

      setDemoMessage(`Test data loaded: ${data.seeded ?? 0} leads added.`);
      await loadLeads(true);
    } catch (err: any) {
      console.error("Demo seed failed:", err);
      setDemoMessage(err?.message ?? "Test data load failed.");
    } finally {
      setDemoLoading(false);
    }
  }

  async function clearDemoMode() {
    setDemoLoading(true);
    setDemoMessage(null);

    try {
      const res = await fetch("/api/demo/clear", {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error ?? "demo_clear_failed");
      }

      setDemoMessage("Test data cleared.");
      await loadLeads(true);
    } catch (err: any) {
      console.error("Demo clear failed:", err);
      setDemoMessage(err?.message ?? "Test data clear failed.");
    } finally {
      setDemoLoading(false);
    }
  }

  const sendDisabled =
    !selected?.reply ||
    sending ||
    selectedStatus === "duplicate" ||
    selectedStatus === "spam" ||
    selectedStatus === "closed" ||
    selectedStatus === "completed" ||
    selectedIsBooked;

  // Presentation-only filtering. Backend lead truth, polling, selection and actions remain unchanged.
  const visibleLeads = normalizedLeads.filter((lead) => {
    const status = getDisplayStatus(lead);
    const matchesView = activeView === "all" ||
      (activeView === "new" && status === "new") ||
      (activeView === "quote" && (status === "contacted" || status === "awaiting_customer")) ||
      (activeView === "scheduled" && isRealBookedLead(lead)) ||
      (activeView === "followup" && status === "awaiting_customer");
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch = !query || [lead.customer_name, lead.email, lead.phone, lead.message, lead.input, lead.type, lead.service_area]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
    return matchesView && matchesSearch;
  });

  // Navigation-only action: end the Supabase session before opening the existing login page.
  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      window.location.assign("/login");
    } catch (error) {
      console.error("Logout failed:", error);
      window.alert("Could not sign out. Please try again.");
      setLoggingOut(false);
    }
  }

  const navItems = [
    { id: "all", label: "Overview", count: normalizedLeads.length },
    { id: "new", label: "New leads", count: newLeadCount },
    { id: "quote", label: "Need attention", count: needQuoteCount },
    { id: "scheduled", label: "Scheduled", count: scheduledCount },
    { id: "followup", label: "Follow ups", count: followUpTodayCount },
  ];

  return (
    <main className="min-h-screen bg-[#e7eef4] text-slate-900">
      <div className="min-h-screen lg:flex">
        <aside className="bg-gradient-to-b from-[#061521] via-[#09283e] to-[#04121f] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[248px] lg:shrink-0 lg:flex-col">
          <div className="flex items-center justify-between border-b border-cyan-300/10 bg-[#061622] px-6 py-6">
            <a href="/" className="flex items-center gap-3" aria-label="BookMoreJobs home">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#b9eb00] text-xl font-black text-[#071323]">B</div>
              <div><div className="text-lg font-extrabold tracking-tight">BookMoreJobs</div><div className="text-[10px] font-bold uppercase tracking-[.22em] text-slate-400">Command center</div></div>
            </a>
          </div>
          <div className="px-4 py-6">
            <div className="mb-3 px-3 text-[11px] font-bold uppercase tracking-[.18em] text-slate-500">Workspace</div>
            <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Lead views">
              {navItems.map((item) => (
                <button key={item.id} type="button" onClick={() => setActiveView(item.id)}
                  aria-current={activeView === item.id ? "page" : undefined}
                  className={`flex min-w-max items-center justify-between gap-5 rounded-xl px-4 py-3 text-left text-sm font-semibold transition lg:w-full ${activeView === item.id ? "bg-[#b9eb00] text-[#071323]" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}>
                  <span>{item.label}</span><span className={`rounded-md px-2 py-0.5 text-xs ${activeView === item.id ? "bg-black/10" : "bg-white/10"}`}>{item.count}</span>
                </button>
              ))}
            </nav>
          </div>
          <div className="hidden flex-1 lg:block" />
          <div className="border-t border-white/10 px-4 py-5">
            <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
              <p className="truncate text-sm font-semibold">{company?.name || "Your HVAC company"}</p>
              <p className="mt-1 text-xs text-slate-400">Private company workspace</p>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="grid grid-cols-1 items-center gap-3 border-b border-[#17384a] bg-[#061b2b] px-5 py-4 text-white sm:px-8 lg:grid-cols-[minmax(210px,1fr)_auto_minmax(210px,1fr)] lg:gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-400">BookMoreJobs / Dashboard</p>
              <h1 className="mt-1 text-xl font-bold tracking-tight">Operations overview</h1>
            </div>
            <nav aria-label="Dashboard navigation" className="flex flex-wrap items-center justify-start gap-2 md:gap-3 lg:flex-nowrap lg:justify-center xl:gap-4">
              <a href="/settings" className="whitespace-nowrap rounded-lg px-3.5 py-2.5 text-[20px] font-semibold text-slate-100 transition hover:bg-[#b9eb00] hover:text-[#061b2b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b9eb00]">Settings</a>
              <a href="/terms" className="whitespace-nowrap rounded-lg px-3.5 py-2.5 text-[20px] font-semibold text-slate-100 transition hover:bg-[#b9eb00] hover:text-[#061b2b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b9eb00]">Terms</a>
              <a href="/privacy" className="whitespace-nowrap rounded-lg px-3.5 py-2.5 text-[20px] font-semibold text-slate-100 transition hover:bg-[#b9eb00] hover:text-[#061b2b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b9eb00]">Privacy Policy</a>
              <button type="button" onClick={handleLogout} disabled={loggingOut} className="whitespace-nowrap rounded-lg px-3.5 py-2.5 text-[20px] font-semibold text-slate-100 transition hover:bg-[#b9eb00] hover:text-[#061b2b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b9eb00] disabled:cursor-not-allowed disabled:opacity-50">{loggingOut ? "Signing out…" : "Log out"}</button>
            </nav>
            <div className="flex items-center justify-start gap-3 lg:justify-end">
              <span className="hidden items-center gap-2 whitespace-nowrap rounded-full border border-emerald-700/50 bg-emerald-950/50 px-3 py-2 text-xs font-semibold text-emerald-300 xl:flex"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Live lead updates</span>
              <button type="button" onClick={() => void loadLeads(false)} className="whitespace-nowrap rounded-xl border border-[#28536a] bg-[#0d344a] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#19516a]">↻ Refresh</button>
            </div>
          </header>

          <div className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 sm:px-8 sm:py-8">
            <section className="relative overflow-hidden rounded-2xl border border-[#1a4558] bg-gradient-to-br from-[#061623] via-[#08344c] to-[#0d5670] px-6 py-7 text-white shadow-[0_14px_35px_rgba(5,18,34,0.17)] sm:px-8 sm:py-8">
              <div className="relative z-10 flex flex-wrap items-end justify-between gap-6">
                <div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#b9eb00]">Your performance · rolling 7 days</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Jobs booked. Revenue in motion.</h2>
                  <p className="mt-3 text-sm text-slate-300">One workspace for leads, replies and appointments.</p>
                </div>
                <div className="rounded-xl border border-[#397089]/60 bg-[#061b2a]/75 px-6 py-4 backdrop-blur-sm">
                  <p className="text-xs font-semibold text-slate-300">Estimated booked job value</p>
                  <p className="mt-1 text-3xl font-extrabold tracking-tight text-[#b9eb00] sm:text-4xl">{formatRevenue(thisWeekBookedRevenue)}</p>
                  <p className="mt-1 text-[11px] text-slate-400">Estimate, not collected revenue</p>
                </div>
              </div>
              <div className="pointer-events-none absolute -right-16 -top-24 h-60 w-60 rounded-full border-[40px] border-white/5" />
            </section>

            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key metrics">
              <MetricCard label="New leads" value={newLeadCount} helper="Awaiting first action" />
              <MetricCard label="Need attention" value={needQuoteCount} helper="Contacted or waiting" tone="amber" />
              <MetricCard label="Scheduled" value={scheduledCount} helper="Confirmed bookings" tone="green" />
              <MetricCard label="Follow ups" value={followUpTodayCount} helper="Awaiting customer" />
              <MetricCard label="Booked this week" value={metrics.bookedJobs} helper="Last 7 days" tone="green" />
              <MetricCard label="Average reply" value={metrics.averageResponseTime ? formatSeconds(metrics.averageResponseTime) : "—"} helper="Measured responses" />
            </section>

            <section className="overflow-hidden rounded-2xl border border-[#c4d3df] bg-white shadow-[0_8px_25px_rgba(8,25,43,0.06)]" id="jobs">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#255065] bg-[#061b2b] px-5 py-5 text-white sm:px-6">
                <div><h2 className="text-lg font-bold">Lead pipeline</h2><p className="mt-1 text-sm text-slate-300">See where each opportunity stands.</p></div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={loadDemoMode} disabled={demoLoading} className="rounded-lg border border-[#32667d] bg-[#10445c] px-3 py-2 text-xs font-semibold text-white hover:bg-[#18617b] disabled:opacity-50">{demoLoading ? "Working…" : "Load test data"}</button>
                  <button type="button" onClick={clearDemoMode} disabled={demoLoading || demoLeadCount === 0} className="rounded-lg border border-rose-400/60 bg-rose-950/20 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-950/40 disabled:opacity-50">Clear test data</button>
                </div>
              </div>
              <div className="overflow-x-auto px-5 py-5 sm:px-6"><LeadPipeline leads={normalizedLeads} /></div>
              {demoMessage && <p className="border-t border-slate-100 px-6 py-3 text-sm font-medium text-slate-700" role="status">{demoMessage}</p>}
            </section>

            <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.35fr)]" aria-label="Job workspace">
              <div className="min-w-0 space-y-5">
                <div className="overflow-hidden rounded-2xl border border-[#c4d3df] bg-white shadow-[0_8px_25px_rgba(8,25,43,0.06)]">
                  <div className="border-b border-[#255065] bg-[#061b2b] px-5 py-5 text-white">
                    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-bold">Jobs inbox</h2><p className="mt-1 text-xs text-slate-300">Choose a lead to see all details</p></div><span className="rounded-full bg-[#124059] px-3 py-1 text-xs font-bold text-white">{visibleLeads.length}</span></div>
                    <input aria-label="Search leads" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search customer, job or contact…" className="mt-4 w-full rounded-xl border border-[#4b6077] bg-[#0f394e] px-4 py-3 text-sm text-white placeholder:text-slate-300 outline-none focus:border-[#b9eb00] focus:bg-[#144860]" />
                    <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                      {navItems.map((item) => <button type="button" key={item.id} onClick={() => setActiveView(item.id)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${activeView === item.id ? "bg-[#b9eb00] text-[#081625]" : "bg-[#12394f] text-slate-200 hover:bg-[#1d5970]"}`}>{item.label}</button>)}
                    </div>
                  </div>
                  <div className="max-h-[620px] space-y-2 overflow-y-auto p-3 custom-scroll">
                    {visibleLeads.length ? visibleLeads.map((lead) => (
                      <LeadCard key={lead.id} lead={{...lead, ...(lead.service_area ? {city: lead.service_area, state: null, zip: null, address: null} : {})}}
                        active={selected?.id === lead.id} onClick={() => setSelectedId(lead.id)} />
                    )) : <p className="px-4 py-12 text-center text-sm text-slate-500">No leads match this view.</p>}
                  </div>
                </div>
                <div className="rounded-2xl border border-[#c4d3df] bg-white p-5 shadow-[0_8px_25px_rgba(8,25,43,0.06)]">
                  <p className="text-[11px] font-bold uppercase tracking-[.15em] text-slate-500">Manual test</p>
                  <h3 className="mt-2 text-base font-bold">Create HVAC lead</h3>
                  <p className="mt-1 text-xs text-slate-400">Submit a customer request to the existing processing system.</p>
                  <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste customer request here…" className="mt-4 min-h-28 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-slate-400" />
                  <button type="button" onClick={createLead} disabled={loading || !input.trim()} className="mt-3 w-full rounded-xl bg-[#b9eb00] px-4 py-3 text-sm font-bold text-[#071323] transition hover:bg-[#d1ff33] disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Processing…" : "Process lead →"}</button>
                </div>
              </div>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-[#c4d3df] bg-white shadow-[0_8px_25px_rgba(8,25,43,0.06)]" aria-label="Selected job details">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#255065] bg-[#061b2b] px-5 py-5 text-white sm:px-6">
                  <div><h2 className="text-lg font-bold">Job details</h2><p className="mt-1 text-xs text-slate-300">Customer information, conversation and booking</p></div>
                  {selected && <span className={`rounded-full px-3 py-1 text-xs font-bold ${selectedIsBooked ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>{statusLabel(selectedStatus)}</span>}
                </div>
                {!selected ? <div className="grid min-h-80 place-items-center px-6 text-center text-sm text-slate-500">Choose a job from the inbox to view its details.</div> : (
                  <div className="space-y-5 p-5 sm:p-6">
                    <div className="flex flex-wrap gap-2"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold capitalize text-slate-700">{selected.type || "HVAC lead"}</span><span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold capitalize text-amber-700">{selected.priority || "Normal"} priority</span></div>
                    <div className="rounded-xl bg-slate-50 p-5"><p className="text-xs font-bold uppercase tracking-wider text-slate-500">Customer request</p><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-800">{selected.message || selected.input || "No message"}</p></div>
                    {selectedIsBooked && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5"><p className="text-xs font-bold uppercase tracking-wider text-emerald-800">✓ Appointment booked</p><p className="mt-2 text-base font-bold">{selected.appointment_time ? new Date(selected.appointment_time).toLocaleString() : "Booked time saved"}</p>{selected.calendar_event_id && <p className="mt-2 break-all text-xs text-emerald-800">Calendar event: {selected.calendar_event_id}</p>}</div>}
                    {selectedStatus === "awaiting_customer" && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-bold text-amber-800">Follow up needed</p><p className="mt-1 text-sm text-slate-700">Customer still needs to pick an available slot or give a clearer time.</p></div>}
                    <div><h3 className="mb-3 text-sm font-bold">Customer & job information</h3>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {[
                          ["Customer", selected.customer_name || "Not captured"],
                          ["Service area", formatServiceArea(selected)],
                          ["Requested time", selected.preferred_time || "Not captured"],
                          ["Address", selected.address || "Not captured"],
                          ["Phone", selected.phone || "Not captured"],
                          ["Email", selected.email || "Not captured"],
                          ["Estimated job value", formatRevenue(calculateLeadValue(selected.type))],
                          ["Reply speed", selected.response_time_seconds == null ? "Not contacted" : formatSeconds(selected.response_time_seconds)],
                        ].map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3"><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold text-slate-800">{value}</p></div>)}
                      </div>
                    </div>
                    {!selectedIsBooked && <div className="rounded-xl border border-slate-200 p-4 sm:p-5"><h3 className="text-sm font-bold">Customer reply draft</h3><div className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-7 text-slate-700">{selected.reply || "No reply generated yet."}</div><button type="button" onClick={sendReply} disabled={sendDisabled} className="mt-4 w-full rounded-xl bg-[#07273b] px-5 py-3 text-sm font-bold text-white hover:bg-[#13465f] disabled:cursor-not-allowed disabled:bg-slate-300">{sending ? "Sending reply…" : "Send reply →"}</button></div>}
                    <div className="border-t border-slate-100 pt-5"><h3 className="mb-4 text-sm font-bold">Appointment scheduling</h3><BookingPanel leadId={selected.id} customerName={selected.customer_name} customerEmail={selected.email} customerPhone={selected.phone} defaultAppointmentMinutes={company?.default_appointment_minutes ?? 60} onBooked={() => loadLeads(false)} /></div>
                  </div>
                )}
              </section>
            </section>
            <p className="pb-3 text-center text-xs text-slate-400">BookMoreJobs · Your calls. Your texts. Your emails. Your business.</p>
          </div>
        </div>
      </div>
    </main>
  );
}