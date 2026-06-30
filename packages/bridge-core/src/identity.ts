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
