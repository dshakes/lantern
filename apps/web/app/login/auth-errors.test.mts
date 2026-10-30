import test from "node:test";
import assert from "node:assert/strict";
import { describeAuthError, safeNextPath } from "./auth-errors.ts";

test("status-specific copy", () => {
  assert.equal(describeAuthError(new Error('API 429: {"error":"too many login attempts"}'), "signin").kind, "rate_limited");
  const inv = describeAuthError(new Error('API 401: {"error":"invalid credentials"}'), "signin");
  assert.equal(inv.kind, "invalid");
  assert.match(inv.message, /incorrect/i);
  assert.equal(describeAuthError(new Error('API 403: {"code":"email_unverified"}'), "signin").kind, "unverified");
  assert.equal(describeAuthError(new TypeError("Failed to fetch"), "signin").kind, "unreachable");
  assert.equal(describeAuthError(new Error("API 500: oops"), "signin").kind, "server");
});

test("sign-up surfaces the server's reason", () => {
  const v = describeAuthError(new Error('API 403: {"error":"sign-up is invite-only"}'), "signup");
  assert.equal(v.kind, "closed");
  assert.equal(v.message, "Sign-up is invite-only");
  assert.equal(describeAuthError(new Error('API 400: {"error":"password too short"}'), "signup").message, "Password too short");
});

test("safeNextPath blocks open redirects and loops", () => {
  assert.equal(safeNextPath("/agents/x?y=1"), "/agents/x?y=1");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath("/login?next=/x"), "/");
  assert.equal(safeNextPath(null), "/");
});
