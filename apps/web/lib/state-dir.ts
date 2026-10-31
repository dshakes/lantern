// Single resolver for the on-disk state dir (server-side only):
// PAL_STATE_DIR, else ~/.pal.
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  return process.env.PAL_STATE_DIR || join(homedir(), ".pal");
}
