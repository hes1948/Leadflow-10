"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { Icon, GoogleMark } from "@/components/workspace/Icons";
import styles from "@/components/workspace/workspace.module.css";
import { useGoogleConnection } from "./useGoogleConnection";

// Styling only. Scoped to the setup view so existing settings and gate logic are untouched.
const bmGoogleTheme = `
  /* Signup-matched palette: midnight navy canvas, white primary content, lime actions. */
  body:has(.bm-google-connect-theme) { background: #061B2B !important; }
  .bm-google-connect-theme {
    background: #061B2B !important;
    color: #0B2033 !important;
    min-height: 100vh;
    padding: 18px 24px 50px;
    box-shadow: 0 0 0 100vmax #061B2B;
    clip-path: inset(-100vmax);
  }
  .bm-google-connect-theme .${styles.steps} {
    max-width: 1215px;
    margin: 0 auto 22px;
    color: #B7CADA !important;
  }
  .bm-google-connect-theme .${styles.steps} li { color: #C9D9E6 !important; }
  .bm-google-connect-theme .${styles.current} { color: #B9EB00 !important; }
  .bm-google-connect-theme .${styles.steps} b {
    border-color: #31617B !important;
    color: #B9EB00 !important;
    background: #0C334B !important;
  }
  .bm-google-connect-theme .${styles.setup} {
    width: 100%;
    max-width: 1215px;
    margin: 0 auto;
    gap: clamp(25px, 3.6vw, 61px);
    color: #F8FAFC !important;
  }
  .bm-google-connect-theme .${styles.eyebrow} { color: #B9EB00 !important; }
  .bm-google-connect-theme .${styles.title} { color: #FFFFFF !important; }
  .bm-google-connect-theme .${styles.accent} { color: #B9EB00 !important; }
  .bm-google-connect-theme .${styles.intro} { color: #C3D5E1 !important; }
  .bm-google-connect-theme .${styles.feature} { color: #F1F7FB !important; }
  .bm-google-connect-theme .${styles.feature} b { color: #FFFFFF !important; }
  .bm-google-connect-theme .${styles.feature} p { color: #BFD1DF !important; }
  .bm-google-connect-theme .${styles.icon} {
    background: #0D3A55 !important;
    border-color: #2C6781 !important;
    color: #B9EB00 !important;
  }
  .bm-google-connect-theme .${styles.card} {
    background: #FFFFFF !important;
    border: 1px solid #D6E1EB !important;
    color: #0B2033 !important;
    box-shadow: 0 22px 60px rgba(0, 6, 15, .34) !important;
  }
  .bm-google-connect-theme .${styles.card} h2 { color: #0B2033 !important; }
  .bm-google-connect-theme .${styles.card} p { color: #506478 !important; }
  .bm-google-connect-theme .${styles.card} .${styles.icon} {
    background: #EAF1F7 !important;
    border-color: #CCDDEA !important;
    color: #0C4C69 !important;
  }
  .bm-google-connect-theme .${styles.pill} {
    background: #ECF7D5 !important;
    border-color: #B6D47B !important;
    color: #274310 !important;
  }
  .bm-google-connect-theme .${styles.primary} {
    background: #B9EB00 !important;
    border-color: #B9EB00 !important;
    color: #061B2B !important;
    font-weight: 800 !important;
    box-shadow: 0 6px 18px rgba(101, 134, 0, .16);
  }
  .bm-google-connect-theme .${styles.primary}:hover:not(:disabled) { background: #D2FF37 !important; }
  .bm-google-connect-theme .${styles.linkButton} { color: #0B4F6A !important; }
  .bm-google-connect-theme .${styles.divider} {
    border-color: #D8E3EC !important;
    background-color: #D8E3EC !important;
  }
  .bm-google-connect-theme .${styles.fineprint} { color: #52687B !important; }
  /* Enlarged Google Connect layout; only presentation, no workflow changes. */
  .bm-google-connect-theme .${styles.setup} {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr) !important;
    align-items: center !important;
  }
  .bm-google-connect-theme .${styles.setup} > section { min-width: 0; }
  .bm-google-connect-theme .${styles.title} {
    font-size: clamp(49px, 4.77vw, 77px) !important;
    line-height: 1.02 !important;
    letter-spacing: -.045em !important;
  }
  .bm-google-connect-theme .${styles.eyebrow} { font-size: 13.5px !important; }
  .bm-google-connect-theme .${styles.intro} { font-size: clamp(16px, 1.22vw, 20px) !important; line-height: 1.6 !important; }
  .bm-google-connect-theme .${styles.feature} b { font-size: 14.5px !important; }
  .bm-google-connect-theme .${styles.feature} p { font-size: 14.5px !important; line-height: 1.6 !important; }
  .bm-google-connect-theme .${styles.connectCard} {
    width: 100% !important;
    max-width: none !important;
    padding: clamp(29px, 3.06vw, 49px) !important;
    border-radius: 22px !important;
  }
  .bm-google-connect-theme .${styles.connectCard} h2 { font-size: clamp(25px, 2.07vw, 34px) !important; line-height: 1.15 !important; }
  .bm-google-connect-theme .${styles.connectCard} > p { font-size: 15.5px !important; line-height: 1.6 !important; }
  .bm-google-connect-theme .${styles.connectCard} :is(a,button) { font-size: 14.5px !important; }
  @media (max-width: 900px) {
    .bm-google-connect-theme { padding: 24px 16px 56px; }
    .bm-google-connect-theme .${styles.setup} { max-width: 680px; grid-template-columns: 1fr !important; gap: 28px; }
    .bm-google-connect-theme .${styles.title} { font-size: clamp(38px, 7.2vw, 58px) !important; }
    .bm-google-connect-theme .${styles.connectCard} { padding: 25px !important; }
  }
  .bm-google-connect-theme :is(a,button):focus-visible {
    outline: 2px solid #92BC00 !important;
    outline-offset: 3px;
  }
`;

type Props = { variant?: "setup" | "settings" | "gate"; children?: React.ReactNode };
export default function GoogleConnectionPanel({ variant = "setup", children }: Props) {
  const connection = useGoogleConnection();
  const { status, loading, activating, error, unauthorized, refresh, activate } = connection;
  const router = useRouter();
  useEffect(() => {
    if (variant === "setup" && status?.connected) router.replace("/settings");
  }, [variant, status?.connected, router]);

  // Decide routing only after the Google status check finishes.
  // This keeps the dashboard hidden for unconnected companies.
  useEffect(() => {
    if (variant !== "gate" || loading || unauthorized || error || !status) return;
    if (!status.connected) {
      router.replace("/onboarding/company/gmail");
    } else if (!status.ready) {
      router.replace("/settings");
    }
  }, [variant, loading, unauthorized, error, status?.connected, status?.ready, router]);

  // When Gmail onboarding is the selected destination, show its real page
  // immediately. Keep connected users out while redirecting to Settings.
  if (variant === "setup" && status?.connected === true) {
    return null;
  }

  // BMJ_GATE_ROUTING_FIX: Never show dashboard before Google readiness is known.
  // Unconnected -> Connect Gmail; connected but not ready -> Settings;
  // ready -> Dashboard. Existing auth protection stays in proxy.ts.
  if (variant === "gate") {
    if (!loading && status?.ready && !unauthorized && !error) {
      return <>{children}</>;
    }

    // Keep the protected dashboard unmounted while checking or redirecting.
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F3F6F9] px-6 text-[#0B2033]">
        {unauthorized ? (
          <a href="/login?next=/dashboard" className="rounded-xl bg-[#B9EB00] px-5 py-3 font-bold text-[#061B2B]">Log in</a>
        ) : error ? (
          <div className="rounded-2xl border border-[#D7E0EA] bg-white p-8">
            <p role="alert" className="text-red-700">{error}</p>
            <a href="/settings" className="mt-4 inline-block font-bold text-[#0B4F6A] underline">Check connection settings</a>
          </div>
        ) : (
          <p role="status" className="text-sm font-semibold">Checking company connection...</p>
        )}
      </main>
    );
  }
  const connected = Boolean(status?.connected);
  const reconnect = Boolean(status?.reconnectRequired);
  const title = loading && variant !== "setup" ? "Checking your connection…" : unauthorized ? "Sign in to continue" : error && !status ? "Let’s check your connection" : reconnect ? "Reconnect your Google account" : connected ? "Your Google account is connected" : "Connect your company inbox";
  const primary = unauthorized ? <a className={styles.primary} href="/login?next=/settings">Sign in</a>
    : !status || loading ? null
    : !connected ? <a className={styles.primary} href="/api/google/connect"><GoogleMark />{reconnect ? "Reconnect Google account" : "Connect Gmail & Calendar"}<span aria-hidden="true">→</span></a>
    : !status.ready && status.gmailIngestionEnabled !== false ? <button className={styles.primary} type="button" onClick={activate} disabled={activating}>{activating ? "Enabling inbox capture…" : "Enable inbox capture"}</button>
    : null;
  const explanation = connected
    ? status?.ready ? "Your company inbox is linked and lead capture is enabled. Customize your company below, then head to your dashboard."
      : status?.gmailIngestionEnabled === false ? "Lead capture is disabled for this inbox. Contact your workspace administrator to review mailbox ownership before enabling it."
      : "Your account is linked. Enable inbox capture to receive new leads; you don’t need to sign in to Google again."
    : reconnect ? "Google authorization needs to be renewed. Reconnect the account this company uses for Gmail and Calendar."
    : "Link the Gmail and Google Calendar your company uses for customer requests and appointments.";
  const errorBlock = error ? <div className={styles.error} role="alert">{unauthorized ? "Your session has ended. Sign in to continue securely." : error}</div> : null;

  if (variant === "settings") return <section className={`${styles.card} ${styles.connection}`} aria-label="Google connection">
    <div>
      <div className={styles.cardTop}><span className={styles.icon}><Icon name="mail" /></span><div><h2>{title}</h2>{status?.googleAccountEmail && <p className={styles.mailbox}>{status.googleAccountEmail}</p>}</div></div>
      <p>{explanation}</p>
      {errorBlock}
      <div className={styles.actions}>{primary}<button type="button" className={styles.linkButton} onClick={() => void refresh()} disabled={loading || activating}>Check connection</button></div>
    </div>
    {!loading && status && <span className={`${styles.pill} ${!status.ready ? styles.pending : ""}`}>{status.ready ? "Lead capture enabled" : connected ? "Setup needs attention" : "Not connected"}</span>}
  </section>;

  return <WorkspaceShell>
    <div className="bm-google-connect-theme">
      <style dangerouslySetInnerHTML={{ __html: bmGoogleTheme }} />
      <ol className={styles.steps} aria-label="Setup progress"><li><b>✓</b>Account created</li><li className={styles.current} aria-current="step"><b>2</b>Connect Google</li><li><b>3</b>Customize & launch</li></ol>
      <div className={styles.setup}>
        <section><p className={styles.eyebrow}>YOUR INBOX. YOUR NEXT OPPORTUNITY.</p>
          <h1 className={styles.title}>Put your next<br />HVAC job <span className={styles.accent}>in motion.</span></h1>
          <p className={styles.intro}>One connection brings customer conversations and your calendar into BookMoreJobs. Set it up once. Keep your focus on the job.</p>
          <div className={styles.features}>
            {([
              ["mail", "Catch the request", "Turn incoming customer emails into leads."],
              ["clock", "Keep the conversation moving", "Answer customers and collect the details you need."],
              ["calendar", "Book real availability", "Use your company calendar, hours, and appointment length."],
            ] as const).map(([icon, heading, copy]) => <div className={styles.feature} key={icon}><span className={styles.icon}><Icon name={icon} /></span><div><b>{heading}</b><p>{copy}</p></div></div>)}
          </div>
        </section>
        <section className={`${styles.card} ${styles.connectCard}`} aria-label="Connect Google">
          <div className={styles.apps}><span className={styles.appTile}><GoogleMark /></span><span aria-hidden="true" style={{ color: "#7284a0" }}>＋</span><span className={styles.icon}><Icon name="calendar" /></span><span className={styles.pill}>COMPANY WORKSPACE</span></div>
          <h2>{title}</h2><p>{explanation}</p>
          {status?.googleAccountEmail && <p className={styles.mailbox}>{status.googleAccountEmail}</p>}
          {loading && variant !== "setup" && <p role="status">Checking saved connection status…</p>}
          {primary}
          {connected && <a className={styles.primary} href="/settings">Continue to company settings <span aria-hidden="true">→</span></a>}
          {errorBlock}
          <div className={styles.actions}><button type="button" className={styles.linkButton} onClick={() => void refresh()} disabled={loading || activating}>Check connection again</button></div>
          <div className={styles.divider} />
          <p className={styles.fineprint}>Choose this company’s Google account. Google will ask you to approve access to email and calendar features used for lead replies and bookings.</p>
          <p className={styles.fineprint}>Next: customize your company details, appointment length, and follow-up preferences.</p>
        </section>
      </div>
    </div>
  </WorkspaceShell>;
}