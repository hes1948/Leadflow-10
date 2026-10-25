// app/api/send-email/route.ts

import { NextResponse } from "next/server";
import { sendLeadReply } from "@/lib/email/sendLeadReply";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";

export async function POST(req: Request) {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      throw new Error("missing_company_id");
    }

    const body = await req.json();

    if ("companyId" in body || "company_id" in body) {
      return NextResponse.json(
        {
          success: false,
          error: "company_id_must_come_from_authenticated_session",
        },
        { status: 400 }
      );
    }

    const leadId = body.id ?? body.leadId;

    if (!leadId || typeof leadId !== "string") {
      return NextResponse.json(
        {
          success: false,
          error: "missing_lead_id",
        },
        { status: 400 }
      );
    }

    const result = await sendLeadReply({
      companyId,
      leadId,
      idempotencyKey: req.headers.get("Idempotency-Key") ?? undefined,
      to: body.to,
      subject: body.subject ?? "Re: Your HVAC Request",
      body: body.body ?? body.message ?? body.reply ?? "",
      isFollowUp: body.isFollowUp === true,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    const message = err?.message ?? "send_email_failed";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status:
          message === "company_busy_retry_request"
            ? 409
            : message === "unauthorized"
            ? 401
            : message === "company_not_found" || message === "missing_company_id"
            ? 403
            : 500,
      }
    );
  }
}