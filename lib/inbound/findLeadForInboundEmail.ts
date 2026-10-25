// lib/inbound/findLeadForInboundEmail.ts

import { supabase } from "@/lib/supabase";

type FindLeadForInboundEmailInput = {
  companyId: string;
  fromEmail?: string | null;
  subject?: string | null;
  threadId?: string | null;
};

type LeadMatch = {
  id: string;
  company_id: string;
  email: string | null;
  status: string | null;
  last_email_subject: string | null;
  outbound_thread_id: string | null;
  inbound_thread_id: string | null;
  outbound_email_id: string | null;
  inbound_email_id: string | null;
  sent_at: string | null;
  last_contacted_at: string | null;
  created_at: string | null;
  qualification?: Record<string, any> | null;
};

function toLeadMatches(data: unknown): LeadMatch[] {
  return Array.isArray(data) ? (data as LeadMatch[]) : [];
}

function normalizeEmail(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);

  return (match?.[1] ?? raw).trim().toLowerCase();
}

function normalizeSubject(value?: string | null) {
  return String(value ?? "")
    .replace(/^re:\s*/i, "")
    .replace(/^fwd:\s*/i, "")
    .trim()
    .toLowerCase();
}

function safeText(value?: string | null) {
  return String(value ?? "").trim();
}

function hasPendingSlotSuggestion(lead: LeadMatch) {
  const pending = lead.qualification?.pendingSlotSuggestion;

  if (!pending || typeof pending !== "object") return false;

  const suggestedSlots = (pending as any).suggestedSlots;

  return (
    (pending as any).status === "awaiting_customer_confirmation" &&
    (Boolean((pending as any).suggestedStartTime) ||
      (Array.isArray(suggestedSlots) && suggestedSlots.length > 0))
  );
}

function statusRank(lead: LeadMatch) {
  if (hasPendingSlotSuggestion(lead)) return 0;

  if (lead.status === "awaiting_customer") return 1;
  if (lead.status === "contacted" || lead.status === "sent") return 2;
  if (lead.status === "new") return 3;

  return 99;
}

function activityTime(lead: LeadMatch) {
  return new Date(
    lead.last_contacted_at ?? lead.sent_at ?? lead.created_at ?? 0
  ).getTime();
}

function sortBestLeadFirst(a: LeadMatch, b: LeadMatch) {
  const rankDiff = statusRank(a) - statusRank(b);
  if (rankDiff !== 0) return rankDiff;

  return activityTime(b) - activityTime(a);
}

function isUsableThreadId(threadId?: string | null) {
  const id = safeText(threadId);
  if (!id) return false;
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

async function findByThreadId(params: {
  companyId: string;
  threadId: string;
  selectColumns: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select(params.selectColumns)
    .eq("company_id", params.companyId)
    .in("status", ["new", "contacted", "sent", "awaiting_customer"])
    .or(
      `outbound_thread_id.eq.${params.threadId},inbound_thread_id.eq.${params.threadId},outbound_email_id.eq.${params.threadId},inbound_email_id.eq.${params.threadId}`
    )
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) throw new Error(error.message);

  const matches = toLeadMatches(data).sort(sortBestLeadFirst);

  return matches[0] ?? null;
}

async function findByEmail(params: {
  companyId: string;
  fromEmail: string;
  cleanSubject: string;
  selectColumns: string;
}) {
  const { data, error } = await supabase
    .from("leads")
    .select(params.selectColumns)
    .eq("company_id", params.companyId)
    .eq("email", params.fromEmail)
    .in("status", ["new", "contacted", "sent", "awaiting_customer"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(error.message);

  const leads = toLeadMatches(data).sort(sortBestLeadFirst);

  if (params.cleanSubject) {
    const pendingSubjectMatches = leads
      .filter(hasPendingSlotSuggestion)
      .filter((lead) => {
        const leadSubject = normalizeSubject(lead.last_email_subject);
        return leadSubject && leadSubject === params.cleanSubject;
      })
      .sort(sortBestLeadFirst);

    if (pendingSubjectMatches[0]) return pendingSubjectMatches[0];
  }

  const pendingSuggestionMatches = leads
    .filter(hasPendingSlotSuggestion)
    .sort(sortBestLeadFirst);

  if (pendingSuggestionMatches[0]) return pendingSuggestionMatches[0];

  if (params.cleanSubject) {
    const subjectMatches = leads
      .filter((lead) => {
        const leadSubject = normalizeSubject(lead.last_email_subject);
        return leadSubject && leadSubject === params.cleanSubject;
      })
      .sort(sortBestLeadFirst);

    if (subjectMatches[0]) return subjectMatches[0];
  }

  return leads[0] ?? null;
}

export async function findLeadForInboundEmail(
  input: FindLeadForInboundEmailInput
) {
  if (!input.companyId) throw new Error("missing_company_id");

  const fromEmail = normalizeEmail(input.fromEmail);
  const cleanSubject = normalizeSubject(input.subject);
  const threadId = safeText(input.threadId);

  const selectColumns = `
    id,
    company_id,
    email,
    status,
    last_email_subject,
    outbound_thread_id,
    inbound_thread_id,
    outbound_email_id,
    inbound_email_id,
    sent_at,
    last_contacted_at,
    created_at,
    qualification
  `;

  if (isUsableThreadId(threadId)) {
    const threadMatch = await findByThreadId({
      companyId: input.companyId,
      threadId,
      selectColumns,
    });

    if (threadMatch) return threadMatch;
  }

  if (!fromEmail) return null;

  return findByEmail({
    companyId: input.companyId,
    fromEmail,
    cleanSubject,
    selectColumns,
  });
}
