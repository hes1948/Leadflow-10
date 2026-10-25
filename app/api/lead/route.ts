import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/getUser";
import { validateLeadMessage } from "@/lib/validation/leadValidation";
import { supabase } from "@/lib/supabase";
import { acquireIntakePermit } from "@/lib/intake/admission";

export async function POST(req: Request) {
  let release: (() => void) | undefined;
  try {
    release = await acquireIntakePermit(req.signal);
    const user = await getUser();
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: "invalid_lead_payload" }, { status: 400 });
    }
    if ("companyId" in body || "company_id" in body) {
      return NextResponse.json({ success: false, error: "company_id_must_come_from_authenticated_session" }, { status: 400 });
    }
    const validation = validateLeadMessage(body.message ?? body.body ?? body.input ?? "");
    if (!validation.valid) {
      return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
    }
    const requestKey = req.headers.get("Idempotency-Key")?.trim() || null;
    if (requestKey && requestKey.length > 200) {
      return NextResponse.json({ success: false, error: "invalid_idempotency_key" }, { status: 400 });
    }
    // Company lookup, durable enqueue, and event recording use one DB transaction.
    if (req.signal.aborted) throw new Error("intake_request_aborted");
    const { data, error } = await supabase.rpc("leadflow_enqueue_authenticated_intake", {
      p_user_id: user.id,
      p_message: validation.cleanMessage,
      p_request_key: requestKey,
      p_request_day: Math.floor(Date.now() / 86400000),
    });
    if (error) throw new Error(error.message);
    if (!data?.companyId || !data?.jobId) throw new Error("intake_rpc_invalid_result");
    return NextResponse.json({ success: true, queued: true, companyId: data.companyId, jobId: data.jobId }, { status: 202 });
  } catch (error: any) {
    const message = error?.message ?? "lead_intake_failed";
    const status = message === "unauthorized" ? 401
      : message === "company_not_found" ? 403
      : message === "intake_busy" ? 503
      : message === "intake_request_aborted" ? 499 : 500;
    if (status === 500 || status === 503) console.error("LEAD_INTAKE_ERROR", { message });
    return NextResponse.json({ success: false, error: message }, {
      status,
      ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}),
    });
  } finally {
    release?.();
  }
}
