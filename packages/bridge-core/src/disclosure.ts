// disclosure.ts — owner-authoritative "never tell THIS contact where I am" overlay.
//
// Born from a real incident: the bot told a probing contact where the owner
// was. presence.ts already gates a `place` on having a fresh timestamp, and
// social-graph.ts forbids CROSS-thread disclosure, but neither is a durable,
// per-contact "keep my whereabouts private from Ravi" flag. This is that flag.
//
// Same shape as identity.ts: owner-only, local, append-only JSONL
// (~/.lantern/disclosure-denies.jsonl, mode 0600), last-write-wins. The deny
// is keyed by canonical handle so it holds across channels (a deny set on
// iMessage applies on WhatsApp for the same person). Pure + best-effort; never
// throws into a reply path.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { canonicalHandle } from "./canonical-handle.js";

export interface DisclosureRecord {
  handle: string;
  deny: boolean; // true = never disclose location; false = re-allow
  source: "owner";
  ts: number;
}

const DEFAULT_PATH = join(homedir(), ".lantern", "disclosure-denies.jsonl");

export interface DiscOpts {
  path?: string;
  nowMs?: number;
}

/** True when the owner has told the bot to keep his whereabouts private from
 *  this handle. Last write wins, so a later re-allow flips it back. */
export function resolveDisclosureDeny(handle: string, opts: DiscOpts = {}): boolean {
  const path = opts.path ?? DEFAULT_PATH;
  if (!handle || !existsSync(path)) return false;
  const key = canonicalHandle(handle);
  let deny = false;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as DisclosureRecord;
        if (o && canonicalHandle(o.handle) === key && typeof o.deny === "boolean") deny = o.deny;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return false;
  }
  return deny;
}

/** Persist a disclosure deny / re-allow for a handle. Best-effort. */
export function recordDisclosureDeny(handle: string, deny: boolean, opts: DiscOpts = {}): boolean {
  const path = opts.path ?? DEFAULT_PATH;
  const h = (handle || "").trim();
  if (!h) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ handle: h, deny, source: "owner", ts: opts.nowMs ?? Date.now() } satisfies DisclosureRecord) + "\n",
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

// --- Owner self-chat detection --------------------------------------------
// The owner says "don't tell Ravi where I am" (deny) or "you can tell Ravi
// where I am again" (re-allow). The TARGET is usually a NAME, which the bridge
// resolves to a handle (it has the roster); occasionally an explicit handle.
// We return the raw target string + the direction and let the bridge resolve.

// Whereabouts nouns the deny is about — keeps "don't tell Ravi I'm busy"
// (not a location) from tripping it.
const LOCATION_NOUN = String.raw`(?:where\s+i\s?'?m|where\s+i\s+am|my\s+location|my\s+whereabouts|where\s+i'?ll\s+be)`;

function cleanTarget(raw: string): string | null {
  const s = raw.trim().replace(/^(?:to\s+)?/i, "").replace(/[.,!?;:]+$/, "").trim();
  if (!s) return null;
  // ponytail: a name or a handle, at most 2 tokens — not a sentence.
  const tokens = s.split(/\s+/).slice(0, 2);
  const target = tokens.join(" ");
  if (target.length < 2 || target.length > 50) return null;
  // Reject obvious non-targets.
  if (/^(?:anyone|anybody|everyone|nobody|people|them|him|her)$/i.test(target)) return null;
  return target;
}

export function detectDisclosureDeny(
  text: string,
): { target: string; deny: boolean } | null {
  const t = (text || "").trim();
  if (!t || t.length > 200) return null;

  // RE-ALLOW (check first — "you can tell X where I am again" must not match
  // the deny "tell X where I am" pattern).
  //   "you can tell Ravi where I am" / "it's ok to tell Ravi my location" /
  //   "tell Ravi where I am again" / "stop hiding my location from Ravi"
  const allow =
    new RegExp(`(?:you\\s+can|it'?s\\s+ok\\s+to|ok\\s+to|go\\s+ahead\\s+and)\\s+tell\\s+(.+?)\\s+${LOCATION_NOUN}`, "i").exec(t) ||
    new RegExp(`tell\\s+(.+?)\\s+${LOCATION_NOUN}\\s+again\\b`, "i").exec(t) ||
    new RegExp(`stop\\s+hiding\\s+(?:my\\s+location|where\\s+i\\s+am)\\s+from\\s+(.+)$`, "i").exec(t);
  if (allow) {
    const target = cleanTarget(allow[1]);
    if (target) return { target, deny: false };
  }

  // DENY:
  //   "don't tell Ravi where I am" / "do not tell Ravi my location"
  //   "don't share my location with Ravi" / "stop telling Ravi where I am"
  //   "keep my location private from Ravi" / "don't let Ravi know where I am"
  const deny =
    new RegExp(`(?:don'?t|do\\s+not|never|stop)\\s+(?:tell|telling|let)\\s+(.+?)\\s+(?:know\\s+)?${LOCATION_NOUN}`, "i").exec(t) ||
    new RegExp(`(?:don'?t|do\\s+not|never|stop)\\s+shar(?:e|ing)\\s+(?:my\\s+location|where\\s+i\\s+am)\\s+with\\s+(.+)$`, "i").exec(t) ||
    new RegExp(`keep\\s+(?:my\\s+location|my\\s+whereabouts|where\\s+i\\s+am)\\s+(?:private\\s+)?from\\s+(.+)$`, "i").exec(t);
  if (deny) {
    const target = cleanTarget(deny[1]);
    if (target) return { target, deny: true };
  }

  return null;
}
