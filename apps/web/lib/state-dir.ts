// Single resolver for the on-disk state dir (server-side only).
// PAL_STATE_DIR -> ~/.pal if it exists -> ~/.pal (legacy, pre-rename).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
  const env = process.env.PAL_STATE_DIR;
  if (env) return env;
  const pal = join(homedir(), ".pal");
  return existsSync(pal) ? pal : join(homedir(), ".pal");
}
