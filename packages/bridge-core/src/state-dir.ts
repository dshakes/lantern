// The bridges' local state directory: PAL_STATE_DIR, else ~/.pal.
//
// Evaluated per call, not at import: the iMessage bridge loads its env file
// after its static imports have run.
import { homedir } from "node:os";
import { join } from "node:path";

export function palStateDir(): string {
  return process.env.PAL_STATE_DIR || join(homedir(), ".pal");
}
