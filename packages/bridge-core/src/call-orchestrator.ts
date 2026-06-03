// Outbound call orchestrator — the high-level entry both bridges use.
//
// Flow per call:
//   1. Resolve target (contact name → E.164 phone via owner profile +
//      contact-name cache provided by the bridge).
//   2. Classify risk tier via call-risk-tier.
//   3. Draft pre-flight summary; if needsOwnerAck, post to self-chat
//      via the supplied notify hook + cache a pendingOffer that the
//      bridge's "yes" intercept fires. If owner-initiated explicit
//      command, this gate is auto-passed (TIER A) or surfaces a tight
//      2-line ack request (TIER B/C).
//   4. Build TwiML for the call mode.
//   5. Dial via Twilio's place_call + (for conference) add owner as
//      second participant.
//   6. Notify owner of dial status; persist commitment placeholders.
//
// Voice rendering:
//   - Default: inline TwiML <Say> with Polly voices (free, included).
//   - Optional: ElevenLabs voice clone (B8) — OFF by default, gated
//     behind LANTERN_VOICE_CLONE=1 AND LANTERN_ELEVENLABS_API_KEY AND
//     LANTERN_ELEVENLABS_VOICE_ID (see resolveVoiceCloneConfig). When
//     the gate is open the orchestrator renders the spoken text via the
//     ElevenLabs API, the bridge hosts the MP3 at a public URL, and
//     TwiML uses <Play>url</Play> instead of <Say>. On ANY error it
//     falls back to Polly — voice-clone never fails the call.

import type { Logger } from "pino";
import {
  planCall,
  buildTwiml,
  buildConferenceTwiml,
  newConferenceName,
  resolveVoiceCloneConfig,
  type OutboundCallRequest,
  type CallPlan,
  type VoiceCloneConfig,
} from "./outbound-call.js";

export interface OrchestratorDeps {
  logger: Logger;
  // E.164 of the owner's Twilio number (the "from" leg). Resolved
  // from the Twilio connector config.
  twilioFromNumber: string;
  // E.164 of the owner's personal phone (the second leg for
  // conference). Pulled from LANTERN_OWNER_PHONE.
  ownerPhone?: string;
  // Maps a name ("Madhu", "mom") to an E.164 phone. The bridge
  // implements this with its profile + contact-name cache. Returns
  // null when unresolvable.
  resolveContact: (nameOrNumber: string) => Promise<{ phone: string; name?: string; relationship?: string } | null>;
  // Authenticated fetch to control-plane (passed in from bridge so
  // we don't duplicate auth wiring).
  authedFetch: typeof fetch;
  // How to notify the owner — drops a self-chat message.
  notifyOwner: (text: string) => Promise<void>;
  // Get + set a pending offer keyed by the owner's chat jid. The
  // orchestrator uses this for pre-flight approval flow.
  cachePendingOffer?: (offer: { kind: "outbound-call"; payload: OutboundCallRequest; plan: CallPlan; planSummary: string; issuedAt: number }) => void;
  // Optional voice renderer for ElevenLabs clones. When set, the
  // orchestrator uses this to render TTS instead of relying on
  // inline Polly <Say>. Returns a URL Twilio can <Play> — must be
  // publicly reachable from Twilio's servers.
  renderVoice?: (text: string) => Promise<string | null>;
  // Caller-ID shown to the RECIPIENT: the owner's own verified number,
  // so contacts recognize the call instead of an unknown Twilio DID and
  // actually answer. Must be a Twilio number OR a Verified Caller ID on
  // the account (else Twilio rejects the dial). Falls back to
  // twilioFromNumber when unset. The SMS heads-up + owner leg still use
  // the Twilio number (only Twilio DIDs can send SMS / be conference hosts).
  callerId?: string;
  // Owner display name for the heads-up SMS copy (from LANTERN_OWNER_NAME).
  ownerName?: string;
  // When true, text the recipient a one-line heads-up right before dialing
  // a CONFERENCE (a known human), so they recognize the incoming call.
  smsHeadsUp?: boolean;
}

export interface OutboundCallIntent {
  intent: "conference" | "voicemail" | "task";
  target: string;             // contact name or phone
  message?: string;
  reason?: string;
}

export interface OrchestratorResult {
  ok: boolean;
  reason?: string;
  callSid?: string;
  plan?: CallPlan;
}

/**
 * Main entry — the single function bridges call when the owner
 * issues a `call-*` NL command.
 *
 * @param intent  parsed call intent (target + mode + optional msg)
 * @param deps    bridge-provided I/O hooks
 * @param opts.ownerInitiated true when this came from an explicit owner command
 */
export async function executeOutboundCall(
  intent: OutboundCallIntent,
  deps: OrchestratorDeps,
  opts: { ownerInitiated: boolean } = { ownerInitiated: true },
): Promise<OrchestratorResult> {
  // 1. Resolve target.
  const resolved = await deps.resolveContact(intent.target);
  if (!resolved) {
    // Bridge may have populated last-resolve suggestions on its
    // contact resolver; surface them in the error so the owner can
    // re-try with the right name.
    const suggestion = (deps as any).lastSuggestions?.() || "";
    return {
      ok: false,
      reason: suggestion
        ? `couldn't resolve "${intent.target}" to a phone. ${suggestion}`
        : `couldn't resolve "${intent.target}" to a phone. try the full name, or paste a phone number directly`,
    };
  }

  // 2. Build request + plan.
  const mode =
    intent.intent === "conference" ? "CONFERENCE_BRIDGE" :
    intent.intent === "voicemail"  ? "VOICEMAIL_DELIVERY" :
                                     "AGENT_TASK";
  const req: OutboundCallRequest = {
    mode,
    to: resolved.phone,
    from: deps.twilioFromNumber,
    contactName: resolved.name,
    message: intent.message,
    reason: intent.reason || intent.message,
    ownerInitiated: opts.ownerInitiated,
    ownerPhone: deps.ownerPhone,
  };
  const plan = planCall(req, { relationship: resolved.relationship });

  // 3. Pre-flight approval. For TIER A owner-initiated, we skip; for
  // anything else, we post a summary + cache the offer. The bridge's
  // pendingOffers/Yes intercept fires our execute path on owner ack.
  if (plan.tier.needsOwnerAck && deps.cachePendingOffer) {
    deps.cachePendingOffer({
      kind: "outbound-call",
      payload: req,
      plan,
      planSummary: plan.summary,
      issuedAt: Date.now(),
    });
    await deps.notifyOwner(
      `${plan.summary}\n\n*Reply "yes" to dial (offer expires in 10 min) · "no" to cancel.*`,
    );
    deps.logger.info(
      { tier: plan.tier.tier, target: intent.target, mode },
      "outbound call awaiting owner ack",
    );
    return { ok: true, plan, reason: "awaiting-ack" };
  }

  // 4. Dial — fast path. Tier A or owner explicitly bypassed ack.
  return placeCallNow(req, plan, deps);
}

/**
 * Place the call given a plan that has owner approval. Called both
 * (a) directly for TIER-A owner-initiated, AND (b) from the
 * pendingOffer "yes" execute path after owner ack.
 */
export async function placeCallNow(
  req: OutboundCallRequest,
  plan: CallPlan,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  try {
    // Caller-ID shown to the recipient: the owner's own number when
    // configured, so contacts recognize + answer. SMS + owner leg still
    // use the Twilio DID (req.from).
    const recipientFrom = deps.callerId || req.from!;
    if (req.mode === "CONFERENCE_BRIDGE") {
      // Heads-up SMS so the recipient recognizes the call about to come in
      // (live-person conference only). Best-effort — never blocks the dial.
      if (deps.smsHeadsUp) {
        await sendHeadsUpSms(req, deps).catch((err) =>
          deps.logger.warn({ err: (err as Error)?.message || String(err) }, "heads-up SMS failed (continuing to dial)"),
        );
      }
      // Conference: dial recipient with conference TwiML, then add
      // owner as second participant once recipient picks up. We
      // generate the conference name once + use it for both legs.
      const confName = newConferenceName();
      const recipientTwiml = buildConferenceTwiml(plan, confName);
      const recipientCall = await dialViaTwilio(req.to, recipientFrom, recipientTwiml, deps);
      if (!recipientCall.ok) return recipientCall;

      // Owner leg — fired as add_conference_participant so we re-use
      // the connector executor's conference-aware action. Uses the Twilio
      // DID (req.from), not the caller-ID override (the override may be the
      // owner's own number — dialing them "from themselves" is confusing).
      if (!req.ownerPhone) {
        deps.logger.warn("conference: owner phone unset; recipient is in conf alone");
      } else {
        const ownerLeg = await addParticipant(confName, req.ownerPhone, req.from!, deps);
        if (!ownerLeg.ok) {
          deps.logger.warn({ reason: ownerLeg.reason }, "conference: owner leg failed");
        }
      }
      await deps.notifyOwner(
        `📞 dialing ${req.contactName || req.to} now — your phone will ring with the conference call. SID: ${recipientCall.callSid}`,
      );
      return { ok: true, callSid: recipientCall.callSid, plan };
    }

    // VOICEMAIL_DELIVERY / AGENT_TASK — single one-way leg with the
    // message spoken via TwiML.
    let twiml = buildTwiml(plan);
    // ElevenLabs voice-clone path: render message to MP3, get URL,
    // splice into TwiML as <Play>. Falls back silently to Polly TwiML.
    if (deps.renderVoice && req.message) {
      try {
        const audioUrl = await deps.renderVoice(req.message);
        if (audioUrl) {
          twiml = `<Response><Play>${audioUrl}</Play></Response>`;
          deps.logger.info({ audioUrl: audioUrl.slice(0, 60) }, "using ElevenLabs voice clone");
        }
      } catch (err) {
        deps.logger.warn({ err }, "voice clone render failed; falling back to Polly");
      }
    }

    const call = await dialViaTwilio(req.to, recipientFrom, twiml, deps);
    if (call.ok) {
      await deps.notifyOwner(
        `📞 ${req.mode === "VOICEMAIL_DELIVERY" ? "voicemail" : "task call"} placed to ${req.contactName || req.to}. SID: ${call.callSid}`,
      );
    }
    return { ...call, plan };
  } catch (err) {
    deps.logger.error({ err }, "outbound call placement failed");
    return { ok: false, reason: (err as Error).message };
  }
}

// One-line SMS sent to the recipient right before a conference dial so an
// unknown caller-ID isn't ignored. Sent FROM the Twilio DID (only Twilio
// numbers can send SMS, and it's the A2P-registered sender). Best-effort:
// the caller wraps this in a catch so SMS failure never blocks the call.
async function sendHeadsUpSms(req: OutboundCallRequest, deps: OrchestratorDeps): Promise<void> {
  const owner = deps.ownerName || "your contact";
  const firstName = req.contactName ? ` ${req.contactName.split(/\s+/)[0]}` : "";
  const why = req.reason ? ` about ${req.reason.replace(/\s+/g, " ").trim().slice(0, 80)}` : "";
  const body = `Hi${firstName}, this is ${owner}'s assistant — ${owner} is calling you in a few seconds${why}.`;
  const res = await deps.authedFetch(
    `/v1/connectors/twilio/execute?action=send_sms`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: req.to, from: req.from, body }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`send_sms ${res.status} ${t.slice(0, 120)}`);
  }
}

async function dialViaTwilio(
  to: string,
  from: string,
  twiml: string,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const res = await deps.authedFetch(
    `/v1/connectors/twilio/execute?action=place_call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, from, twiml }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `Twilio dial failed: ${res.status} ${body.slice(0, 200)}` };
  }
  const j = (await res.json()) as { data?: { sid?: string } };
  return { ok: true, callSid: j.data?.sid };
}

async function addParticipant(
  conferenceName: string,
  to: string,
  from: string,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const res = await deps.authedFetch(
    `/v1/connectors/twilio/execute?action=add_conference_participant`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conferenceName, to, from }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `add participant failed: ${res.status} ${body.slice(0, 200)}` };
  }
  const j = (await res.json()) as { data?: { sid?: string } };
  return { ok: true, callSid: j.data?.sid };
}

// ─────────────────────────────────────────────────────
// ElevenLabs voice rendering helper.
//
// When the bridge has LANTERN_ELEVENLABS_API_KEY (legacy:
// LANTERN_ELEVENLABS_KEY) + LANTERN_ELEVENLABS_VOICE_ID set,
// renderTextWithElevenLabs(text) → returns an MP3 buffer.
// The bridge is responsible for hosting that buffer at a public URL
// Twilio can fetch from (via Cloudflare Tunnel, ngrok, or Twilio Assets).
// The orchestrator just renders + returns bytes; the bridge wires the
// hosting.
// ─────────────────────────────────────────────────────
export async function renderTextWithElevenLabs(
  text: string,
  opts: { apiKey: string; voiceId: string; model?: string } ,
): Promise<Buffer | null> {
  const model = opts.model || "eleven_turbo_v2_5";
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${opts.voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": opts.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.2 },
      }),
    },
  );
  if (!res.ok) return null;
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ─────────────────────────────────────────────────────
// synthesizeSpeech — the single gated TTS abstraction (B8).
//
// Returns a public audio URL Twilio can <Play> when voice-clone is
// enabled+configured AND synthesis+hosting succeed; returns null in
// EVERY other case so the caller falls back to Polly <Say>. It never
// throws — the call path stays alive regardless of ElevenLabs/host
// failures. The API key is never logged.
// ─────────────────────────────────────────────────────
export interface SynthesizeSpeechDeps {
  // Persist the MP3 bytes (keyed by `cacheKey`) and return the public
  // URL Twilio will fetch. The bridge owns hosting (e.g. writes to
  // ~/.lantern/voice-cache/<key>.mp3 and returns
  // <LANTERN_VOICE_CACHE_PUBLIC_URL>/voice-cache/<key>.mp3). May return
  // null/throw — treated as "fall back to Polly".
  hostAudio: (cacheKey: string, mp3: Buffer) => Promise<string | null>;
  logger?: Pick<Logger, "info" | "warn">;
  // Test/override seam. Defaults to env-resolved config; pass an
  // explicit config to bypass process.env.
  config?: VoiceCloneConfig | null;
  // Test seam for the network render. Defaults to renderTextWithElevenLabs.
  render?: (
    text: string,
    opts: { apiKey: string; voiceId: string },
  ) => Promise<Buffer | null>;
}

export async function synthesizeSpeech(
  text: string,
  deps: SynthesizeSpeechDeps,
): Promise<string | null> {
  if (!text || !text.trim()) return null;
  // Gate: config explicitly passed wins; otherwise read the env gate.
  const cfg = deps.config !== undefined ? deps.config : resolveVoiceCloneConfig();
  if (!cfg) return null; // disabled or unconfigured → Polly

  try {
    const render = deps.render || renderTextWithElevenLabs;
    const mp3 = await render(text, { apiKey: cfg.apiKey, voiceId: cfg.voiceId });
    if (!mp3 || mp3.length === 0) return null;
    // Stable cache key by (text + voice) so repeated phrases reuse audio.
    const { createHash } = await import("node:crypto");
    const cacheKey = createHash("sha1").update(text + " " + cfg.voiceId).digest("hex");
    const url = await deps.hostAudio(cacheKey, mp3);
    if (!url) return null;
    deps.logger?.info({ audioUrl: url.slice(0, 60), bytes: mp3.length }, "voice-clone synthesized");
    return url;
  } catch (err) {
    deps.logger?.warn(
      { err: (err as Error)?.message || String(err) },
      "voice-clone synth failed; falling back to Polly",
    );
    return null;
  }
}
