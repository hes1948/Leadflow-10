import {
  createWorkerId,
  recoverStaleJobs,
  WORKER_HEARTBEAT_SECONDS,
} from "@/lib/background-jobs/jobReliability";
import { claimBackgroundJob } from "@/lib/background-jobs/claimBackgroundJob";
import { updateBackgroundJobHeartbeat } from "@/lib/background-jobs/updateBackgroundJobHeartbeat";
import { completeBackgroundJob } from "@/lib/background-jobs/completeBackgroundJob";
import { failBackgroundJob } from "@/lib/background-jobs/failBackgroundJob";
import type { BackgroundJob } from "@/lib/background-jobs/backgroundJobTypes";

import { ingestLeadRequestJob } from "@/lib/jobs/ingestLeadRequestJob";
import { processNewLeadJob } from "@/lib/jobs/processNewLeadJob";
import { processInboundEmailJob } from "@/lib/jobs/processInboundEmailJob";
import { processProspectInquiryJob } from "@/lib/jobs/processProspectInquiryJob";
import { sendOwnerAlertJob } from "@/lib/jobs/sendOwnerAlertJob";
import { sendFollowUpJob } from "@/lib/jobs/sendFollowUpJob";
import { bookAppointmentJob } from "@/lib/jobs/bookAppointmentJob";

import { ensureGmailInboxWatchFresh } from "@/lib/gmailWatch";
import { recoverCompanyGmailMailbox, processGmailPubSubWebhook } from "@/lib/gmail/processGmailPubSubWebhook";
import { supabase } from "@/lib/supabase";
import { enqueueBackgroundJob } from "@/lib/background-jobs/enqueueBackgroundJob";
import { executionContext } from "@/lib/background-jobs/executionContext";
import { randomUUID } from "node:crypto";
import { validateQueuedGmailSource } from "@/lib/gmail/validateQueuedGmailSource";
import { listEnabledGmailCompanyIds } from "@/lib/gmail/listEnabledGmailCompanyIds";

type ProspectInquiryJobData = Parameters<typeof processProspectInquiryJob>[0];

type WorkerJob =
  | BackgroundJob
  | {
      id: string;
      name: "process_prospect_inquiry";
      data: ProspectInquiryJobData;
    };

const workerId = createWorkerId();
const workerConcurrency = Number(process.env.LEADFLOW_WORKER_CONCURRENCY ?? 8);
if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 100) {
  throw new Error("LEADFLOW_WORKER_CONCURRENCY_must_be_between_1_and_100");
}

const GMAIL_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

let shuttingDown = false;
let recovering = false;
let gmailMaintenanceRunning = false;
let lastGmailMaintenanceAt = 0;

console.log("BACKGROUND WORKER ONLINE");
console.log("WORKER MODE: hardened_gmail_and_leadflow");
console.log("WORKER ID:", workerId);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRecoverStaleJobs() {
  if (recovering) return;

  recovering = true;

  try {
    await recoverStaleJobs();
  } catch (err) {
    console.error("[background-worker] stale recovery failed", err);
  } finally {
    recovering = false;
  }
}

async function runGmailMaintenance(force = false) {
  if (gmailMaintenanceRunning || shuttingDown) return;

  const now = Date.now();

  if (!force && now - lastGmailMaintenanceAt < GMAIL_MAINTENANCE_INTERVAL_MS) {
    return;
  }

  gmailMaintenanceRunning = true;
  lastGmailMaintenanceAt = now;

  try {
    const bucket = Math.floor(Date.now() / GMAIL_MAINTENANCE_INTERVAL_MS);
    for await (const companyId of listEnabledGmailCompanyIds(supabase)) {
      if (shuttingDown) break;
      await enqueueBackgroundJob({ name: "maintain_gmail_mailbox",
        jobId: `maintain_gmail_mailbox:${companyId}:${bucket}`,
        data: { companyId }, priority: 200 });
    }
  } catch (err) {
    console.error("[background-worker] gmail maintenance failed", {
      error: err instanceof Error ? err.message : err,
    });
  } finally {
    gmailMaintenanceRunning = false;
  }
}

async function runJob(job: WorkerJob) {
  const sourceRejection = await validateQueuedGmailSource(job as BackgroundJob);
  if (sourceRejection) {
    console.warn("[background-worker] source message rejected", {
      companyId: job.data.companyId, jobId: job.id, reason: sourceRejection,
    });
    return { success: true, skipped: true, reason: sourceRejection };
  }
  switch (job.name) {
    case "ingest_lead_request":
      return ingestLeadRequestJob(job.data);
    case "route_gmail_message":
      return processGmailPubSubWebhook(job.data.body, {
        companyId: job.data.companyId, messageId: job.data.messageId,
      });
    case "sync_gmail_mailbox":
      return processGmailPubSubWebhook(job.data.body);
    case "maintain_gmail_mailbox": {
      const recovery = await recoverCompanyGmailMailbox(job.data.companyId, { enqueue: false });
      const watch = await ensureGmailInboxWatchFresh(job.data.companyId);
      return { recovery, watch };
    }
    case "process_new_lead":
      return processNewLeadJob(job.data);

    case "process_inbound_email":
      return processInboundEmailJob(job.data);

    case "process_prospect_inquiry":
      return processProspectInquiryJob(job.data);

    case "send_owner_alert":
      return sendOwnerAlertJob(job.data);

    case "send_follow_up":
      return sendFollowUpJob(job.data);

    case "book_appointment":
      return bookAppointmentJob(job.data);

    default: {
      const exhaustiveCheck: never = job;
      throw new Error(
        `unknown_job_name_${String((exhaustiveCheck as { name?: unknown }).name)}`
      );
    }
  }
}

function startHeartbeat(job: BackgroundJob, claimToken: string, context: { lost: boolean }) {
  let stopped = false;
  let beating = false;

  const beat = async () => {
    if (stopped || beating) return;
    beating = true;

    try {
      const alive = await updateBackgroundJobHeartbeat({ jobId: job.id, workerId: claimToken });
      if (!alive) context.lost = true;
    } catch (err) {
      context.lost = true;
      console.error("[background-worker] heartbeat exception", {
        jobId: job.id,
        workerId,
        error: err instanceof Error ? err.message : err,
      });
    } finally { beating = false; }
  };

  const timer = setInterval(beat, WORKER_HEARTBEAT_SECONDS * 1000);

  void beat();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function processOneJob() {
  const claimToken = `${workerId}:${randomUUID()}`;
  const job = await claimBackgroundJob(claimToken);

  if (!job) return false;

  console.log("[background-worker] started", job.name, job.id);

  const context = { companyId: job.data.companyId, holder: claimToken, operationId: job.id, lost: false };
  const heartbeat = startHeartbeat(job, claimToken, context);

  try {
    const result = await executionContext.run(context, () => runJob(job));
    if (context.lost) throw new Error("worker_lease_lost");

    heartbeat.stop();

    await completeBackgroundJob({
      jobId: job.id,
      workerId: claimToken,
      result,
    });

    console.log("[background-worker] completed", job.name, job.id);
  } catch (err) {
    heartbeat.stop();

    console.error("[background-worker] job failed", {
      jobId: job.id,
      name: job.name,
      error: err instanceof Error ? err.message : err,
    });

    await failBackgroundJob({
      job,
      workerId: claimToken,
      error: err,
    });
  }

  return true;
}

async function workerLoop() {
  while (!shuttingDown) {
    try {
      const worked = await processOneJob();
      if (!worked) await sleep(1500 + Math.floor(Math.random() * 500));
    } catch (err) {
      console.error("[background-worker] loop error", err);
      await sleep(3000);
    }
  }
}
async function main() {
  await safeRecoverStaleJobs();
  await runGmailMaintenance(true);
  const recoveryTimer = setInterval(() => { void safeRecoverStaleJobs(); }, 30_000);
  const gmailTimer = setInterval(() => { void runGmailMaintenance(); }, 60_000);
  try { await Promise.all(Array.from({ length: workerConcurrency }, () => workerLoop())); }
  finally { clearInterval(recoveryTimer); clearInterval(gmailTimer); }
  console.log("[background-worker] shutdown complete", workerId);
}

process.on("SIGINT", () => {
  shuttingDown = true;
});

process.on("SIGTERM", () => {
  shuttingDown = true;
});

process.on("uncaughtException", (err: unknown) => {
  console.error("[background-worker] uncaught exception", err);
});

process.on("unhandledRejection", (err: unknown) => {
  console.error("[background-worker] unhandled rejection", err);
});

main().catch((err: unknown) => {
  console.error("[background-worker] fatal", err);
  process.exit(1);
});
