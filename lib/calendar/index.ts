// lib/calendar/index.ts

export interface CalendarProvider {
  createEvent(
    title: string,
    start: string
  ): Promise<any>;
}