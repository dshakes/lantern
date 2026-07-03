// On-disk trim for append-only JSONL state files. The read paths already cap
// what they LOAD (last N bytes) — this caps what stays on DISK, so an
// always-on bridge can't grow a state file forever. Trim triggers at 2× the
// cap so we rewrite rarely, not on every append. Best-effort: never throws.

import { readFile, stat, writeFile } from "node:fs/promises";

const FILE_MODE = 0o600;

/** Truncate `path` to its last `maxBytes` (aligned to a line boundary) once it exceeds 2× that. */
export async function trimJsonlBytes(path: string, maxBytes: number): Promise<void> {
  try {
    const { size } = await stat(path);
    if (size <= maxBytes * 2) return;
    let raw = await readFile(path, "utf8");
    raw = raw.slice(-maxBytes);
    const firstNl = raw.indexOf("\n");
    if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    await writeFile(path, raw, { encoding: "utf8", mode: FILE_MODE });
  } catch {
    /* best-effort — trimming is hygiene, never worth failing a write for */
  }
}
