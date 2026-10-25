// lib/gmailWatch.ts

import { getCompanyGmailClient } from "@/lib/google/companyGoogle";
import { supabase } from "@/lib/supabase";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }

  return value;
}

function buildTopicName() {
  const projectId = requireEnv("GOOGLE_CLOUD_PROJECT_ID");
  const topicName = process.env.GMAIL_PUBSUB_TOPIC_NAME || "gmail-inbound-leadflow";

  if (topicName.startsWith("projects/")) {
    return topicName;
  }

  return `projects/${projectId}/topics/${topicName}`;
}

export async function startGmailInboxWatch(companyId: string) {
  if (!companyId) {
    throw new Error("missing_company_id");
  }

  const gmail = await getCompanyGmailClient(companyId);
  const topicName = buildTopicName();

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });

  const historyId = res.data.historyId ?? null;
  const expiration = res.data.expiration ? Number(res.data.expiration) : null;

  const { error } = await supabase
    .from("google_connections")
    .update({
      gmail_watch_active: true,
      gmail_watch_history_id: historyId,
      gmail_watch_expiration: expiration,
      gmail_watch_topic: topicName,
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", companyId);

  if (error) {
    throw new Error(error.message);
  }

  return {
    success: true,
    companyId,
    topicName,
    historyId,
    expiration,
    raw: res.data,
  };
}