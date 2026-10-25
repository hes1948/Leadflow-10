import { google } from "googleapis";
import { CalendarProvider } from "./index";

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

auth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: "v3", auth });

export const GoogleCalendarProvider: CalendarProvider = {
  async createEvent(title: string, start: string) {
    const end = new Date(
      new Date(start).getTime() + 30 * 60000
    );

    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end.toISOString() },
      },
    });

    return res.data;
  },
};