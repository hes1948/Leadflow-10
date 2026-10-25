// lib/inbound/resolvePendingSlotConfirmation.ts

type PendingSlotSuggestion = {
  status?: string | null;
  suggestedStartTime?: string | null;
  suggestedEndTime?: string | null;
  suggestedSlots?: Array<{
    startTime?: string | null;
    endTime?: string | null;
  }> | null;
};

type ResolveParams = {
  message: string;
  qualification?: Record<string, any> | null;
  timezone: string;
};

export type ResolvedSlot = {
  matched: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
  confidence: "low" | "medium" | "high";
};

type NormalizedSlot = {
  startTime: string;
  endTime: string | null;
};

function normalize(text: string) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’‘`]/g, "'")
    .replace(/\bya['’]?ll\b/g, " yall ")
    .replace(/\by['’]?all\b/g, " yall ")
    .replace(/\bu\b/g, " you ")
    .replace(/\bur\b/g, " your ")
    .replace(/\br\b/g, " are ")
    .replace(/\bpls\b/g, " please ")
    .replace(/\bplz\b/g, " please ")
    .replace(/\bappt\b/g, " appointment ")
    .replace(/\bsched\b/g, " schedule ")
    .replace(/\s*#\s*/g, " number ")
    .replace(/[^\w\s:.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getPendingSuggestion(
  qualification?: Record<string, any> | null
): NormalizedSlot[] {
  const pending = qualification?.pendingSlotSuggestion as
    | PendingSlotSuggestion
    | undefined;

  if (!pending) return [];
  if (pending.status !== "awaiting_customer_confirmation") return [];

  const sourceSlots =
    Array.isArray(pending.suggestedSlots) && pending.suggestedSlots.length > 0
      ? pending.suggestedSlots
      : pending.suggestedStartTime
        ? [
            {
              startTime: pending.suggestedStartTime,
              endTime: pending.suggestedEndTime ?? null,
            },
          ]
        : [];

  const seen = new Set<string>();

  return sourceSlots
    .filter((slot) => Boolean(slot?.startTime))
    .map((slot) => ({
      startTime: String(slot.startTime),
      endTime: slot.endTime ? String(slot.endTime) : null,
    }))
    .filter((slot) => {
      const startMs = new Date(slot.startTime).getTime();
      if (!Number.isFinite(startMs)) return false;

      const key = `${slot.startTime}|${slot.endTime ?? ""}`;
      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
}

function hasHardNegative(text: string) {
  return /\b(no|nope|cancel|never mind|nevermind|hold off|do not book|don't book|dont book|not that one|none of those)\b/.test(
    text
  );
}

function hasChangeRequest(text: string) {
  return /\b(different|another|later|earlier|reschedule|what about|how about|is there|do you have|available|availability)\b/.test(
    text
  );
}

function hasPositiveLanguage(text: string) {
  return /\b(yes|yeah|yea|yep|yup|sure|ok|okay|alright|aight|bet|perfect|good|great|cool|fine|works?|book|schedule|confirm|take|grab|choose|pick|select|use|do|go|lock|reserve|set|make|put|send|run|roll|slide|swing|come|stop by|show up|pull up|please|lets|let's|that one|this one|see you|be there|sounds good|that works|works for me|i'll take|ill take|i want|give me|put me down|sign me up)\b/.test(
    text
  );
}

function hasExplicitTimeLanguage(text: string) {
  return (
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|morning|afternoon|evening|tonight|noon|midnight)\b/.test(
      text
    ) ||
    /\b(at|around|about|before|after|by)\s+(1[0-2]|0?[1-9])(?::[0-5][0-9])?\s*(am|pm)?\b/.test(
      text
    ) ||
    /\b(1[0-2]|0?[1-9])(?::[0-5][0-9])\s*(am|pm)?\b/.test(text) ||
    /\b(1[0-2]|0?[1-9])\s*(am|pm)\b/.test(text)
  );
}

function extractOptionIndex(message: string, max: number) {
  const text = normalize(message);

  if (!text || max <= 0) return null;
  if (hasHardNegative(text) || hasChangeRequest(text)) return null;

  const explicitPatterns: Array<[RegExp, number]> = [
    [
      /\b(?:option|slot|choice|opening|appointment|number|num)\s*(?:number\s*)?(?:1|one|first|1st)\b/,
      0,
    ],
    [
      /\b(?:option|slot|choice|opening|appointment|number|num)\s*(?:number\s*)?(?:2|two|second|2nd|middle)\b/,
      1,
    ],
    [
      /\b(?:option|slot|choice|opening|appointment|number|num)\s*(?:number\s*)?(?:3|three|third|3rd)\b/,
      2,
    ],
    [/\b(?:first|1st)\s+(?:one|option|slot|choice|opening|appointment)\b/, 0],
    [/\b(?:second|2nd|middle)\s+(?:one|option|slot|choice|opening|appointment)\b/, 1],
    [/\b(?:third|3rd)\s+(?:one|option|slot|choice|opening|appointment)\b/, 2],
  ];

  for (const [pattern, index] of explicitPatterns) {
    if (index < max && pattern.test(text)) return index;
  }

  const actionPatterns: Array<[RegExp, number]> = [
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|number\s+|num\s+)?(?:1|one|first|1st)\b/,
      0,
    ],
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|number\s+|num\s+)?(?:2|two|second|2nd)\b/,
      1,
    ],
    [
      /\b(?:do|take|pick|choose|select|book|schedule|confirm|grab|use|want|reserve|lock(?:\s+in)?|go\s+with|give\s+me|put\s+me\s+(?:down\s+)?for|sign\s+me\s+up\s+for)\s+(?:the\s+)?(?:option\s+|slot\s+|choice\s+|opening\s+|appointment\s+|number\s+|num\s+)?(?:3|three|third|3rd)\b/,
      2,
    ],
  ];

  for (const [pattern, index] of actionPatterns) {
    if (index < max && pattern.test(text)) return index;
  }

  if (
    /\b(earliest|soonest|asap|first available|next available|top one)\b/.test(
      text
    )
  ) {
    return 0;
  }

  if (
    max >= 2 &&
    /\b(middle|middle one|middle option|middle slot)\b/.test(text)
  ) {
    return 1;
  }

  if (/\b(last|latest|final|last one|final one|bottom one)\b/.test(text)) {
    return max - 1;
  }

  const explicitTime = hasExplicitTimeLanguage(text);

  const ordinalPatterns: Array<[RegExp, number]> = [
    [/\b(first|1st)\b/, 0],
    [/\b(second|2nd)\b/, 1],
    [/\b(third|3rd)\b/, 2],
  ];

  for (const [pattern, index] of ordinalPatterns) {
    if (index >= max || !pattern.test(text)) continue;

    if (
      !explicitTime ||
      /\b(option|slot|choice|opening|appointment|one)\b/.test(text)
    ) {
      return index;
    }
  }

  if (!explicitTime) {
    const words = text.split(/\s+/).filter(Boolean);
    const shortReply = words.length <= 7;

    if (shortReply) {
      const numericCandidates = Array.from(
        text.matchAll(/\b([1-9]\d{0,2})\b/g)
      )
        .map((match) => Number(match[1]))
        .filter((value) => value >= 1 && value <= max);

      const uniqueNumericCandidates = Array.from(new Set(numericCandidates));

      if (uniqueNumericCandidates.length === 1) {
        const candidate = uniqueNumericCandidates[0] - 1;

        if (
          hasPositiveLanguage(text) ||
          /\b(on|with|for)\s+(?:number\s+)?[1-9]\d{0,2}\b/.test(text) ||
          words.length <= 3
        ) {
          return candidate;
        }
      }

      const wordCandidates: Array<[RegExp, number]> = [
        [/\bone\b/, 0],
        [/\btwo\b/, 1],
        [/\bthree\b/, 2],
      ];

      for (const [pattern, index] of wordCandidates) {
        if (index >= max || !pattern.test(text)) continue;

        if (
          hasPositiveLanguage(text) ||
          /\b(option|slot|choice|opening|appointment|number)\b/.test(text) ||
          words.length <= 3
        ) {
          return index;
        }
      }
    }
  }

  return null;
}

function extractRequestedTime(message: string) {
  const text = normalize(message);

  const match = text.match(
    /\b(1[0-2]|0?[1-9])(?::([0-5][0-9]))?\s*(am|pm)?\b/
  );

  if (!match) return null;

  const rawHour = Number(match[1]);
  let hour = rawHour;
  const minute = match[2] ? Number(match[2]) : 0;
  let meridian = match[3] ?? null;

  if (!meridian) {
    if (/\bmorning\b/.test(text)) meridian = "am";
    if (/\b(afternoon|evening|tonight)\b/.test(text)) meridian = "pm";
  }

  if (meridian === "pm" && hour !== 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;

  return {
    rawHour,
    hour,
    minute,
    hasMinute: Boolean(match[2]),
    hasMeridian: Boolean(meridian),
  };
}

function getLocalParts(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value;

  return {
    weekday: String(get("weekday") ?? "").toLowerCase(),
    hour: Number(get("hour") ?? 0),
    minute: Number(get("minute") ?? 0),
  };
}

function findUniqueContextualOfferedSlot(params: {
  message: string;
  slots: NormalizedSlot[];
  timezone: string;
}): NormalizedSlot | null {
  const text = normalize(params.message);
  const requested = extractRequestedTime(text);

  if (!requested || requested.hasMeridian) return null;

  const weekdayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  const requestedWeekday = weekdayNames.find((weekday) =>
    new RegExp(`\\b${weekday}\\b`).test(text)
  );

  if (!requestedWeekday) return null;

  const matches = params.slots.filter((slot) => {
    const local = getLocalParts(slot.startTime, params.timezone);

    if (local.weekday !== requestedWeekday) return false;

    const twelveHourSlot =
      local.hour === 0 ? 12 : local.hour > 12 ? local.hour - 12 : local.hour;

    if (twelveHourSlot !== requested.rawHour) return false;

    if (requested.hasMinute && local.minute !== requested.minute) return false;
    if (!requested.hasMinute && local.minute !== 0) return false;

    return true;
  });

  return matches.length === 1 ? matches[0] : null;
}

function scoreSlot(params: {
  message: string;
  slotStart: string;
  timezone: string;
}) {
  const text = normalize(params.message);
  const requested = extractRequestedTime(text);
  const slot = getLocalParts(params.slotStart, params.timezone);

  let score = 0;

  if (text.includes(slot.weekday)) score += 35;

  if (requested) {
    const exactHour = requested.hour === slot.hour;
    const possibleNoMeridianHour =
      !requested.hasMeridian &&
      (requested.rawHour === slot.hour ||
        requested.rawHour + 12 === slot.hour);

    if (exactHour || possibleNoMeridianHour) {
      score += 55;

      const minuteDistance = Math.abs(requested.minute - slot.minute);

      if (requested.hasMinute && minuteDistance <= 5) score += 45;
      else if (requested.hasMinute && minuteDistance <= 10) score += 35;
      else if (requested.hasMinute && minuteDistance <= 20) score += 20;
      else if (!requested.hasMinute && slot.minute <= 15) score += 35;
      else if (!requested.hasMinute && slot.minute <= 45) score += 15;
    } else {
      score -= 100;
    }
  }

  if (hasPositiveLanguage(text)) score += 30;

  return score;
}

export function resolvePendingSlotConfirmation(
  params: ResolveParams
): ResolvedSlot {
  const slots = getPendingSuggestion(params.qualification);

  if (slots.length === 0) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "no_pending_slot_suggestion",
      confidence: "low",
    };
  }

  const text = normalize(params.message);

  if (!text) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "empty_booking_reply",
      confidence: "low",
    };
  }

  if (hasHardNegative(text)) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "customer_rejected_booking",
      confidence: "high",
    };
  }

  if (hasChangeRequest(text)) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "customer_requested_different_slot",
      confidence: "medium",
    };
  }

  const optionIndex = extractOptionIndex(text, slots.length);

  if (optionIndex !== null) {
    const slot = slots[optionIndex];

    return {
      matched: true,
      startTime: slot.startTime,
      endTime: slot.endTime,
      reason: "matched_option_or_slang_reference",
      confidence: "high",
    };
  }

  if (slots.length === 1 && hasPositiveLanguage(text)) {
    return {
      matched: true,
      startTime: slots[0].startTime,
      endTime: slots[0].endTime,
      reason: "single_pending_slot_confirmed",
      confidence: "high",
    };
  }

  const contextualOfferedSlot = findUniqueContextualOfferedSlot({
    message: text,
    slots,
    timezone: params.timezone,
  });

  if (contextualOfferedSlot) {
    return {
      matched: true,
      startTime: contextualOfferedSlot.startTime,
      endTime: contextualOfferedSlot.endTime,
      reason: "matched_option_or_slang_reference",
      confidence: "high",
    };
  }

  const scored = slots
    .map((slot, index) => ({
      index,
      slot,
      score: scoreSlot({
        message: text,
        slotStart: slot.startTime,
        timezone: params.timezone,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (!best || best.score < 60) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "pending_slot_confirmation_too_ambiguous_or_not_offered",
      confidence: "low",
    };
  }

  if (second && best.score - second.score < 15) {
    return {
      matched: false,
      startTime: null,
      endTime: null,
      reason: "multiple_pending_slots_too_close",
      confidence: "medium",
    };
  }

  return {
    matched: true,
    startTime: best.slot.startTime,
    endTime: best.slot.endTime,
    reason: "matched_by_natural_language_time",
    confidence: "high",
  };
}
