// intent-router.ts — Phase 2c: one LLM intent-reasoning classifier that sits
// in FRONT of the owner-side regex gate stack (isSelfContextQuery /
// detectDisclosureDeny / looksLikeRecapRequest / looksLikeThreadPeek …).
//
// Why: those gates are a static wordlist in front of a smart body. They miss
// paraphrases. The most expensive miss is the PRIVACY-critical disclosure gate
// — a real past incident leaked the owner's location to a probing contact
// because the "don't tell X where I am" wordlist didn't match the phrasing.
//
// This module reasons about what the owner's message MEANS (any phrasing) and
// returns a constrained decision that routes to the SAME existing handlers.
//
// HARD invariants (this runs on the owner's LIVE GA bridges):
//   • FLAG-GATED, DEFAULT OFF (LANTERN_INTENT_ROUTER). Off → the router never
//     runs; the regex gates dispatch byte-for-byte as today. See
//     intentRouterEnabled(); the bridge short-circuits on it synchronously so
//     no await/LLM/state is touched when off.
//   • ADDITIVE. It cannot invent actions — it can only pick from the KNOWN
//     intents, each of which maps to a handler that already exists. On ANY
//     uncertainty / malformed output / timeout / error it returns null and the
//     bridge FALLS BACK to the regex gates (they remain the floor). Fail-safe.
//   • Owner-only, no session pollution (throwaway `owner::intent::<ts>` key),
//     bounded timeout, never throws.
//
// PURE module: flag read, prompt build, tolerant parse, decision→handler map.
// The one async fn (classifyIntent) takes the LLM caller by injection so it is
// unit-tested with a mock. Tests: src/intent-router.test.ts.

/** The KNOWN intents the router can route to. Each maps to an EXISTING owner
 *  handler (or to "let the normal reply path run"). It can never invent more. */
export type IntentDecision =
  | { kind: "disclosure_deny"; target: string; deny: boolean }
  | { kind: "recap" }
  | { kind: "self_context" }
  | { kind: "thread_peek" }
  | { kind: "normal_reply" };

/** The subset the router FORCE-routes (self-contained handlers it subsumes).
 *  self_context / thread_peek / normal_reply fall through to the regex gates —
 *  they're classified so the LLM doesn't misroute them AS disclosure/recap. */
export type ForcedHandler = "disclosure_deny" | "recap";

/** Injected LLM caller — shape of AgentClient.respondTo. Returns raw text or
 *  null. Injected so the core is testable without a live model. */
export type IntentLLM = (
  key: string,
  text: string,
  hint?: string,
  opts?: { withTools?: boolean; webSearch?: boolean; timeoutMs?: number },
) => Promise<string | null>;

/** Feature flag. DEFAULT OFF: unset / anything but 1|true|on|yes → false.
 *  The bridge gates every router call on this synchronously, so when off the
 *  router is never constructed, awaited, or reached — dispatch is unchanged. */
export function intentRouterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.LANTERN_INTENT_ROUTER ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

const INTENT_HINT = "Return ONLY the JSON object. No prose.";

/** Build the classifier prompt for the owner's message. Constrains the model
 *  to the KNOWN intents and forbids inventing actions. Disclosure leads. */
export function buildIntentPrompt(text: string): string {
  return [
    "You classify a message the OWNER just sent to their personal assistant (self-chat). Decide what the owner is asking for, then reply with ONE JSON object and nothing else.",
    "",
    "Allowed intents (pick exactly one `kind`):",
    '  • "disclosure_deny" — the owner is setting who may (or may NOT) be told WHERE THE OWNER IS / their whereabouts/location. This is PRIVACY-CRITICAL. Covers any phrasing: "don\'t tell Ravi where I am", "keep Priya in the dark about my location", "don\'t let mom know I\'m travelling", and the REVERSE "you can tell Ravi where I am again", "it\'s fine for Sam to know my location". Return also: "target" = the person named, and "deny" = true to HIDE the location from them, false to allow sharing again. If unsure of direction, use deny=true (safer).',
    '  • "recap" — the owner wants a summary of what they missed while away: "what did I miss", "catch me up", "what happened while I was out".',
    '  • "self_context" — the owner is asking about their OWN state/context/what they were doing (not another thread, not location-sharing): "what was I working on", "what\'s on my plate".',
    '  • "thread_peek" — the owner wants to look at / recall a specific conversation thread with a contact: "what did Raju say", "pull up my thread with mom".',
    '  • "normal_reply" — anything else. When in doubt, use this.',
    "",
    "Rules: choose the SINGLE best intent. Do not invent intents or actions. Do not add commentary. Location-sharing preferences are disclosure_deny, NOT self_context.",
    "",
    'Reply shape: {"kind":"disclosure_deny","target":"Ravi","deny":true} or {"kind":"recap"} or {"kind":"self_context"} or {"kind":"thread_peek"} or {"kind":"normal_reply"}',
    "",
    `Owner's message: ${JSON.stringify(text)}`,
  ].join("\n");
}

const KNOWN_KINDS = new Set(["disclosure_deny", "recap", "self_context", "thread_peek", "normal_reply"]);

/** Tolerant parse of the model's raw output into a decision. Returns null on
 *  anything unusable (no JSON, unknown kind, disclosure_deny without a usable
 *  target) so the caller falls back to the regex gates. Never throws. */
export function parseIntentDecision(raw: string | null | undefined): IntentDecision | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const kind = typeof p.kind === "string" ? p.kind.trim() : "";
  if (!KNOWN_KINDS.has(kind)) return null;
  if (kind === "disclosure_deny") {
    const target = typeof p.target === "string" ? p.target.trim() : "";
    if (!target) return null; // can't act on a location rule with no person
    // Privacy-protective default: an omitted/garbage `deny` means HIDE.
    const deny = typeof p.deny === "boolean" ? p.deny : true;
    return { kind: "disclosure_deny", target: target.slice(0, 100), deny };
  }
  return { kind } as IntentDecision;
}

/** Map a decision to the handler the bridge should FORCE, or null to fall
 *  through to the regex gates (the floor). Pure — the bridge's routing table. */
export function forcedHandler(d: IntentDecision | null): ForcedHandler | null {
  if (!d) return null;
  if (d.kind === "disclosure_deny") return "disclosure_deny";
  if (d.kind === "recap") return "recap";
  return null; // self_context / thread_peek / normal_reply → regex gates
}

// ponytail: belt-and-suspenders bound. respondTo already honors timeoutMs, but
// this hard race guarantees classify never blocks the owner's reply path even
// if the caller misbehaves. Upgrade path: drop if respondTo's abort is trusted.
function withHardTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** Classify the owner's message. Uses a THROWAWAY session key (never a
 *  contact's live session), no tools, no web search, a bounded timeout, and
 *  never throws — any failure returns null (→ regex-gate fallback). */
export async function classifyIntent(
  text: string,
  llm: IntentLLM,
  opts: { timeoutMs?: number; now?: () => number } = {},
): Promise<IntentDecision | null> {
  const t = (text ?? "").trim();
  if (!t) return null;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const key = `owner::intent::${opts.now?.() ?? Date.now()}`;
  try {
    const raw = await withHardTimeout(
      llm(key, buildIntentPrompt(t), INTENT_HINT, { withTools: false, webSearch: false, timeoutMs }),
      timeoutMs,
    );
    return parseIntentDecision(raw);
  } catch {
    return null;
  }
}
