// Encryption-at-rest for the bridges' PII JSONL state.
//
// episodes.jsonl / topic-index.jsonl / dislike-patterns.jsonl under
// ~/.lantern/ hold raw conversation content (inbound text, bot replies,
// topics). They were mode-0600 plaintext; this gives them the same
// AES-256-GCM treatment the DB already uses for credentials.
//
// Line format on disk: `enc1:<base64(iv)>:<base64(ciphertext+tag)>`, one
// per line, fresh 12-byte IV per line. Decrypt is backward-compatible: a
// line that does NOT start with `enc1:` is returned unchanged, so existing
// plaintext lines keep working with no migration — old lines age out of the
// trim-bounded files naturally.
//
// Nothing here throws: a tampered/garbage line decrypts to null and the
// caller skips it, matching the modules' existing "log-and-skip" read loops.

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ALGO = "aes-256-gcm";
const PREFIX = "enc1:";
const FILE_MODE = 0o600;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEFAULT_STATE_DIR = join(homedir(), ".lantern");

/**
 * Load the 32-byte state key from `<dir>/state.key`, creating it (mode 0600)
 * on first use. Stable across calls. Synchronous — callers memoize.
 */
export function loadOrCreateStateKey(dir: string = DEFAULT_STATE_DIR): Buffer {
  const keyPath = join(dir, "state.key");
  const existing = readKeyIfValid(keyPath);
  if (existing) return existing;

  mkdirSync(dir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  try {
    // wx: fail if a concurrent creator won the race — then read theirs.
    writeFileSync(keyPath, key, { mode: FILE_MODE, flag: "wx" });
    try { chmodSync(keyPath, FILE_MODE); } catch { /* best-effort: umask may have loosened it */ }
    return key;
  } catch {
    const raced = readKeyIfValid(keyPath);
    if (raced) return raced;
    throw new Error("secure-store: state key unavailable at " + keyPath);
  }
}

function readKeyIfValid(keyPath: string): Buffer | null {
  try {
    const buf = readFileSync(keyPath);
    return buf.length === KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/** Encrypt one plaintext line into an `enc1:` envelope with a fresh IV. */
export function encryptLine(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + Buffer.concat([ct, tag]).toString("base64");
}

/**
 * Decrypt one line. Backward-compat: a line without the `enc1:` prefix is
 * returned unchanged (existing plaintext). Tamper/garbage → null (skip it).
 * Never throws.
 */
export function decryptLine(line: string, key: Buffer): string | null {
  if (!line.startsWith(PREFIX)) return line; // plaintext passthrough
  try {
    const parts = line.slice(PREFIX.length).split(":");
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], "base64");
    const blob = Buffer.from(parts[1], "base64");
    if (iv.length !== IV_BYTES || blob.length < TAG_BYTES) return null;
    const ct = blob.subarray(0, blob.length - TAG_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Append one encrypted line (0600), chmod-ing on first create. */
export async function appendSecureLine(file: string, line: string, key: Buffer): Promise<void> {
  const fresh = !existsSync(file);
  await appendFile(file, encryptLine(line, key) + "\n", { encoding: "utf8", mode: FILE_MODE });
  if (fresh) { try { await chmod(file, FILE_MODE); } catch { /* best-effort */ } }
}

/**
 * Read + decrypt every line, skipping blanks and undecryptable ones. Missing
 * file → []. Optional `maxBytes` tail-slices the raw file (dropping a
 * possibly-truncated first line) before decrypting — preserves the modules'
 * existing OOM guard, and works on encrypted content because lines stay
 * newline-delimited and independently decryptable.
 */
export async function readSecureLines(file: string, key: Buffer, maxBytes?: number): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  if (maxBytes && raw.length > maxBytes) {
    raw = raw.slice(-maxBytes);
    const nl = raw.indexOf("\n");
    if (nl >= 0) raw = raw.slice(nl + 1);
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const dec = decryptLine(trimmed, key);
    if (dec !== null) out.push(dec);
  }
  return out;
}
