// lib/booking/resolveBookingCommand.ts
//
// ONE authoritative booking-domain action resolver.
//
// Generic semantic architecture:
// - Decides WHAT booking operation the customer is asking for.
// - Uses the full newest customer statement + authoritative conversation state.
// - Does NOT use hand-written phrase catalogs/regexes to decide cancel/book/
//   reschedule/restore/availability intent.
// - Separates WHAT action is being discussed from WHETHER the customer has
//   actually authorized a mutation.
// - Fails closed to clarify when a mutation decision is internally inconsistent.
//
// Non-ownership:
// - Does NOT resolve the actual date/time/window. Canonical temporal owns WHEN.
// - Does NOT check business hours or Calendar availability.
// - Does NOT mutate bookings, Calendar events, cancellation history, or lineage.
// - Does NOT answer company/realtime questions. Conversation Intelligence owns them.

import OpenAI from "openai";

export type BookingCommandKind =
  | "none"
  | "information"
  | "show_availability"
  | "book"
  | "select_offer"
  | "reschedule"
  | "cancel"
  | "restore_previous"
  | "restore_original"
  | "restore_cancelled"
  | "keep_current"
  | "clarify";

export type BookingCommandSource =
  | "deterministic"
  | "semantic_model"
  | "fallback";

export type BookingOfferedSlot = {
  optionNumber: number;
  startTime: string;
  endTime?: string | null;
};

export type BookingCommandContext = {
  hasActiveBooking: boolean;
  hasCancelledBooking?: boolean;
  currentAppointmentTime?: string | null;
  cancelledAppointmentTime?: string | null;
  timezone?: string | null;
  subject?: string | null;
  recentAssistantMessage?: string | null;
  /** Full recent service/prospect context for elliptical follow-ups. */
  conversationContext?: string | null;
  pendingOfferedSlots?: BookingOfferedSlot[];
  hasReversibleReschedule?: boolean;
  hasOriginalBookingHistory?: boolean;
  priorSchedulingRequest?: {
    displayPreference?: string | null;
    requestedStartTime?: string | null;
    requestedEndTime?: string | null;
  } | null;
  pendingConfirmation?: {
    kind: BookingCommandKind;
    appointmentTime?: string | null;
    requestedAt?: string | null;
    requestedByReply?: string | null;
  } | null;
  pendingClarification?: {
    kind: BookingCommandKind;
    missing?: string[] | string | null;
    appointmentTime?: string | null;
    requestedAt?: string | null;
    requestedByReply?: string | null;
  } | null;
};

export type BookingCommandResult = {
  kind: BookingCommandKind;
  confidence: number;
  requiresClarification: boolean;
  reason: string;
  source: BookingCommandSource;
  selectedOptionNumber: number | null;
  /**
   * True only when the newest customer turn introduces or changes scheduling
   * time meaning. This is a routing/context signal, not the canonical WHEN.
   */
  hasFreshTemporalConstraint: boolean;
};

export type LegacyCustomerActionIntent = {
  action:
    | "cancel_booking"
    | "reschedule_booking"
    | "keep_booking"
    | "information_request"
    | "booking_request"
    | "restore_booking"
    | "unclear"
    | "none";
  confidence: number;
  requiresClarification: boolean;
  reason: string;
  source: BookingCommandSource;
};

export type LegacyAvailabilityIntent = {
  decision:
    | "availability_inquiry"
    | "booking_action"
    | "option_selection"
    | "information_question"
    | "other";
  confidence: number;
  reason: string;
  hasFreshTemporalConstraint: boolean;
  selectedOptionNumber: number | null;
  source: BookingCommandSource;
};

type SemanticSpeechAct =
  | "action_request"
  | "information_request"
  | "status_question"
  | "hypothetical"
  | "confirmation"
  | "withdrawal"
  | "selection"
  | "statement"
  | "unclear"
  | "none";

type SemanticRestorationReference =
  | "none"
  | "unspecified"
  | "cancelled"
  | "previous"
  | "original";

type SemanticDecision = {
  kind: BookingCommandKind;
  speechAct: SemanticSpeechAct;
  mutationAuthorized: boolean;
  restorationReference: SemanticRestorationReference;
  restorationReferenceSpecified: boolean;
  confidence: number;
  requiresClarification: boolean;
  reason: string;
  selectedOptionNumber: number;
  hasFreshTemporalConstraint: boolean;
};

type MutationAuthorizationDecision = {
  authorization: "authorized" | "not_authorized" | "unclear";
  confidence: number;
  reason: string;
};

type HistoryBacktrackDecision = {
  interpretation:
    | "restore_history"
    | "new_reschedule_with_target"
    | "new_reschedule_without_target"
    | "not_history_backtrack"
    | "unclear";
  restorationReference: SemanticRestorationReference;
  restorationReferenceSpecified: boolean;
  confidence: number;
  reason: string;
};

type ContextualActiveBookingDecision = {
  interpretation:
    | "reschedule_active_booking"
    | "show_availability"
    | "information"
    | "unclear";
  confidence: number;
  reason: string;
};

const MODEL =
  process.env.LEADFLOW_BOOKING_COMMAND_MODEL ||
  process.env.LEADFLOW_ACTION_INTENT_MODEL ||
  process.env.LEADFLOW_SCHEDULING_MODEL ||
  "gpt-4o-mini";

const MUTATION_KINDS = new Set<BookingCommandKind>([
  "book",
  "select_offer",
  "reschedule",
  "cancel",
  "restore_previous",
  "restore_original",
  "restore_cancelled",
]);

/*
 * These are semantic speech-act categories, not customer phrase matches.
 * A mutation is executable only when the semantic resolver says BOTH:
 *   1) the booking operation is a mutation; and
 *   2) the customer's speech act authorizes that mutation.
 *
 * This lets natural language stay open-ended. No vocabulary list is required.
 */
const AUTHORIZING_SPEECH_ACTS = new Set<SemanticSpeechAct>([
  "action_request",
  "confirmation",
  "withdrawal",
  "selection",
]);

const NON_MUTATING_DISCUSSION_SPEECH_ACTS = new Set<SemanticSpeechAct>([
  "information_request",
  "status_question",
  "hypothetical",
  "statement",
]);

let client: OpenAI | null = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

function cleanInputText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boundedConfidence(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function result(params: {
  kind: BookingCommandKind;
  confidence: number;
  requiresClarification?: boolean;
  reason: string;
  source: BookingCommandSource;
  selectedOptionNumber?: number | null;
  hasFreshTemporalConstraint?: boolean;
}): BookingCommandResult {
  return {
    kind: params.kind,
    confidence: boundedConfidence(params.confidence),
    requiresClarification: params.requiresClarification === true,
    reason: params.reason,
    source: params.source,
    selectedOptionNumber:
      Number.isInteger(params.selectedOptionNumber) &&
      Number(params.selectedOptionNumber) > 0
        ? Number(params.selectedOptionNumber)
        : null,
    hasFreshTemporalConstraint:
      params.hasFreshTemporalConstraint === true,
  };
}

function semanticContext(context: BookingCommandContext) {
  return {
    hasActiveBooking: context.hasActiveBooking,
    hasCancelledBooking: context.hasCancelledBooking === true,
    currentAppointmentTime: context.currentAppointmentTime ?? null,
    cancelledAppointmentTime: context.cancelledAppointmentTime ?? null,
    timezone: context.timezone ?? null,
    subject: context.subject ?? null,
    recentAssistantMessage: context.recentAssistantMessage
      ? String(context.recentAssistantMessage).slice(0, 12000)
      : null,
    conversationContext: context.conversationContext
      ? String(context.conversationContext).slice(0, 16000)
      : null,
    hasReversibleReschedule: context.hasReversibleReschedule === true,
    hasOriginalBookingHistory: context.hasOriginalBookingHistory === true,
    priorSchedulingRequest: context.priorSchedulingRequest ?? null,
    pendingConfirmation: context.pendingConfirmation ?? null,
    pendingClarification: context.pendingClarification ?? null,
    pendingOfferedSlots: (context.pendingOfferedSlots ?? []).map((slot) => ({
      optionNumber: slot.optionNumber,
      startTime: slot.startTime,
      endTime: slot.endTime ?? null,
    })),
  };
}

/**
 * Resolve an explicit selection from authoritative persisted offered slots.
 *
 * This is structured-state interpretation, not a competing natural-language
 * action classifier. When LeadFlow has already presented numbered appointment
 * offers, choosing one of those identifiers is deterministic and must continue
 * to work even if the semantic model is unavailable, rate-limited, or out of
 * credits.
 *
 * If the newest turn also contains a temporal transformation (for example an
 * option plus a different day/month/year/time), this resolver deliberately
 * returns null so the normal semantic WHAT + canonical WHEN pipeline owns the
 * richer request.
 */
function resolveDeterministicPendingOfferSelection(params: {
  message: string;
  pendingOfferedSlots?: BookingOfferedSlot[];
}): BookingCommandResult | null {
  const offers = Array.isArray(params.pendingOfferedSlots)
    ? params.pendingOfferedSlots.filter(
        (slot) =>
          Number.isInteger(slot?.optionNumber) &&
          Number(slot.optionNumber) > 0 &&
          typeof slot?.startTime === "string" &&
          Boolean(slot.startTime.trim())
      )
    : [];

  if (offers.length === 0) return null;

  const text = cleanInputText(params.message).toLowerCase();
  if (!text) return null;

  // A selection plus any new WHEN meaning is not a plain persisted-offer pick.
  // Defer those turns to the semantic resolver and canonical temporal engine.
  const hasTemporalTransformationSurface =
    /\b(?:today|tomorrow|tonight|next|last|prior|previous|before|after|later|earlier|this\s+(?:morning|afternoon|evening|week|month|year)|morning|afternoon|evening|noon|midnight)\b/i.test(text) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text) ||
    /\b\d+\s*(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\b/i.test(text) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(text) ||
    /\b\d{1,2}:\d{2}\b/.test(text) ||
    /\b\d{1,2}[\\/-]\d{1,2}(?:[\\/-]\d{2,4})?\b/.test(text);

  if (hasTemporalTransformationSurface) return null;

  const numericCandidates: number[] = [];

  for (const match of text.matchAll(
    /\b(?:option|choice|slot|opening|number|no\\.?)[\s#:.-]*(\d{1,3})(?:st|nd|rd|th)?\b/gi
  )) {
    numericCandidates.push(Number(match[1]));
  }

  for (const match of text.matchAll(
    /(?:^|\s)#\s*(\d{1,3})\b/g
  )) {
    numericCandidates.push(Number(match[1]));
  }

  for (const match of text.matchAll(
    /\b(\d{1,3})(?:st|nd|rd|th)\s+(?:one|option|choice|slot|opening)\b/gi
  )) {
    numericCandidates.push(Number(match[1]));
  }

  const ordinalWords: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };

  for (const match of text.matchAll(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+(?:one|option|choice|slot|opening))?\b/gi
  )) {
    numericCandidates.push(ordinalWords[String(match[1]).toLowerCase()] ?? 0);
  }

  const authoritativeOptionNumbers = new Set(
    offers.map((slot) => Number(slot.optionNumber))
  );

  const selected = Array.from(
    new Set(
      numericCandidates.filter((candidate) =>
        authoritativeOptionNumbers.has(candidate)
      )
    )
  );

  // Zero matches means this is not a deterministic enumerated selection.
  // Multiple different valid option references are genuinely ambiguous.
  if (selected.length !== 1) return null;

  return result({
    kind: "select_offer",
    confidence: 1,
    requiresClarification: false,
    reason: "authoritative_pending_offer_selected_by_explicit_identifier",
    source: "deterministic",
    selectedOptionNumber: selected[0],
    hasFreshTemporalConstraint: false,
  });
}

function isBookingCommandKind(value: unknown): value is BookingCommandKind {
  return (
    value === "none" ||
    value === "information" ||
    value === "show_availability" ||
    value === "book" ||
    value === "select_offer" ||
    value === "reschedule" ||
    value === "cancel" ||
    value === "restore_previous" ||
    value === "restore_original" ||
    value === "restore_cancelled" ||
    value === "keep_current" ||
    value === "clarify"
  );
}

function isSemanticSpeechAct(value: unknown): value is SemanticSpeechAct {
  return (
    value === "action_request" ||
    value === "information_request" ||
    value === "status_question" ||
    value === "hypothetical" ||
    value === "confirmation" ||
    value === "withdrawal" ||
    value === "selection" ||
    value === "statement" ||
    value === "unclear" ||
    value === "none"
  );
}

function isSemanticRestorationReference(
  value: unknown
): value is SemanticRestorationReference {
  return (
    value === "none" ||
    value === "unspecified" ||
    value === "cancelled" ||
    value === "previous" ||
    value === "original"
  );
}

function isRestorationKind(kind: BookingCommandKind) {
  return (
    kind === "restore_previous" ||
    kind === "restore_original" ||
    kind === "restore_cancelled"
  );
}

/**
 * Resolve WHICH authoritative history target a semantic restoration request
 * refers to without interpreting customer vocabulary. The semantic model
 * decides whether the customer actually specified a target. When it did not,
 * state chronology owns the default: undo the latest reversible transition
 * first. A still-restorable cancellation is newer than reschedule lineage, so
 * it wins; otherwise the immediately previous reschedule wins; original
 * history is the final fallback.
 */
function normalizeRestorationKind(params: {
  decision: SemanticDecision;
  context: BookingCommandContext;
}): BookingCommandKind {
  const { decision, context } = params;

  if (!isBookingCommandKind(decision.kind) || !isRestorationKind(decision.kind)) {
    return isBookingCommandKind(decision.kind) ? decision.kind : "clarify";
  }

  const reference = isSemanticRestorationReference(
    decision.restorationReference
  )
    ? decision.restorationReference
    : "unspecified";

  if (decision.restorationReferenceSpecified === true) {
    if (reference === "cancelled") return "restore_cancelled";
    if (reference === "previous") return "restore_previous";
    if (reference === "original") return "restore_original";
    return "clarify";
  }

  // No history target was semantically identified by the customer.
  // Restore the latest authoritative reversible booking state.
  if (context.hasCancelledBooking === true) return "restore_cancelled";
  if (context.hasReversibleReschedule === true) return "restore_previous";
  if (context.hasOriginalBookingHistory === true) return "restore_original";

  return "clarify";
}

function validateSemanticDecision(params: {
  decision: SemanticDecision;
  context: BookingCommandContext;
}): BookingCommandResult {
  const { decision, context } = params;

  let kind: BookingCommandKind = isBookingCommandKind(decision.kind)
    ? decision.kind
    : "clarify";

  if (isRestorationKind(kind)) {
    kind = normalizeRestorationKind({ decision, context });
  }

  const speechAct: SemanticSpeechAct = isSemanticSpeechAct(decision.speechAct)
    ? decision.speechAct
    : "unclear";

  let selectedOptionNumber = Number(decision.selectedOptionNumber);
  if (!Number.isInteger(selectedOptionNumber) || selectedOptionNumber <= 0) {
    selectedOptionNumber = 0;
  }

  let requiresClarification = decision.requiresClarification === true;
  let reason =
    typeof decision.reason === "string" && decision.reason.trim()
      ? decision.reason.trim().slice(0, 600)
      : "semantic_booking_command_resolution";

  /*
   * Generic mutation firewall.
   *
   * The model must independently identify both the booking operation and the
   * speech act. If those two semantic judgments do not establish authorization,
   * the resolver refuses to mutate. No word, phrase, regex, punctuation mark,
   * or verb can bypass this invariant.
   */
  if (MUTATION_KINDS.has(kind)) {
    const authorizedBySemantics =
      decision.mutationAuthorized === true &&
      AUTHORIZING_SPEECH_ACTS.has(speechAct) &&
      decision.requiresClarification !== true;

    if (!authorizedBySemantics) {
      selectedOptionNumber = 0;

      if (
        NON_MUTATING_DISCUSSION_SPEECH_ACTS.has(speechAct) &&
        decision.requiresClarification !== true
      ) {
        kind = "information";
        requiresClarification = false;
        reason = "booking_mutation_discussed_without_execution_authorization";
      } else {
        kind = "clarify";
        requiresClarification = true;
        reason = "mutation_not_semantically_authorized";
      }
    }
  }

  /*
   * Structural state invariants. These do not interpret natural language.
   * They only prevent semantically impossible or stale state transitions.
   */
  if (kind === "book" && context.hasActiveBooking === true) {
    kind = "clarify";
    requiresClarification = true;
    reason = "new_booking_requested_while_active_booking_exists";
  }

  if (
    (kind === "reschedule" || kind === "cancel") &&
    context.hasActiveBooking !== true
  ) {
    kind = "clarify";
    requiresClarification = true;
    reason = "active_booking_required_for_requested_operation";
  }

  if (
    kind === "reschedule" &&
    decision.hasFreshTemporalConstraint !== true
  ) {
    kind = "clarify";
    requiresClarification = true;
    reason = "reschedule_requires_fresh_temporal_target";
  }

  if (
    kind === "restore_previous" &&
    context.hasReversibleReschedule !== true
  ) {
    kind = "clarify";
    requiresClarification = true;
    reason = "no_reversible_reschedule_history";
  }

  if (
    kind === "restore_original" &&
    context.hasOriginalBookingHistory !== true
  ) {
    kind = "clarify";
    requiresClarification = true;
    reason = "no_original_booking_history";
  }

  if (
    kind === "restore_cancelled" &&
    context.hasCancelledBooking !== true
  ) {
    kind = "clarify";
    requiresClarification = true;
    reason = "no_cancelled_booking_available_to_restore";
  }

  if (kind === "select_offer") {
    const offeredOptionNumbers = new Set(
      (context.pendingOfferedSlots ?? []).map((slot) => Number(slot.optionNumber))
    );
    if (!offeredOptionNumbers.has(selectedOptionNumber)) {
      kind = "clarify";
      requiresClarification = true;
      selectedOptionNumber = 0;
      reason = "selected_offer_not_present_in_authoritative_pending_offers";
    }
  } else {
    selectedOptionNumber = 0;
  }

  if (kind === "clarify") {
    requiresClarification = true;
  }

  return result({
    kind,
    confidence: decision.confidence,
    requiresClarification,
    reason,
    source: "semantic_model",
    selectedOptionNumber,
    hasFreshTemporalConstraint:
      decision.hasFreshTemporalConstraint === true,
  });
}

async function resolveContextualActiveBookingIntent(params: {
  openai: OpenAI;
  message: string;
  context: BookingCommandContext;
}): Promise<ContextualActiveBookingDecision> {
  const response = await params.openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "leadflow_contextual_active_booking_intent",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["interpretation", "confidence", "reason"],
          properties: {
            interpretation: {
              type: "string",
              enum: [
                "reschedule_active_booking",
                "show_availability",
                "information",
                "unclear",
              ],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
    } as any,
    messages: [
      {
        role: "system",
        content: [
          "You are a semantic discriminator inside an HVAC booking system.",
          "An ACTIVE appointment already exists. The primary action resolver did not confidently decide whether the newest customer turn changes that appointment, asks only for availability/information, or failed to recognize an elliptical relative scheduling change.",
          "Use the complete supplied booking state and discourse context. Do not classify from isolated keywords or require the customer to say the word reschedule.",
          "Do not resolve the actual date/time. Do not check availability. Do not mutate anything.",
          "",
          "Return reschedule_active_booking when the customer is directing the system/company to move/change the ACTIVE appointment and the fresh temporal language supplies or transforms its replacement WHEN. Elliptical references to the current appointment or its time are valid when discourse context makes that referent clear.",
          "Return show_availability when the customer is only asking to see/know whether openings exist for the referenced time/window and is not directing a change to the current appointment.",
          "Return information for non-availability informational discussion.",
          "Return unclear only when the discourse really does not establish whether execution is requested or what booking object is being referred to.",
          "",
          "Important: a directive about an already-active appointment plus a fresh temporal transformation is a reschedule even when phrased indirectly, colloquially, with pronouns, demonstratives, ellipsis, or shorthand. Do not demand redundant wording that the appointment be rescheduled when the active-booking context already supplies that object.",
          "A question about possible times is not a reschedule. A directive to change the active appointment is.",
          "Return only the strict JSON object.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          context: semanticContext(params.context),
          newestCustomerMessage: params.message.slice(0, 16000),
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("empty_contextual_active_booking_resolution");

  const parsed = JSON.parse(content);
  const interpretation = [
    "reschedule_active_booking",
    "show_availability",
    "information",
    "unclear",
  ].includes(parsed?.interpretation)
    ? parsed.interpretation
    : "unclear";

  return {
    interpretation,
    confidence: boundedConfidence(parsed?.confidence),
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 600)
        : "contextual_active_booking_resolution",
  };
}

async function resolveHistoryBacktrackAmbiguity(params: {
  openai: OpenAI;
  message: string;
  context: BookingCommandContext;
}): Promise<HistoryBacktrackDecision> {
  const response = await params.openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "leadflow_history_backtrack_discriminator",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "interpretation",
            "restorationReference",
            "restorationReferenceSpecified",
            "confidence",
            "reason",
          ],
          properties: {
            interpretation: {
              type: "string",
              enum: [
                "restore_history",
                "new_reschedule_with_target",
                "new_reschedule_without_target",
                "not_history_backtrack",
                "unclear",
              ],
            },
            restorationReference: {
              type: "string",
              enum: ["none", "unspecified", "cancelled", "previous", "original"],
            },
            restorationReferenceSpecified: { type: "boolean" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
    } as any,
    messages: [
      {
        role: "system",
        content: [
          "You are a semantic discriminator inside one canonical booking-action resolver.",
          "The primary resolver proposed a reschedule or booking-history restoration while authoritative booking history may be reversible.",
          "Independently decide whether the customer means booking-history restoration or a genuinely new reschedule. Do NOT trust the primary resolver's hasFreshTemporalConstraint flag; infer meaning from the complete newest utterance plus supplied conversation/state.",
          "Do not key off isolated words. Resolve pronouns, ellipsis, discourse references, and the immediately preceding completed booking-state change from context.",
          "A directional edit with a new replacement scheduling destination is a reschedule even when it moves backward. Direction alone does not authorize restoring an old history record. Interpret the complete destination clause before choosing restoration.",
          "",
          "INTERPRETATIONS:",
          "restore_history = the customer is asking to undo/reverse/backtrack a completed booking-state change and return to an earlier authoritative booking state, without supplying a new replacement scheduling destination.",
          "new_reschedule_with_target = the customer wants a new appointment state and the newest turn supplies or completes a replacement WHEN target (date/day/time/daypart/window/relative calendar transform).",
          "new_reschedule_without_target = the customer wants a different appointment but has not supplied enough replacement WHEN information and is not asking to restore booking history.",
          "not_history_backtrack = the turn is not actually a booking-history rollback request and does not fit the new-reschedule cases above.",
          "unclear = the distinction cannot be made safely.",
          "",
          "RESTORATION REFERENCE:",
          "For restore_history, set restorationReferenceSpecified=true only if the utterance/context identifies cancelled, previous, or original history specifically.",
          "Otherwise use restorationReference=unspecified and restorationReferenceSpecified=false. Authoritative state chronology will choose the latest reversible state.",
          "For non-restoration interpretations use restorationReference=none and restorationReferenceSpecified=false.",
          "",
          "Do not treat communication follow-up as booking restoration merely because wording can have a backward-looking meaning.",
          "Do not invent a date/time. Do not check availability. Do not execute anything.",
          "Return only the strict JSON object.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          context: semanticContext(params.context),
          newestCustomerMessage: params.message.slice(0, 16000),
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("empty_history_backtrack_resolution");

  const parsed = JSON.parse(content) as HistoryBacktrackDecision;
  const allowedInterpretations = new Set<HistoryBacktrackDecision["interpretation"]>([
    "restore_history",
    "new_reschedule_with_target",
    "new_reschedule_without_target",
    "not_history_backtrack",
    "unclear",
  ]);

  return {
    interpretation: allowedInterpretations.has(parsed?.interpretation)
      ? parsed.interpretation
      : "unclear",
    restorationReference: isSemanticRestorationReference(parsed?.restorationReference)
      ? parsed.restorationReference
      : "none",
    restorationReferenceSpecified:
      parsed?.restorationReferenceSpecified === true,
    confidence: boundedConfidence(parsed?.confidence),
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 600)
        : "history_backtrack_semantic_resolution",
  };
}

async function verifyMutationAuthorization(params: {
  openai: OpenAI;
  message: string;
  context: BookingCommandContext;
  proposedKind: BookingCommandKind;
}): Promise<MutationAuthorizationDecision> {
  const response = await params.openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "leadflow_mutation_authorization",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["authorization", "confidence", "reason"],
          properties: {
            authorization: {
              type: "string",
              enum: ["authorized", "not_authorized", "unclear"],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
        },
      },
    } as any,
    messages: [
      {
        role: "system",
        content: [
          "You are a booking-mutation AUTHORIZATION verifier, not an action classifier.",
          "A separate canonical resolver has already proposed a booking mutation kind. Do NOT choose or change the kind. Your only job is to decide whether the newest customer's complete utterance, interpreted with the supplied conversation and authoritative booking state, gives the system/company permission to execute that proposed mutation NOW.",
          "Use semantic meaning, discourse context, reference resolution, and speech act. Do not decide from keywords, isolated verbs, punctuation, or fixed wording.",
          "Natural language may be direct, indirect, slang, fragmentary, elliptical, polite, or context-dependent. No magic words are required for authorization.",
          "Return authorized when the customer is genuinely requesting/confirming/selecting/withdrawing in a way that authorizes the proposed mutation now.",
          "Return not_authorized when the customer is asking for information, procedure, capability, policy, explanation, status, or discussing a hypothetical/conditional possibility rather than asking for execution.",
          "Return unclear when the context does not safely establish whether execution is authorized.",
          "A question grammatical form can still authorize an action if its communicative function is a request for the company to perform it. Conversely, naming an action does not authorize it if its communicative function is informational or hypothetical.",
          "Terse confirmations or rejections must be interpreted from the immediately preceding conversational context; do not invent a pending action that is not actually present.",
          "Be conservative about execution when meaning is genuinely ambiguous, but do not require explicit formulaic wording when the intent is semantically clear.",
          "When proposedMutationKind=reschedule and an active booking exists, an execution directive that refers contextually to the active appointment or its time and supplies a fresh relative/absolute scheduling change authorizes that reschedule even if the customer omits the words appointment or reschedule. Natural anaphora, pronouns, slang, and ellipsis are valid when the supplied discourse context makes the booking referent clear.",
          "Do NOT authorize when the customer is only asking whether a time is open, asking what options exist, or otherwise requesting read-only availability/information rather than directing a change.",
          "Return only the strict JSON object.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          proposedMutationKind: params.proposedKind,
          context: semanticContext(params.context),
          newestCustomerMessage: params.message.slice(0, 16000),
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return {
      authorization: "unclear",
      confidence: 0,
      reason: "empty_mutation_authorization_resolution",
    };
  }

  const parsed = JSON.parse(content);
  const authorization =
    parsed?.authorization === "authorized" ||
    parsed?.authorization === "not_authorized" ||
    parsed?.authorization === "unclear"
      ? parsed.authorization
      : "unclear";

  return {
    authorization,
    confidence: boundedConfidence(parsed?.confidence),
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 600)
        : "semantic_mutation_authorization_resolution",
  };
}

export async function resolveBookingCommand(input: {
  message: string;
  context: BookingCommandContext;
}): Promise<BookingCommandResult> {
  const message = cleanInputText(input.message);

  if (!message) {
    return result({
      kind: "none",
      confidence: 1,
      reason: "empty_message",
      source: "deterministic",
    });
  }

  const deterministicPendingOfferSelection =
    resolveDeterministicPendingOfferSelection({
      message,
      pendingOfferedSlots: input.context.pendingOfferedSlots,
    });

  if (deterministicPendingOfferSelection) {
    return deterministicPendingOfferSelection;
  }

  const openai = getClient();
  if (!openai) {
    return result({
      kind: input.context.hasActiveBooking ? "clarify" : "none",
      confidence: 0,
      requiresClarification: input.context.hasActiveBooking,
      reason:
        "booking_command_semantic_resolution_unavailable_and_no_safe_language_heuristic_is_allowed",
      source: "fallback",
      hasFreshTemporalConstraint: false,
    });
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "leadflow_booking_command",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "speechAct",
              "mutationAuthorized",
              "restorationReference",
              "restorationReferenceSpecified",
              "confidence",
              "requiresClarification",
              "reason",
              "selectedOptionNumber",
              "hasFreshTemporalConstraint",
            ],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "none",
                  "information",
                  "show_availability",
                  "book",
                  "select_offer",
                  "reschedule",
                  "cancel",
                  "restore_previous",
                  "restore_original",
                  "restore_cancelled",
                  "keep_current",
                  "clarify",
                ],
              },
              speechAct: {
                type: "string",
                enum: [
                  "action_request",
                  "information_request",
                  "status_question",
                  "hypothetical",
                  "confirmation",
                  "withdrawal",
                  "selection",
                  "statement",
                  "unclear",
                  "none",
                ],
              },
              mutationAuthorized: { type: "boolean" },
              restorationReference: {
                type: "string",
                enum: [
                  "none",
                  "unspecified",
                  "cancelled",
                  "previous",
                  "original",
                ],
              },
              restorationReferenceSpecified: { type: "boolean" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              requiresClarification: { type: "boolean" },
              reason: { type: "string" },
              selectedOptionNumber: {
                type: "integer",
                minimum: 0,
                maximum: 100,
              },
              hasFreshTemporalConstraint: { type: "boolean" },
            },
          },
        },
      } as any,
      messages: [
        {
          role: "system",
          content: [
            "You are the ONE authoritative booking-domain semantic action resolver for an HVAC lead-response system.",
            "Your job is to understand the newest customer's COMPLETE utterance in the supplied conversation and authoritative booking state, then decide WHAT booking operation—if any—the customer is actually asking the system to perform.",
            "Do not answer the customer. Do not resolve the actual date/time. Do not invent availability. Do not mutate Calendar or booking state.",
            "Do not classify from isolated keywords, individual verbs, punctuation, or surface templates. Interpret meaning compositionally from the whole statement and context.",
            "Natural language is open-ended: slang, typos, fragments, pronouns, indirect requests, confirmations, withdrawals, ellipsis, and follow-up answers must be resolved from context rather than from a fixed phrase vocabulary.",
            "Conversation Intelligence and Booking are parallel lanes. A turn may discuss booking while still being informational. The fact that an operation is mentioned does not authorize that operation.",
            "Temporal language answers WHEN. It does not by itself authorize a booking mutation.",
            "",
            "FIRST decide speechAct:",
            "action_request = customer is asking the system/company to perform an action now.",
            "information_request = customer wants knowledge, instructions, policy, capability, explanation, or procedure rather than execution.",
            "status_question = customer asks whether something happened/is true/is currently scheduled.",
            "hypothetical = customer discusses a possible/conditional scenario rather than authorizing it now.",
            "confirmation = customer confirms an immediately pending action/choice established by the conversation context.",
            "withdrawal = customer clearly withdraws from/cannot proceed with the active service visit; this can authorize cancellation even without naming cancellation.",
            "selection = customer chooses one specific authoritative pending offered option.",
            "statement = meaningful statement that does not itself request execution.",
            "unclear = the complete utterance and context do not safely establish the speech act.",
            "none = no meaningful booking-domain speech act.",
            "",
            "THEN decide kind:",
            "none = no meaningful booking-domain operation.",
            "information = customer is asking/talking about company, service, policy, procedure, status, general information, or a booking operation without authorizing execution.",
            "show_availability = customer wants to see/know/compare real appointment openings without committing to one.",
            "book = customer authorizes creation of a new appointment when no active booking exists.",
            "select_offer = customer selects exactly one supplied pendingOfferedSlot.",
            "reschedule = customer authorizes moving/changing an active appointment.",
            "cancel = customer authorizes cancellation/withdrawal of the active appointment/service visit.",
            "restore_previous = customer authorizes returning specifically to the immediately previous completed appointment from authoritative reschedule history; only when hasReversibleReschedule=true.",
            "restore_original = customer authorizes return specifically to the original/first booking from authoritative booking lineage; only when hasOriginalBookingHistory=true.",
            "restore_cancelled = customer authorizes reinstatement specifically of the still-restorable cancelled appointment; only when hasCancelledBooking=true.",
            "keep_current = customer wants the active appointment left unchanged or withdraws a proposed/uncompleted change.",
            "clarify = booking-domain meaning or authorization is genuinely ambiguous and executing anything would be unsafe.",
            "",
            "MUTATION AUTHORIZATION:",
            "mutationAuthorized=true ONLY when the full utterance in context gives the system/company permission to perform the returned mutation now.",
            "Mutation kinds are book, select_offer, reschedule, cancel, restore_previous, restore_original, restore_cancelled.",
            "A mutation may be authorized by direct language, indirect natural language, contextual confirmation, contextual withdrawal, or selecting a pending offer. No magic wording is required.",
            "mutationAuthorized=false when the customer is merely asking how/whether/why/when an action works, discussing policy/process, checking status, considering a possibility, stating a hypothetical, quoting someone, or otherwise mentioning the operation without requesting execution.",
            "If the utterance both asks for information and authorizes a mutation, return the mutation only when execution authorization is genuinely clear; the caller can handle information sidecars separately.",
            "If authorization is uncertain, return clarify with mutationAuthorized=false. Never guess into a mutation.",
            "",
            "RESTORATION TARGET SEMANTICS:",
            "restorationReference describes WHICH booking-history target the customer semantically identified, independently of whether restoration itself is authorized.",
            "For non-restoration turns, restorationReference=none and restorationReferenceSpecified=false.",
            "For an authorized restoration/backtracking request where the customer does not identify which history target they mean, restorationReference=unspecified and restorationReferenceSpecified=false.",
            "Set restorationReferenceSpecified=true only when the complete utterance plus discourse context actually identifies one particular target: cancelled, previous, or original. Do not mark a target specified merely because that target exists in state.",
            "cancelled means the customer specifically identifies the still-restorable cancelled appointment as the target.",
            "previous means the customer specifically identifies the appointment immediately before the latest completed reschedule as the target.",
            "original means the customer specifically identifies the first/original booking in lineage as the target.",
            "Generic restoration/backtracking language must remain unspecified; do not silently reinterpret an unspecified restoration as previous or original.",
            "When restorationReference is unspecified, the caller—not you—applies authoritative state chronology: latest restorable cancellation first, then previous reschedule history, then original history.",
            "",
            "CONTEXT RULES:",
            "Resolve references such as it/that/this/the old one/the other one/yes/no/back/there from recentAssistantMessage, conversationContext, pendingOfferedSlots, current booking state, and booking history.",
            "A terse confirmation can authorize a mutation only when the immediately preceding context clearly presented that exact action for confirmation.",
            "A terse rejection can mean keep_current or information depending on what was pending; use context.",
            "A customer may cancel by semantically withdrawing from the active visit even if they never use the word cancel.",
            "A customer may request cancellation in question grammar while still clearly asking the company to perform it; grammar alone does not determine speechAct.",
            "A customer may ask about cancellation using cancellation vocabulary without authorizing it; vocabulary alone does not determine speechAct.",
            "A request for options/openings/times in a service-scheduling context is show_availability unless the conversation clearly establishes a different option set.",
            "Seeing availability is read-only and mutationAuthorized must be false.",
            "Selecting a persisted offered slot is select_offer; selectedOptionNumber must correspond to exactly one supplied pendingOfferedSlot.",
            "Do not reinterpret a selected option number as a clock/date.",
            "Restoration language with a fresh new scheduling target is generally reschedule unless the customer clearly identifies authoritative previous/original/cancelled history as the target.",
            "If the customer asks to undo/reverse/backtrack the most recent completed booking-state change without introducing a new WHEN, treat that as restoration/backtracking, not as a targetless reschedule.",
            "A genuine reschedule must introduce or complete a replacement scheduling target; if no fresh WHEN exists and the meaning is not booking-history restoration, clarification is required.",
            "When an active booking exists and the customer gives an execution directive whose referent is the current appointment or its time, fresh relative/absolute scheduling language that changes WHEN is sufficient to make the operation reschedule. Do not require the customer to repeat the noun appointment or the verb reschedule when discourse context already identifies the active booking.",
            "Conversely, a customer merely asking what openings exist or whether a time is available is show_availability, not reschedule. Distinguish directive execution from read-only inspection using the whole utterance and context.",
            "Communication follow-up is not booking restoration merely because a customer uses a word such as back.",
            "Never call a day/time available. Availability is downstream authoritative company-rules + Calendar truth.",
            "",
            "hasFreshTemporalConstraint=true only when the newest turn itself introduces or changes date/day/clock/daypart/relative-time/window meaning. It is false when the newest turn merely selects an already-offered option or refers to an already-established scheduling target without changing it.",
            "",
            "selectedOptionNumber must be 0 unless kind=select_offer.",
            "Return only the strict JSON object.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            context: semanticContext(input.context),
            newestCustomerMessage: message.slice(0, 16000),
          }),
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("empty_booking_command_resolution");

    const parsed = JSON.parse(content) as SemanticDecision;

    if (isBookingCommandKind(parsed?.kind) && isRestorationKind(parsed.kind)) {
      parsed.kind = normalizeRestorationKind({
        decision: parsed,
        context: input.context,
      });

      if (parsed.kind === "clarify") {
        parsed.mutationAuthorized = false;
        parsed.requiresClarification = true;
        parsed.speechAct = "unclear";
        parsed.reason = "restoration_target_not_resolvable_from_authoritative_state";
      }
    }

    /*
     * Contextual active-booking arbitration.
     *
     * Natural customer follow-ups often omit the noun "appointment" because the
     * active booking is already the discourse object. When the primary semantic
     * pass is unsure whether an active-booking follow-up requests execution,
     * read-only availability, or information—or proposes reschedule without
     * correctly recognizing its fresh temporal meaning—resolve that ambiguity
     * from the complete conversation state here.
     *
     * This remains inside the ONE canonical WHAT authority. It does not parse
     * WHEN, check Calendar truth, or mutate anything.
     */
    if (
      input.context.hasActiveBooking === true &&
      (
        parsed?.kind === "clarify" ||
        parsed?.kind === "information" ||
        parsed?.kind === "show_availability" ||
        (
          parsed?.kind === "reschedule" &&
          parsed?.hasFreshTemporalConstraint !== true
        )
      )
    ) {
      try {
        const contextualDecision = await resolveContextualActiveBookingIntent({
          openai,
          message,
          context: input.context,
        });

        if (
          contextualDecision.interpretation === "reschedule_active_booking" &&
          contextualDecision.confidence >= 0.75
        ) {
          parsed.kind = "reschedule";
          parsed.speechAct = "action_request";
          parsed.mutationAuthorized = true;
          parsed.requiresClarification = false;
          parsed.hasFreshTemporalConstraint = true;
          parsed.restorationReference = "none";
          parsed.restorationReferenceSpecified = false;
          parsed.confidence = Math.max(
            boundedConfidence(parsed.confidence),
            contextualDecision.confidence
          );
          parsed.reason = contextualDecision.reason;
        } else if (
          contextualDecision.interpretation === "show_availability" &&
          contextualDecision.confidence >= 0.75
        ) {
          parsed.kind = "show_availability";
          parsed.speechAct = "information_request";
          parsed.mutationAuthorized = false;
          parsed.requiresClarification = false;
          parsed.restorationReference = "none";
          parsed.restorationReferenceSpecified = false;
          parsed.confidence = contextualDecision.confidence;
          parsed.reason = contextualDecision.reason;
        } else if (
          contextualDecision.interpretation === "information" &&
          contextualDecision.confidence >= 0.75
        ) {
          parsed.kind = "information";
          parsed.speechAct = "information_request";
          parsed.mutationAuthorized = false;
          parsed.requiresClarification = false;
          parsed.restorationReference = "none";
          parsed.restorationReferenceSpecified = false;
          parsed.confidence = contextualDecision.confidence;
          parsed.reason = contextualDecision.reason;
        }
      } catch (error: any) {
        console.error("[booking-command] contextual active-booking arbitration failed", {
          error: error?.message ?? error,
        });
      }
    }

    /*
     * Generic history-backtrack arbitration.
     *
     * IMPORTANT: do not gate this on the primary model's
     * hasFreshTemporalConstraint flag. A rollback utterance can be incorrectly
     * labeled as containing fresh temporal meaning simply because it contains
     * directional language. Whenever RESCHEDULE or RESTORATION is proposed and authoritative
     * reversible booking history exists, independently distinguish:
     *   - restore prior authoritative booking state,
     *   - genuine reschedule with a replacement WHEN,
     *   - targetless reschedule requiring clarification.
     *
     * This stays inside the ONE canonical WHAT authority. It does not resolve
     * the actual date/time, check availability, or mutate Calendar state.
     */
    if (
      (
        parsed?.kind === "reschedule" ||
        parsed?.kind === "restore_previous" ||
        parsed?.kind === "restore_original" ||
        parsed?.kind === "restore_cancelled"
      ) &&
      input.context.hasActiveBooking === true &&
      (
        input.context.hasCancelledBooking === true ||
        input.context.hasReversibleReschedule === true ||
        input.context.hasOriginalBookingHistory === true
      )
    ) {
      try {
        const backtrack = await resolveHistoryBacktrackAmbiguity({
          openai,
          message,
          context: input.context,
        });

        if (
          backtrack.interpretation === "restore_history" &&
          backtrack.confidence >= 0.7
        ) {
          parsed.kind = "restore_previous";
          parsed.restorationReference = backtrack.restorationReference;
          parsed.restorationReferenceSpecified =
            backtrack.restorationReferenceSpecified;
          parsed.hasFreshTemporalConstraint = false;
          parsed.requiresClarification = false;
          parsed.reason = backtrack.reason;

          parsed.kind = normalizeRestorationKind({
            decision: parsed,
            context: input.context,
          });

          if (parsed.kind === "clarify") {
            parsed.mutationAuthorized = false;
            parsed.requiresClarification = true;
            parsed.speechAct = "unclear";
            parsed.reason =
              "history_backtrack_target_not_resolvable_from_authoritative_state";
          }
        } else if (
          backtrack.interpretation === "new_reschedule_with_target" &&
          backtrack.confidence >= 0.7
        ) {
          // A replacement destination is a new reschedule, including when the
          // primary pass proposed restoring history. Canonical temporal owns WHEN.
          parsed.kind = "reschedule";
          parsed.restorationReference = "none";
          parsed.restorationReferenceSpecified = false;
          parsed.selectedOptionNumber = 0;
          parsed.hasFreshTemporalConstraint = true;
          parsed.requiresClarification = false;
          parsed.reason = backtrack.reason;
        } else if (
          backtrack.interpretation === "new_reschedule_without_target"
        ) {
          parsed.kind = "clarify";
          parsed.mutationAuthorized = false;
          parsed.hasFreshTemporalConstraint = false;
          parsed.requiresClarification = true;
          parsed.speechAct = "unclear";
          parsed.reason = "reschedule_requires_fresh_temporal_target";
        } else if (
          backtrack.interpretation === "unclear" ||
          (backtrack.interpretation === "not_history_backtrack" &&
            parsed.kind !== "reschedule") ||
          ((backtrack.interpretation === "restore_history" ||
            backtrack.interpretation === "new_reschedule_with_target") &&
            backtrack.confidence < 0.7)
        ) {
          parsed.kind = "clarify";
          parsed.mutationAuthorized = false;
          parsed.hasFreshTemporalConstraint = false;
          parsed.requiresClarification = true;
          parsed.speechAct = "unclear";
          parsed.reason = "history_backtrack_vs_reschedule_unclear";
        }
      } catch (error: any) {
        console.error("[booking-command] history-backtrack arbitration failed", {
          error: error?.message ?? error,
        });
        parsed.kind = "clarify";
        parsed.mutationAuthorized = false;
        parsed.hasFreshTemporalConstraint = false;
        parsed.requiresClarification = true;
        parsed.speechAct = "unclear";
        parsed.reason = "history_backtrack_arbitration_failed";
      }
    }

    /*
     * Mutation candidates receive a second semantic authorization check.
     * This verifier cannot choose WHAT operation to perform, so the canonical
     * action authority remains singular. It only controls whether execution is
     * permitted. No customer phrase list is involved.
     */
    if (
      isBookingCommandKind(parsed?.kind) &&
      MUTATION_KINDS.has(parsed.kind) &&
      parsed?.mutationAuthorized === true &&
      isSemanticSpeechAct(parsed?.speechAct) &&
      AUTHORIZING_SPEECH_ACTS.has(parsed.speechAct) &&
      parsed?.requiresClarification !== true
    ) {
      let authorization: MutationAuthorizationDecision;
      try {
        authorization = await verifyMutationAuthorization({
          openai,
          message,
          context: input.context,
          proposedKind: parsed.kind,
        });
      } catch (error: any) {
        console.error("[booking-command] mutation authorization verification failed", {
          error: error?.message ?? error,
          proposedKind: parsed.kind,
        });
        authorization = {
          authorization: "unclear",
          confidence: 0,
          reason: "mutation_authorization_verification_failed",
        };
      }

      if (authorization.authorization !== "authorized") {
        parsed.mutationAuthorized = false;

        if (authorization.authorization === "unclear") {
          parsed.requiresClarification = true;
          parsed.speechAct = "unclear";
        }

        parsed.reason = authorization.reason;
        parsed.confidence = Math.min(
          boundedConfidence(parsed.confidence),
          boundedConfidence(authorization.confidence)
        );
      } else {
        parsed.confidence = Math.min(
          boundedConfidence(parsed.confidence),
          boundedConfidence(authorization.confidence)
        );
      }
    }

    return validateSemanticDecision({
      decision: parsed,
      context: input.context,
    });
  } catch (error: any) {
    console.error("[booking-command] semantic resolution failed", {
      error: error?.message ?? error,
    });

    return result({
      kind: input.context.hasActiveBooking ? "clarify" : "none",
      confidence: 0,
      requiresClarification: input.context.hasActiveBooking,
      reason: "booking_command_semantic_resolution_failed",
      source: "fallback",
      hasFreshTemporalConstraint: false,
    });
  }
}

export function toLegacyCustomerActionIntent(
  command: BookingCommandResult
): LegacyCustomerActionIntent {
  switch (command.kind) {
    case "cancel":
      return {
        action: "cancel_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "reschedule":
      return {
        action: "reschedule_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "restore_previous":
      return {
        action: "keep_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: "customer_requested_previous_booking_restoration",
        source: command.source,
      };
    case "restore_original":
      return {
        action: "keep_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: "customer_requested_original_booking_restoration",
        source: command.source,
      };
    case "restore_cancelled":
      return {
        action: "restore_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "keep_current":
      return {
        action: "keep_booking",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "information":
      return {
        action: "information_request",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "book":
      return {
        action: "booking_request",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
    case "clarify":
      return {
        action: "unclear",
        confidence: command.confidence,
        requiresClarification: true,
        reason: command.reason,
        source: command.source,
      };
    default:
      return {
        action: "none",
        confidence: command.confidence,
        requiresClarification: false,
        reason: command.reason,
        source: command.source,
      };
  }
}

export function toLegacyAvailabilityIntent(
  command: BookingCommandResult
): LegacyAvailabilityIntent {
  const decision: LegacyAvailabilityIntent["decision"] =
    command.kind === "show_availability"
      ? "availability_inquiry"
      : command.kind === "select_offer"
        ? "option_selection"
        : command.kind === "information"
          ? "information_question"
          : [
                "book",
                "reschedule",
                "cancel",
                "restore_previous",
                "restore_original",
                "restore_cancelled",
                "keep_current",
              ].includes(command.kind)
            ? "booking_action"
            : "other";

  return {
    decision,
    confidence: command.confidence,
    reason: command.reason,
    hasFreshTemporalConstraint: command.hasFreshTemporalConstraint,
    selectedOptionNumber: command.selectedOptionNumber,
    source: command.source,
  };
}