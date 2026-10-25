import type { BookingCommandResult } from "@/lib/booking/resolveBookingCommand";

// lib/background-jobs/backgroundJobTypes.ts

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "dead_letter";

export type ProcessNewLeadJobData = {
  companyId: string;
  leadId: string;
};

export type ProcessInboundEmailJobData = {
  companyId: string;
  provider: string;
  providerEventId: string;
  providerThreadId?: string | null;
  providerEmailId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;

  // Prospect -> booking one-resolution handoff.
  preResolvedBookingCommand?: BookingCommandResult | null;
  recentAssistantMessage?: string | null;
  prospectConversationContext?: string | null;
  prospectConversationId?: string | null;
};

export type ProcessProspectInquiryJobData = {
  companyId: string;
  provider: string;
  providerEventId: string;
  providerThreadId: string;
  providerEmailId?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  subject?: string | null;
  textBody: string;
  prospectClassification?: {
    isProspectInquiry: boolean;
    directServiceRequest: boolean;
    confidence: number;
    category:
      | "company_service_question"
      | "company_pricing_question"
      | "company_policy_question"
      | "company_service_area_question"
      | "company_hours_question"
      | "general_hvac_question"
      | "current_external_question"
      | "other_prospect_question"
      | "not_prospect";
    requiresCompanyFacts: boolean;
    requiresFreshExternalData: boolean;
    reason: string;
    source: "semantic_model" | "deterministic_fallback";
  } | null;
};

export type SendOwnerAlertJobData = {
  companyId: string;
  leadId: string;
  alertType: "new_lead" | "booked" | "follow_up_due" | "failed_booking";
  message?: string | null;
};

export type SendFollowUpJobData = {
  companyId: string;
  leadId: string;
};

export type BookAppointmentJobData = {
  companyId: string;
  leadId: string;
  startTime: string;
  endTime?: string | null;
  durationMinutes?: number | null;
  summary?: string | null;
  description?: string | null;
  fallbackDescription?: string | null;
  location?: string | null;
  notes?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  attendeePhone?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerReply?: string | null;
  serviceAddress?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  matchedReason?: string | null;
  durationSource?: string | null;
  source?: string | null;
  metadata?: Record<string, any> | null;
};

export type BackgroundJobName =
  | "ingest_lead_request"
  | "route_gmail_message"
  | "sync_gmail_mailbox"
  | "maintain_gmail_mailbox"
  | "process_new_lead"
  | "process_inbound_email"
  | "process_prospect_inquiry"
  | "send_owner_alert"
  | "send_follow_up"
  | "book_appointment";

export type BackgroundJobData =
  | ProcessNewLeadJobData
  | ProcessInboundEmailJobData
  | ProcessProspectInquiryJobData
  | SendOwnerAlertJobData
  | SendFollowUpJobData
  | BookAppointmentJobData;

export type BackgroundJobBase = {
  id: string;
  status: BackgroundJobStatus;
  result?: any;
  error?: string | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  run_at: string;
  locked_by?: string | null;
  locked_at?: string | null;
  heartbeat_at?: string | null;
  leased_until?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  dead_lettered_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ProcessNewLeadBackgroundJob = BackgroundJobBase & {
  name: "process_new_lead";
  data: ProcessNewLeadJobData;
};

export type ProcessInboundEmailBackgroundJob = BackgroundJobBase & {
  name: "process_inbound_email";
  data: ProcessInboundEmailJobData;
};

export type ProcessProspectInquiryBackgroundJob = BackgroundJobBase & {
  name: "process_prospect_inquiry";
  data: ProcessProspectInquiryJobData;
};

export type SendOwnerAlertBackgroundJob = BackgroundJobBase & {
  name: "send_owner_alert";
  data: SendOwnerAlertJobData;
};

export type SendFollowUpBackgroundJob = BackgroundJobBase & {
  name: "send_follow_up";
  data: SendFollowUpJobData;
};

export type BookAppointmentBackgroundJob = BackgroundJobBase & {
  name: "book_appointment";
  data: BookAppointmentJobData;
};

export type GmailMaintenanceBackgroundJob = BackgroundJobBase & {
  name: "maintain_gmail_mailbox";
  data: { companyId: string };
};
export type GmailSyncBackgroundJob = BackgroundJobBase & {
  name: "sync_gmail_mailbox";
  data: { companyId: string; body: any };
};
export type IngestLeadRequestBackgroundJob = BackgroundJobBase & {
  name: "ingest_lead_request";
  data: { companyId: string; message: string };
};
export type GmailRoutingBackgroundJob = BackgroundJobBase & {
  name: "route_gmail_message";
  data: { companyId: string; body: any; messageId: string };
};
export type BackgroundJob =
  | GmailRoutingBackgroundJob
  | IngestLeadRequestBackgroundJob
  | GmailSyncBackgroundJob
  | GmailMaintenanceBackgroundJob
  | ProcessNewLeadBackgroundJob
  | ProcessInboundEmailBackgroundJob
  | ProcessProspectInquiryBackgroundJob
  | SendOwnerAlertBackgroundJob
  | SendFollowUpBackgroundJob
  | BookAppointmentBackgroundJob;