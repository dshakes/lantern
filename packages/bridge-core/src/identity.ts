// identity.ts — durable owner-correction overlay for "who is this handle."
//
// The single highest-precedence source of a contact's name. Fixes the
// Arun↔Manasa flip-flop: when the owner says "that number is Manasa's," it is
// recorded here and OUTRANKS the AddressBook and any area-code guess —
// permanently, until the owner corrects it again. This is the entity-resolution
// + correction-precedence layer (Zep/Graphiti call it owner-authoritative
// edges): a confirmed fact must never be overridden by a heuristic.
//
// Owner-only, local. Store: ~/.lantern/identity-overrides.jsonl (mode 0600),
// append-only, last-write-wins. Path + now injectable for tests.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { canonicalHandle } from "./canonical-handle.js";

export interface IdentityOverride {
  handle: string;
  name: string;
  source: "owner-correction";
  ts: number;
}

const DEFAULT_PATH = join(homedir(), ".lantern", "identity-overrides.jsonl");

export interface IdOpts {
  path?: string;
  nowMs?: number;
}

/** Owner-confirmed name for a handle, or null if none. Consult this FIRST,
 *  before AddressBook/alias resolution. When BOTH this and the AddressBook
 *  return null the caller must NOT invent a name (no area-code guessing) —
 *  refer to the contact as the raw handle. Last write wins. */
export function resolveName(handle: string, opts: IdOpts = {}): string | null {
  const path = opts.path ?? DEFAULT_PATH;
  if (!handle || !existsSync(path)) return null;
  const key = canonicalHandle(handle);
  let name: string | null = null;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as IdentityOverride;
        if (o && o.name && canonicalHandle(o.handle) === key) name = o.name; // last wins
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return null;
  }
  return name;
}

// --- Owner self-chat correction CAPTURE -----------------------------------
// Deterministic detector for an owner correction that names a SPECIFIC handle,
// e.g. "+15125551234 is Manasa" or "Sam's number is 512-555-1234". Only the
// explicit-handle form is captured — a bare "that's Manasa" can't be resolved
// to a handle without ambiguous context, so we leave it to the LLM extractor.
// Pure; no I/O; never throws.

const PHONE_SRC = String.raw`\+?\d[\d\s().-]{7,}\d`;
const EMAIL_SRC = String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`;

// Words that are never part of a contact name. If ANY token of the captured
// name is in here we reject — so "512… is wrong", "… is just spam", "…
// definitely wrong", "… clearly not Manasa" don't get stored as a bogus,
// highest-precedence override. Includes hedges/adverbs/verdicts that follow
// "is" in a non-correction sentence.
const NON_NAMES = new Set([
  // verdicts / states
  "wrong", "mine", "not", "gone", "dead", "old", "new", "off", "blocked",
  "spam", "busy", "here", "there", "fine", "ok", "okay", "correct", "right",
  "working", "down", "unknown", "unavailable", "calling", "texting", "back",
  // pronouns / articles / prepositions
  "me", "us", "them", "him", "her", "at", "in", "on", "from", "the", "a", "an",
  "my", "your", "our", "his", "their", "it",
  // hedges / adverbs that follow "is" in a non-correction sentence
  "just", "still", "probably", "definitely", "really", "clearly", "actually",
  "basically", "literally", "maybe", "perhaps", "no", "nope", "yeah", "yes",
  "always", "never", "sometimes", "now",
]);

function cleanCorrectionName(raw: string): string | null {
  let s = raw.trim();
  // "<handle> is a/an/the …" is a description, not a name assignment
  // ("512 is a great number") — names don't take an article. Reject.
  if (/^(?:a|an|the)\s/i.test(s)) return null;
  s = s.replace(/^my\s+/i, "").trim();
  s = s.replace(/['']s\b/i, "").replace(/[.,!?;:]+$/, "").trim();
  if (!s) return null;
  // ponytail: keep at most the first 2 tokens — a display name, not a sentence.
  const tokens = s.split(/\s+/).slice(0, 2);
  const name = tokens.join(" ");
  if (name.length < 2 || name.length > 40) return null;
  // Reject if ANY token is a non-name word (catches "just spam", "definitely
  // wrong", "clearly not", "probably <name>") — a single bad token means the
  // sentence isn't a clean correction, so we leave it to the LLM extractor.
  if (tokens.some((t) => NON_NAMES.has(t.toLowerCase()))) return null;
  if (/^\+?\d/.test(name) || name.includes("@")) return null; // not another handle
  return name;
}

/** Detect an explicit owner identity correction in a self-chat message.
 *  Returns the handle + name to persist, or null when there's no
 *  unambiguous handle-named correction. */
export function detectIdentityCorrection(
  text: string,
): { handle: string; name: string } | null {
  const t = (text || "").trim();
  if (!t || t.length > 200) return null;

  // "<name>'s number/cell/phone/email is <handle>"
  const b = new RegExp(
    `^(.+?)(?:['']s)?\\s+(?:number|cell|phone|mobile|email|imessage|handle|contact)\\s+(?:is|=|:)\\s+(${PHONE_SRC}|${EMAIL_SRC})\\b`,
    "i",
  ).exec(t);
  if (b) {
    const name = cleanCorrectionName(b[1]);
    if (name) return { handle: b[2].trim(), name };
  }

  // "[that|this] [number] <handle> is/=/belongs to <name>"
  const a = new RegExp(
    `(?:^|\\b)(?:that|this)?\\s*(?:number|contact)?\\s*(${PHONE_SRC}|${EMAIL_SRC})\\s+(?:is|=|belongs to|is for)\\s+(.+)$`,
    "i",
  ).exec(t);
  if (a) {
    const name = cleanCorrectionName(a[2]);
    if (name) return { handle: a[1].trim(), name };
  }

  return null;
}

/** Persist an owner correction ("that number is Manasa's" / "this is Sam").
 *  Best-effort; returns whether it was written. */
export function recordIdentityCorrection(handle: string, name: string, opts: IdOpts = {}): boolean {
  const path = opts.path ?? DEFAULT_PATH;
  const h = (handle || "").trim();
  const n = (name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!h || !n) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ handle: h, name: n, source: "owner-correction", ts: opts.nowMs ?? Date.now() } satisfies IdentityOverride) + "\n",
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}
