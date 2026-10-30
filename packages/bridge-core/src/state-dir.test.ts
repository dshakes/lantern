import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { palStateDir } from "./state-dir.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("PAL_STATE_DIR wins", () => {
  withEnv({ PAL_STATE_DIR: "/x/state", HOME: mkdtempSync(join(tmpdir(), "pal-sd-")) }, () => {
    assert.equal(palStateDir(), "/x/state");
  });
});

test("legacy ~/.pal when ~/.pal does not exist", () => {
  const home = mkdtempSync(join(tmpdir(), "pal-sd-"));
  mkdirSync(join(home, ".pal"));
  withEnv({ PAL_STATE_DIR: undefined, HOME: home }, () => {
    assert.equal(palStateDir(), join(home, ".pal"));
  });
});

test("~/.pal once it exists", () => {
  const home = mkdtempSync(join(tmpdir(), "pal-sd-"));
  mkdirSync(join(home, ".pal"));
  mkdirSync(join(home, ".pal"));
  withEnv({ PAL_STATE_DIR: undefined, HOME: home }, () => {
    assert.equal(palStateDir(), join(home, ".pal"));
  });
});

test("legacy PAL_STATE_DIR honoured without the env-compat mirror", () => {
  withEnv({ PAL_STATE_DIR: undefined, PAL_STATE_DIR: "/legacy/state" }, () => {
    assert.equal(palStateDir(), "/legacy/state");
  });
});
