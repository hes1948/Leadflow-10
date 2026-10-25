// app/api/calendar/test/route.ts

import { NextResponse } from "next/server";
import { getCompanyCalendarClient } from "@/lib/google/companyGoogle";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export async function GET() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);
    const googleCalendar = await getCompanyCalendarClient(companyId);

    const result =
      await googleCalendar.calendarList.list();

    const calendars =
      result.data.items?.map((item) => ({
        id: item.id ?? null,
        summary: item.summary ?? null,
        primary: item.primary ?? false,
      })) ?? [];

    return NextResponse.json({
      success: true,
      calendars,
    });
  } catch (err: any) {
    console.error(
      "CALENDAR TEST FAILED:",
      err
    );

    return NextResponse.json(
      {
        success: false,
        error:
          err?.message ??
          "calendar_test_failed",
      },
      { status: err?.message === "unauthorized" ? 401 : 500 }
    );
  }
}