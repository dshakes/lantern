import test from "node:test";
import assert from "node:assert/strict";
import {
  parseApiErrorBody,
  getRubric,
  setRubric,
  assertionSummary,
  fmtDelta,
  isGrounded,
} from "./eval-format.ts";

test("parseApiErrorBody recovers a 422 body, ignores other statuses and junk", () => {
  assert.deepEqual(parseApiErrorBody('API 422: {"regressed":true}', 422), { regressed: true });
  assert.equal(parseApiErrorBody('API 500: {"a":1}', 422), null);
  assert.equal(parseApiErrorBody("API 422: not json", 422), null);
  assert.equal(parseApiErrorBody("API 422: [1]", 422), null);
});

test("rubric get/set is immutable and drops an emptied lone judge block", () => {
  const a = { contains: "x" };
  const b = setRubric(a, "be nice");
  assert.equal(getRubric(b), "be nice");
  assert.equal("judge" in a, false);
  const c = setRubric({ judge: { rubric: "r", threshold: 0.8 } }, "");
  assert.deepEqual(c.judge, { rubric: "", threshold: 0.8 });
  assert.equal("judge" in setRubric(b, ""), false);
});

test("assertionSummary lists configured checks", () => {
  assert.deepEqual(
    assertionSummary({ contains: "30", judge: { rubric: "r" }, maxCostUsd: 0.05 }, "ok"),
    ['expected "ok"', 'contains "30"', "judge", "≤$0.05"],
  );
  assert.deepEqual(assertionSummary(undefined), []);
});

test("fmtDelta and isGrounded", () => {
  assert.equal(fmtDelta(0.123), "+0.12");
  assert.equal(fmtDelta(-0.3), "-0.30");
  assert.equal(fmtDelta(-0.0001), "0.00");
  assert.equal(isGrounded("reference:run:abc"), true);
  assert.equal(isGrounded("rubric-only"), false);
});
