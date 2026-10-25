"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";

export default function SignupPage() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  const [companyName, setCompanyName] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();

    setLoading(true);
    setError("");

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });

      if (error) throw error;

      const userId = data.user?.id;
      if (!userId) throw new Error("missing_user");

      const res = await fetch("/api/auth/create-company", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          companyName,
          companyPhone,
          email,
        }),
      });

      const json = await res.json();

      if (!json.success) {
        throw new Error(json.error ?? "company_creation_failed");
      }

      router.push("/onboarding/company/gmail");
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "signup_failed");
    } finally {
      setLoading(false);
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
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#147C64]">Create account</p>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-[#0B2033] sm:text-[34px]">Start your free trial</h1>
              <p className="mt-3 text-sm leading-6 text-[#526779]">
                Set up your HVAC company account to get started.
              </p>

              <form onSubmit={handleSignup} className="mt-7 space-y-4">
                <div>
                  <label htmlFor="companyName" className="mb-1.5 block text-sm font-bold text-[#20384B]">Company name</label>
                  <input
                    id="companyName"
                    required
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-[#CAD6E0] bg-[#F7F9FB] px-4 text-[#0B2033] outline-none placeholder:text-[#7D91A2] focus:border-[#147C64] focus:ring-2 focus:ring-[#B9EB00]/35"
                    placeholder="Company name"
                  />
                </div>

                <div>
                  <label htmlFor="companyPhone" className="mb-1.5 block text-sm font-bold text-[#20384B]">Company phone</label>
                  <input
                    id="companyPhone"
                    required
                    value={companyPhone}
                    onChange={(e) => setCompanyPhone(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-[#CAD6E0] bg-[#F7F9FB] px-4 text-[#0B2033] outline-none placeholder:text-[#7D91A2] focus:border-[#147C64] focus:ring-2 focus:ring-[#B9EB00]/35"
                    placeholder="Company phone"
                  />
                </div>

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
                    placeholder="Create password"
                  />
                </div>

                {error ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700" role="alert">
                    {error}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="min-h-12 w-full rounded-xl bg-[#B9EB00] px-4 font-extrabold text-[#061D2F] shadow-sm transition hover:bg-[#C7F000] disabled:cursor-not-allowed disabled:bg-[#B7C6CC] disabled:shadow-none"
                >
                  {loading ? "Creating Account..." : "Create Account"}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-[#526779]">
                Already have an account?{" "}
                <Link href="/login" className="font-extrabold text-[#086786] hover:underline">
                  Log in
                </Link>
              </p>
            </section>

            <aside className="flex flex-col justify-between border-t border-[#DCE5EB] bg-[#F3F6F9] px-6 py-8 sm:px-8 sm:py-10 md:border-l md:border-t-0">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#147C64]">Your setup</p>
                <h2 className="mt-3 text-xl font-black tracking-tight text-[#0B2033]">Three simple steps</h2>
                <div className="mt-7 space-y-6">
                  {[
                    ["01", "Create your account", "Enter your company details."],
                    ["02", "Connect Gmail", "Link your company's inbox."],
                    ["03", "Set booking preferences", "Choose the hours and details that fit your business."],
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
                <p className="text-sm font-bold text-[#17364D]">Made for HVAC businesses.</p>
                <p className="mt-1 text-xs leading-5 text-[#617787]">Your setup starts with the account information on this page.</p>
              </div>
            </aside>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-[#B1C7D3]">BookMoreJobs · AI Lead Recovery &amp; Booking</p>
      </div>
    </main>
  );
}