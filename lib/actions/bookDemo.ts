import { createEvent } from "@/lib/calendar";
import { resend } from "@/lib/resend";

function extractEmail(lead: any, fallback: string) {
  const match =
    lead?.input?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  return match?.[0] || lead?.email || fallback || "test@example.com";
}

export async function handleDemoBooking(emailText: string, lead: any) {
  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  let calendarResult: any = null;
  let calendarError: string | null = null;

  // CALENDAR IS OPTIONAL (DO NOT BREAK FLOW)
  try {
    calendarResult = await createEvent("Demo Call - AI Ops", start);
  } catch (err: any) {
    console.error("CALENDAR ERROR:", err?.message);
    calendarError = err?.message || "calendar_failed";
  }

  // EMAIL MUST ALWAYS WORK
  try {
    await resend.emails.send({
      from: "AI Ops <onboarding@resend.dev>",
      to: extractEmail(lead, emailText),
      subject: "Demo Confirmed",
      html: `
        <p>You're booked.</p>
        <p>Time: ${start}</p>
        <p>Status: ${calendarError ? "Pending confirmation" : "Confirmed"}</p>
      `,
    });
  } catch (err: any) {
    console.error("EMAIL ERROR:", err?.message);
  }

  return {
    success: true,
    timestamp: start,
    calendar: {
      success: !calendarError,
      error: calendarError,
      eventId: calendarResult?.id || null,
    },
  };
}