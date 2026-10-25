// lib/followup/runFollowUps.ts

import { supabase } from "@/lib/supabase";
import { sendLeadReply } from "@/lib/email/sendLeadReply";
import { requireCompany } from "@/lib/company/resolveCompany";

type RunFollowUpsInput = {
  companyId: string;
};

type FollowUpLead = {
  id: string;
  company_id: string;
  email: string | null;
  phone: string | null;
  customer_name: string | null;
  type: string | null;
  status: string | null;
  preferred_time: string | null;
  issue_summary: string | null;
  follow_up_count: number | null;
  next_follow_up_at: string | null;
  last_email_subject: string | null;
};

function getServiceLabel(type?: string | null) {
  if (type === "hvac") return "HVAC";
  if (type === "roofing") return "roofing";
  if (type === "plumbing") return "plumbing";
  if (type === "electrical") return "electrical";

  return "service";
}

function generateFollowUpMessage(lead: FollowUpLead) {
  const service = getServiceLabel(lead.type);
  const count = Number(lead.follow_up_count ?? 0);

  if (count <= 0) {
    return `Hey — just following up on your ${service} request. Do you still need help getting this looked at?`;
  }

  if (count === 1) {
    return `Hey — checking back one more time on your ${service} request. What time works best for someone to follow up?`;
  }

  return `Hey — final follow-up on your ${service} request. If you still need help, reply here and we can help get this scheduled.`;
}

function shouldSkipLead(lead: FollowUpLead, maxFollowUps: number) {
  if (!lead.company_id) return "missing_company_id";
  if (!lead.email) return "missing_email";

  if (
    lead.status === "booked" ||
    lead.status === "completed" ||
    lead.status === "closed" ||
    lead.status === "duplicate" ||
    lead.status === "spam" ||
    lead.status === "outside_service_area"
  ) {
    return `blocked_status_${lead.status}`;
  }

  if (Number(lead.follow_up_count ?? 0) >= maxFollowUps) {
    return "max_followups_reached";
  }

  return null;
}

export async function runFollowUps(input: RunFollowUpsInput) {
  if (!input.companyId) {
    throw new Error("missing_company_id");
  }

  const company = await requireCompany(input.companyId);
  const maxFollowUps = Number(company.max_follow_ups ?? 3);
  const nowIso = new Date().toISOString();

  const { data: dueLeads, error } = await supabase
    .from("leads")
    .select(
      `
      id,
      company_id,
      email,
      phone,
      customer_name,
      type,
      status,
      preferred_time,
      issue_summary,
      follow_up_count,
      next_follow_up_at,
      last_email_subject
    `
    )
    .eq("company_id", company.id)
    .not("next_follow_up_at", "is", null)
    .lte("next_follow_up_at", nowIso)
    .order("next_follow_up_at", { ascending: true })
    .limit(25);

  if (error) throw new Error(error.message);

  const leads = (dueLeads ?? []) as FollowUpLead[];
  const results = [];

  for (const lead of leads) {
    if (lead.company_id !== company.id) {
      results.push({
        companyId: company.id,
        leadId: lead.id,
        sent: false,
        skipped: true,
        reason: "lead_company_scope_violation",
      });

      continue;
    }

    const skipReason = shouldSkipLead(lead, maxFollowUps);

    if (skipReason) {
      results.push({
        companyId: company.id,
        leadId: lead.id,
        sent: false,
        skipped: true,
        reason: skipReason,
      });

      continue;
    }

    const message = generateFollowUpMessage(lead);

    try {
      const result = await sendLeadReply({
        companyId: company.id,
        leadId: lead.id,
        to: lead.email as string,
        subject: lead.last_email_subject ?? "Quick follow-up on your HVAC request",
        body: message,
        isFollowUp: true,
      });

      results.push({
        companyId: company.id,
        leadId: lead.id,
        sent: true,
        skipped: false,
        messageId: result.messageId,
        followUpCount: result.followUpCount,
      });
    } catch (err: any) {
      results.push({
        companyId: company.id,
        leadId: lead.id,
        sent: false,
        skipped: false,
        error: err?.message ?? "followup_send_failed",
      });
    }
  }

  return {
    success: true,
    companyId: company.id,
    maxFollowUps,
    followUpDelayHours: Number(company.follow_up_delay_hours ?? 24),
    checked: leads.length,
    sent: results.filter((item) => item.sent).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => item.error).length,
    results,
  };
}