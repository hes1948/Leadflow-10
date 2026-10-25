// lib/twilio/twilioClient.ts

import twilio from "twilio";

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string | null;
  fromPhoneNumber: string | null;
};

function readRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`missing_env_${name}`);
  }

  return value.trim();
}

function readOptionalEnv(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

export function getTwilioConfig(): TwilioConfig {
  return {
    accountSid: readRequiredEnv("TWILIO_ACCOUNT_SID"),
    authToken: readRequiredEnv("TWILIO_AUTH_TOKEN"),
    messagingServiceSid: readOptionalEnv("TWILIO_MESSAGING_SERVICE_SID"),
    fromPhoneNumber: readOptionalEnv("TWILIO_FROM_PHONE_NUMBER"),
  };
}

export function getTwilioClient() {
  const config = getTwilioConfig();

  return twilio(config.accountSid, config.authToken);
}

export function getTwilioAuthToken() {
  return readRequiredEnv("TWILIO_AUTH_TOKEN");
}

export function getTwilioOutboundSender() {
  const config = getTwilioConfig();

  if (config.messagingServiceSid) {
    return {
      messagingServiceSid: config.messagingServiceSid,
      from: undefined,
    };
  }

  if (config.fromPhoneNumber) {
    return {
      messagingServiceSid: undefined,
      from: config.fromPhoneNumber,
    };
  }

  throw new Error(
    "missing_twilio_sender_config_use_TWILIO_MESSAGING_SERVICE_SID_or_TWILIO_FROM_PHONE_NUMBER"
  );
}
