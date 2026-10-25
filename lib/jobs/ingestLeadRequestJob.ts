// lib/jobs/ingestLeadRequestJob.ts

import crypto from "crypto";
import { supabase } from "@/lib/supabase";
import { extractLeadData } from "@/lib/ai/extractLeadData";
import { validateLeadMessage } from "@/lib/validation/leadValidation";
import {
  isInsideCompanyServiceArea,
  requireCompany,
} from "@/lib/company/resolveCompany";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import type { ProcessNewLeadJobData } from "@/lib/background-jobs/backgroundJobTypes";

type LeadStatus =
  | "new"
  | "contacted"
  | "awaiting_customer"
  | "booked"
  | "completed"
  | "outside_service_area"
  | "spam"
  | "duplicate"
  | "closed";

function normalize(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function createFingerprint(params: {
  companyId: string;
  phone?: string | null;
  email?: string | null;
  issueSummary: string;
}) {
  const base = [
    normalize(params.companyId),
    normalize(params.phone),
    normalize(params.email),
    normalize(params.issueSummary.slice(0, 120)),
  ]
    .filter(Boolean)
    .join(":");

  return crypto.createHash("sha256").update(base).digest("hex");
}

function getPriority(urgency?: string | null) {
  return urgency === "emergency" || urgency === "high" ? "high" : "normal";
}

function jobResult(payload: any, options?: { status: number }) {
  if ((options?.status ?? 200) >= 400) throw new Error(payload.error ?? "lead_intake_failed");
  return payload;
}

export async function ingestLeadRequestJob(data: { companyId: string; message: string }) {
  try {
    const companyId = data.companyId;

    if (!companyId) throw new Error("missing_company_id");

    const company = await requireCompany(companyId);
    const body = { message: data.message };

    if ("companyId" in body || "company_id" in body) {
      return jobResult(
        {
          success: false,
          error: "company_id_must_come_from_authenticated_session",
        },
        { status: 400 }
      );
    }

    const rawMessage = body.message;
    const validation = validateLeadMessage(rawMessage);

    if (!validation.valid) {
      return jobResult(
        {
          success: false,
          error: validation.error,
        },
        { status: 400 }
      );
    }

    const cleanMessage = validation.cleanMessage;
    const qualification = await extractLeadData(cleanMessage);

    const city = qualification.location?.city ?? null;
    const state = qualification.location?.state ?? null;
    const zip = qualification.location?.zip ?? null;

    const outsideServiceArea = !isInsideCompanyServiceArea({
      company,
      city,
      state,
      zip,
    });

    const fingerprint = createFingerprint({
      companyId: company.id,
      phone: qualification.phone,
      email: qualification.email,
      issueSummary: qualification.issueSummary,
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: existingDuplicate, error: duplicateError } = await supabase
      .from("leads")
      .select("id")
      .eq("company_id", company.id)
      .eq("fingerprint", fingerprint)
      .gte("created_at", since)
      .limit(1)
      .maybeSingle();

    if (duplicateError) {
      return jobResult(
        { success: false, error: duplicateError.message },
        { status: 500 }
      );
    }

    if (existingDuplicate) {
      const { data: duplicateLead, error: insertDuplicateError } =
        await supabase
          .from("leads")
          .insert({
            company_id: company.id,
            input: cleanMessage,
            message: cleanMessage,
            reply: null,
            status: "duplicate" satisfies LeadStatus,
            priority: getPriority(qualification.urgency),
            type: qualification.serviceType,
            email: qualification.email,
            phone: qualification.phone,
            customer_name: qualification.customerName,
            address: qualification.location?.address ?? null,
            city,
            state,
            zip,
            preferred_time: qualification.preferredTime,
            issue_summary: qualification.issueSummary,
            qualification,
            fingerprint,
            duplicate_of: existingDuplicate.id,
            duplicate_detected_at: new Date().toISOString(),
          })
          .select()
          .single();

      if (insertDuplicateError) {
        return jobResult(
          { success: false, error: insertDuplicateError.message },
          { status: 500 }
        );
      }

      return jobResult({
        success: true,
        duplicate: true,
        queued: false,
        companyId: company.id,
        existingLeadId: existingDuplicate.id,
        lead: duplicateLead,
        qualification,
      });
    }

    const status: LeadStatus = outsideServiceArea
      ? "outside_service_area"
      : "new";

    const { data: lead, error: insertError } = await supabase
      .rpc("leadflow_insert_lead", { p_row: {
        company_id: company.id,
        input: cleanMessage,
        message: cleanMessage,
        reply: null,
        status,
        priority: getPriority(qualification.urgency),
        type: qualification.serviceType,
        email: qualification.email,
        phone: qualification.phone,
        customer_name: qualification.customerName,
        address: qualification.location?.address ?? null,
        city,
        state,
        zip,
        preferred_time: qualification.preferredTime,
        issue_summary: qualification.issueSummary,
        qualification,
        fingerprint,
      } })
      .single<{ id: string; company_id: string; status: string; duplicate_of?: string | null }>();

    if (insertError) {
      return jobResult(
        { success: false, error: insertError.message },
        { status: 500 }
      );
    }

    if (!lead?.id || lead.company_id !== company.id) {
      throw new Error("lead_company_scope_violation");
    }

    if (lead.status === "duplicate") {
      return jobResult({ success: true, duplicate: true, queued: false,
        companyId: company.id, existingLeadId: lead.duplicate_of, lead, qualification });
    }
    let jobId: string | null = null;

    if (!outsideServiceArea) {
      const jobData: ProcessNewLeadJobData = {
        companyId: company.id,
        leadId: lead.id,
      };

      const job = await enqueueBackgroundJob({
        name: "process_new_lead",
        jobId: `process_new_lead:${company.id}:${lead.id}`,
        data: jobData,
      });

      jobId = job.id ?? null;
    }

    return jobResult({
      success: true,
      duplicate: false,
      queued: !outsideServiceArea,
      jobId,
      companyId: company.id,
      lead,
      qualification,
      outsideServiceArea,
    });
  } catch (err: any) {
    const message = err?.message ?? "lead_intake_failed";

    return jobResult(
      {
        success: false,
        error: message,
      },
      {
        status:
          message === "unauthorized"
            ? 401
            : message === "missing_company_id" || message === "company_not_found"
            ? 403
            : 500,
      }
    );
  }
}