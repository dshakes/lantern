// build-info.ts — make "which build is actually running?" answerable.
//
// The bridges run as long-lived processes on the host (LaunchAgent / Terminal).
// A merged fix does nothing until that process is rebuilt + restarted, so the
// #1 confusion is "did my change deploy?". This exposes the running build's git
// SHA (and whether the working tree is dirty) at startup and on /health, so the
// answer is a curl, not a guess.

import { execSync } from "node:child_process";

export interface BuildInfo {
  /** Short git SHA (or LANTERN_BUILD_SHA when baked at build time, or "unknown"). */
  sha: string;
  /** True when the working tree had uncommitted changes at resolution time. */
  dirty: boolean;
}

let cached: BuildInfo | undefined;

function git(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the running build, cached after first call. Resolution order:
 *   1. LANTERN_BUILD_SHA env (baked at CI/build time, e.g. packaged deploys),
 *   2. `git rev-parse --short HEAD` from the source checkout (dev / make run),
 *   3. "unknown".
 * Never throws.
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const envSha = (process.env.LANTERN_BUILD_SHA || "").trim();
  const sha = envSha || git("rev-parse --short HEAD") || "unknown";
  // Only meaningful for a source checkout; a baked SHA is authoritative.
  const dirty = envSha ? false : (git("status --porcelain") ?? "") !== "";
  cached = { sha, dirty };
  return cached;
}

/** Human-readable build label, e.g. "a1b2c3d" or "a1b2c3d-dirty". */
export function buildLabel(): string {
  const { sha, dirty } = buildInfo();
  return dirty ? `${sha}-dirty` : sha;
}
