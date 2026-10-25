   // lib/ai/extractLeadData.ts

    import { extractCustomerIdentity } from "@/lib/ai/extractCustomerIdentity";
    import { resolveUsZip } from "@/lib/location/resolveUsZip";

    export type LeadUrgency = "low" | "normal" | "high" | "emergency";

    export type ServiceType =
      | "hvac"
      | "roofing"
      | "plumbing"
      | "electrical"
      | "general";

    export type ExtractedLocation = {
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    };

    export type ExtractedLeadData = {
      customerName: string | null;
      email: string | null;
      phone: string | null;
      urgency: LeadUrgency;
      serviceType: ServiceType;
      issueSummary: string;
      location: ExtractedLocation;
      preferredTime: string | null;
      isCommercial: boolean;
      rawMessage: string;
    };

    const VALID_US_STATES = new Set([
      "AL",
      "AK",
      "AZ",
      "AR",
      "CA",
      "CO",
      "CT",
      "DE",
      "FL",
      "GA",
      "HI",
      "IA",
      "ID",
      "IL",
      "IN",
      "KS",
      "KY",
      "LA",
      "MA",
      "MD",
      "ME",
      "MI",
      "MN",
      "MO",
      "MS",
      "MT",
      "NC",
      "ND",
      "NE",
      "NH",
      "NJ",
      "NM",
      "NV",
      "NY",
      "OH",
      "OK",
      "OR",
      "PA",
      "RI",
      "SC",
      "SD",
      "TN",
      "TX",
      "UT",
      "VA",
      "VT",
      "WA",
      "WI",
      "WV",
      "WY",
      "DC",
    ]);

    const US_STATE_NAME_TO_CODE: Record<string, string> = {
      alabama: "AL",
      alaska: "AK",
      arizona: "AZ",
      arkansas: "AR",
      california: "CA",
      colorado: "CO",
      connecticut: "CT",
      delaware: "DE",
      florida: "FL",
      georgia: "GA",
      hawaii: "HI",
      idaho: "ID",
      illinois: "IL",
      indiana: "IN",
      iowa: "IA",
      kansas: "KS",
      kentucky: "KY",
      louisiana: "LA",
      maine: "ME",
      maryland: "MD",
      massachusetts: "MA",
      michigan: "MI",
      minnesota: "MN",
      mississippi: "MS",
      missouri: "MO",
      montana: "MT",
      nebraska: "NE",
      nevada: "NV",
      "new hampshire": "NH",
      "new jersey": "NJ",
      "new mexico": "NM",
      "new york": "NY",
      "north carolina": "NC",
      "north dakota": "ND",
      ohio: "OH",
      oklahoma: "OK",
      oregon: "OR",
      pennsylvania: "PA",
      "rhode island": "RI",
      "south carolina": "SC",
      "south dakota": "SD",
      tennessee: "TN",
      texas: "TX",
      utah: "UT",
      vermont: "VT",
      virginia: "VA",
      washington: "WA",
      "west virginia": "WV",
      wisconsin: "WI",
      wyoming: "WY",
      "district of columbia": "DC",
    };

    const STATE_NAME_PATTERN = Object.keys(US_STATE_NAME_TO_CODE)
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");

    const STREET_SUFFIX_PATTERN =
      "(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Trail|Trl|Terrace|Ter|Place|Pl|Path)";

    const STANDARD_PHONE_PATTERN =
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    const INTERNATIONAL_PHONE_PATTERN =
      /\+\d[\d\s().-]{5,24}\d/;

    const EMAIL_PATTERN =
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

    const AMBIGUOUS_STATE_CODES = new Set([
      "IN",
      "OR",
      "ME",
      "HI",
      "OK",
    ]);

    const CITY_PROSE_WORDS = new Set([
      "i",
      "im",
      "i'm",
      "ive",
      "i've",
      "id",
      "i'd",
      "ill",
      "i'll",
      "my",
      "me",
      "we",
      "we're",
      "were",
      "our",
      "you",
      "your",
      "he",
      "she",
      "they",
      "it",
      "its",
      "this",
      "that",
      "the",
      "a",
      "an",
      "and",
      "but",
      "or",
      "if",
      "so",
      "because",
      "need",
      "needs",
      "needed",
      "want",
      "wants",
      "wanted",
      "have",
      "has",
      "had",
      "got",
      "getting",
      "get",
      "live",
      "living",
      "located",
      "location",
      "over",
      "near",
      "around",
      "by",
      "at",
      "from",
      "here",
      "there",
      "house",
      "home",
      "place",
      "unit",
      "system",
      "ac",
      "hvac",
      "furnace",
      "heater",
      "broken",
      "broke",
      "working",
      "cooling",
      "heating",
      "help",
      "please",
      "today",
      "tomorrow",
      "asap",
    ]);

    /*
     * GENERIC ZIP POLICY
     *
     * Accept:
     * - explicit ZIP / ZIP code / postal / service ZIP context
     * - ZIP+4, normalized to ZIP5
     * - credible city + state + ZIP
     * - ZIP after a street address
     * - one lone unblocked ZIP-looking token, preserving shorthand such as:
     *     "unit making noise. 90210"
     *
     * Reject:
     * - ZIP-looking numbers explicitly labeled as non-location identifiers:
     *     invoice number, order number, ticket number, account number,
     *     confirmation number, serial number, model number, quote number,
     *     work order, PO, claim, tracking, reservation, appointment, etc.
     * - contradictory state/ZIP combinations
     * - arbitrary invalid ZIPs when resolveUsZip() cannot validate them
     * - multiple ambiguous unlabeled five-digit numbers
     *
     * IMPORTANT:
     * This is contextual/generic. It does NOT special-case 90210 or any other ZIP.
     */

    const NON_LOCATION_NUMBER_LABEL_PATTERN =
      /\b(?:invoice|order|ticket|confirmation|confirm|reference|ref|account|acct|customer|client|member|job|work\s*order|wo|po|purchase\s*order|quote|estimate|proposal|case|claim|tracking|shipment|serial|model|part|sku|item|receipt|transaction|payment|authorization|auth|reservation|booking|appointment)\s*(?:number|no\.?|#|id|code)?\s*(?::|=|\bis\b)?\s*$/iu;

    const POSITIVE_ZIP_CONTEXT_PATTERN =
      /\b(?:zip|zip\s*code|zipcode|postal\s*code|postal|service\s+zip|service\s+zipcode|service\s+postal\s+code)\s*(?::|=|\bis\b)?\s*$/iu;

    const POSITIVE_LOCATION_CONTEXT_PATTERN =
      /\b(?:i(?:'m|\s+am)?\s+in|we(?:'re|\s+are)?\s+in|located\s+in|location(?:\s+is)?|service\s+area(?:\s+is)?|area(?:\s+is)?|service\s+address(?:\s+is)?|address(?:\s+is)?|live\s+in|living\s+in|at|near)\s*$/iu;

    type ZipCandidate = {
      zip: string;
      raw: string;
      index: number;
      end: number;
      explicit: boolean;
      blocked: boolean;
    };

    function normalizeWhitespace(value: string) {
      return value
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/\u202f/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeState(value?: string | null) {
      const raw = normalizeWhitespace(
        String(value ?? "")
      ).replace(/[.,]+$/g, "");

      if (!raw) {
        return null;
      }

      const upper = raw.toUpperCase();

      if (VALID_US_STATES.has(upper)) {
        return upper;
      }

      return US_STATE_NAME_TO_CODE[
        raw.toLowerCase()
      ] ?? null;
    }

    function normalizeZip(value?: string | null) {
      const match = normalizeWhitespace(
        String(value ?? "")
      ).match(/\b(\d{5})(?:-\d{4})?\b/);

      return match?.[1] ?? null;
    }

    function extractEmail(text: string) {
      return (
        text.match(EMAIL_PATTERN)?.[0] ??
        null
      );
    }

    function extractPhoneDeterministic(text: string) {
      return (
        text.match(STANDARD_PHONE_PATTERN)?.[0] ??
        text.match(INTERNATIONAL_PHONE_PATTERN)?.[0] ??
        null
      );
    }

    function extractCustomerNameDeterministic(
      text: string
    ) {
      const normalized = text.replace(/\r/g, "\n");

      const labeled = normalized.match(
        /(?:^|\n|\s)name\s*:\s*([^\n]{1,120}?)(?=\s+(?:phone|email|address|city|state|zip)\s*:|\n|$)/iu
      );

      const candidate = String(
        labeled?.[1] ?? ""
      )
        .replace(/\s+/g, " ")
        .replace(/[,.;:]+$/g, "")
        .trim();

      if (!candidate) {
        return null;
      }

      if (candidate.includes("@")) {
        return null;
      }

      if (
        /^(unknown|none|null|undefined|n\/?a)$/iu.test(
          candidate
        )
      ) {
        return null;
      }

      if (
        !Array.from(candidate).some((character) =>
          /\p{L}/u.test(character)
        )
      ) {
        return null;
      }

      return candidate;
    }

    function maskPhones(text: string) {
      return text
        .replace(
          new RegExp(
            STANDARD_PHONE_PATTERN.source,
            "g"
          ),
          " "
        )
        .replace(
          new RegExp(
            INTERNATIONAL_PHONE_PATTERN.source,
            "g"
          ),
          " "
        );
    }

    function collectZipCandidates(
      text?: string | null
    ): ZipCandidate[] {
      const value = normalizeWhitespace(
        String(text ?? "")
      );

      if (!value) {
        return [];
      }

      const withoutPhones = maskPhones(value);

      const regex =
        /\b(\d{5})(?:-(\d{4}))?\b/g;

      const candidates: ZipCandidate[] = [];

      let match: RegExpExecArray | null;

      while (
        (match = regex.exec(withoutPhones)) !== null
      ) {
        const raw = match[0];
        const zip = match[1];
        const index = match.index;
        const end = index + raw.length;

        const before = withoutPhones.slice(
          Math.max(0, index - 90),
          index
        );

        const after = withoutPhones.slice(
          end,
          Math.min(
            withoutPhones.length,
            end + 40
          )
        );

        const blocked =
          NON_LOCATION_NUMBER_LABEL_PATTERN.test(
            before
          );

        const explicit =
          POSITIVE_ZIP_CONTEXT_PATTERN.test(before) ||
          POSITIVE_LOCATION_CONTEXT_PATTERN.test(
            before
          ) ||
          /^\s*(?:zip|zipcode|postal)\b/iu.test(
            after
          );

        candidates.push({
          zip,
          raw,
          index,
          end,
          explicit,
          blocked,
        });
      }

      return candidates;
    }

    function extractCredibleZipFromText(
      text?: string | null
    ) {
      const candidates =
        collectZipCandidates(text);

      if (candidates.length === 0) {
        return null;
      }

      const explicit = candidates.filter(
        (candidate) =>
          candidate.explicit &&
          !candidate.blocked
      );

      if (explicit.length > 0) {
        return explicit[
          explicit.length - 1
        ].zip;
      }

      const unblocked = candidates.filter(
        (candidate) =>
          !candidate.blocked
      );

      /*
       * Preserve lone-ZIP shorthand.
       *
       * "unit making noise. 90210" -> candidate
       *
       * But:
       *
       * "invoice number is 90210" -> rejected
       *
       * And multiple unlabeled five-digit numbers are not guessed.
       */
      if (unblocked.length === 1) {
        return unblocked[0].zip;
      }

      return null;
    }

    function isPlausibleCityCandidate(
      value?: string | null
    ) {
      const city = normalizeWhitespace(
        String(value ?? "")
      );

      if (!city) {
        return false;
      }

      if (
        city.length < 2 ||
        city.length > 80
      ) {
        return false;
      }

      if (/\d/u.test(city)) {
        return false;
      }

      if (
        city.includes("@") ||
        STANDARD_PHONE_PATTERN.test(city) ||
        INTERNATIONAL_PHONE_PATTERN.test(city)
      ) {
        return false;
      }

      const words = city
        .toLowerCase()
        .replace(
          /[^\p{L}'-]+/gu,
          " "
        )
        .split(/\s+/u)
        .filter(Boolean);

      if (
        words.length === 0 ||
        words.length > 8
      ) {
        return false;
      }

      const proseHits = words.filter(
        (word) =>
          CITY_PROSE_WORDS.has(word)
      ).length;

      return proseHits === 0;
    }

    function isCredibleStateToken(
      rawState?: string | null
    ) {
      const raw = normalizeWhitespace(
        String(rawState ?? "")
      );

      if (!raw) {
        return false;
      }

      if (
        US_STATE_NAME_TO_CODE[
          raw.toLowerCase()
        ]
      ) {
        return true;
      }

      const upper = raw.toUpperCase();

      if (
        !VALID_US_STATES.has(upper)
      ) {
        return false;
      }

      /*
       * Prevent ordinary prose such as "in", "or", "me", "hi", and "ok"
       * from becoming state abbreviations through case-insensitive matching.
       */
      if (
        AMBIGUOUS_STATE_CODES.has(
          upper
        )
      ) {
        return raw === upper;
      }

      return raw === upper;
    }

    function extractAddress(text: string) {
      const withoutPhones =
        maskPhones(text);

      const match = withoutPhones.match(
        new RegExp(
          `\\b\\d{1,6}\\s+[\\p{L}0-9.'#\\-\\s]+?\\s${STREET_SUFFIX_PATTERN}\\b`,
          "iu"
        )
      );

      return match?.[0]
        ? normalizeWhitespace(match[0])
        : null;
    }

    function removeAddressFromText(
      text: string,
      address?: string | null
    ) {
      if (!address) {
        return text;
      }

      const index = text
        .toLowerCase()
        .indexOf(
          address.toLowerCase()
        );

      if (index < 0) {
        return text;
      }

      return (
        text.slice(0, index) +
        " " +
        text.slice(
          index + address.length
        )
      );
    }

    function extractExplicitLocationSegment(
      text: string
    ) {
      const normalized =
        normalizeWhitespace(text);

      const marker = normalized.match(
        /\b(?:city|location|service\s+area|area)\s*(?::|=|\bis\b)\s*/iu
      );

      if (
        !marker ||
        marker.index === undefined
      ) {
        return null;
      }

      const start =
        marker.index +
        marker[0].length;

      const remainder =
        normalized.slice(start);

      const stop = remainder.search(
        /\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|name|issue|problem)\s*(?::|=|\bis\b)/iu
      );

      return (
        normalizeWhitespace(
          stop >= 0
            ? remainder.slice(0, stop)
            : remainder
        ) || null
      );
    }

    function extractExplicitAddressSegment(
      text: string
    ) {
      const normalized =
        normalizeWhitespace(text);

      const marker = normalized.match(
        /\b(?:my\s+)?(?:service\s+)?address\s*(?::|=|\bis\b)\s*/iu
      );

      if (
        !marker ||
        marker.index === undefined
      ) {
        return null;
      }

      const start =
        marker.index +
        marker[0].length;

      const remainder =
        normalized.slice(start);

      const stop = remainder.search(
        /\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|name|issue|problem)\s*(?::|=|\bis\b)/iu
      );

      return (
        normalizeWhitespace(
          stop >= 0
            ? remainder.slice(0, stop)
            : remainder
        ) || null
      );
    }

    function parseCityStateZipCandidate(
      text?: string | null
    ) {
      const value = normalizeWhitespace(
        String(text ?? "")
      );

      if (!value) {
        return {
          city: null,
          state: null,
          zip: null,
        };
      }

      const stateCodePattern =
        Array.from(
          VALID_US_STATES
        ).join("|");

      /*
       * State-code regex is deliberately case-sensitive.
       *
       * That prevents:
       *   "in" -> IN
       *   "or" -> OR
       *   "me" -> ME
       *   "hi" -> HI
       *   "ok" -> OK
       *
       * Full state names remain case-insensitive.
       */
      const codeRegex = new RegExp(
        `(?:^|[,;]|\\s)([\\p{L}][\\p{L} .'-]{0,79}?),?\\s+(${stateCodePattern})(?:\\s+(\\d{5}(?:-\\d{4})?))?(?=$|[,;.!?]|\\s)`,
        "u"
      );

      const nameRegex = new RegExp(
        `(?:^|[,;]|\\s)([\\p{L}][\\p{L} .'-]{0,79}?),?\\s+(${STATE_NAME_PATTERN})(?:\\s+(\\d{5}(?:-\\d{4})?))?(?=$|[,;.!?]|\\s)`,
        "iu"
      );

      const match =
        value.match(codeRegex) ??
        value.match(nameRegex);

      if (!match) {
        return {
          city: null,
          state: null,
          zip:
            extractCredibleZipFromText(
              value
            ),
        };
      }

      const rawCity =
        normalizeWhitespace(
          match[1]
        );

      const rawState =
        normalizeWhitespace(
          match[2]
        );

      const zip =
        normalizeZip(match[3]) ??
        extractCredibleZipFromText(
          value
        );

      if (
        !isPlausibleCityCandidate(
          rawCity
        )
      ) {
        return {
          city: null,
          state: null,
          zip,
        };
      }

      if (
        !isCredibleStateToken(
          rawState
        )
      ) {
        return {
          city: null,
          state: null,
          zip,
        };
      }

      return {
        city: rawCity,
        state:
          normalizeState(rawState),
        zip,
      };
    }

    function extractCityStateZipAfterStreet(
      text: string,
      address?: string | null
    ) {
      if (!address) {
        return {
          city: null,
          state: null,
          zip: null,
        };
      }

      const normalized =
        normalizeWhitespace(text);

      const index = normalized
        .toLowerCase()
        .indexOf(
          address.toLowerCase()
        );

      if (index < 0) {
        return {
          city: null,
          state: null,
          zip: null,
        };
      }

      const tail = normalized
        .slice(
          index + address.length
        )
        .trim()
        .replace(
          /^[,;:\-\s]+/u,
          ""
        );

      return parseCityStateZipCandidate(
        tail
      );
    }

    function extractFallbackCityStateZip(
      text: string
    ) {
      const explicitAddress =
        extractExplicitAddressSegment(
          text
        );

      if (explicitAddress) {
        const parsed =
          parseCityStateZipCandidate(
            explicitAddress
          );

        if (
          parsed.city &&
          parsed.state
        ) {
          return parsed;
        }
      }

      const explicitLocation =
        extractExplicitLocationSegment(
          text
        );

      if (explicitLocation) {
        const parsed =
          parseCityStateZipCandidate(
            explicitLocation
          );

        if (
          parsed.city &&
          parsed.state
        ) {
          return parsed;
        }
      }

      const naturalLocation =
        normalizeWhitespace(text).match(
          /\b(?:i(?:'m|\s+am)?\s+in|we(?:'re|\s+are)?\s+in|located\s+in|live\s+in|living\s+in)\s+([\p{L}][\p{L} .'-]{0,79}?),?\s+([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?/u
        );

      if (naturalLocation) {
        const rawCity =
          normalizeWhitespace(
            naturalLocation[1]
          );

        const rawState =
          normalizeWhitespace(
            naturalLocation[2]
          );

        if (
          isPlausibleCityCandidate(
            rawCity
          ) &&
          isCredibleStateToken(
            rawState
          )
        ) {
          return {
            city: rawCity,
            state:
              normalizeState(rawState),
            zip:
              normalizeZip(
                naturalLocation[3]
              ) ??
              extractCredibleZipFromText(
                text
              ),
          };
        }
      }

      return parseCityStateZipCandidate(
        text
      );
    }

    function extractStandaloneState(
      text: string
    ) {
      const normalized =
        normalizeWhitespace(text);

      /*
       * Explicit "state:" / "state is" context may safely accept either
       * a state abbreviation or a full state name.
       */
      const explicitState =
        normalized.match(
          new RegExp(
            `\\bstate\\s*(?::|=|\\bis\\b)\\s*(${Array.from(
              VALID_US_STATES
            ).join("|")}|${STATE_NAME_PATTERN})\\b`,
            "iu"
          )
        )?.[1] ?? null;

      if (explicitState) {
        return normalizeState(
          explicitState
        );
      }

      /*
       * Full state names are credible without relying on arbitrary
       * two-letter prose tokens.
       */
      const fullState =
        normalized.match(
          new RegExp(
            `\\b(${STATE_NAME_PATTERN})\\b`,
            "iu"
          )
        )?.[1] ?? null;

      if (fullState) {
        return normalizeState(
          fullState
        );
      }

      return null;
    }

    function enrichGeographyFromZip(params: {
      city?: string | null;
      state?: string | null;
      zip?: string | null;
    }) {
      const zip =
        normalizeZip(params.zip);

      const explicitCity =
        normalizeWhitespace(
          String(
            params.city ?? ""
          )
        ) || null;

      const explicitState =
        normalizeState(
          params.state
        );

      if (!zip) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      const resolved =
        resolveUsZip(zip);

      /*
       * Invalid / unknown ZIP:
       *
       * Do not retain it as a service ZIP just because it has five digits.
       */
      if (!resolved) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      /*
       * Explicit state and resolved ZIP state disagree.
       *
       * Preserve explicit geography but reject the contradictory ZIP.
       * Never manufacture a tuple such as:
       *
       *   Austin, TX 90210
       */
      if (
        explicitState &&
        explicitState !==
          resolved.state
      ) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      /*
       * If an explicit city was supplied and the ZIP resolves to the same
       * state, preserve the explicit city. City names can legitimately map
       * across multiple ZIPs and ZIP databases can choose a preferred city.
       */
      return {
        city:
          explicitCity ??
          resolved.city,

        state:
          explicitState ??
          resolved.state,

        zip:
          resolved.zip,
      };
    }

    function extractLocation(
      text: string
    ): ExtractedLocation {
      const address =
        extractAddress(text);

      const afterStreet =
        extractCityStateZipAfterStreet(
          text,
          address
        );

      const withoutAddress =
        removeAddressFromText(
          text,
          address
        );

      const fallback =
        extractFallbackCityStateZip(
          withoutAddress
        );

      const extractedCity =
        afterStreet.city ??
        fallback.city;

      const extractedState =
        afterStreet.state ??
        fallback.state ??
        extractStandaloneState(
          withoutAddress
        );

      const extractedZip =
        afterStreet.zip ??
        fallback.zip ??
        extractCredibleZipFromText(
          text
        );

      const geography =
        enrichGeographyFromZip({
          city: extractedCity,
          state: extractedState,
          zip: extractedZip,
        });

      return {
        address:
          address || null,

        city:
          geography.city,

        state:
          geography.state,

        zip:
          geography.zip,
      };
    }

    function detectUrgency(
      text: string
    ): LeadUrgency {
      const lower =
        text.toLowerCase();

      if (
        /\b(emergency|gas leak|carbon monoxide|co alarm|smell gas)\b/.test(
          lower
        ) ||
        /\b(flooding|flooded)\b/.test(
          lower
        )
      ) {
        return "emergency";
      }

      if (
        /\b(urgent|asap|today|right now|immediately|same day)\b/.test(
          lower
        ) ||
        /\b(no ac|no a\/c|no air conditioning|ac stopped|a\/c stopped|air conditioner stopped|stopped cooling|not cooling|blowing hot|blowing warm)\b/.test(
          lower
        ) ||
        /\b(no heat|furnace stopped|heater stopped|house is freezing|stopped working|quit working)\b/.test(
          lower
        )
      ) {
        return "high";
      }

      if (
        /\b(next week|not urgent|whenever)\b/.test(
          lower
        )
      ) {
        return "low";
      }

      return "normal";
    }

    function detectServiceType(
      text: string
    ): ServiceType {
      const lower =
        text.toLowerCase();

      const hvac =
        /\b(ac|a\/c|hvac|air conditioner|air conditioning|furnace|heater|heating|cooling|thermostat|compressor|condenser|air handler|duct|ductwork|mini split|heat pump)\b/.test(
          lower
        );

      if (hvac) {
        return "hvac";
      }

      const roofing =
        /\b(roof|roofing|shingle|shingles|gutter|gutters|flashing|hail damage|roof leak)\b/.test(
          lower
        );

      if (roofing) {
        return "roofing";
      }

      const plumbing =
        /\b(plumbing|plumber|pipe|pipes|toilet|drain|sewer|water heater|faucet|sink|garbage disposal|slab leak)\b/.test(
          lower
        );

      if (plumbing) {
        return "plumbing";
      }

      const electrical =
        /\b(electrical|electrician|breaker|outlet|panel|wiring|circuit|receptacle)\b/.test(
          lower
        );

      if (electrical) {
        return "electrical";
      }

      return "general";
    }

    function detectPreferredTime(
      text: string
    ) {
      const lower =
        text.toLowerCase();

      const exactTime =
        lower.match(
          /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*(?:at|around|about|by)?\s*(1[0-2]|0?[1-9])(?::([0-5][0-9]))?\s*(am|pm)\b/i
        );

      if (exactTime) {
        return normalizeWhitespace(
          exactTime[0]
        );
      }

      if (
        lower.includes(
          "tomorrow morning"
        )
      ) {
        return "tomorrow morning";
      }

      if (
        lower.includes(
          "tomorrow afternoon"
        )
      ) {
        return "tomorrow afternoon";
      }

      if (
        lower.includes(
          "tomorrow evening"
        )
      ) {
        return "tomorrow evening";
      }

      if (
        lower.includes(
          "today morning"
        )
      ) {
        return "today morning";
      }

      if (
        lower.includes(
          "today afternoon"
        )
      ) {
        return "today afternoon";
      }

      if (
        lower.includes(
          "today evening"
        )
      ) {
        return "today evening";
      }

      if (
        lower.includes("today")
      ) {
        return "today";
      }

      if (
        lower.includes("tomorrow")
      ) {
        return "tomorrow";
      }

      if (
        lower.includes("morning")
      ) {
        return "morning";
      }

      if (
        lower.includes("afternoon")
      ) {
        return "afternoon";
      }

      if (
        lower.includes("evening")
      ) {
        return "evening";
      }

      if (
        lower.includes("next week")
      ) {
        return "next week";
      }

      return null;
    }

    export async function extractLeadData(
      text: string
    ): Promise<ExtractedLeadData> {
      const clean =
        String(text ?? "").trim();

      if (!clean) {
        throw new Error(
          "missing_lead_text"
        );
      }

      const lower =
        clean.toLowerCase();

      const location =
        extractLocation(clean);

      const semanticIdentity =
        await extractCustomerIdentity(
          clean
        );

      return {
        customerName:
          semanticIdentity.customerName ??
          extractCustomerNameDeterministic(
            clean
          ),

        email:
          semanticIdentity.email ??
          extractEmail(clean),

        phone:
          semanticIdentity.phone ??
          extractPhoneDeterministic(
            clean
          ),

        urgency:
          detectUrgency(clean),

        serviceType:
          detectServiceType(clean),

        issueSummary:
          clean.length > 500
            ? `${clean.slice(
                0,
                500
              )}...`
            : clean,

        location,

        preferredTime:
          detectPreferredTime(
            clean
          ),

        isCommercial:
          /\b(commercial|business|office|restaurant|warehouse|retail|storefront|property management)\b/.test(
            lower
          ),

        rawMessage:
          clean,
      };
    }
