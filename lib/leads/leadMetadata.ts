// lib/leads/leadMetadata.ts

    import { extractCustomerIdentity } from "@/lib/ai/extractCustomerIdentity";
    import { resolveUsZip } from "@/lib/location/resolveUsZip";

    export type LeadMetadata = {
      customerName: string | null;
      email: string | null;
      phone: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      serviceArea: string | null;
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
      "(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl|Path|Trail|Trl|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Highway)";

    const STANDARD_PHONE_PATTERN =
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

    const INTERNATIONAL_PHONE_PATTERN = /\+\d[\d\s().-]{5,24}\d/;

    const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

    const AMBIGUOUS_STATE_CODES = new Set(["IN", "OR", "ME", "HI", "OK"]);

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
      "book",
      "books",
      "booked",
      "booking",
      "schedule",
      "schedules",
      "scheduled",
      "scheduling",
      "call",
      "calls",
      "called",
      "calling",
      "text",
      "texts",
      "texted",
      "texting",
      "send",
      "sends",
      "sent",
      "sending",
      "email",
      "emails",
      "emailed",
      "emailing",
      "tell",
      "tells",
      "told",
      "telling",
      "show",
      "shows",
      "showed",
      "showing",
      "check",
      "checks",
      "checked",
      "checking",
      "say",
      "says",
      "said",
      "saying",
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
     * ZIP extraction policy:
     *
     * 1. Preserve explicit ZIP / postal / service-area phrases.
     * 2. Preserve ZIP+4 by normalizing it to ZIP5.
     * 3. Preserve credible city/state/ZIP and address-tail ZIPs.
     * 4. Preserve the existing shorthand case where a lone valid ZIP-looking token
     *    is supplied without a competing identifier label:
     *
     *      "unit making noise. 90210"
     *
     * 5. Reject ZIP-looking values explicitly labeled as non-location identifiers:
     *
     *      "invoice number is 90210"
     *      "ticket #60601"
     *      "order id 75201"
     *      "serial number 10001"
     *
     * 6. Never turn a rejected identifier into a location merely because
     *    resolveUsZip() recognizes the five-digit value.
     *
     * 7. If explicit city/state conflicts with the resolved ZIP state, do not
     *    manufacture a contradictory city/state/ZIP tuple.
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

    function clean(value?: string | null) {
      return String(value ?? "")
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/\u202f/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, "\n")
        .trim()
        .replace(/[,.;:]+$/g, "")
        .trim();
    }

    function cleanOneLine(value?: string | null) {
      return clean(value)
        .replace(/\s+/g, " ")
        .trim();
    }

    function normalizeState(value?: string | null) {
      const raw = cleanOneLine(value);

      if (!raw) {
        return null;
      }

      const upper = raw.toUpperCase();

      if (VALID_US_STATES.has(upper)) {
        return upper;
      }

      return US_STATE_NAME_TO_CODE[raw.toLowerCase()] ?? null;
    }

    function normalizeZip(value?: string | null) {
      const match = cleanOneLine(value).match(/\b(\d{5})(?:-\d{4})?\b/);

      return match?.[1] ?? null;
    }

    function normalizeBody(body: string) {
      return String(body ?? "")
        .replace(/\r/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/\u202f/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, "\n")
        .trim();
    }

    function normalizeBodyForAddress(body: string) {
      return normalizeBody(body)
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function collectZipCandidates(text?: string | null): ZipCandidate[] {
      const value = cleanOneLine(text);

      if (!value) {
        return [];
      }

      const regex = /\b(\d{5})(?:-(\d{4}))?\b/g;
      const candidates: ZipCandidate[] = [];

      let match: RegExpExecArray | null;

      while ((match = regex.exec(value)) !== null) {
        const raw = match[0];
        const zip = match[1];
        const index = match.index;
        const end = index + raw.length;

        const before = value.slice(
          Math.max(0, index - 90),
          index
        );

        const after = value.slice(
          end,
          Math.min(value.length, end + 40)
        );

        const blocked = NON_LOCATION_NUMBER_LABEL_PATTERN.test(before);

        const explicit =
          POSITIVE_ZIP_CONTEXT_PATTERN.test(before) ||
          POSITIVE_LOCATION_CONTEXT_PATTERN.test(before) ||
          /^\s*(?:zip|zipcode|postal)\b/iu.test(after);

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

    function extractCredibleZipFromText(text?: string | null) {
      const candidates = collectZipCandidates(text);

      if (candidates.length === 0) {
        return null;
      }

      const explicit = candidates.filter(
        (candidate) => candidate.explicit && !candidate.blocked
      );

      if (explicit.length > 0) {
        return explicit[explicit.length - 1].zip;
      }

      const unblocked = candidates.filter(
        (candidate) => !candidate.blocked
      );

      /*
       * Preserve the existing shorthand behavior only when exactly one
       * unblocked ZIP-looking value remains.
       *
       * Examples:
       *
       *   "unit making noise. 90210"       -> 90210
       *   "heater quit. service zip 10001" -> 10001
       *   "invoice number is 90210"        -> null
       *
       * Multiple unlabeled five-digit values are intentionally not guessed.
       */
      if (unblocked.length === 1) {
        return unblocked[0].zip;
      }

      return null;
    }

    function cleanNameCandidate(value?: string | null) {
      const candidate = cleanOneLine(value)
        .replace(/^(?:is|=|:)\s*/iu, "")
        .replace(
          /\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|address|service address)\b[\s\S]*$/iu,
          ""
        )
        .trim();

      if (!candidate) {
        return null;
      }

      if (candidate.includes("@")) {
        return null;
      }

      if (/\d{3}[-.\s]?\d{3}/u.test(candidate)) {
        return null;
      }

      if (/^(unknown|none|null|undefined|n\/?a|na)$/iu.test(candidate)) {
        return null;
      }

      if (candidate.length > 120) {
        return null;
      }

      const hasLetter = Array.from(candidate).some((character) =>
        /\p{L}/u.test(character)
      );

      if (!hasLetter) {
        return null;
      }

      return candidate;
    }

    function extractNameDeterministic(body: string) {
      const text = normalizeBody(body);

      const patterns = [
        /(?:^|\n|\s)(?:my\s+)?name\s*(?::|=|\bis\b)\s*([^\n,;]{1,120}?)(?=\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|address|service address)\b|[\n,;]|$)/iu,
        /(?:^|\n|\s)(?:customer|contact)\s+name\s*(?::|=|\bis\b)\s*([^\n,;]{1,120}?)(?=\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|address|service address)\b|[\n,;]|$)/iu,
      ];

      for (const pattern of patterns) {
        const candidate = cleanNameCandidate(
          text.match(pattern)?.[1] ?? null
        );

        if (candidate) {
          return candidate;
        }
      }

      return null;
    }

    function extractPhoneDeterministic(body: string) {
      const text = normalizeBody(body);

      const labeled = text.match(
        /\b(?:phone(?:\s+number)?|callback(?:\s+number)?|best\s+number|mobile|cell)\s*(?::|=|\bis\b)?\s*((?:\+?\d[\d\s().-]{3,24}\d))/iu
      )?.[1];

      if (labeled) {
        return cleanOneLine(labeled);
      }

      const standard =
        text.match(STANDARD_PHONE_PATTERN)?.[0] ?? null;

      if (standard) {
        return cleanOneLine(standard);
      }

      const international =
        text.match(INTERNATIONAL_PHONE_PATTERN)?.[0] ?? null;

      return cleanOneLine(international) || null;
    }

    function extractEmail(
      body: string,
      fallbackEmail?: string | null
    ) {
      const text = normalizeBody(body);

      const labeled = text.match(
        /\bemail(?:\s+address)?\s*(?::|=|\bis\b)?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu
      )?.[1];

      return (
        cleanOneLine(
          labeled ??
            text.match(EMAIL_PATTERN)?.[0] ??
            fallbackEmail ??
            null
        ) || null
      );
    }

    function maskPhones(text: string) {
      return text
        .replace(
          new RegExp(STANDARD_PHONE_PATTERN.source, "g"),
          " "
        )
        .replace(
          new RegExp(INTERNATIONAL_PHONE_PATTERN.source, "g"),
          " "
        );
    }

    function extractStreetAddressFromSegment(segment: string) {
      const withoutPhones = maskPhones(segment);

      const streetRegex = new RegExp(
        `\\b(\\d{1,6}\\s+[\\p{L}0-9.'#\\-\\s]+?\\s${STREET_SUFFIX_PATTERN})(?:\\s+(?:apt|apartment|unit|suite|ste|#)\\s*[\\p{L}0-9-]+)?\\b`,
        "iu"
      );

      const match =
        withoutPhones.match(streetRegex)?.[0] ?? null;

      return match
        ? cleanOneLine(match)
        : null;
    }

    function extractExplicitAddressSegment(body: string) {
      const normalized = normalizeBodyForAddress(body);

      const marker = normalized.match(
        /\b(?:my\s+)?(?:service\s+)?address\s*(?::|=|\bis\b)\s*/iu
      );

      if (!marker || marker.index === undefined) {
        return null;
      }

      const start = marker.index + marker[0].length;
      const remainder = normalized.slice(start);

      const stop = remainder.search(
        /\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|name)\s*(?::|=|\bis\b)/iu
      );

      return (
        cleanOneLine(
          stop >= 0
            ? remainder.slice(0, stop)
            : remainder
        ) || null
      );
    }

    function extractFullAddress(body: string) {
      const explicitSegment =
        extractExplicitAddressSegment(body);

      const explicitStreet = explicitSegment
        ? extractStreetAddressFromSegment(explicitSegment)
        : null;

      if (explicitStreet) {
        return explicitStreet;
      }

      const normalized = maskPhones(
        normalizeBodyForAddress(body)
      );

      return extractStreetAddressFromSegment(normalized);
    }

    function isPlausibleCityCandidate(value?: string | null) {
      const city = cleanOneLine(value);

      if (!city) {
        return false;
      }

      if (city.length < 2 || city.length > 80) {
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
        .replace(/[^\p{L}'-]+/gu, " ")
        .split(/\s+/u)
        .filter(Boolean);

      if (words.length === 0 || words.length > 8) {
        return false;
      }

      const proseHits = words.filter((word) =>
        CITY_PROSE_WORDS.has(word)
      ).length;

      return proseHits === 0;
    }

    function isCredibleStateToken(rawState?: string | null) {
      const raw = cleanOneLine(rawState);

      if (!raw) {
        return false;
      }

      if (US_STATE_NAME_TO_CODE[raw.toLowerCase()]) {
        return true;
      }

      const upper = raw.toUpperCase();

      if (!VALID_US_STATES.has(upper)) {
        return false;
      }

      if (AMBIGUOUS_STATE_CODES.has(upper)) {
        return raw === upper;
      }

      return raw === upper;
    }

    function extractExplicitLocationSegment(body: string) {
      const normalized = normalizeBodyForAddress(body);

      const marker = normalized.match(
        /\b(?:city|location|service\s+area|area)\s*(?::|=|\bis\b)\s*/iu
      );

      if (!marker || marker.index === undefined) {
        return null;
      }

      const start = marker.index + marker[0].length;
      const remainder = normalized.slice(start);

      const stop = remainder.search(
        /\s+(?:and\s+)?(?:my\s+)?(?:phone|phone number|callback|callback number|email|email address|name|issue|problem)\s*(?::|=|\bis\b)/iu
      );

      return (
        cleanOneLine(
          stop >= 0
            ? remainder.slice(0, stop)
            : remainder
        ) || null
      );
    }

    function parseCityStateZipCandidate(
      text?: string | null
    ) {
      const value = cleanOneLine(text);

      if (!value) {
        return {
          city: null,
          state: null,
          zip: null,
        };
      }

      const stateCodePattern =
        Array.from(VALID_US_STATES).join("|");

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
          zip: extractCredibleZipFromText(value),
        };
      }

      const rawCity = cleanOneLine(match[1]);
      const rawState = cleanOneLine(match[2]);

      const zip =
        normalizeZip(match[3]) ??
        extractCredibleZipFromText(value);

      if (!isPlausibleCityCandidate(rawCity)) {
        return {
          city: null,
          state: null,
          zip,
        };
      }

      if (!isCredibleStateToken(rawState)) {
        return {
          city: null,
          state: null,
          zip,
        };
      }

      return {
        city: rawCity,
        state: normalizeState(rawState),
        zip,
      };
    }

    function extractCityStateZipAfterStreet(
      body: string,
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
        normalizeBodyForAddress(body);

      const index = normalized
        .toLowerCase()
        .indexOf(address.toLowerCase());

      if (index < 0) {
        return {
          city: null,
          state: null,
          zip: null,
        };
      }

      const tail = normalized
        .slice(index + address.length)
        .trim()
        .replace(/^[,;:\-\s]+/u, "");

      return parseCityStateZipCandidate(tail);
    }

    function extractFallbackCityStateZip(body: string) {
      const explicitAddress =
        extractExplicitAddressSegment(body);

      if (explicitAddress) {
        const parsed =
          parseCityStateZipCandidate(explicitAddress);

        if (parsed.city && parsed.state) {
          return parsed;
        }
      }

      const explicitLocation =
        extractExplicitLocationSegment(body);

      if (explicitLocation) {
        const parsed =
          parseCityStateZipCandidate(explicitLocation);

        if (parsed.city && parsed.state) {
          return parsed;
        }
      }

      return parseCityStateZipCandidate(
        normalizeBodyForAddress(body)
      );
    }

    function buildServiceArea(
      city?: string | null,
      state?: string | null,
      zip?: string | null
    ) {
      const cleanCity = cleanOneLine(city);
      const cleanState = normalizeState(state);
      const cleanZip = normalizeZip(zip);

      if (cleanCity && cleanState && cleanZip) {
        return `${cleanCity}, ${cleanState} ${cleanZip}`;
      }

      if (cleanCity && cleanState) {
        return `${cleanCity}, ${cleanState}`;
      }

      if (cleanZip) {
        return cleanZip;
      }

      return null;
    }

    function enrichGeographyFromZip(params: {
      city?: string | null;
      state?: string | null;
      zip?: string | null;
    }) {
      const zip = normalizeZip(params.zip);

      const explicitCity =
        cleanOneLine(params.city) || null;

      const explicitState =
        normalizeState(params.state);

      if (!zip) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      const resolved = resolveUsZip(zip);

      if (!resolved) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      /*
       * A resolved ZIP is authoritative for state.
       *
       * Do not manufacture combinations such as:
       *
       *   Austin, TX 90210
       *
       * If the user explicitly supplied a state that conflicts with the ZIP,
       * preserve the explicit city/state but reject the ZIP as contradictory.
       */
      if (
        explicitState &&
        explicitState !== resolved.state
      ) {
        return {
          city: explicitCity,
          state: explicitState,
          zip: null,
        };
      }

      return {
        city: explicitCity ?? resolved.city,
        state: explicitState ?? resolved.state,
        zip: resolved.zip,
      };
    }

    function buildDeterministicMetadata(
      text: string,
      fallbackEmail?: string | null
    ): LeadMetadata {
      const body = String(text ?? "");

      const customerName =
        extractNameDeterministic(body);

      const phone =
        extractPhoneDeterministic(body);

      const email =
        extractEmail(body, fallbackEmail);

      const address =
        extractFullAddress(body);

      const afterStreet =
        extractCityStateZipAfterStreet(
          body,
          address
        );

      const fallback =
        extractFallbackCityStateZip(body);

      const extractedCity =
        afterStreet.city ??
        fallback.city;

      const extractedState =
        afterStreet.state ??
        fallback.state;

      const extractedZip =
        afterStreet.zip ??
        fallback.zip ??
        extractCredibleZipFromText(body);

      const geography =
        enrichGeographyFromZip({
          city: extractedCity,
          state: extractedState,
          zip: extractedZip,
        });

      return {
        customerName:
          customerName || null,

        email:
          cleanOneLine(email).toLowerCase() || null,

        phone:
          cleanOneLine(phone) || null,

        address:
          cleanOneLine(address) || null,

        city:
          geography.city,

        state:
          geography.state,

        zip:
          geography.zip,

        serviceArea:
          buildServiceArea(
            geography.city,
            geography.state,
            geography.zip
          ),
      };
    }

    export function extractLeadMetadataFromText(
      text: string,
      fallbackEmail?: string | null
    ): LeadMetadata {
      return buildDeterministicMetadata(
        text,
        fallbackEmail
      );
    }

    export async function extractLeadMetadataFromTextSemantic(
      text: string,
      fallbackEmail?: string | null
    ): Promise<LeadMetadata> {
      const deterministic =
        buildDeterministicMetadata(
          text,
          fallbackEmail
        );

      const semanticIdentity =
        await extractCustomerIdentity(text);

      const customerName =
        semanticIdentity.customerName ??
        deterministic.customerName ??
        null;

      const phone =
        semanticIdentity.phone ??
        deterministic.phone ??
        null;

      const explicitEmail =
        semanticIdentity.email ??
        null;

      const email =
        (
          explicitEmail ??
          deterministic.email ??
          cleanOneLine(fallbackEmail).toLowerCase()
        ) || null;

      return {
        ...deterministic,
        customerName,
        phone,
        email,
      };
    }

    function normalizeQualificationCity(
      value?: string | null
    ) {
      const city = cleanOneLine(value);

      if (!city) {
        return null;
      }

      return isPlausibleCityCandidate(city)
        ? city
        : null;
    }

    function normalizeQualificationState(
      value?: string | null
    ) {
      const raw = cleanOneLine(value);

      if (!raw) {
        return null;
      }

      return normalizeState(raw);
    }

    export function mergeLeadMetadata(params: {
      qualification?: Record<string, any> | null;
      metadata: LeadMetadata;
      fallbackEmail?: string | null;
    }): LeadMetadata {
      const q = params.qualification ?? {};
      const m = params.metadata;

      const qLocation =
        typeof q.location === "object" &&
        q.location !== null
          ? q.location
          : {};

      const customerName = cleanOneLine(
        m.customerName ??
          q.customerName ??
          q.customer_name ??
          q.name ??
          q.fullName ??
          q.full_name
      );

      const email = cleanOneLine(
        m.email ??
          q.email ??
          q.customerEmail ??
          q.customer_email ??
          params.fallbackEmail
      ).toLowerCase();

      const phone = cleanOneLine(
        m.phone ??
          q.phone ??
          q.customerPhone ??
          q.customer_phone
      );

      const address = cleanOneLine(
        m.address ??
          q.address ??
          q.serviceAddress ??
          q.service_address ??
          qLocation.address
      );

      const qualificationCity =
        normalizeQualificationCity(
          q.city ??
            qLocation.city
        );

      const qualificationState =
        normalizeQualificationState(
          q.state ??
            qLocation.state
        );

      const qualificationZip =
        normalizeZip(q.zip) ??
        normalizeZip(qLocation.zip);

      let city =
        cleanOneLine(m.city) ||
        qualificationCity ||
        null;

      let state =
        normalizeState(m.state) ??
        qualificationState ??
        null;

      const zip =
        normalizeZip(m.zip) ??
        qualificationZip ??
        null;

      if (
        !m.city &&
        qualificationCity &&
        !qualificationState
      ) {
        city = null;
      }

      if (
        !m.state &&
        qualificationState &&
        !qualificationCity
      ) {
        state = qualificationState;
      }

      const geography =
        enrichGeographyFromZip({
          city,
          state,
          zip,
        });

      return {
        customerName:
          customerName || null,

        email:
          email || null,

        phone:
          phone || null,

        address:
          address || null,

        city:
          geography.city,

        state:
          geography.state,

        zip:
          geography.zip,

        serviceArea:
          buildServiceArea(
            geography.city,
            geography.state,
            geography.zip
          ),
      };
    }

