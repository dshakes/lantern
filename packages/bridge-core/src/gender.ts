// gender.ts — owner-authoritative pronoun overlay for contacts.
//
// The LLM guesses a contact's gender from their name and gets it wrong
// (calling a male contact "she"). Instructions don't reliably override the
// model's prior, so gender must be a stored FACT the owner can set — exactly
// like the identity name overlay. Keyed by lowercased name (business contacts
// are referred to by name, not a stable handle). Owner-only, local, append-only
// JSONL (~/.lantern/gender-overrides.jsonl, 0600), last-write-wins. Pure +
// best-effort; never throws.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";

export type Gender = "m" | "f";

export interface GenderRecord {
  name: string; // lowercased
  gender: Gender;
  source: "owner";
  ts: number;
}

const DEFAULT_PATH = join(homedir(), ".lantern", "gender-overrides.jsonl");

export interface GenderOpts {
  path?: string;
  nowMs?: number;
}

const norm = (n: string): string => (n || "").trim().toLowerCase().split(/\s+/)[0] || "";

/** Owner-set gender for a name (matches on first name), or null. Last wins. */
export function resolveGender(name: string, opts: GenderOpts = {}): Gender | null {
  const path = opts.path ?? DEFAULT_PATH;
  const key = norm(name);
  if (!key || !existsSync(path)) return null;
  let g: Gender | null = null;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as GenderRecord;
        if (o && (o.gender === "m" || o.gender === "f") && norm(o.name) === key) g = o.gender;
      } catch {
        /* skip */
      }
    }
  } catch {
    return null;
  }
  return g;
}

/** Persist an owner gender correction. Best-effort. */
export function recordGender(name: string, gender: Gender, opts: GenderOpts = {}): boolean {
  const path = opts.path ?? DEFAULT_PATH;
  const n = norm(name);
  if (!n || (gender !== "m" && gender !== "f")) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ name: n, gender, source: "owner", ts: opts.nowMs ?? Date.now() } satisfies GenderRecord) + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Gender words; the FIRST one to appear after "<name> is …" decides (so
// "Prithvi is a boy not girl" → male).
const MALE = new Set(["boy", "man", "guy", "dude", "male", "gentleman", "he", "him", "his", "bro", "brother", "son", "husband", "father", "dad", "mr"]);
const FEMALE = new Set(["girl", "woman", "lady", "female", "she", "her", "hers", "sister", "daughter", "wife", "mother", "mom", "mrs", "ms"]);

function looksLikeName(s: string): boolean {
  const t = s.trim();
  return t.length >= 2 && t.length <= 40 && /^[\p{L}][\p{L} .'-]*$/u.test(t) && t.split(/\s+/).length <= 3;
}

/** Detect "Prithvi is a boy" / "Raju is a man, not a girl" / "Mae is female".
 *  Returns the name + gender, or null. */
export function detectGenderStatement(text: string): { name: string; gender: Gender } | null {
  const t = (text || "").trim();
  if (!t || t.length > 160) return null;
  const m = /^(.+?)\s+is\s+(?:not\s+)?(?:an?\s+)?(.+)$/i.exec(t);
  if (!m) return null;
  const name = m[1].replace(/^(?:the|a|an)\s+/i, "").trim();
  if (!looksLikeName(name)) return null;
  for (const w of m[2].toLowerCase().split(/[^a-z]+/)) {
    if (MALE.has(w)) return { name, gender: "m" };
    if (FEMALE.has(w)) return { name, gender: "f" };
  }
  return null;
}
