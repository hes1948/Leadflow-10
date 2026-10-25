// app/page.tsx

import Link from "next/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const capabilities = [
  {
    title: "Gmail lead capture",
    text: "Watches the connected company Gmail inbox and captures inbound HVAC requests.",
  },
  {
    title: "Noise filtering",
    text: "Classifies real HVAC leads separately from unrelated emails and junk.",
  },
  {
    title: "Customer metadata extraction",
    text: "Pulls customer name, phone, email, address, city, state, and ZIP when present.",
  },
  {
    title: "Instant appointment reply",
    text: "Sends customers real available appointment options instead of a weak “we’ll check” message.",
  },
  {
    title: "Unavailable-time recovery",
    text: "If a customer asks for a time that is not open, the system says it is unavailable and sends the next real openings.",
  },
  {
    title: "Natural reply booking",
    text: "Handles replies like “first option works” and books the matching appointment.",
  },
  {
    title: "Google Calendar booking",
    text: "Creates the confirmed HVAC appointment in Google Calendar with customer details.",
  },
  {
    title: "Lead dashboard",
    text: "Tracks new leads, contacted leads, waiting customers, booked jobs, and follow-up status.",
  },
];

const stats = [
  ["Instant", "First response"],
  ["Gmail", "Lead source"],
  ["Calendar", "Booking output"],
  ["HVAC", "Built for service calls"],
];

const workflow = [
  "Customer emails your HVAC company",
  "BookMoreJobs captures and classifies the request",
  "The system sends real appointment options",
  "Customer replies naturally",
  "Appointment is booked in Google Calendar",
  "Dashboard updates the job status",
];

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#f4f7fb] text-slate-950">
      <section className="relative isolate overflow-hidden bg-[#07111f] text-white">
        <div className="absolute left-[-12rem] top-[-12rem] h-[34rem] w-[34rem] rounded-full bg-blue-600/30 blur-3xl" />
        <div className="absolute right-[-10rem] top-24 h-[30rem] w-[30rem] rounded-full bg-orange-500/20 blur-3xl" />
        <div className="absolute bottom-[-16rem] left-1/3 h-[30rem] w-[30rem] rounded-full bg-cyan-400/10 blur-3xl" />

        <header className="relative z-10 border-b border-white/10 bg-white/[0.03] backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
            <Link href="/" className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-orange-500 text-lg font-black text-white shadow-lg shadow-orange-500/30">
                B
              </span>
              <span className="text-2xl font-black tracking-tight">
                BookMoreJobs
              </span>
            </Link>

            <nav className="flex items-center gap-3">
              <Link
                href="/login"
                className="rounded-full bg-blue-600 px-5 py-2.5 text-sm font-black text-white shadow-lg shadow-blue-600/25 transition hover:-translate-y-0.5 hover:bg-blue-700"
              >
                Log In
              </Link>

              <Link
                href="/signup"
                className="rounded-full bg-orange-500 px-5 py-2.5 text-sm font-black text-white shadow-lg shadow-orange-500/25 transition hover:-translate-y-0.5 hover:bg-orange-600"
              >
                Sign Up
              </Link>
            </nav>
          </div>
        </header>

        <div className="relative z-10 mx-auto grid max-w-7xl gap-14 px-6 py-24 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:py-32">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/30 bg-orange-400/10 px-4 py-2 text-xs font-black uppercase tracking-[0.18em] text-orange-200">
              <span className="h-2 w-2 rounded-full bg-orange-400" />
              AI Lead Recovery + Booking
            </div>

            <h1 className="mt-7 max-w-4xl text-5xl font-black leading-[0.95] tracking-[-0.05em] md:text-7xl">
              Stop letting HVAC leads die in the inbox.
            </h1>

            <p className="mt-7 max-w-2xl text-lg font-semibold leading-8 text-slate-300">
              BookMoreJobs connects to company Gmail, catches urgent HVAC
              requests, replies with real available appointment times, handles
              natural customer replies, and books confirmed jobs into Google
              Calendar.
            </p>

            <div className="mt-9 flex flex-col gap-4 sm:flex-row">
              <Link
                href="/signup"
                className="rounded-full bg-orange-500 px-9 py-4 text-center text-sm font-black text-white shadow-2xl shadow-orange-500/30 transition hover:-translate-y-1 hover:bg-orange-600"
              >
                Create Account
              </Link>

              <Link
                href="/login"
                className="rounded-full bg-blue-600 px-9 py-4 text-center text-sm font-black text-white shadow-2xl shadow-blue-600/25 transition hover:-translate-y-1 hover:bg-blue-700"
              >
                Log In
              </Link>
            </div>

            <div className="mt-10 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              {stats.map(([value, label]) => (
                <div
                  key={label}
                  className="rounded-3xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur"
                >
                  <p className="text-lg font-black text-white">{value}</p>
                  <p className="mt-1 text-xs font-bold text-slate-400">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-4 rounded-[2.5rem] bg-gradient-to-br from-blue-500/20 via-white/10 to-orange-500/20 blur-2xl" />

            <div className="relative rounded-[2rem] border border-white/15 bg-white/10 p-4 shadow-2xl backdrop-blur-xl">
              <div className="rounded-[1.5rem] bg-[#0d1726] p-5">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
                      Live Inbox Capture
                    </p>
                    <p className="mt-1 text-xl font-black text-white">
                      Emergency AC Repair
                    </p>
                  </div>

                  <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-black text-emerald-300">
                    New Lead
                  </span>
                </div>

                <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.06] p-5">
                  <p className="text-sm font-bold leading-6 text-slate-300">
                    “My AC stopped working at 9996 Culebra Rd San Antonio TX
                    78251. Need emergency HVAC help today.”
                  </p>

                  <div className="mt-4 grid gap-2 text-xs font-black text-slate-300 sm:grid-cols-2">
                    <div className="rounded-xl bg-white/[0.06] px-3 py-2">
                      Customer: Caleb Warren
                    </div>
                    <div className="rounded-xl bg-white/[0.06] px-3 py-2">
                      Phone: 210-555-9996
                    </div>
                    <div className="rounded-xl bg-white/[0.06] px-3 py-2">
                      ZIP: 78251
                    </div>
                    <div className="rounded-xl bg-white/[0.06] px-3 py-2">
                      Priority: High
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl bg-white p-5 text-slate-950 shadow-xl">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">
                      Auto Reply
                    </p>
                    <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-700">
                      Sent instantly
                    </span>
                  </div>

                  <p className="mt-4 text-sm font-black leading-6">
                    Thanks for reaching out — this sounds urgent. Here are the
                    next real openings we can book:
                  </p>

                  <div className="mt-4 space-y-2">
                    {["Tue, Jun 30, 8:00 AM", "Tue, Jun 30, 8:30 AM", "Tue, Jun 30, 9:00 AM"].map(
                      (slot, index) => (
                        <div
                          key={slot}
                          className="flex items-center justify-between rounded-2xl border border-orange-100 bg-orange-50 px-4 py-3"
                        >
                          <span className="text-sm font-black">
                            {index + 1}. {slot}
                          </span>
                          <span className="text-xs font-black text-orange-700">
                            Open
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4">
                    <p className="text-xs font-black uppercase tracking-wide text-emerald-300">
                      Customer Reply
                    </p>
                    <p className="mt-2 text-sm font-black text-white">
                      “First option works.”
                    </p>
                  </div>

                  <div className="rounded-2xl border border-blue-400/20 bg-blue-400/10 p-4">
                    <p className="text-xs font-black uppercase tracking-wide text-blue-300">
                      Result
                    </p>
                    <p className="mt-2 text-sm font-black text-white">
                      Calendar job booked.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white px-6 py-12">
        <div className="mx-auto grid max-w-7xl gap-4 md:grid-cols-4">
          {[
            "Gmail connected",
            "Real HVAC leads captured",
            "Natural replies handled",
            "Google Calendar booking",
          ].map((item) => (
            <div
              key={item}
              className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-center shadow-sm"
            >
              <p className="text-sm font-black text-slate-800">{item}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-[#f4f7fb] px-6 py-24">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">
                Built Around The Money Problem
              </p>

              <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] text-slate-950 md:text-6xl">
                Fast response is not enough. The lead has to get booked.
              </h2>
            </div>

            <p className="text-lg font-semibold leading-8 text-slate-600">
              This is not a generic AI assistant. The system is built around the
              HVAC booking flow: capture the request, reply with appointment
              options, recover unavailable times, understand customer replies,
              and update the dashboard when the job is booked.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {capabilities.map((item, index) => (
              <div
                key={item.title}
                className="group rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-2xl hover:shadow-slate-200"
              >
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 group-hover:bg-orange-500">
                  {index + 1}
                </div>

                <h3 className="mt-6 text-xl font-black tracking-tight text-slate-950">
                  {item.title}
                </h3>

                <p className="mt-3 text-sm font-semibold leading-6 text-slate-600">
                  {item.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-white px-6 py-24">
        <div className="absolute left-0 top-0 h-full w-1/2 bg-orange-50/70" />

        <div className="relative mx-auto grid max-w-7xl gap-12 lg:grid-cols-2 lg:items-center">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-200">
            <div className="rounded-[1.5rem] bg-slate-950 p-6 text-white">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-300">
                Unavailable Time Recovery
              </p>

              <div className="mt-5 rounded-2xl bg-white/[0.06] p-5">
                <p className="text-sm font-bold text-slate-300">
                  Customer asks:
                </p>
                <p className="mt-2 text-xl font-black">
                  “Tuesday at 4:41 PM works.”
                </p>
              </div>

              <div className="mt-4 rounded-2xl bg-white p-5 text-slate-950">
                <p className="text-sm font-black">
                  Tuesday, June 30, 4:41 PM is not available.
                </p>

                <p className="mt-4 text-sm font-black">
                  Here are the next real openings we can book:
                </p>

                <div className="mt-4 space-y-2 text-sm font-black">
                  <div className="rounded-xl bg-blue-50 px-4 py-3">
                    1. Thu, Jul 2, 4:11 PM
                  </div>
                  <div className="rounded-xl bg-blue-50 px-4 py-3">
                    2. Fri, Jul 3, 8:11 AM
                  </div>
                  <div className="rounded-xl bg-blue-50 px-4 py-3">
                    3. Fri, Jul 3, 8:41 AM
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-700">
              Real Booking Behavior
            </p>

            <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] text-slate-950 md:text-6xl">
              If the time is not open, the system does not dead-end the lead.
            </h2>

            <p className="mt-5 text-lg font-semibold leading-8 text-slate-600">
              When a customer suggests an unavailable time, BookMoreJobs responds
              with the unavailable-time message and immediately gives real
              alternatives. The customer can still reply naturally and the
              system can book the selected option.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-[#07111f] px-6 py-24 text-white">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-300">
                Workflow
              </p>

              <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] md:text-6xl">
                The pipeline is simple because the goal is simple.
              </h2>

              <p className="mt-5 text-lg font-semibold leading-8 text-slate-300">
                Capture the lead. Respond fast. Offer real times. Book the job.
                Show the result in the dashboard.
              </p>
            </div>

            <div className="grid gap-4">
              {workflow.map((step, index) => (
                <div
                  key={step}
                  className="flex items-center gap-5 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-xl shadow-black/10"
                >
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-blue-600 text-sm font-black text-white">
                    {index + 1}
                  </div>
                  <p className="text-base font-black text-white">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white px-6 py-24">
        <div className="mx-auto max-w-7xl rounded-[2.5rem] border border-slate-200 bg-gradient-to-br from-slate-950 via-[#0c1c33] to-blue-950 p-10 text-white shadow-2xl shadow-slate-300 md:p-16">
          <div className="grid gap-10 lg:grid-cols-[1fr_0.8fr] lg:items-center">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-300">
                Start The System
              </p>

              <h2 className="mt-4 text-4xl font-black leading-tight tracking-[-0.04em] md:text-6xl">
                Build the HVAC front desk that replies before competitors do.
              </h2>

              <p className="mt-5 max-w-2xl text-lg font-semibold leading-8 text-slate-300">
                Create an account, connect the company email, and use the
                dashboard to manage captured leads, waiting customers, and
                booked appointments.
              </p>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-white/[0.08] p-6 backdrop-blur">
              <Link
                href="/signup"
                className="block rounded-full bg-orange-500 px-8 py-4 text-center text-sm font-black text-white shadow-2xl shadow-orange-500/25 transition hover:-translate-y-1 hover:bg-orange-600"
              >
                Create Account
              </Link>

              <Link
                href="/login"
                className="mt-3 block rounded-full bg-blue-600 px-8 py-4 text-center text-sm font-black text-white shadow-2xl shadow-blue-600/25 transition hover:-translate-y-1 hover:bg-blue-700"
              >
                Log In
              </Link>

              <p className="mt-5 text-center text-xs font-bold leading-5 text-slate-400">
                Routes stay connected: homepage → signup/login → dashboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-[#f8fafc] px-6 py-8">
        <div className="mx-auto flex max-w-7xl flex-col justify-between gap-4 text-sm font-bold text-slate-500 md:flex-row">
          <p>BookMoreJobs</p>
          <p>AI lead response and booking automation for HVAC companies.</p>
        </div>
      </footer>
    </main>
  );
}