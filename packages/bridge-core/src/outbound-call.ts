// High-level outbound call orchestration.
//
// Three call MODES, each with a distinct TwiML shape + cost profile:
//
//   VOICEMAIL_DELIVERY
//     Dial the recipient, speak a short message, hang up. No live
//     conversation. Cheapest mode (~$0.013/min × ~0.5 min = $0.007
//     per call). Ideal for: "leave Madhu a happy-birthday voicemail",
//     "tell the restaurant we'll be 10 min late".
//
//   CONFERENCE_BRIDGE
//     Dial party-A (recipient), have the bot ask if they're free to
//     talk, then dial party-B (owner) and conference both. Owner can
//     trigger this with "lantern, get me on a call with Madhu". Cost:
//     2 legs × duration. Bot drops out once both connected.
//
//   AGENT_TASK (basic IVR mode)
//     Dial a business line, speak a structured task ("Hi, this is
//     calling on behalf of Shekhar — refill prescription 12345 for
//     pickup tomorrow"), hang up. Doesn't currently handle multi-turn
//     IVR; that requires Twilio Media Streams + Realtime API (Phase 2).
//     Used for one-shot transactional pings.
//
// All three modes use Twilio's inline TwiML (no callback URL needed
// for the basic flow) and Polly voices (free, included with Twilio).
// Live-conversation mode with ElevenLabs voice clone is Phase 2.

import type { Logger } from "pino";
import {
  classifyOutboundCall,
  tierBadge,
  type CallContext,
  type TierVerdict,
} from "./call-risk-tier.js";

export type CallMode =
  | "VOICEMAIL_DELIVERY"
  | "CONFERENCE_BRIDGE"
  | "AGENT_TASK";

export interface OutboundCallRequest {
  mode: CallMode;
  // E.164 destination. Required.
  to: string;
  // E.164 of the Twilio "from" number (the owner's purchased Twilio
  // number). Pulled from the Twilio connector config when omitted.
  from?: string;
  // Resolved contact name if known.
  contactName?: string;
  // What the bot should say (for VOICEMAIL_DELIVERY + AGENT_TASK).
  // Max 1200 chars; longer is truncated.
  message?: string;
  // For CONFERENCE_BRIDGE: the owner's phone number to dial as the
  // second leg.
  ownerPhone?: string;
  // Stated reason (drives risk-tier classification + the bot's tone).
  reason?: string;
  // Owner explicitly invoked this call from self-chat right now.
  ownerInitiated: boolean;
}

export interface CallPlan {
  mode: CallMode;
  tier: TierVerdict;
  // Human-readable summary of WHAT the call will do — shown to the
  // owner in the pre-flight approval message.
  summary: string;
  // Per-relationship voice (Polly identifier) — measured/warm/casual.
  voice:
    | "Polly.Joanna"
    | "Polly.Matthew"
    | "Polly.Salli"
    | "Polly.Ivy"
    | "Polly.Kendra"
    | "Polly.Brian"
    | "Polly.Amy";
  // Two-party state hint — when true, bot must announce "this call
  // may be saved for Shekhar's records".
  twoPartyConsent: boolean;
  // Pre-flight cost forecast (USD). Shown in the approval gate so the
  // owner sees the spend before the call is placed — the same
  // "forecast before every run" posture Lantern applies to LLM runs.
  estimatedCostUsd: number;
  request: OutboundCallRequest;
}

// Rough Twilio US outbound voice pricing. Conference bridges dial two
// legs, so their per-minute cost doubles. SMS + ElevenLabs TTS are billed
// separately and not included here — this is a floor estimate for the
// voice legs, deliberately conservative for an approval-gate preview.
const TWILIO_VOICE_USD_PER_MIN = 0.014;

// Expected call duration (minutes) per mode, used only for the estimate.
function estimatedCallMinutes(mode: CallMode): number {
  switch (mode) {
    case "VOICEMAIL_DELIVERY":
      return 0.5;
    case "AGENT_TASK":
      return 0.6;
    case "CONFERENCE_BRIDGE":
      return 3;
  }
}

/**
 * Estimate the USD cost of an outbound call before placing it. Used for the
 * pre-flight approval message. Rounded to the cent-ish (3 dp).
 */
export function estimateCallCostUsd(mode: CallMode): number {
  const legs = mode === "CONFERENCE_BRIDGE" ? 2 : 1;
  return Number(
    (estimatedCallMinutes(mode) * legs * TWILIO_VOICE_USD_PER_MIN).toFixed(3),
  );
}

// Two-party-consent states (require all-party consent to record).
// All-party state list (US): California, Florida, Illinois, Maryland,
// Massachusetts, Michigan, Montana, New Hampshire, Pennsylvania,
// Washington, Connecticut, Delaware, Oregon (federal-employees).
// Area-code-prefix heuristic — coarse but conservative. When unsure
// we default to TRUE (announce consent) so we don't accidentally
// record without notice.
const TWO_PARTY_AREA_CODES = new Set([
  // CA
  "209",
  "213",
  "279",
  "310",
  "323",
  "341",
  "408",
  "415",
  "424",
  "442",
  "510",
  "530",
  "559",
  "562",
  "619",
  "626",
  "628",
  "650",
  "657",
  "661",
  "669",
  "707",
  "714",
  "747",
  "760",
  "805",
  "818",
  "820",
  "831",
  "858",
  "909",
  "916",
  "925",
  "949",
  "951",
  // FL
  "239",
  "305",
  "321",
  "352",
  "386",
  "407",
  "561",
  "689",
  "727",
  "754",
  "772",
  "786",
  "813",
  "850",
  "863",
  "904",
  "941",
  "954",
  // IL
  "217",
  "224",
  "309",
  "312",
  "331",
  "447",
  "464",
  "618",
  "630",
  "708",
  "773",
  "779",
  "815",
  "847",
  "872",
  // PA
  "215",
  "223",
  "267",
  "272",
  "412",
  "445",
  "484",
  "570",
  "582",
  "610",
  "717",
  "724",
  "814",
  "835",
  "878",
  // MA
  "339",
  "351",
  "413",
  "508",
  "617",
  "774",
  "781",
  "857",
  "978",
  // MD
  "227",
  "240",
  "301",
  "410",
  "443",
  "667",
  // WA
  "206",
  "253",
  "360",
  "425",
  "509",
  "564",
  // MI
  "231",
  "248",
  "269",
  "313",
  "517",
  "586",
  "616",
  "679",
  "734",
  "810",
  "906",
  "947",
  "989",
  // MT
  "406",
  // NH
  "603",
  // CT
  "203",
  "475",
  "860",
  "959",
  // DE
  "302",
  // OR
  "458",
  "503",
  "541",
  "971",
]);

function inferTwoPartyConsent(to: string): boolean {
  // Strip +1, take 3-digit area code.
  const m = to.match(/^\+1[\s-]?(\d{3})/);
  if (!m) return true; // unknown → safer default = announce
  return TWO_PARTY_AREA_CODES.has(m[1]);
}

// Voice selection per relationship. Polly voices are free with
// Twilio. Maps relationship → voice flavor. Empty relationship
// (cold contact / business line) → measured Joanna default.
function pickVoice(relationship?: string): CallPlan["voice"] {
  const r = (relationship || "").toLowerCase();
  if (!r) return "Polly.Joanna"; // measured default
  if (/wife|spouse|partner|girlfriend|boyfriend/.test(r)) return "Polly.Joanna";
  if (/brother|son|father|husband|dad|grandpa/.test(r)) return "Polly.Matthew";
  if (/sister|daughter|mother|wife|mom|grandma|aunt|akka|amma/.test(r))
    return "Polly.Salli";
  if (/friend|cousin|colleague|coworker|teammate/.test(r))
    return "Polly.Kendra";
  if (/manager|boss|investor|client|customer/.test(r)) return "Polly.Joanna";
  return "Polly.Joanna";
}

/**
 * Build a CallPlan from a raw request: classify the tier, pick a
 * voice, compute consent posture, draft a 1-line summary. The plan
 * is what gets shown to the owner for pre-flight approval.
 */
export function planCall(
  req: OutboundCallRequest,
  opts: { ownerName?: string; relationship?: string } = {},
): CallPlan {
  const ctx: CallContext = {
    to: req.to,
    contactName: req.contactName,
    reason: req.reason,
    ownerInitiated: req.ownerInitiated,
  };
  const tier = classifyOutboundCall(ctx);
  const voice = pickVoice(opts.relationship);
  const twoPartyConsent = inferTwoPartyConsent(req.to);

  const ownerName = opts.ownerName || "Shekhar";
  // Always surface the resolved NUMBER alongside the name so the owner can
  // catch a wrong-contact resolution (e.g. multiple "Manasa" entries) before
  // confirming. Never dial a name without showing what it resolved to.
  const who = req.contactName ? `${req.contactName} (${req.to})` : req.to;
  let summary: string;
  switch (req.mode) {
    case "VOICEMAIL_DELIVERY":
      summary = `📞 Voicemail to ${who}: "${(req.message || "").slice(0, 120)}"`;
      break;
    case "CONFERENCE_BRIDGE":
      summary = `📞 Conference call: dial ${who}, ask if free, bridge you in`;
      break;
    case "AGENT_TASK":
      summary = `📞 Agent task call to ${who}: ${(req.reason || req.message || "task").slice(0, 100)}`;
      break;
  }
  summary += `\n${tierBadge(tier)}`;
  if (twoPartyConsent) {
    summary += `\n⚠ 2-party-consent state — bot will announce recording`;
  }
  const estimatedCostUsd = estimateCallCostUsd(req.mode);
  summary += `\n💸 est. ~$${estimatedCostUsd.toFixed(2)}`;
  void ownerName;
  return {
    mode: req.mode,
    tier,
    summary,
    voice,
    twoPartyConsent,
    estimatedCostUsd,
    request: req,
  };
}

/**
 * Build the inline TwiML the Twilio call should execute. The TwiML
 * is sent in the `Twiml` param of the Twilio API call — no callback
 * URL hosting required.
 *
 * For VOICEMAIL_DELIVERY: <Response><Say>…</Say></Response>
 * For AGENT_TASK: same shape; agent_task is one-shot speech.
 * For CONFERENCE_BRIDGE: returns a TwiML for the FIRST leg (the
 *   recipient) that conferences them; caller adds the owner as a
 *   second participant via Twilio's Conference API.
 */
export function buildTwiml(plan: CallPlan): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      .slice(0, 1200);

  const consent = plan.twoPartyConsent
    ? `<Say voice="${plan.voice}">This call may be saved for Shekhar's records.</Say><Pause length="1"/>`
    : "";

  switch (plan.mode) {
    case "VOICEMAIL_DELIVERY": {
      const msg = escape(plan.request.message || "");
      return `<Response>${consent}<Say voice="${plan.voice}" loop="1">${msg}</Say><Pause length="1"/><Say voice="${plan.voice}">Goodbye.</Say></Response>`;
    }
    case "AGENT_TASK": {
      // For now: speak the task once, then hang up. Multi-turn IVR
      // (gather/transcribe response) is Phase 2 with Realtime API.
      const msg = escape(
        plan.request.message ||
          plan.request.reason ||
          "Calling on behalf of Shekhar.",
      );
      const intro = `Hi, this is calling on behalf of Shekhar Mudarapu.`;
      return `<Response>${consent}<Say voice="${plan.voice}">${intro}</Say><Pause length="1"/><Say voice="${plan.voice}">${msg}</Say><Pause length="1"/><Say voice="${plan.voice}">Please call back when you have a moment. Thank you.</Say></Response>`;
    }
    case "CONFERENCE_BRIDGE": {
      // First-leg TwiML: greet recipient, then drop them into a
      // conference. Owner gets added as the second participant via
      // Twilio's Participants API.
      const confName = `lantern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const intro = `Hi, this is Shekhar's helper. He wants to talk — bringing him on the line now.`;
      return `<Response>${consent}<Say voice="${plan.voice}">${escape(intro)}</Say><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false" waitUrl="">${escape(confName)}</Conference></Dial></Response>`;
    }
  }
}

/**
 * Helper for callers that need the conference name from a plan
 * BEFORE dialing (so they can add the owner as a participant).
 * Re-builds TwiML deterministically — same Date.now() can't be used.
 * Caller must call this BEFORE buildTwiml and pass the name in via
 * a separate parameter — but the current buildTwiml inlines a random
 * name. For Phase 1, use this helper to generate the name once and
 * thread it through both legs.
 */
export function newConferenceName(): string {
  return `lantern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Variant of buildTwiml that takes a pre-generated conference name —
 * used for the CONFERENCE_BRIDGE flow so the bridge can dial the
 * owner with the SAME conference name.
 */
export function buildConferenceTwiml(
  plan: CallPlan,
  conferenceName: string,
): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const consent = plan.twoPartyConsent
    ? `<Say voice="${plan.voice}">This call may be saved for Shekhar's records.</Say><Pause length="1"/>`
    : "";
  const intro = `Hi, this is Shekhar's helper. He wants to talk — bringing him on the line now.`;
  return `<Response>${consent}<Say voice="${plan.voice}">${escape(intro)}</Say><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false">${escape(conferenceName)}</Conference></Dial></Response>`;
}

/**
 * Owner-side TwiML for a conference bridge — minimal, just drops the
 * owner into the conference room.
 */
export function buildOwnerConferenceTwiml(conferenceName: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${escape(conferenceName)}</Conference></Dial></Response>`;
}

// Re-export risk-tier helpers so callers have a single import.
export { classifyOutboundCall, tierBadge } from "./call-risk-tier.js";
export type { CallContext, TierVerdict, CallTier } from "./call-risk-tier.js";
