// Sent-reply log: what we actually sent a CONTACT, with the tier + voice delta
// it was drafted at, so reply quality is measurable (it wasn't: ~33 verbatim
// samples/week). The text is PII, so every line is AES-256-GCM encrypted via
// secure-store (enc1: envelope) and the file is size-bounded via jsonl-trim.
// Contact handle is stored only as a short hash. Owner-only data; never read
// on any reply path.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendSecureLine, loadOrCreateStateKey } from "./secure-store.js";
import { trimJsonlBytes } from "./jsonl-trim.js";

export interface SentLogEntry {
  ts: number;
  channel: "imessage" | "whatsapp";
  handleHash: string;
  tier?: string;
  voiceDelta?: number;
  text: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const META_TTL_MS = 10 * 60_000;

const handleKey = (h: string) => h.replace(/@s\.whatsapp\.net$|@lid$/i, "").toLowerCase().replace(/[^a-z0-9@.]/g, "");
export const hashHandle = (h: string) => createHash("sha256").update(handleKey(h)).digest("hex").slice(0, 12);

// Draft-time metadata, set where the tier is final and consumed at the send boundary.
const draftMeta = new Map<string, { tier: string; voiceDelta?: number; at: number }>();
export function noteDraftMeta(handle: string, meta: { tier: string; voiceDelta?: number }, now = Date.now()): void {
  draftMeta.set(handleKey(handle), { ...meta, at: now });
}
export function takeDraftMeta(handle: string, now = Date.now()): { tier: string; voiceDelta?: number } | undefined {
  const k = handleKey(handle);
  const m = draftMeta.get(k);
  draftMeta.delete(k);
  return m && now - m.at <= META_TTL_MS ? { tier: m.tier, voiceDelta: m.voiceDelta } : undefined;
}

/** Append one encrypted entry to `<stateDir>/sent-log.jsonl`. Best-effort: never throws. */
export async function appendSentLog(
  stateDir: string,
  e: { channel: SentLogEntry["channel"]; to: string; text: string; now?: number },
  key?: Buffer,
): Promise<void> {
  try {
    // Inside the try: a corrupt/unreadable key must not reject a fire-and-forget send.
    key ??= loadOrCreateStateKey(stateDir);
    const now = e.now ?? Date.now();
    const meta = takeDraftMeta(e.to, now);
    const entry: SentLogEntry = { ts: now, channel: e.channel, handleHash: hashHandle(e.to), tier: meta?.tier, voiceDelta: meta?.voiceDelta, text: e.text };
    const file = join(stateDir, "sent-log.jsonl");
    await appendSecureLine(file, JSON.stringify(entry), key);
    await trimJsonlBytes(file, MAX_BYTES);
  } catch {
    /* measurement must never break a send */
  }
}
