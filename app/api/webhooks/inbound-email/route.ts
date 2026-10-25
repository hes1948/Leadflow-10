// app/api/webhooks/inbound-email/route.ts

import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";

function getHeader(req: Request, name: string) {
  return req.headers.get(name) ?? req.headers.get(name.toLowerCase());
}

function requireWebhookSecret(req: Request) {
  const expected = process.env.INBOUND_WEBHOOK_SECRET;

  if (!expected) return;

  const received =
    getHeader(req, "x-inbound-secret") ??
    getHeader(req, "authorization")?.replace("Bearer ", "");

  if (received !== expected) {
    throw new Error("invalid_webhook_secret");
  }
}

function extractEmailAddress(value?: string | null) {
  const raw = String(value ?? "").trim();

  const match = raw.match(/<([^>]+)>/);

  if (match?.[1]) return match[1].trim().toLowerCase();

  return raw.toLowerCase();
}

function getInboundPayload(body: any) {
  const data = body.data ?? body.email ?? body;

  return {
    providerEventId: body.id ?? body.event_id ?? data.id ?? null,
    providerEmailId: data.id ?? data.email_id ?? null,

    fromEmail: extractEmailAddress(
      data.from?.email ?? data.from ?? data.sender ?? null
    ),

    toEmail: extractEmailAddress(
      Array.isArray(data.to)
        ? data.to?.[0]?.email ?? data.to?.[0]
        : data.to ?? data.recipient ?? null
    ),

    subject: data.subject ?? null,
    textBody: data.text ?? data.text_body ?? data.plain ?? data.body ?? null,
    htmlBody: data.html ?? data.html_body ?? null,
  };
}

async function findCompanyByInboundAddress(toEmail?: string | null) {
  const cleanTo = String(toEmail ?? "").trim().toLowerCase();

  if (!cleanTo) return null;

  const { data, error } = await supabase
    .from("companies")
    .select(
      `
      id,
      email,
      created_at
    `
    )
    .ilike("email", cleanTo.replace(/[\\%_]/g, "\\$&"))
    .limit(2)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return data;
}

export async function POST(req: Request) {
  try {
    requireWebhookSecret(req);

    const body = await req.json();

    const eventType = body.type ?? body.event ?? null;

    if (eventType && eventType !== "email.received") {
      return NextResponse.json({
        success: true,
        ignored: true,
        reason: "unsupported_event_type",
        eventType,
      });
    }

    const inbound = getInboundPayload(body);

    const company = await findCompanyByInboundAddress(inbound.toEmail);

    if (!company) {
      return NextResponse.json(
        {
          success: false,
          error: "company_not_found_for_inbound_address",
          toEmail: inbound.toEmail,
        },
        { status: 404 }
      );
    }

    if (!inbound.providerEventId) throw new Error("missing_provider_event_id");
    const job = await enqueueBackgroundJob({
      name: "process_inbound_email",
      jobId: `process_inbound_email:${company.id}:resend:${inbound.providerEventId}`,
      data: {
      companyId: company.id,
      provider: "resend",
      providerEventId: inbound.providerEventId,
      providerEmailId: inbound.providerEmailId,
      fromEmail: inbound.fromEmail,
      toEmail: inbound.toEmail,
      subject: inbound.subject,
      textBody: inbound.textBody,
      htmlBody: inbound.htmlBody,
      },
    });

    return NextResponse.json({
      success: true,
      queued: true,
      jobId: job.id,
      inboundMatchedCompanyId: company.id,
      inboundToEmail: inbound.toEmail,
    });
  } catch (err: any) {
    const message = err?.message ?? "inbound_email_webhook_failed";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      {
        status: message === "invalid_webhook_secret" ? 401 : 500,
      }
    );
  }
}