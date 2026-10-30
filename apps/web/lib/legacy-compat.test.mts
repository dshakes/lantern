import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEME_INIT_SCRIPT } from "./theme-init-script.ts";
import { stateDir } from "./state-dir.ts";

function run(store: Map<string, string>) {
  const ls = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  new Function("localStorage", "document", THEME_INIT_SCRIPT)(ls, doc);
  return doc.documentElement.dataset.theme;
}

test("legacy pal-* / pal_* localStorage keys migrate to pal-*", () => {
  const s = new Map([["pal-theme", "light"], ["pal_token", "tok"], ["pal_chat_a", "x"]]);
  assert.equal(run(s), "light");
  assert.equal(s.get("pal_token"), "tok");
  assert.equal(s.get("pal_chat_a"), "x");
});

test("an existing pal key is never overwritten by a legacy one", () => {
  const s = new Map([["pal-theme", "light"], ["pal-theme", "dark"]]);
  assert.equal(run(s), "dark");
});

test("stateDir: PAL_STATE_DIR > ~/.pal if present > ~/.pal", () => {
  const home = mkdtempSync(join(tmpdir(), "palhome-"));
  const saved = { HOME: process.env.HOME, S: process.env.PAL_STATE_DIR };
  try {
    process.env.HOME = home;
    delete process.env.PAL_STATE_DIR;
    assert.equal(stateDir(), join(home, ".pal"));
    mkdirSync(join(home, ".pal"));
    assert.equal(stateDir(), join(home, ".pal"));
    process.env.PAL_STATE_DIR = "/x/y";
    assert.equal(stateDir(), "/x/y");
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.S === undefined) delete process.env.PAL_STATE_DIR; else process.env.PAL_STATE_DIR = saved.S;
  }
});
