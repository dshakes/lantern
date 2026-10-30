// The bridges' local state directory (ADR 0032 PAL→PAL rename).
//
// Resolution, first hit wins:
//   1. PAL_STATE_DIR, else legacy PAL_STATE_DIR (read directly: callers may
//      run before the env-compat mirror)
//   2. ~/.pal          — only once it exists
//   3. ~/.pal      — legacy; every existing install lives here
//
// Nothing is ever moved or rewritten. Creating ~/.pal switches EVERY store at
// once (encrypted stores need their state.key beside them), so migrate by
// moving the whole ~/.pal directory, never a subset.
//
// Evaluated per call, not at import: the iMessage bridge loads its env file
// after its static imports have run.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function palStateDir(): string {
  const explicit = process.env.PAL_STATE_DIR;
  if (explicit) return explicit;
  const pal = join(homedir(), ".pal");
  return existsSync(pal) ? pal : join(homedir(), ".pal");
}
