// lib/validation/leadValidation.ts

export type LeadValidationResult =
  | {
      valid: true;
      cleanMessage: string;
    }
  | {
      valid: false;
      error: string;
    };

const spamSignals = [
  "crypto",
  "casino",
  "viagra",
  "adult",
  "loan offer",
  "free money",
  "make money fast",
  "click here",
  "forex",
  "bitcoin investment",
  "telegram",
  "whatsapp only",
];

function hasSpamSignal(message: string) {
  const lower = message.toLowerCase();

  return spamSignals.some((signal) => lower.includes(signal));
}

function looksLikeGarbage(message: string) {
  const letters = message.replace(/[^a-zA-Z]/g, "");
  const numbers = message.replace(/[^0-9]/g, "");

  if (letters.length < 4 && numbers.length < 7) {
    return true;
  }

  if (/^(.)\1{8,}$/.test(message.replace(/\s/g, ""))) {
    return true;
  }

  return false;
}

export function hasMalformedPhone(message: string) {
  const lower = message.toLowerCase();

  const mentionsPhone =
    lower.includes("phone") ||
    lower.includes("call") ||
    lower.includes("number") ||
    lower.includes("text me") ||
    lower.includes("reach me");

  if (!mentionsPhone) {
    return false;
  }

  const validPhone = message.match(
    /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/
  );

  return !validPhone;
}

export function validateLeadMessage(input: unknown): LeadValidationResult {
  if (typeof input !== "string") {
    return {
      valid: false,
      error: "missing_message",
    };
  }

  const cleanMessage = input.trim();

  if (!cleanMessage) {
    return {
      valid: false,
      error: "missing_message",
    };
  }

  if (cleanMessage.length < 10) {
    return {
      valid: false,
      error: "message_too_short",
    };
  }

  if (cleanMessage.length > 5000) {
    return {
      valid: false,
      error: "message_too_long",
    };
  }

  if (looksLikeGarbage(cleanMessage)) {
    return {
      valid: false,
      error: "garbage_message",
    };
  }

  if (hasSpamSignal(cleanMessage)) {
    return {
      valid: false,
      error: "spam_message",
    };
  }

  if (hasMalformedPhone(cleanMessage)) {
    return {
      valid: false,
      error: "malformed_phone",
    };
  }

  return {
    valid: true,
    cleanMessage,
  };
}