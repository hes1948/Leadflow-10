import { supabase } from "@/lib/supabase";
import { getCompanyGmailClient } from "@/lib/google/companyGoogle";
import { getAutomationReason } from "@/lib/email/automationIdentity";
import { classifyInboundCustomerIntent } from "@/lib/ai/classifyInboundCustomerIntent";
import type { BackgroundJob } from "@/lib/background-jobs/backgroundJobTypes";

const email = (value: unknown) => {
  const text = String(value ?? "").trim().toLowerCase();
  return /<([^>]+)>/.exec(text)?.[1] ?? text;
};

export async function validateQueuedGmailSource(job: BackgroundJob): Promise<string | null> {
  const data: any = job.data;
  let messageId: string | null = null;
  let textBody: string | null = null;
  if (job.name === "process_prospect_inquiry" || job.name === "process_inbound_email") {
    if (!String(data.provider ?? "gmail_pubsub").includes("gmail")) return null;
    messageId = data.providerEmailId || data.providerEventId;
    textBody = data.textBody;
    if (!messageId) throw new Error("gmail_source_identity_required");
  } else if (["process_new_lead", "send_follow_up", "book_appointment"].includes(job.name)) {
    const { data: lead, error } = await supabase.from("leads").select("*")
      .eq("id", data.leadId).eq("company_id", data.companyId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) throw new Error("gmail_source_lead_scope_not_found");
    if (/^[a-f0-9]{16,}$/i.test(String(lead.inbound_email_id ?? ""))) {
      messageId = lead.inbound_email_id;
      textBody = lead.input || lead.message || null;
    } else return null;
  } else return null;

  if (typeof messageId !== "string" || !messageId.trim()) throw new Error("gmail_source_identity_required");
  const gmail = await getCompanyGmailClient(data.companyId);
  const response = await gmail.users.messages.get({
    userId: "me", id: messageId, format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-ID", "Auto-Submitted", "X-LeadFlow-Automated"],
  }, { timeout: 20000, retry: false });
  const headers = response.data.payload?.headers ?? [];
  const automated = getAutomationReason(headers);
  if (automated) return automated;
  const from = headers.find((h: any) => h.name?.toLowerCase() === "from")?.value;
  if (data.fromEmail && email(from) !== email(data.fromEmail)) {
    throw new Error("gmail_source_sender_identity_mismatch");
  }

  // Legacy queued messages may predate our transport markers. Verify message
  // direction again before side effects; continuity alone is not proof that
  // the new message was written by a customer. Genuine terse customer turns
  // retain existing-conversation context and the existing classifier behavior.
  if (textBody) {
    const admission = await classifyInboundCustomerIntent({
      subject: data.subject, body: textBody, fromEmail: email(from),
      hasExistingCustomerConversation: true,
    });
    if (admission.confidence >= 0.85 && (
      admission.isAutomatedOrBulk || admission.isVendorOrSolicitation ||
      admission.isAccountOrSystemNotice
    )) return "queued_non_customer_message_direction";
  }
  return null;
}
