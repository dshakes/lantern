import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { palStateDir } from "./state-dir.ts";

function withEnv(v: string | undefined, fn: () => void) {
  const saved = process.env.PAL_STATE_DIR;
  if (v === undefined) delete process.env.PAL_STATE_DIR;
  else process.env.PAL_STATE_DIR = v;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.PAL_STATE_DIR;
    else process.env.PAL_STATE_DIR = saved;
  }
}

test("palStateDir: ~/.pal by default", () => {
  withEnv(undefined, () => assert.equal(palStateDir(), join(homedir(), ".pal")));
});

test("palStateDir: PAL_STATE_DIR overrides", () => {
  withEnv("/x/state", () => assert.equal(palStateDir(), "/x/state"));
});
