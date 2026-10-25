// lib/jobs/sendFollowUpJob.ts

import { supabase } from "@/lib/supabase";
import { sendLeadReply } from "@/lib/email/sendLeadReply";
import { requireCompany } from "@/lib/company/resolveCompany";
import type { SendFollowUpJobData } from "@/lib/background-jobs/backgroundJobTypes";

function isTerminalStatus(status?: string | null) {
  return (
    status === "booked" ||
    status === "completed" ||
    status === "closed" ||
    status === "duplicate" ||
    status === "outside_service_area" ||
    status === "spam"
  );
}

export async function sendFollowUpJob(data: SendFollowUpJobData) {
  if (!data.companyId) throw new Error("missing_company_id");
  if (!data.leadId) throw new Error("missing_lead_id");

  const company = await requireCompany(data.companyId);

  const maxFollowUps = Number(company.max_follow_ups);

  if (
    !Number.isFinite(maxFollowUps) ||
    !Number.isInteger(maxFollowUps) ||
    maxFollowUps < 0
  ) {
    throw new Error("invalid_company_max_follow_ups");
  }

  const { data: lead, error } = await supabase
    .from("leads")
    .select(
      `
      id,
      company_id,
      email,
      status,
      follow_up_count,
      last_email_subject
      `
    )
    .eq("id", data.leadId)
    .eq("company_id", data.companyId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!lead) throw new Error("lead_not_found");

  if (lead.company_id !== company.id) {
    throw new Error("lead_company_scope_violation");
  }

  if (isTerminalStatus(lead.status)) {
    return {
      success: true,
      skipped: true,
      reason: `blocked_status_${lead.status}`,
      leadId: data.leadId,
    };
  }

  if (lead.status !== "awaiting_customer") {
    return {
      success: true,
      skipped: true,
      reason: `not_awaiting_customer_${lead.status ?? "unknown"}`,
      leadId: data.leadId,
    };
  }

  if (!lead.email) {
    return {
      success: true,
      skipped: true,
      reason: "missing_customer_email",
      leadId: data.leadId,
    };
  }

  const currentFollowUpCount = Number(lead.follow_up_count ?? 0);

  if (currentFollowUpCount >= maxFollowUps) {
    return {
      success: true,
      skipped: true,
      reason: "max_followups_reached",
      leadId: data.leadId,
      followUpCount: currentFollowUpCount,
      maxFollowUps,
    };
  }

  const body = [
    "Just checking in — do you still need help with your HVAC request?",
    "",
    "Reply with a time that works and we can get you scheduled.",
  ].join("\n");

  const result = await sendLeadReply({
    companyId: data.companyId,
    leadId: data.leadId,
    to: lead.email,
    subject: lead.last_email_subject ?? "Re: Your HVAC Request",
    body,
    isFollowUp: true,
  });

  return {
    success: true,
    skipped: false,
    companyId: data.companyId,
    leadId: data.leadId,
    messageId: result.messageId,
    threadId: result.threadId,
    followUpCount: result.followUpCount,
    nextFollowUpAt: result.nextFollowUpAt,
    status: result.status,
    maxFollowUps,
  };
}