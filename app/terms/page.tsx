"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

export default function TermsPage() {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      router.push("/login");
      router.refresh();
    } catch (error) {
      console.error("Logout failed:", error);
      setLoggingOut(false);
    }
  }

  const navLinkClass =
    "rounded-xl px-4 py-2.5 text-[20px] font-bold text-white transition-colors hover:bg-[#B9EB00] hover:text-[#061B2B] focus-visible:bg-[#B9EB00] focus-visible:text-[#061B2B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C7F000]";
  const cardClass = "rounded-2xl border border-[#23536E] bg-gradient-to-br from-[#04263C] via-[#073650] to-[#0B4F6A] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]";

  return (
    <main className="min-h-screen bg-[#F3F6F9] text-[#0B2033]">
      <header className="w-full border-b border-[#1B4761] bg-[#051D2F] text-white">
        <div className="relative mx-auto flex min-h-[76px] max-w-7xl flex-col items-center gap-3 px-5 py-3 sm:px-8 xl:flex-row">
          <div className="self-start shrink-0">
            <p className="text-xs font-medium text-[#9FC9E8]">BookMoreJobs / Terms</p>
            <p className="mt-1 text-lg font-bold tracking-tight text-white">SMS Terms &amp; Conditions</p>
          </div>
          <nav aria-label="BookMoreJobs navigation" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 xl:absolute xl:left-[calc(50%+125px)] xl:top-1/2 xl:w-max xl:max-w-[calc(100vw-20rem)] xl:-translate-x-1/2 xl:-translate-y-1/2 xl:flex-nowrap xl:gap-x-7">
            <Link href="/settings" className={navLinkClass}>Settings</Link>
            <Link href="/privacy" className={navLinkClass}>Privacy Policy</Link>
            <Link href="/dashboard" className={navLinkClass}>Dashboard</Link>
            <Link href="/settings" className={navLinkClass}>My Account</Link>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className={`${navLinkClass} cursor-pointer disabled:cursor-wait disabled:opacity-60`}
            >
              {loggingOut ? "Logging out..." : "Log out"}
            </button>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        <div className="mb-8">
          <h1 className="text-4xl font-black tracking-tight text-[#0B2033] sm:text-5xl">SMS Terms &amp; Conditions</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-[#506478]">
            BookMoreJobs provides SMS communications relating to HVAC service
            requests, appointment scheduling, confirmations, reminders, and customer
            support.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Message Frequency</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Message frequency varies depending on customer activity.
            </p>
          </section>

          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Fees</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Message and data rates may apply.
            </p>
          </section>

          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Opt-Out</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Reply STOP to unsubscribe at any time.
            </p>
          </section>

          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Help</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Reply HELP for assistance.
            </p>
          </section>

          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Carrier Disclaimer</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Carriers are not liable for delayed or undelivered messages.
            </p>
          </section>

          <section className={cardClass}>
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Privacy Policy</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              Please review our Privacy Policy for details regarding how your
              information is collected and used.
            </p>
          </section>
        </div>

        <section className="mt-5 rounded-2xl border border-[#23536E] bg-gradient-to-r from-[#04263C] to-[#073650] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
          <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
          <h2 className="text-xl font-bold">Contact</h2>
          <p className="mt-4 leading-7 text-[#D7E7F1]">bookmorejobsorg@gmail.com</p>
        </section>
      </div>
    </main>
  );
}