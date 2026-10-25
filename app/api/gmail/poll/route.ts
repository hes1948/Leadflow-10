// app/api/gmail/poll/route.ts

import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { getAuthenticatedCompanyId } from "@/lib/tenant/getAuthenticatedCompanyId";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function json(payload: Record<string, any>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

async function handleRecovery() {
  try {
    const user = await getUser();
    const companyId = await getAuthenticatedCompanyId(user.id);

    if (!companyId) {
      throw new Error("missing_company_id");
    }

    const recovery = await enqueueBackgroundJob({ name: "maintain_gmail_mailbox",
      jobId: `maintain_gmail_mailbox:${companyId}:poll:${Date.now()}`, data: { companyId }, priority: 50 });
    const watch = { queued: true, jobId: recovery.id };

    return json({
      success: true,
      route: "/api/gmail/poll",
      mode: "authenticated_gmail_recovery",
      companyId,
      recovery,
      watch,
    });
  } catch (error: any) {
    const message = error?.message ?? "gmail_recovery_failed";

    return json(
      {
        success: false,
        route: "/api/gmail/poll",
        mode: "authenticated_gmail_recovery",
        error: message,
      },
      message === "unauthorized" ? 401 : 500
    );
  }
}

export async function GET() {
  return handleRecovery();
}

export async function POST() {
  return handleRecovery();
}

export async function HEAD() {
  return new Response(null, { status: 200 });
}

export async function OPTIONS() {
  return json({
    success: true,
    route: "/api/gmail/poll",
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
  });
}
