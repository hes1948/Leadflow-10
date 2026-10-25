// lib/ai/extractCustomerIdentity.ts

import OpenAI from "openai";

export type CustomerIdentityExtraction = {
  customerName: string | null;
  phone: string | null;
  email: string | null;
  customerNameConfidence: number;
  phoneConfidence: number;
  emailConfidence: number;
  customerNameExplicit: boolean;
  phoneExplicit: boolean;
  emailExplicit: boolean;
};

const EMPTY_IDENTITY: CustomerIdentityExtraction = {
  customerName: null,
  phone: null,
  email: null,
  customerNameConfidence: 0,
  phoneConfidence: 0,
  emailConfidence: 0,
  customerNameExplicit: false,
  phoneExplicit: false,
  emailExplicit: false,
};

let client: OpenAI | null = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return client;
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanOneLine(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

function clampConfidence(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function sanitizeName(value: unknown) {
  const name = cleanOneLine(value);

  if (!name) return null;
  if (name.length > 120) return null;
  if (name.includes("@")) return null;
  if (/^(unknown|none|null|undefined|n\/?a|na)$/iu.test(name)) return null;

  const letterCount = Array.from(name).filter((character) => /\p{L}/u.test(character)).length;
  if (letterCount === 0) return null;

  return name;
}

function sanitizeEmail(value: unknown) {
  const email = cleanOneLine(value).toLowerCase();
  if (!email) return null;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

function sanitizePhone(value: unknown, explicitlyProvided: boolean) {
  const phone = cleanOneLine(value);
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");

  // E.164 allows up to 15 digits, but customers often provide local or incomplete
  // numbers. When the model says the customer explicitly presented the sequence as
  // their phone number, preserve values with at least four digits rather than
  // silently replacing them with an unrelated number or discarding the intent.
  if (explicitlyProvided) {
    if (digits.length < 4 || digits.length > 20) return null;
    return phone;
  }

  // Unlabeled / inferred phone candidates must be substantially stronger so that
  // option numbers, times, ZIP codes, street numbers and model numbers are rejected.
  if (digits.length < 7 || digits.length > 15) return null;

  return phone;
}

function normalizeModelOutput(value: any): CustomerIdentityExtraction {
  const customerNameExplicit = Boolean(value?.customerNameExplicit);
  const phoneExplicit = Boolean(value?.phoneExplicit);
  const emailExplicit = Boolean(value?.emailExplicit);

  return {
    customerName: sanitizeName(value?.customerName),
    phone: sanitizePhone(value?.phone, phoneExplicit),
    email: sanitizeEmail(value?.email),
    customerNameConfidence: clampConfidence(value?.customerNameConfidence),
    phoneConfidence: clampConfidence(value?.phoneConfidence),
    emailConfidence: clampConfidence(value?.emailConfidence),
    customerNameExplicit,
    phoneExplicit,
    emailExplicit,
  };
}

export async function extractCustomerIdentity(
  message: string
): Promise<CustomerIdentityExtraction> {
  const text = cleanText(message);
  if (!text) return EMPTY_IDENTITY;

  const openai = getClient();
  if (!openai) {
    return EMPTY_IDENTITY;
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.LEADFLOW_IDENTITY_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "customer_identity_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "customerName",
              "phone",
              "email",
              "customerNameConfidence",
              "phoneConfidence",
              "emailConfidence",
              "customerNameExplicit",
              "phoneExplicit",
              "emailExplicit",
            ],
            properties: {
              customerName: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
              phone: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
              email: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
              customerNameConfidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              phoneConfidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              emailConfidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              customerNameExplicit: { type: "boolean" },
              phoneExplicit: { type: "boolean" },
              emailExplicit: { type: "boolean" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content: [
            "You extract customer identity/contact facts from real service-business customer messages.",
            "The customer may use any language, script, spelling, capitalization, dialect, slang, typo, punctuation, or sentence structure.",
            "Names are open-vocabulary human data. Never require a label such as 'name'. Do not use a name dictionary. Preserve the name the customer actually gives, including Unicode, apostrophes, hyphens, multi-part names and single-word names.",
            "A customer can communicate multiple things at once: identity, phone, email, address, booking option, time, correction, question, etc. Extract identity/contact facts independently from booking intent.",
            "Only return customerName when the message itself identifies the sender/customer by that name. Do not mistake a spouse, technician, property manager, person onsite, brand, equipment model, street name, email username, or another mentioned person for the customer unless context explicitly makes them the customer/sender.",
            "Only return phone when the message actually communicates a phone/callback/contact number. Phone formats may be domestic, international, spaced, punctuated, parenthesized, prefixed by +, or imperfect/incomplete. Preserve the customer-provided representation rather than inventing missing digits.",
            "Never treat appointment option numbers, dates, times, ZIP/postal codes, addresses, prices, quantities, confirmation codes or equipment model numbers as a phone number.",
            "Only return email when the message actually contains or clearly states an email address.",
            "Explicit means the customer intentionally communicated that field, even if informally (for example identity by saying who they are or a phone by saying how to call them).",
            "Do not infer or hallucinate missing values. Use null when the message does not support the field.",
          ].join("\n"),
        },
        {
          role: "user",
          content: text.slice(0, 12000),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return EMPTY_IDENTITY;

    const parsed = JSON.parse(content);
    const normalized = normalizeModelOutput(parsed);

    // Conservative acceptance gates. Explicitly communicated values can be accepted
    // at a lower model confidence because the post-processor validates structure;
    // implicit values need very high confidence.
    return {
      customerName:
        normalized.customerName &&
        (normalized.customerNameExplicit
          ? normalized.customerNameConfidence >= 0.65
          : normalized.customerNameConfidence >= 0.92)
          ? normalized.customerName
          : null,
      phone:
        normalized.phone &&
        (normalized.phoneExplicit
          ? normalized.phoneConfidence >= 0.65
          : normalized.phoneConfidence >= 0.95)
          ? normalized.phone
          : null,
      email:
        normalized.email &&
        (normalized.emailExplicit
          ? normalized.emailConfidence >= 0.65
          : normalized.emailConfidence >= 0.95)
          ? normalized.email
          : null,
      customerNameConfidence: normalized.customerNameConfidence,
      phoneConfidence: normalized.phoneConfidence,
      emailConfidence: normalized.emailConfidence,
      customerNameExplicit: normalized.customerNameExplicit,
      phoneExplicit: normalized.phoneExplicit,
      emailExplicit: normalized.emailExplicit,
    };
  } catch (error) {
    console.error("[identity-extraction] semantic extraction failed; deterministic fallback remains available", {
      error: error instanceof Error ? error.message : error,
    });

    return EMPTY_IDENTITY;
  }
}
