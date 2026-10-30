import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NAV, MODE_HOME, allNavItems, chooseLanding, isNavActive, modeForPath, resolveMode,
  type WorkspaceMode,
} from "./workspace-nav.ts";

test("modeForPath classifies pal, runtime and shared routes", () => {
  assert.equal(modeForPath("/brief"), "pal");
  assert.equal(modeForPath("/personal/drafts"), "pal");
  assert.equal(modeForPath("/automations"), "pal");
  assert.equal(modeForPath("/overview"), "runtime");
  assert.equal(modeForPath("/agents/foo/runs"), "runtime");
  assert.equal(modeForPath("/runtime/vm-1"), "runtime");
  assert.equal(modeForPath("/runs"), "runtime");
  assert.equal(modeForPath("/settings"), null);
  assert.equal(modeForPath("/"), null);
  // prefix must be a whole segment
  assert.equal(modeForPath("/briefcase"), null);
});

test("resolveMode falls back to the remembered mode on shared routes", () => {
  assert.equal(resolveMode("/settings", "runtime"), "runtime");
  assert.equal(resolveMode("/settings", null), "pal");
  assert.equal(resolveMode("/settings", "garbage"), "pal");
  assert.equal(resolveMode("/agents", "pal"), "runtime");
});

test("every nav item belongs to its own mode and points at a real page", () => {
  const dash = join(process.cwd(), "app", "(dashboard)");
  for (const mode of ["pal", "runtime"] as WorkspaceMode[]) {
    assert.equal(modeForPath(MODE_HOME[mode]), mode);
    for (const item of allNavItems(mode)) {
      assert.equal(modeForPath(item.href), mode, `${item.href} is in the ${mode} nav`);
      assert.ok(existsSync(join(dash, item.href, "page.tsx")), `${item.href} has a page`);
    }
  }
  assert.ok(NAV.pal.length > 0 && NAV.runtime.length > 0);
});

test("isNavActive: longest match wins", () => {
  const items = allNavItems("pal");
  const holds = items.find((i) => i.href === "/personal/drafts")!;
  const assistant = items.find((i) => i.href === "/personal")!;
  assert.equal(isNavActive(holds, "/personal/drafts", items), true);
  assert.equal(isNavActive(assistant, "/personal/drafts", items), false);
  assert.equal(isNavActive(assistant, "/personal", items), true);
  const people = items.find((i) => i.href === "/personal/contacts")!;
  assert.equal(isNavActive(people, "/personal/vip", items), true);
});

test("chooseLanding", () => {
  assert.equal(chooseLanding({ storedMode: null, onboardingStarted: false, agentCount: 0 }), "/welcome");
  assert.equal(chooseLanding({ storedMode: null, onboardingStarted: true, agentCount: 0 }), "/onboarding");
  assert.equal(chooseLanding({ storedMode: null, onboardingStarted: true, agentCount: 2 }), "/overview");
  assert.equal(chooseLanding({ storedMode: "pal", onboardingStarted: false, agentCount: 5 }), "/brief");
  assert.equal(chooseLanding({ storedMode: "runtime", onboardingStarted: false, agentCount: 0 }), "/overview");
});
