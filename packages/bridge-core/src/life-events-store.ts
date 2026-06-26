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
import { recordAccept, recordIgnore } from "./life-events.js";

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
