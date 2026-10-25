"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

export default function PrivacyPage() {
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

  return (
    <main className="min-h-screen bg-[#F3F6F9] text-[#0B2033]">
      {/* Full-width navigation header; page content unchanged. */}
      <header className="w-full border-b border-[#1B4761] bg-[#051D2F] text-white">
        <div className="mx-auto grid min-h-[76px] max-w-7xl grid-cols-1 items-center gap-3 px-5 py-3 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="shrink-0">
            <p className="text-xs font-medium text-[#9FC9E8]">BookMoreJobs / Privacy</p>
            <p className="mt-1 text-lg font-bold tracking-tight text-white">Privacy Policy</p>
          </div>
          <nav aria-label="BookMoreJobs navigation" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 lg:col-start-2 lg:gap-x-7">
            <Link href="/settings" className={navLinkClass}>Settings</Link>
            <Link href="/terms" className={navLinkClass}>Terms</Link>
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
          <div aria-hidden="true" className="hidden lg:block" />
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
        <div className="mb-8">
          <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#187254]">BOOKMOREJOBS · YOUR INFORMATION</p>
          <h1 className="mt-4 text-4xl font-black tracking-tight text-[#0B2033] sm:text-5xl">Privacy Policy</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-[#506478]">
            BookMoreJobs respects your privacy and is committed to protecting your
            personal information.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <section className="rounded-2xl border border-[#23536E] bg-gradient-to-br from-[#04263C] via-[#073650] to-[#0B4F6A] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Information We Collect</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              We may collect your name, phone number, email address, service address,
              and information related to your HVAC service request.
            </p>
          </section>

          <section className="rounded-2xl border border-[#23536E] bg-gradient-to-br from-[#04263C] via-[#073650] to-[#0B4F6A] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">How We Use Information</h2>
            <p className="mt-4 leading-7 text-[#D7E7F1]">
              We use this information to schedule appointments, provide customer
              support, send appointment confirmations, reminders, service updates,
              and respond to customer inquiries.
            </p>
          </section>

          <section className="rounded-2xl border border-[#23536E] bg-gradient-to-br from-[#04263C] via-[#073650] to-[#0B4F6A] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">SMS Messaging</h2>
            <div className="mt-4 space-y-4 leading-7 text-[#D7E7F1]">
              <p>
                By providing your mobile number, you agree to receive SMS messages
                regarding appointment scheduling, confirmations, reminders, and customer
                support.
              </p>
              <p>Message frequency varies depending on your interaction with our service.</p>
              <p>Message and data rates may apply.</p>
              <p>Reply STOP at any time to opt out.</p>
              <p>Reply HELP for assistance.</p>
            </div>
          </section>

          <section className="rounded-2xl border border-[#23536E] bg-gradient-to-br from-[#04263C] via-[#073650] to-[#0B4F6A] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
            <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
            <h2 className="text-xl font-bold">Mobile Information</h2>
            <div className="mt-4 space-y-4 leading-7 text-[#D7E7F1]">
              <p>
                No mobile information will be shared with third parties or affiliates
                for marketing or promotional purposes.
              </p>
              <p>
                All the above categories exclude text messaging originator opt-in data
                and consent; this information will not be shared with any third parties.
              </p>
            </div>
          </section>
        </div>

        <section className="mt-5 rounded-2xl border border-[#23536E] bg-gradient-to-r from-[#04263C] to-[#073650] p-7 text-white shadow-[0_14px_34px_rgba(4,21,36,0.13)]">
          <span className="mb-5 block h-1 w-12 rounded-full bg-[#C7F000]" aria-hidden="true" />
          <h2 className="text-xl font-bold">Contact</h2>
          <p className="mt-4 leading-7 text-[#D7E7F1]">Email: bookmorejobsorg@gmail.com</p>
        </section>
      </div>
    </main>
  );
}