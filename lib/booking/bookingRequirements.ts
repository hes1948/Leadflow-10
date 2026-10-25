// lib/booking/bookingRequirements.ts
// Canonical dispatch-information gate for NEW appointment creation.
//
// Availability may be shown without these fields. A new appointment may not be
// created until all three are present on authoritative Lead state:
//   1) contact name
//   2) callback phone
//   3) service street address
//
// This module is deliberately semantic-free. It reads structured state only.

export type BookingRequirement =
  | "contact_name"
  | "callback_phone"
  | "service_address";

export type BookingRequirementsResult = {
  complete: boolean;
  missing: BookingRequirement[];
  contactName: string | null;
  callbackPhone: string | null;
  serviceAddress: string | null;
  serviceAddressCandidate: string | null;
  serviceAddressNeedsDispatchConfirmation: boolean;
  serviceAddressDispatchConfirmed: boolean;
};

export type PendingBookingRequirementsAction =
  | "book"
  | "select_offer"
  | "restore_cancelled"
  | "restore_previous"
  | "restore_original";

export type PendingBookingRequirementsState = {
  status:
    | "awaiting_required_contact"
    | "requirements_complete"
    | "fulfilled"
    | "superseded";
  actionKind: PendingBookingRequirementsAction;
  requestedStartTime: string;
  requestedEndTime?: string | null;
  selectedOptionNumber?: number | null;
  selectedByReply?: string | null;
  requestedAt?: string | null;
  reminderCount?: number;
  missing?: BookingRequirement[];
};

function clean(value: unknown) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function cleanName(value: unknown) {
  const text = clean(value);
  if (!text) return null;

  const lower = text.toLowerCase();
  if (text.includes("@")) return null;
  if (/^(?:unknown|n\/?a|none|null|undefined|hvac customer)$/i.test(lower)) {
    return null;
  }

  return text;
}

function cleanPhone(value: unknown) {
  const text = clean(value);
  if (!text) return null;

  /*
   * Texas/US production callback requirement.
   *
   * A value only satisfies the booking gate when it is a structurally valid
   * NANP callback number: 10 national digits, or 11 digits with leading 1.
   * Area-code and exchange prefixes cannot begin with 0 or 1. A trailing
   * extension is allowed but is not counted as part of the callback number.
   */
  const baseNumber = text.replace(
    /\s*(?:ext\.?|extension|x)\s*\d+\s*$/i,
    ""
  );
  const digits = baseNumber.replace(/\D/g, "");
  const nationalDigits =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits;

  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(nationalDigits)) {
    return null;
  }

  return text;
}


/*
 * Positive evidence that the customer supplied a secondary dispatch locator.
 * This is intentionally a vocabulary detector, not a property-type guess: it
 * never assumes that a house needs a unit or that a bare street address belongs
 * to an apartment complex. The semantic conversation layer can separately
 * confirm that no secondary locator is needed.
 */
export function hasExplicitSecondaryServiceLocator(value: unknown) {
  const text = clean(value);
  if (!text) return false;

  return /(?:^|[\s,;])(?:apt(?:artment)?|unit|suite|ste|building|bldg|floor|fl|room|rm|lot|space|trailer|site|block|bay|shop|office|door|#)\s*[-:#.]?\s*[A-Za-z0-9][A-Za-z0-9-]*/i.test(
    text
  );
}


export type ServiceAddressValidationContext = {
  city?: unknown;
  state?: unknown;
  zip?: unknown;
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripKnownTrailingLocality(
  value: string,
  context?: ServiceAddressValidationContext
) {
  let result = value.trim();

  const zip = clean(context?.zip);
  const state = clean(context?.state);
  const city = clean(context?.city);

  if (zip) {
    result = result.replace(
      new RegExp(`(?:\\s*,?\\s*)${escapeRegex(zip)}(?:-\\d{4})?\\s*$`, "i"),
      ""
    ).trim();
  }

  if (state) {
    result = result.replace(
      new RegExp(`(?:\\s*,?\\s*)${escapeRegex(state)}\\s*$`, "i"),
      ""
    ).trim();
  }

  if (city) {
    result = result.replace(
      new RegExp(`(?:\\s*,?\\s*)${escapeRegex(city)}\\s*$`, "i"),
      ""
    ).trim();
  }

  return result.replace(/[\s,.;:-]+$/g, "").trim();
}

/*
 * Structural service-address validator.
 *
 * This intentionally does NOT try to geocode or prove that an address exists.
 * It enforces the minimum dispatch shape needed before a NEW appointment may
 * be created:
 *   - a civic/street number at the beginning, AND
 *   - a real street-name component after that number.
 *
 * Unit/suite/building/floor identifiers supplement the street address; they
 * can never substitute for the street name. Known city/state/ZIP values are
 * stripped from the tail before validation so locality text cannot masquerade
 * as a street name.
 */
export function isStructurallyCompleteServiceStreetAddress(
  value: unknown,
  context?: ServiceAddressValidationContext
) {
  const raw = clean(value);
  if (!raw) return false;

  const withoutLocality = stripKnownTrailingLocality(raw, context);
  if (!withoutLocality) return false;

  if (/^P\.?\s*O\.?\s+Box\b/i.test(withoutLocality)) return false;

  const civicMatch = withoutLocality.match(
    /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+(.+)$/
  );
  if (!civicMatch?.[1]) return false;

  const afterCivicNumber = civicMatch[1].trim();

  /*
   * Remove a trailing secondary-unit/access segment before checking for the
   * street name. This is what prevents values such as "12003 unit 7" or
   * "12003 apt 5" from satisfying the booking gate.
   */
  const streetCore = afterCivicNumber
    .replace(
      /(?:\s|,)+(?:apt(?:artment)?|unit|suite|ste|building|bldg|floor|fl|room|rm|lot|space|#)\s*[A-Za-z0-9-]*(?:\s.*)?$/i,
      ""
    )
    .replace(/[\s,.;:-]+$/g, "")
    .trim();

  if (!streetCore || !/[A-Za-z]/.test(streetCore)) return false;

  const alphaTokens = streetCore.match(/[A-Za-z][A-Za-z.'-]*/g) ?? [];
  if (alphaTokens.length === 0) return false;

  const disallowedStandaloneTokens = new Set([
    "apt",
    "apartment",
    "unit",
    "suite",
    "ste",
    "building",
    "bldg",
    "floor",
    "fl",
    "room",
    "rm",
    "lot",
    "space",
    "n",
    "s",
    "e",
    "w",
    "ne",
    "nw",
    "se",
    "sw",
    "north",
    "south",
    "east",
    "west",
  ]);

  const normalizedTokens = alphaTokens.map((token) =>
    token.toLowerCase().replace(/\./g, "")
  );

  if (normalizedTokens.every((token) => disallowedStandaloneTokens.has(token))) {
    return false;
  }

  const stateOnly = clean(context?.state)?.toLowerCase().replace(/\./g, "");
  if (
    normalizedTokens.length === 1 &&
    stateOnly &&
    normalizedTokens[0] === stateOnly
  ) {
    return false;
  }

  const cityOnly = clean(context?.city)?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const streetCoreComparable = streetCore
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (cityOnly && streetCoreComparable === cityOnly) return false;

  return true;
}

function qualificationObject(source: any) {
  return source?.qualification && typeof source.qualification === "object"
    ? source.qualification
    : {};
}

function locationObject(source: any) {
  const qualification = qualificationObject(source);
  const sourceLocation =
    source?.location && typeof source.location === "object"
      ? source.location
      : {};
  const qualificationLocation =
    qualification?.location && typeof qualification.location === "object"
      ? qualification.location
      : {};

  return {
    ...qualificationLocation,
    ...sourceLocation,
  };
}

export function resolveBookingRequirements(
  source: any
): BookingRequirementsResult {
  const qualification = qualificationObject(source);
  const location = locationObject(source);

  const contactName =
    cleanName(source?.customer_name) ??
    cleanName(source?.customerName) ??
    cleanName(source?.name) ??
    cleanName(qualification?.customerName) ??
    cleanName(qualification?.customer_name) ??
    cleanName(qualification?.name) ??
    cleanName(qualification?.fullName) ??
    cleanName(qualification?.full_name) ??
    cleanName(qualification?.contactName) ??
    cleanName(qualification?.contact_name);

  const callbackPhone =
    cleanPhone(source?.phone) ??
    cleanPhone(source?.callbackPhone) ??
    cleanPhone(qualification?.phone) ??
    cleanPhone(qualification?.customerPhone) ??
    cleanPhone(qualification?.callbackPhone);

  /*
   * A city/ZIP by itself is NOT a service address. Appointment dispatch needs
   * a structurally complete street address: civic number + actual street-name
   * component. Apartment/unit/suite information is supplemental when applicable
   * and can never substitute for the street name.
   */
  const streetAddress =
    clean(source?.address) ??
    clean(location?.address) ??
    clean(qualification?.address);

  const city = clean(source?.city) ?? clean(location?.city) ?? clean(qualification?.city);
  const state = clean(source?.state) ?? clean(location?.state) ?? clean(qualification?.state);
  const zip = clean(source?.zip) ?? clean(location?.zip) ?? clean(qualification?.zip);

  const structurallyCompleteStreetAddress =
    isStructurallyCompleteServiceStreetAddress(streetAddress, {
      city,
      state,
      zip,
    })
      ? streetAddress
      : null;

  const serviceAddressCandidate = structurallyCompleteStreetAddress
    ? [structurallyCompleteStreetAddress, city, state, zip]
        .filter(Boolean)
        .join(", ")
    : null;

  /*
   * Street-address shape and dispatch completeness are separate questions. A
   * bare street address can be structurally valid while still being ambiguous
   * for a multi-unit property. We therefore require positive evidence that the
   * exact navigable service location is complete: either the address itself
   * contains a secondary locator, or the conversation layer has persisted an
   * explicit customer confirmation that no additional locator is needed.
   *
   * This deliberately does NOT make apartment/unit/suite data universally
   * mandatory. A single-location house or business can satisfy the gate by
   * confirming that the supplied address is complete as written.
   */
  const serviceAddressDispatchConfirmed = Boolean(
    serviceAddressCandidate &&
      (hasExplicitSecondaryServiceLocator(structurallyCompleteStreetAddress) ||
        qualification?.serviceAddressDispatchConfirmed === true ||
        location?.serviceAddressDispatchConfirmed === true)
  );

  const serviceAddressNeedsDispatchConfirmation = Boolean(
    serviceAddressCandidate && !serviceAddressDispatchConfirmed
  );

  const serviceAddress = serviceAddressDispatchConfirmed
    ? serviceAddressCandidate
    : null;

  const missing: BookingRequirement[] = [];
  if (!contactName) missing.push("contact_name");
  if (!callbackPhone) missing.push("callback_phone");
  if (!serviceAddress) missing.push("service_address");

  return {
    complete: missing.length === 0,
    missing,
    contactName,
    callbackPhone,
    serviceAddress,
    serviceAddressCandidate,
    serviceAddressNeedsDispatchConfirmation,
    serviceAddressDispatchConfirmed,
  };
}

function requirementLabel(requirement: BookingRequirement) {
  if (requirement === "contact_name") return "your name";
  if (requirement === "callback_phone") return "your best callback number";
  return "the exact service location a technician can navigate to (street address plus any unit, building, suite, lot, space, floor, room, or similar locator if one applies)";
}

function joinHuman(items: string[]) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function normalizeReminderCount(value: unknown) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

export function buildBookingRequirementsPrompt(
  requirements: BookingRequirementsResult,
  options?: {
    selectedTimeLabel?: string | null;
    reminderCount?: number;
  }
) {
  if (requirements.complete) return "";

  const selectedTimeLabel = clean(options?.selectedTimeLabel);
  const reminderCount = normalizeReminderCount(options?.reminderCount);
  const variant = reminderCount % 4;

  if (requirements.serviceAddressNeedsDispatchConfirmation) {
    const candidate = requirements.serviceAddressCandidate;
    const otherMissing = requirements.missing.filter(
      (requirement) => requirement !== "service_address"
    );
    const otherNeeded = joinHuman(otherMissing.map(requirementLabel));
    const locationPrompt = candidate
      ? `I have ${candidate}. Please confirm that this is the complete service location a technician should navigate to. If it is complete as written, just say so. If the property needs any additional locator—such as a unit, building, suite, lot, space, floor, room, or similar identifier—send that locator instead.`
      : "Please confirm the complete service location a technician should navigate to.";

    if (selectedTimeLabel && otherNeeded) {
      return [
        `I still have ${selectedTimeLabel} selected. I also still need ${otherNeeded}.`,
        locationPrompt,
      ].join("\n\n");
    }

    if (selectedTimeLabel) {
      return [
        `I still have ${selectedTimeLabel} selected.`,
        locationPrompt,
      ].join("\n\n");
    }

    if (otherNeeded) {
      return [
        `I still need ${otherNeeded} before I can finalize the appointment.`,
        locationPrompt,
      ].join("\n\n");
    }

    return locationPrompt;
  }

  const needed = joinHuman(requirements.missing.map(requirementLabel));

  if (selectedTimeLabel) {
    if (variant === 1) {
      return [
        `${selectedTimeLabel} is still the time I have selected for you. I still need ${needed} before I can finalize the appointment.`,
        "Once you send that over, I’ll verify the slot is still open and confirm it.",
      ].join("\n\n");
    }

    if (variant === 2) {
      return [
        `We’re almost there — your requested time is ${selectedTimeLabel}. To finish the booking, please send ${needed}.`,
        "I’ll re-check that exact opening as soon as I have the missing information.",
      ].join("\n\n");
    }

    if (variant === 3) {
      return [
        `I still have ${selectedTimeLabel} as your requested slot. I can’t complete the booking until I have ${needed}.`,
        "Send the remaining information and I’ll check that same time again before confirming.",
      ].join("\n\n");
    }

    return [
      `I have ${selectedTimeLabel} selected, but I can’t confirm the appointment until I have ${needed}.`,
      "Send the missing details and I’ll re-check that exact time before confirming it.",
    ].join("\n\n");
  }

  if (variant === 1) {
    return `I still need ${needed} before I can finalize an appointment.`;
  }

  if (variant === 2) {
    return `To finish the booking, please send ${needed}.`;
  }

  if (variant === 3) {
    return `I can’t complete the appointment booking until I have ${needed}.`;
  }

  return `Before I can confirm an appointment, I need ${needed}.`;
}

export function getPendingBookingRequirements(
  qualification: Record<string, any> | null | undefined
): PendingBookingRequirementsState | null {
  const raw = qualification?.pendingBookingRequirements;
  if (!raw || typeof raw !== "object") return null;

  const status = String(raw.status ?? "");
  if (
    status !== "awaiting_required_contact" &&
    status !== "requirements_complete" &&
    status !== "fulfilled" &&
    status !== "superseded"
  ) {
    return null;
  }

  const actionKind = String(raw.actionKind ?? "") as PendingBookingRequirementsAction;
  if (
    actionKind !== "book" &&
    actionKind !== "select_offer" &&
    actionKind !== "restore_cancelled" &&
    actionKind !== "restore_previous" &&
    actionKind !== "restore_original"
  ) {
    return null;
  }

  const requestedStartTime = clean(raw.requestedStartTime);
  if (!requestedStartTime || Number.isNaN(new Date(requestedStartTime).getTime())) {
    return null;
  }

  const requestedEndTime = clean(raw.requestedEndTime);
  if (requestedEndTime && Number.isNaN(new Date(requestedEndTime).getTime())) {
    return null;
  }

  const selectedOptionNumber = Number(raw.selectedOptionNumber);

  return {
    status: status as PendingBookingRequirementsState["status"],
    actionKind,
    requestedStartTime: new Date(requestedStartTime).toISOString(),
    requestedEndTime: requestedEndTime
      ? new Date(requestedEndTime).toISOString()
      : null,
    selectedOptionNumber:
      Number.isInteger(selectedOptionNumber) && selectedOptionNumber > 0
        ? selectedOptionNumber
        : null,
    selectedByReply: clean(raw.selectedByReply),
    requestedAt: clean(raw.requestedAt),
    reminderCount:
      Number.isInteger(Number(raw.reminderCount)) && Number(raw.reminderCount) >= 0
        ? Number(raw.reminderCount)
        : 0,
    missing: Array.isArray(raw.missing)
      ? raw.missing.filter(
          (item: unknown): item is BookingRequirement =>
            item === "contact_name" ||
            item === "callback_phone" ||
            item === "service_address"
        )
      : [],
  };
}

export function createBookingRequirementsError(
  requirements: BookingRequirementsResult
) {
  const error: any = new Error("booking_requirements_incomplete");
  error.missingBookingRequirements = requirements.missing;
  return error;
}