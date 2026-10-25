import { google } from "googleapis";

// -------------------------
// AUTH SETUP
// -------------------------
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_REDIRECT_URI;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
  throw new Error("Missing Google Calendar environment variables");
}

const auth = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri
);

auth.setCredentials({
  refresh_token: refreshToken,
});

// optional debug for token rotation
auth.on("tokens", (tokens) => {
  if (tokens.refresh_token) {
    console.log("NEW REFRESH TOKEN:", tokens.refresh_token);
  }
});

// -------------------------
// CALENDAR CLIENT
// -------------------------
const calendar = google.calendar({
  version: "v3",
  auth,
});

// -------------------------
// MAIN FUNCTION: CREATE EVENT
// -------------------------
export async function createEvent(summary: string, start: string) {
  try {
    if (!summary || !start) {
      throw new Error("Missing summary or start time");
    }

    const startDate = new Date(start);

    if (isNaN(startDate.getTime())) {
      throw new Error("Invalid start date format");
    }

    const endDate = new Date(startDate.getTime() + 30 * 60000); // 30 min meeting

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        start: {
          dateTime: startDate.toISOString(),
        },
        end: {
          dateTime: endDate.toISOString(),
        },
      },
    });

    if (!res.data) {
      throw new Error("Failed to create calendar event");
    }

    return {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      status: res.data.status,
      start: res.data.start,
      end: res.data.end,
    };
  } catch (err: any) {
    console.error("CALENDAR ERROR:", err?.response?.data || err);

    throw new Error(
      err?.message || "Calendar event creation failed"
    );
  }
}