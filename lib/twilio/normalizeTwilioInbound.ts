// lib/twilio/normalizeTwilioInbound.ts

export type TwilioInboundKind = "sms" | "voice";

export type NormalizedTwilioInbound = {
  provider: "twilio";
  kind: TwilioInboundKind;
  providerEventId: string;
  providerMessageId: string | null;
  providerCallSid: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  body: string;
  speechResult: string | null;
  digits: string | null;
  raw: Record<string, string>;
};

function clean(value?: string | null) {
  return String(value ?? "").trim();
}

function normalizePhone(value?: string | null) {
  const raw = clean(value);
  if (!raw) return null;

  if (raw.startsWith("+")) return raw;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return raw;
}

function normalizeText(value?: string | null) {
  return clean(value)
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getFirst(params: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = clean(params[key]);
    if (value) return value;
  }

  return "";
}

export function normalizeTwilioInboundSms(
  params: Record<string, string>
): NormalizedTwilioInbound {
  const messageSid = getFirst(params, ["MessageSid", "SmsMessageSid", "SmsSid"]);
  const fromPhone = normalizePhone(getFirst(params, ["From"]));
  const toPhone = normalizePhone(getFirst(params, ["To"]));
  const body = normalizeText(getFirst(params, ["Body"]));

  if (!messageSid) throw new Error("missing_twilio_message_sid");
  if (!fromPhone) throw new Error("missing_twilio_from_phone");
  if (!toPhone) throw new Error("missing_twilio_to_phone");

  return {
    provider: "twilio",
    kind: "sms",
    providerEventId: messageSid,
    providerMessageId: messageSid,
    providerCallSid: null,
    fromPhone,
    toPhone,
    body,
    speechResult: null,
    digits: null,
    raw: params,
  };
}

export function normalizeTwilioInboundVoice(
  params: Record<string, string>
): NormalizedTwilioInbound {
  const callSid = getFirst(params, ["CallSid"]);
  const fromPhone = normalizePhone(getFirst(params, ["From", "Caller"]));
  const toPhone = normalizePhone(getFirst(params, ["To", "Called"]));
  const speechResult = normalizeText(getFirst(params, ["SpeechResult"]));
  const digits = normalizeText(getFirst(params, ["Digits"]));
  const transcriptionText = normalizeText(getFirst(params, ["TranscriptionText"]));

  const body =
    speechResult ||
    transcriptionText ||
    (digits ? `Customer pressed: ${digits}` : "") ||
    "Inbound phone call received.";

  if (!callSid) throw new Error("missing_twilio_call_sid");
  if (!fromPhone) throw new Error("missing_twilio_from_phone");
  if (!toPhone) throw new Error("missing_twilio_to_phone");

  return {
    provider: "twilio",
    kind: "voice",
    providerEventId: callSid,
    providerMessageId: null,
    providerCallSid: callSid,
    fromPhone,
    toPhone,
    body,
    speechResult: speechResult || null,
    digits: digits || null,
    raw: params,
  };
}

export function formDataToRecord(formData: FormData) {
  const record: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    record[key] = String(value ?? "");
  }

  return record;
}
