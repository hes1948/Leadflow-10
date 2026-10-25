// lib/actions/notifySlack.ts

type NotifySlackResult =
  | {
      success: true;
      delivered: true;
      provider: "slack";
    }
  | {
      success: true;
      delivered: false;
      skipped: true;
      provider: "slack";
      reason: "slack_webhook_not_configured";
    }
  | {
      success: false;
      delivered: false;
      provider: "slack";
      error: string;
    };

export async function notifySlack(message: string): Promise<NotifySlackResult> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn("[slack] skipped: SLACK_WEBHOOK_URL not configured");

    return {
      success: true,
      delivered: false,
      skipped: true,
      provider: "slack",
      reason: "slack_webhook_not_configured",
    };
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    return {
      success: false,
      delivered: false,
      provider: "slack",
      error: "missing_slack_message",
    };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: message.trim(),
      }),
    });

    if (!res.ok) {
      const text = await res.text();

      return {
        success: false,
        delivered: false,
        provider: "slack",
        error: `slack_webhook_failed_${res.status}_${text.slice(0, 300)}`,
      };
    }

    return {
      success: true,
      delivered: true,
      provider: "slack",
    };
  } catch (err: any) {
    console.error("SLACK NOTIFY ERROR:", err?.message || err);

    return {
      success: false,
      delivered: false,
      provider: "slack",
      error: err?.message || "unknown_slack_error",
    };
  }
}