// lib/jobs/processInboundEmailJob.ts

import { processInboundEmail } from "@/lib/inbound/processInboundEmail";
import type { ProcessInboundEmailJobData } from "@/lib/background-jobs/backgroundJobTypes";

function clean(value?: string | null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function cleanOptional(value?: string | null) {
  return clean(value) ?? undefined;
}

function normalizeProviderThreadId(data: ProcessInboundEmailJobData) {
  const providerThreadId = clean(data.providerThreadId);
  const providerEventId = clean(data.providerEventId);
  const providerEmailId = clean(data.providerEmailId);
  const prospectBookingHandoff =
    Boolean(data.preResolvedBookingCommand) &&
    Boolean(clean(data.prospectConversationId));
  const threadIdMatchesMessageId =
    Boolean(providerThreadId) &&
    (providerThreadId === providerEventId || providerThreadId === providerEmailId);

  /*
   * Gmail legitimately gives a brand-new thread the same id as its first
   * message. Prospect booking handoffs already carry an explicit internal
   * handoff contract, so that equality is not evidence that the thread id is
   * unsafe. Preserve it for that handoff only; ordinary inbound jobs retain
   * the existing defensive fallback behavior below.
   */
  if (threadIdMatchesMessageId && prospectBookingHandoff) {
    console.log("[processInboundEmailJob] preserving authoritative prospect handoff thread id", {
      providerThreadId,
      providerEventId,
      providerEmailId,
      reason: "prospect_handoff_first_message_thread_id",
    });

    return providerThreadId;
  }

  if (threadIdMatchesMessageId) {
    console.warn("[processInboundEmailJob] providerThreadId looked like a message id; using email fallback matching", {
      providerThreadId,
      providerEventId,
      providerEmailId,
      reason: "providerThreadId_matched_message_id",
    });

    return null;
  }

  return providerThreadId;
}

export async function processInboundEmailJob(data: ProcessInboundEmailJobData) {
  const companyId = clean(data.companyId);
  const providerEventId = clean(data.providerEventId);

  if (!companyId) throw new Error("missing_company_id");
  if (!providerEventId) throw new Error("missing_provider_event_id");

  const providerThreadId = normalizeProviderThreadId(data);

  console.log("[processInboundEmailJob] normalized inbound job", {
    companyId,
    provider: clean(data.provider),
    providerEventId,
    providerThreadId,
    providerEmailId: clean(data.providerEmailId),
    fromEmail: clean(data.fromEmail),
    toEmail: clean(data.toEmail),
    subject: clean(data.subject),
    hasTextBody: Boolean(clean(data.textBody)),
    hasHtmlBody: Boolean(clean(data.htmlBody)),
    hasPreResolvedBookingCommand: Boolean(data.preResolvedBookingCommand),
    prospectConversationId: clean(data.prospectConversationId),
  });

  return processInboundEmail({
    companyId,
    provider: cleanOptional(data.provider),
    providerEventId,
    providerThreadId,
    providerEmailId: clean(data.providerEmailId),
    fromEmail: clean(data.fromEmail),
    toEmail: clean(data.toEmail),
    subject: clean(data.subject),
    textBody: data.textBody ?? null,
    htmlBody: data.htmlBody ?? null,
    preResolvedBookingCommand: data.preResolvedBookingCommand ?? null,
    recentAssistantMessage: clean(data.recentAssistantMessage),
    prospectConversationContext: data.prospectConversationContext ?? null,
    prospectConversationId: clean(data.prospectConversationId),
  });
}