// lib/twilio/sendTwilioSms.ts

import twilio from "twilio";

type SendTwilioSmsInput = {
  to: string;
  body: string;
  from?: string | null;
  messagingServiceSid?: string | null;
};

type TwilioOutboundSender = {
  messagingServiceSid?: string;
  from?: string;
};

function clean(value?: string | null) {
  return String(value ?? "").trim();
}

function normalizePhone(value?: string | null) {
  const raw = clean(value);
  if (!raw) return "";

  if (raw.startsWith("+")) return raw;

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return raw;
}

function readRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`missing_env_${name}`);
  }

  return value.trim();
}

function getTwilioClientInline() {
  const accountSid = readRequiredEnv("TWILIO_ACCOUNT_SID");
  const authToken = readRequiredEnv("TWILIO_AUTH_TOKEN");

  return twilio(accountSid, authToken);
}

function getTwilioOutboundSenderInline(): TwilioOutboundSender {
  const messagingServiceSid = clean(process.env.TWILIO_MESSAGING_SERVICE_SID);
  const fromPhoneNumber = normalizePhone(process.env.TWILIO_FROM_PHONE_NUMBER);

  if (messagingServiceSid) {
    return {
      messagingServiceSid,
      from: undefined,
    };
  }

  if (fromPhoneNumber) {
    return {
      messagingServiceSid: undefined,
      from: fromPhoneNumber,
    };
  }

  throw new Error(
    "missing_twilio_sender_config_use_TWILIO_MESSAGING_SERVICE_SID_or_TWILIO_FROM_PHONE_NUMBER"
  );
}

export async function sendTwilioSms(input: SendTwilioSmsInput) {
  const to = normalizePhone(input.to);
  const body = clean(input.body);

  if (!to) throw new Error("missing_sms_to");
  if (!body) throw new Error("missing_sms_body");

  const client = getTwilioClientInline();
  const defaultSender = getTwilioOutboundSenderInline();

  const messagingServiceSid =
    clean(input.messagingServiceSid) || defaultSender.messagingServiceSid;
  const from = normalizePhone(input.from) || defaultSender.from;

  const message = await client.messages.create({
    to,
    body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from }),
  });

  return {
    success: true,
    provider: "twilio",
    sid: message.sid,
    status: message.status,
    to: message.to,
    from: message.from,
    messagingServiceSid: message.messagingServiceSid ?? messagingServiceSid ?? null,
  };
}
