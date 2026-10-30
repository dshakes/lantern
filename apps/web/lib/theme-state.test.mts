import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { THEME_INIT_SCRIPT } from "./theme-init-script.ts";
import { stateDir } from "./state-dir.ts";

function run(store: Map<string, string>) {
  const ls = { getItem: (k: string) => store.get(k) ?? null };
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  new Function("localStorage", "document", THEME_INIT_SCRIPT)(ls, doc);
  return doc.documentElement.dataset.theme;
}

test("theme: persisted pal-theme wins, dark by default", () => {
  assert.equal(run(new Map([["pal-theme", "light"]])), "light");
  assert.equal(run(new Map()), "dark");
});

test("stateDir: PAL_STATE_DIR, else ~/.pal", () => {
  const saved = process.env.PAL_STATE_DIR;
  try {
    delete process.env.PAL_STATE_DIR;
    assert.equal(stateDir(), join(homedir(), ".pal"));
    process.env.PAL_STATE_DIR = "/x/y";
    assert.equal(stateDir(), "/x/y");
  } finally {
    if (saved === undefined) delete process.env.PAL_STATE_DIR;
    else process.env.PAL_STATE_DIR = saved;
  }
});
