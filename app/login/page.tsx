"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

const supabase = createSupabaseBrowserClient();

export default function LoginPage() {

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [signedInPendingRoute, setSignedInPendingRoute] = useState(false);
  const loginInFlight = useRef(false);
  const [phase, setPhase] = useState<"idle" | "authenticating" | "verifying" | "navigating">("idle");

  // After Supabase creates the session, the server checks this user's company
  // and Google connection using the existing protected verification functions.
  // This avoids a second client-side company-status fetch and retry loop.
  function openVerifiedWorkspace() {
    setPhase("navigating");
    window.location.replace("/auth/continue");
  }

  async function routeAuthenticatedUser() {
    if (loginInFlight.current) return;
    loginInFlight.current = true;
    setLoading(true);
    setError("");
    openVerifiedWorkspace();
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (loginInFlight.current) return;
    loginInFlight.current = true;
    setLoading(true);
    setError("");
    try {
      if (!signedInPendingRoute) {
        setPhase("authenticating");
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        if (!data.session?.access_token) {
          throw new Error("Authentication returned no active session.");
        }
        setSignedInPendingRoute(true);
      }
      openVerifiedWorkspace();
    } catch (err) {
      loginInFlight.current = false;
      setLoading(false);
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Login failed.");
    }
  }

  return (
    <main className="min-h-screen bg-[#061D2F] px-4 py-10 text-[#0B2033] sm:px-6 sm:py-14">
      <div className="mx-auto max-w-[860px]">
        <header className="mb-7 flex items-center justify-center">
          <Link href="/" className="inline-flex items-center gap-3 text-white">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#B9EB00] text-xl font-black text-[#061D2F] shadow-lg shadow-black/20">B</span>
            <span className="text-2xl font-black tracking-tight">BookMoreJobs</span>
          </Link>
        </header>

        <div className="overflow-hidden rounded-[20px] border border-[#31556A] bg-white shadow-[0_24px_75px_rgba(0,0,0,0.3)]">
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.2fr)_minmax(245px,0.8fr)]">
            <section className="min-w-0 bg-white px-6 py-8 sm:px-10 sm:py-10">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#147C64]">Log in</p>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-[#0B2033] sm:text-[34px]">Welcome back</h1>
              <p className="mt-3 text-sm leading-6 text-[#526779]">
                Log in to access your HVAC company dashboard.
              </p>

              <form onSubmit={handleLogin} className="mt-7 space-y-4">
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-sm font-bold text-[#20384B]">Email address</label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-[#CAD6E0] bg-[#F7F9FB] px-4 text-[#0B2033] outline-none placeholder:text-[#7D91A2] focus:border-[#147C64] focus:ring-2 focus:ring-[#B9EB00]/35"
                    placeholder="owner@hvaccompany.com"
                  />
                </div>

                <div>
                  <label htmlFor="password" className="mb-1.5 block text-sm font-bold text-[#20384B]">Password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-[#CAD6E0] bg-[#F7F9FB] px-4 text-[#0B2033] outline-none placeholder:text-[#7D91A2] focus:border-[#147C64] focus:ring-2 focus:ring-[#B9EB00]/35"
                    placeholder="Password"
                  />
                </div>

                {loading && <p role="status" className="text-sm font-semibold text-[#526779]">{phase === "authenticating" ? "Signing in securely..." : phase === "verifying" ? "Opening your verified workspace..." : "Opening your workspace..."}</p>}

                {error ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700" role="alert">
                    {error}
                  </div>
                ) : null}

                {signedInPendingRoute && error ? (
                  <button
                    type="button"
                    onClick={() => void routeAuthenticatedUser()}
                    disabled={loading}
                    className="min-h-12 w-full rounded-xl border border-[#23536E] bg-[#073650] px-4 font-extrabold text-white hover:bg-[#0B4F6A] disabled:opacity-50"
                  >
                    {loading ? "Checking connection..." : "Retry company verification"}
                  </button>
                ) : null}

                <button
                  type="submit"
                  disabled={loading || signedInPendingRoute}
                  className="min-h-12 w-full rounded-xl bg-[#B9EB00] px-4 font-extrabold text-[#061D2F] shadow-sm transition hover:bg-[#C7F000] disabled:cursor-not-allowed disabled:bg-[#B7C6CC] disabled:shadow-none"
                >
                  {loading ? (signedInPendingRoute ? "Checking connection..." : "Signing In...") : signedInPendingRoute ? "Signed in" : "Log In"}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-[#526779]">
                New company?{" "}
                <Link href="/signup" className="font-extrabold text-[#086786] hover:underline">
                  Create account
                </Link>
              </p>
            </section>

            <aside className="flex flex-col justify-between border-t border-[#DCE5EB] bg-[#F3F6F9] px-6 py-8 sm:px-8 sm:py-10 md:border-l md:border-t-0">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#147C64]">Your workspace</p>
                <h2 className="mt-3 text-xl font-black tracking-tight text-[#0B2033]">Back to work in three steps</h2>
                <div className="mt-7 space-y-6">
                  {[
                    ["01", "Sign in securely", "Use your company account credentials."],
                    ["02", "Open your dashboard", "Review leads and customer conversations."],
                    ["03", "Manage bookings", "Track appointments and follow-ups."],
                  ].map(([number, title, description]) => (
                    <div key={number} className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E5F7AF] text-xs font-black text-[#244416]">{number}</span>
                      <div>
                        <h3 className="text-sm font-extrabold text-[#0B2033]">{title}</h3>
                        <p className="mt-1 text-sm leading-5 text-[#5D7181]">{description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-10 rounded-xl border border-[#C9D9E2] bg-white p-4">
                <p className="text-sm font-bold text-[#17364D]">Your HVAC workspace.</p>
                <p className="mt-1 text-xs leading-5 text-[#617787]">Pick up where you left off after signing in.</p>
              </div>
            </aside>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-[#B1C7D3]">BookMoreJobs · AI Lead Recovery &amp; Booking</p>
      </div>
    </main>
  );
}