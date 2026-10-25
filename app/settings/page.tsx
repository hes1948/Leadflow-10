"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabaseBrowser";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import { Icon } from "@/components/workspace/Icons";
import GoogleConnectionPanel from "@/components/onboarding/GoogleConnectionPanel";
import styles from "@/components/workspace/workspace.module.css";
import { buildSettingsPayload, settingsDraft, DAYS, type CompanySettings, type SettingsDraft, type Hours } from "@/lib/settings/companySettingsForm";

// Visual theme only. Uses the existing workspace CSS-module selectors and does not
// change company settings state, requests, validation, or save behavior.
const settingsThemeCss = `
  /* Keep the settings page restrained white, but bring the blues fully in line with the dashboard. */
  body:has(.bm-settings-theme) { background: #f3f6f9 !important; }
  .bm-settings-theme {
    background: #f3f6f9 !important;
    color: #17283c;
    min-height: 100vh;
    padding: 20px 22px 110px;
    border-radius: 18px;
    box-shadow: 0 0 0 100vmax #f3f6f9;
    clip-path: inset(-100vmax -100vmax -100vmax -100vmax);
  }
  .bm-settings-theme .${styles.topline} { border-color: #d7e0ea; }
  .bm-settings-theme .${styles.eyebrow} { color: #187254 !important; letter-spacing: .14em; }
  .bm-settings-theme .${styles.card} .${styles.eyebrow} { color: #c7f000 !important; }
  .bm-settings-theme .${styles.title} { color: #0b2033 !important; }
  .bm-settings-theme .${styles.intro} { color: #506478 !important; }
  .bm-settings-theme .${styles.card} {
    background: linear-gradient(140deg, #04263c 0%, #073650 68%, #0b4f6a 100%) !important;
    border: 1px solid #23536e !important;
    color: #eef7fd !important;
    box-shadow: 0 14px 34px rgba(4, 21, 36, .18) !important;
  }
  .bm-settings-theme .${styles.card} h2,
  .bm-settings-theme .${styles.cardTop} h2 { color: #ffffff !important; }
  .bm-settings-theme .${styles.card} p,
  .bm-settings-theme .${styles.cardTop} p,
  .bm-settings-theme .${styles.card} small { color: #bfd1df !important; }
  .bm-settings-theme .${styles.icon} {
    background: rgba(18, 88, 120, .42) !important;
    border-color: #2a607b !important;
    color: #c7f000 !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
  }
  .bm-settings-theme .${styles.field} > span,
  .bm-settings-theme .${styles.hours} label { color: #e9f3fb !important; }
  .bm-settings-theme .${styles.field} input,
  .bm-settings-theme .${styles.field} select,
  .bm-settings-theme .${styles.field} textarea,
  .bm-settings-theme .${styles.hours} input[type="time"] {
    background: #061b2c !important;
    border: 1px solid #2c5870 !important;
    color: #f7fcff !important;
    color-scheme: dark;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
  }
  .bm-settings-theme .${styles.field} input::placeholder,
  .bm-settings-theme .${styles.field} textarea::placeholder { color: #89a3b8 !important; }
  .bm-settings-theme input:focus-visible,
  .bm-settings-theme select:focus-visible,
  .bm-settings-theme textarea:focus-visible {
    outline: 2px solid #c7f000 !important;
    outline-offset: 2px;
  }
  .bm-settings-theme input[type="checkbox"] { accent-color: #c7f000; }
  .bm-settings-theme .${styles.hours} { border-color: #214963 !important; }
  .bm-settings-theme .${styles.primary} {
    background: #95b81f !important;
    color: #081521 !important;
    border-color: #95b81f !important;
    font-weight: 800;
    box-shadow: 0 10px 24px rgba(149, 184, 31, .16);
  }
  .bm-settings-theme .${styles.primary}:hover:not(:disabled) { background: #aacd29 !important; }
  .bm-settings-theme .${styles.primary}:disabled { opacity: .48; cursor: not-allowed; }
  .bm-settings-theme .${styles.secondary} {
    background: #0d3850 !important;
    border: 1px solid #35627a !important;
    color: #f1f8fb !important;
  }
  .bm-settings-theme .${styles.secondary}:hover { border-color: #c7f000 !important; }
  .bm-settings-theme .${styles.savebar} {
    background: linear-gradient(145deg, #04263c 0%, #07314a 100%) !important;
    border: 1px solid #24556f !important;
    color: #f3f9ff !important;
    box-shadow: 0 12px 34px rgba(4, 20, 35, .22) !important;
  }
  .bm-settings-theme .${styles.savebar} p { color: #f3f9ff !important; }
  .bm-settings-theme .${styles.savebar} small { color: #bed0df !important; }
  .bm-settings-theme .${styles.linkButton} { color: #cfe4f1 !important; }
  .bm-settings-theme .${styles.notice} { background: #0a3647 !important; color: #d2f7ff !important; border-color: #286b81 !important; }
  .bm-settings-theme .${styles.success} { background: #0a3b33 !important; color: #c5ffdd !important; border-color: #338773 !important; }
  .bm-settings-theme .${styles.error} { background: #4b202c !important; color: #ffe4e9 !important; border-color: #a44d61 !important; }
  /* Dashboard-style navy navigation — header only. */
  .bm-settings-topnav {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 9999;
    height: 76px;
    background: linear-gradient(90deg, #051d2f 0%, #08273c 100%);
    display: flex;
    align-items: stretch;
    color: white;
    box-shadow: 0 1px 0 #1b4761;
  }
  .bm-settings-topnav-main {
    display: flex;
    position: relative;
    width: 100%;
    align-items: center;
    padding: 0 32px;
    min-width: 0;
  }
  .bm-settings-topnav-main small { display: block; font-size: 12px; color: #9fc9e8; }
  .bm-settings-topnav-main strong { display: block; font-size: 19px; margin-top: 4px; }
  /* Exact viewport midpoint: navigation group is centered independent of brand width. */
  .bm-settings-nav-links {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 24px;
    white-space: nowrap;
  }
  .bm-settings-topnav-link {
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: white;
    padding: 9px 7px;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.25;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color .15s ease, color .15s ease;
  }
  .bm-settings-topnav-link:hover {
    background: #b9eb00;
    color: #061b2b;
  }
  .bm-settings-topnav-link:disabled { opacity: .6; cursor: wait; }
  .bm-settings-topnav-link:focus-visible { outline: 2px solid #c7f000; outline-offset: 2px; }
  @media (max-width: 1199px) {
    .bm-settings-topnav { height: auto; min-height: 76px; position: relative; }
    .bm-settings-topnav-main { flex-wrap: wrap; justify-content: center; gap: 14px; padding: 14px 18px; }
    .bm-settings-topnav-brand { width: 100%; text-align: center; }
    .bm-settings-nav-links { position: static; transform: none; flex-wrap: wrap; gap: 12px; }
    .bm-settings-topnav-link { font-size: 20px; }
  }
`;

function SectionTitle({ icon, title, copy }: { icon: "company" | "calendar" | "clock" | "settings"; title: string; copy: string }) {
  return <div className={styles.cardTop}><span className={styles.icon}><Icon name={icon} /></span><div><h2>{title}</h2><p>{copy}</p></div></div>;
}

export default function SettingsPage() {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saved, setSaved] = useState<SettingsDraft | null>(null);
  const [hours, setHours] = useState<Hours | null>(null);
  const [savedHours, setSavedHours] = useState<Hours | null>(null);
  const [hoursEdited, setHoursEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [notice, setNotice] = useState("");
  const [success, setSuccess] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || hoursEdited;

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const { error: signOutError } = await createSupabaseBrowserClient().auth.signOut();
      if (signOutError) throw signOutError;
      window.location.assign("/login");
    } catch (logoutError) {
      console.error("Logout failed:", logoutError);
      setLoggingOut(false);
      window.alert("Could not sign out. Please try again.");
    }
  }

  function acceptSettings(settings: CompanySettings) {
    const value = settingsDraft(settings);
    setDraft(value); setSaved(value);
    // Preserve the saved object. Never replace custom business-hour formats
    // with display defaults when saving unrelated company preferences.
    setHours(settings.business_hours ?? null); setSavedHours(settings.business_hours ?? null); setHoursEdited(false);
  }
  async function loadSettings() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/company/settings", { cache: "no-store" });
      setUnauthorized(response.status === 401);
      const data = await response.json();
      if (!response.ok || !data.success || !data.settings) throw new Error("load_failed");
      acceptSettings(data.settings);
    } catch { setError("We couldn’t load your company settings. Please try again."); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void loadSettings();
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    if (google === "connected") setNotice(params.get("watch") === "pending"
      ? "Google account connected. Finish enabling inbox capture below, then customize your company."
      : "Google account connected. Make this workspace yours, then open your dashboard.");
    if (google === "cancelled") setNotice("Google sign-in was cancelled. Your existing settings have been kept.");
    if (google === "failed" || google === "error") setNotice("Google connection wasn’t completed. Check the connection card below and try again.");
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true); setError(""); setSuccess("");
    try {
      const payload = buildSettingsPayload(draft, hoursEdited && hours ? hours : undefined);
      const response = await fetch("/api/company/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      setUnauthorized(response.status === 401);
      const data = await response.json();
      if (!response.ok || !data.success || !data.settings) throw new Error(response.status === 401 ? "Please sign in again before saving." : "Your changes weren’t saved. Please try again.");
      acceptSettings(data.settings);
      setSuccess("Settings saved. Your new preferences are ready for future replies and bookings.");
    } catch (err) { setError(err instanceof Error ? err.message : "Your changes weren’t saved. Please try again."); }
    finally { setSaving(false); }
  }
  function field(key: keyof SettingsDraft, label: string, options: { type?: string; min?: number; max?: number; help?: string; full?: boolean; step?: string } = {}) {
    if (!draft) return null;
    return <label className={`${styles.field} ${options.full ? styles.full : ""}`}><span>{label}</span><input type={options.type || "text"} value={draft[key]} required={key === "name" || options.type === "number"} min={options.min} max={options.max} step={options.step || "1"} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setSuccess(""); }} />{options.help && <small>{options.help}</small>}</label>;
  }
  const standardHours = !hours || (typeof hours === "object" && !Array.isArray(hours) && DAYS.every(day => {
    const window = hours[day];
    return window === null || (window && typeof window.open === "string" && typeof window.close === "string");
  }));
  function updateHours(day: string, value: { open: string; close: string } | null) {
    const current = hours ?? Object.fromEntries(DAYS.map((d, i) => [d, i < 5 ? { open: "08:00", close: "17:00" } : null]));
    setHours({ ...current, [day]: value }); setHoursEdited(true); setSuccess("");
  }

  return <WorkspaceShell active="settings">
    <header className="bm-settings-topnav" aria-label="BookMoreJobs navigation">
      <div className="bm-settings-topnav-main">
        <div className="bm-settings-topnav-brand"><small>BookMoreJobs / Settings</small><strong>Settings overview</strong></div>
        <nav className="bm-settings-nav-links" aria-label="Settings page links">
          <Link href="/terms" className="bm-settings-topnav-link">Terms</Link>
          <Link href="/privacy" className="bm-settings-topnav-link">Privacy Policy</Link>
          <Link href="/dashboard" className="bm-settings-topnav-link">Dashboard</Link>
          <Link href="/settings" className="bm-settings-topnav-link">My Account</Link>
          <button type="button" className="bm-settings-topnav-link" onClick={handleLogout} disabled={loggingOut}>{loggingOut ? "Logging out..." : "Log out"}</button>
        </nav>
      </div>
    </header>
    <div className="bm-settings-theme"><style dangerouslySetInnerHTML={{ __html: settingsThemeCss }} />
    <div className={styles.topline}><div><p className={styles.eyebrow}>YOUR COMPANY. YOUR WAY.</p><h1 className={styles.title}>Company settings</h1><p className={styles.intro}>Make BookMoreJobs sound like your team and book around the way you work.</p></div><Link href="/dashboard" className={styles.secondary}>Open dashboard <span aria-hidden="true">↗</span></Link></div>
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <GoogleConnectionPanel variant="settings" />
    {loading ? <div className={styles.card} role="status">Loading company preferences…</div> : !draft ? <div className={styles.card}><h2>Let’s get your settings loaded</h2><p>{unauthorized ? "Your session has ended. Sign in to continue." : error}</p><div className={styles.actions}>{unauthorized ? <a href="/login?next=/settings" className={styles.primary}>Sign in</a> : <button onClick={() => void loadSettings()} className={styles.secondary}>Try again</button>}</div></div> :
      <form onSubmit={saveSettings}>
        <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className={styles.grid}>
            <div className={styles.stack}>
              <section className={styles.card}><SectionTitle icon="company" title="Company identity" copy="The details your customers recognize." /><div className={styles.fields}>
                {field("name", "Company name", { full: true })}
                {field("phone", "Company phone", { type: "tel" })}
                <label className={styles.field}><span>Company time zone</span><select value={draft.timezone} onChange={e => { setDraft({ ...draft, timezone: e.target.value }); setSuccess(""); }}>
                  {[...new Set([draft.timezone, "America/Chicago", "America/New_York", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "UTC"])].map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
                </select></label>
                <label className={`${styles.field} ${styles.full}`}><span>Email signature</span><textarea value={draft.email_signature} onChange={e => { setDraft({ ...draft, email_signature: e.target.value }); setSuccess(""); }} /><small>Used by your company’s reply sender. Include your company name and contact details.</small></label>
              </div></section>
              <section className={styles.card}><SectionTitle icon="settings" title="Booking preferences" copy="Set the defaults for new appointments." /><div className={styles.fields}>
                {field("default_appointment_minutes", "Appointment length (minutes)", { type: "number", min: 1, max: 1440, help: "Used for new booking and availability checks." })}
                {field("dispatch_radius_miles", "Dispatch radius (miles)", { type: "number", min: 1, max: 1000, step: "any", help: "Your company’s default service radius." })}
              </div></section>
              <section className={styles.card}><SectionTitle icon="clock" title="Customer follow-ups" copy="Keep the next step moving." /><div className={styles.fields}>
                {field("follow_up_delay_hours", "Follow-up delay (hours)", { type: "number", min: 1, max: 8760, step: "any" })}
                {field("max_follow_ups", "Maximum follow-ups", { type: "number", min: 1, max: 100 })}
              </div><p>Applies when future follow-ups are scheduled.</p></section>
            </div>
            <div className={styles.stack}>
              <section className={styles.card}><SectionTitle icon="calendar" title="Business hours" copy="Availability follows your company’s time zone." />
                {standardHours ? DAYS.map((day, index) => {
                  const window = hours ? hours[day] : index < 5 ? { open: "08:00", close: "17:00" } : null;
                  return <div className={styles.hours} key={day}>
                    <label><input type="checkbox" checked={Boolean(window)} onChange={e => updateHours(day, e.target.checked ? { open: "08:00", close: "17:00" } : null)} />{day.slice(0, 3).replace(/^./, c => c.toUpperCase())}</label>
                    <input aria-label={`${day} opening time`} type="time" value={window?.open || ""} disabled={!window || saving} required={Boolean(window)} onChange={e => updateHours(day, { ...window!, open: e.target.value })} />
                    <span aria-hidden="true">–</span><input aria-label={`${day} closing time`} type="time" value={window?.close || ""} disabled={!window || saving} required={Boolean(window)} onChange={e => updateHours(day, { ...window!, close: e.target.value })} />
                  </div>;
                }) : <p>Your company uses a custom hours format. Those saved hours will be preserved when you update other preferences.</p>}
                <p>Uncheck a day to close it. Existing appointments remain on the calendar.</p>
              </section>
              <section className={styles.card}><p className={styles.eyebrow}>READY WHEN YOU ARE</p><h2>Set it up. Get back to work.</h2><p>Save your preferences, then manage your leads, appointments, and customer conversations from the dashboard.</p><div className={styles.actions}><Link href="/dashboard" className={styles.secondary}>Go to dashboard <span aria-hidden="true">→</span></Link></div></section>
            </div>
          </div>
        </fieldset>
        <div aria-live="polite" style={{ marginTop: error || success ? 22 : 0 }}>
          {error && <div className={styles.error} role="alert">{error}{unauthorized && <> <a href="/login?next=/settings">Sign in again</a></>}</div>}
          {success && <div className={styles.success} role="status">{success}</div>}
        </div>
        <div className={styles.savebar}><div><p>{saving ? "Saving your preferences…" : dirty ? "You have unsaved changes." : success ? "All changes saved." : "Your workspace, configured for your team."}</p><small>Saved preferences apply to future processing.</small></div><div className={styles.actions} style={{ marginTop: 0 }}>
          {dirty && <button className={styles.linkButton} type="button" disabled={saving} onClick={() => { setDraft(saved); setHours(savedHours); setHoursEdited(false); setError(""); setSuccess(""); }}>Discard</button>}
          <button type="submit" className={styles.primary} disabled={saving || !dirty}>{saving ? "Saving…" : "Save changes"}</button>
        </div></div>
      </form>}
  </div></WorkspaceShell>;
}