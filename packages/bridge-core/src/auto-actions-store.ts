// Auto-action recap store — persists the SAFE/REVERSIBLE actions the bridge
// took on the owner's behalf (delivery → Deliveries note, appointment/travel →
// calendar) so the "what did you do today" (`did`) recap survives a bridge
// restart. Previously the recap read an in-memory list only, so it answered
// "nothing auto-handled" right after every restart — the bot denying its own
// actions. State lives in `<stateDir>/auto-actions.jsonl` (mode 0600); reads are
// windowed to the last 24h. Best-effort: any I/O failure degrades to empty,
// never throws.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AutoActionEntry {
  text: string;
  ts: number;
}

export interface DidAction {
  id: string;
  label: string;
  undoable: boolean;
}

const FILE = "auto-actions.jsonl";
const WINDOW_MS = 24 * 3_600_000;

/** Append one auto-action to the on-disk recap log. Best-effort. */
export function recordAutoAction(stateDir: string, text: string, now: number = Date.now()): void {
  try {
    appendFileSync(join(stateDir, FILE), JSON.stringify({ text, ts: now }) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort — recap is non-critical */
  }
}

/** Read auto-actions from the last 24h (newest entries kept), oldest-first. */
export function loadAutoActions(stateDir: string, now: number = Date.now()): AutoActionEntry[] {
  try {
    const p = join(stateDir, FILE);
    if (!existsSync(p)) return [];
    const since = now - WINDOW_MS;
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as AutoActionEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AutoActionEntry => !!e && typeof e.ts === "number" && e.ts >= since && typeof e.text === "string")
      .slice(-50);
  } catch {
    return [];
  }
}

/** Map stored entries to the buildDid() shape, stripping the "reply 'undo'" tail. */
export function autoActionsToDid(entries: AutoActionEntry[]): DidAction[] {
  return entries.map((e, i) => ({
    id: String(i + 1),
    label: e.text.replace(/\s*·\s*reply 'undo'.*$/i, "").replace(/^[\s•]+/, "").trim(),
    undoable: /\bundo\b/i.test(e.text),
  }));
}
