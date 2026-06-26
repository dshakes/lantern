// Owner-model-lite persistence for the LIFE-EVENT ENGINE.
//
// The life-events.ts module is PURE (no I/O). This thin store is the bridge-side
// companion that persists the per-kind accept/ignore preference to disk so the
// owner model survives restarts. Kept tiny + documented.
//
// File: ~/.lantern/life-events-prefs.json (mode 0600 — it's owner behavioral
// data, not PII, but we keep it owner-only for consistency with the rest of
// ~/.lantern). Both bridges share the SAME file so the owner model is unified
// across iMessage + WhatsApp (the same kind preference applies on both channels).

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LifeEventKind, LifeEventPrefs } from "./life-events.js";
import { recordAccept, recordIgnore, recordAutoAccept, recordAutoUndo } from "./life-events.js";

export function lifeEventsPrefsPath(): string {
  return process.env.LANTERN_LIFE_EVENTS_PREFS || join(homedir(), ".lantern", "life-events-prefs.json");
}

export function loadLifeEventPrefs(path = lifeEventsPrefsPath()): LifeEventPrefs {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LifeEventPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persist(prefs: LifeEventPrefs, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prefs, null, 2), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort on filesystems w/o mode */ }
  } catch {
    /* persistence is best-effort — never throw into the bridge */
  }
}

// Record that the owner ACCEPTED a surfaced life-event of `kind` (tapped "yes").
// Returns the updated prefs and writes them to disk.
export function persistAccept(kind: LifeEventKind, path = lifeEventsPrefsPath()): LifeEventPrefs {
  const next = recordAccept(loadLifeEventPrefs(path), kind);
  persist(next, path);
  return next;
}

// Record that the owner IGNORED a surfaced life-event of `kind` (no tap within
// the offer window, or an explicit "no"). Returns the updated prefs + persists.
export function persistIgnore(kind: LifeEventKind, path = lifeEventsPrefsPath()): LifeEventPrefs {
  const next = recordIgnore(loadLifeEventPrefs(path), kind);
  persist(next, path);
  return next;
}

// AUTO-ACT LADDER — record that the owner LEFT an auto-action in place (didn't
// undo). Lifts trust for `kind`. Optional/best-effort.
export function persistAutoAccept(kind: LifeEventKind, path = lifeEventsPrefsPath()): LifeEventPrefs {
  const next = recordAutoAccept(loadLifeEventPrefs(path), kind);
  persist(next, path);
  return next;
}

// AUTO-ACT LADDER — record that the owner UNDID an auto-action ("undo"/
// "remove"). Strong negative signal; drives the trust downgrade auto →
// suggest → none in autoActDecision.
export function persistAutoUndo(kind: LifeEventKind, path = lifeEventsPrefsPath()): LifeEventPrefs {
  const next = recordAutoUndo(loadLifeEventPrefs(path), kind);
  persist(next, path);
  return next;
}

// ── AUTO-ACT IDEMPOTENCY STORE ──────────────────────────────────────────────
//
// A persisted, bounded (rolling) set of idempotencyKeys the bot has ALREADY
// auto-acted on, so repeated carrier updates for the SAME package — or a
// bridge restart — never double-book a calendar event / double-log a delivery.
//
// File: ~/.lantern/life-events-acted.json (mode 0600). Stored as an ordered
// array (most-recent last) capped to ACTED_CAP entries; the oldest roll off.
// Both bridges share the same file (unified across iMessage + WhatsApp).

const ACTED_CAP = 500;

export function lifeEventsActedPath(): string {
  return process.env.LANTERN_LIFE_EVENTS_ACTED || join(homedir(), ".lantern", "life-events-acted.json");
}

function loadActed(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function persistActed(keys: string[], path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(keys, null, 0), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  } catch {
    /* best-effort — never throw into the bridge */
  }
}

// True when `key` was already auto-acted (this run or a prior one).
export function hasActed(key: string, path = lifeEventsActedPath()): boolean {
  if (!key) return false;
  return loadActed(path).includes(key);
}

// Mark `key` as auto-acted + persist. Idempotent (a duplicate key is a no-op
// that returns false). Returns true when it newly recorded the key, false when
// it was already present — the caller uses this to guard execution.
export function markActed(key: string, path = lifeEventsActedPath()): boolean {
  if (!key) return false;
  const keys = loadActed(path);
  if (keys.includes(key)) return false;
  keys.push(key);
  // Roll off the oldest when over the cap.
  const bounded = keys.length > ACTED_CAP ? keys.slice(keys.length - ACTED_CAP) : keys;
  persistActed(bounded, path);
  return true;
}

// Remove a key from the acted set (used on UNDO so a re-surfaced package can be
// re-acted later if the owner wants). Best-effort.
export function unmarkActed(key: string, path = lifeEventsActedPath()): void {
  if (!key) return;
  const keys = loadActed(path).filter((k) => k !== key);
  persistActed(keys, path);
}

// ── AUTO-ACT PAUSE FLAG ─────────────────────────────────────────────────────
//
// The owner's "pause automation" / "resume automation" command persists here so
// the choice survives restarts (the env var LANTERN_LIFE_EVENT_AUTOACT is the
// DEFAULT; this flag is the runtime override). File: ~/.lantern/
// life-events-autoact.json (mode 0600). { paused: boolean }.

export function lifeEventsAutoActPath(): string {
  return process.env.LANTERN_LIFE_EVENTS_AUTOACT_STATE || join(homedir(), ".lantern", "life-events-autoact.json");
}

// True when the owner has explicitly PAUSED automation. Default false
// (automation on, per owner request) when the file is absent/unreadable.
export function isAutoActPaused(path = lifeEventsAutoActPath()): boolean {
  try {
    if (!existsSync(path)) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? !!parsed.paused : false;
  } catch {
    return false;
  }
}

// Persist the owner's pause/resume choice.
export function setAutoActPaused(paused: boolean, path = lifeEventsAutoActPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ paused }, null, 0), { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  } catch {
    /* best-effort */
  }
}
