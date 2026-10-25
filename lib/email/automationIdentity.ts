type MailHeader = { name?: string | null; value?: string | null };

export function getAutomationReason(headers: MailHeader[]): string | null {
  const get = (name: string) => headers.filter(h => h.name?.toLowerCase() === name)
    .map(h => String(h.value ?? "").trim());
  if (get("auto-submitted").some(v => v && v.split(";")[0].trim().toLowerCase() !== "no")) {
    return "auto_submitted_message";
  }
  if (get("x-leadflow-automated").some(v => v === "1")) {
    return "leadflow_automated_message";
  }
  // The durable sender used this stable identity before automation headers
  // were introduced, so already-sent durable replies are protected too.
  if (get("message-id").some(v => /^<[a-f0-9]{64}@leadflow\.invalid>$/i.test(v))) {
    return "leadflow_durable_reply_identity";
  }
  return null;
}

export function stampAutomatedReply(raw: string, rfcMessageId: string): string {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const boundary = /\r?\n\r?\n/.exec(message);
  if (!boundary || boundary.index === undefined) throw new Error("invalid_gmail_raw_message");
  const original = message.slice(0, boundary.index).split(/\r?\n/);
  const retained: string[] = [];
  let omit = false;
  for (const line of original) {
    if (!/^[ \t]/.test(line)) {
      omit = /^(Message-ID|Auto-Submitted|X-LeadFlow-Automated|X-Auto-Response-Suppress):/i.test(line);
    }
    if (!omit) retained.push(line);
  }
  const headers = [
    `Message-ID: ${rfcMessageId}`,
    "Auto-Submitted: auto-replied",
    "X-LeadFlow-Automated: 1",
    "X-Auto-Response-Suppress: All",
    ...retained,
  ];
  return Buffer.from(headers.join("\r\n") + "\r\n\r\n" +
    message.slice(boundary.index + boundary[0].length), "utf8").toString("base64url");
}
