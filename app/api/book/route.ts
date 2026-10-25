// app/api/book/route.ts

import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import type { BookAppointmentJobData } from "@/lib/background-jobs/backgroundJobTypes";

export async function POST(req: Request) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      return NextResponse.json(
        {
          success: false,
          error: "missing_company_id",
        },
        { status: 403 }
      );
    }

    const body = await req.json();

    if (
      !body.leadId ||
      typeof body.leadId !== "string" ||
      !body.leadId.trim()
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "missing_lead_id",
        },
        { status: 400 }
      );
    }

    if (
      !body.scheduledAt ||
      typeof body.scheduledAt !== "string" ||
      !body.scheduledAt.trim()
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "missing_scheduled_at",
        },
        { status: 400 }
      );
    }

    const leadId = body.leadId.trim();
    const startTime = body.scheduledAt.trim();

    const startDate = new Date(startTime);

    if (Number.isNaN(startDate.getTime())) {
      return NextResponse.json(
        {
          success: false,
          error: "invalid_scheduled_at",
        },
        { status: 400 }
      );
    }

    const jobData: BookAppointmentJobData = {
      companyId,
      leadId,
      startTime: startDate.toISOString(),
      description:
        typeof body.notes === "string" && body.notes.trim()
          ? body.notes.trim()
          : null,
      attendeeName:
        typeof body.customerName === "string" && body.customerName.trim()
          ? body.customerName.trim()
          : null,
      attendeeEmail:
        typeof body.customerEmail === "string" && body.customerEmail.trim()
          ? body.customerEmail.trim()
          : null,
      customerPhone:
        typeof body.customerPhone === "string" && body.customerPhone.trim()
          ? body.customerPhone.trim()
          : null,
      source: "manual_booking",
    };

    const job = await enqueueBackgroundJob<BookAppointmentJobData>({
      name: "book_appointment",
      jobId: `book_appointment:${companyId}:${leadId}:${startDate.toISOString()}`,
      data: jobData,
    });

    return NextResponse.json({
      success: true,
      queued: true,
      status: "booking_queued",
      jobId: job.id,
    });
  } catch (err: any) {
    const message = err?.message ?? "booking_enqueue_failed";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status: message === "unauthorized" ? 401 : 500,
      }
    );
  }
}