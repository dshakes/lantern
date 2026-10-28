import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoSessionPath } from "./no-session-paths.ts";

test("no-session pages skip the 401 → /login bounce", () => {
  for (const p of ["/login", "/kiosk", "/kiosk/", "/auth/callback"]) assert.equal(isNoSessionPath(p), true, p);
  for (const p of ["/agents", "/onboarding", "/kiosks", "/settings"]) assert.equal(isNoSessionPath(p), false, p);
});
