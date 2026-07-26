import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseBriefReply, formatBriefAck } from "./brief-reply.ts";

test("accepts the forms a person actually types", () => {
  for (const [text, action, n] of [
    ["done 1", "done", 1],
    ["Done 2", "done", 2],
    ["done #3", "done", 3],
    ["1 done", "done", 1],
    ["snooze 2", "snooze", 2],
    ["later 4", "snooze", 4],
    ["dismiss 5", "dismiss", 5],
    ["drop 6", "dismiss", 6],
    ["  done 7  ", "done", 7],
    ["done 8.", "done", 8],
  ] as const) {
    assert.deepEqual(parseBriefReply(text), { action, n }, `should parse ${text}`);
  }
});

// The property that matters. This closes an item the owner cannot see the
// result of, so a false positive silently loses work they still needed.
test("does not fire on messages that merely mention being done", () => {
  for (const text of [
    "I'm done for the day",
    "done with the Amex thing finally",
    "are you done 1 of them?",
    "done",
    "1",
    "call him back done 1 later maybe",
    "that's done, thanks",
    "snooze",
    "done tomorrow",
    "",
  ]) {
    assert.equal(parseBriefReply(text), null, `must NOT parse: ${text}`);
  }
});

test("rejects positions a brief never has", () => {
  assert.equal(parseBriefReply("done 0"), null);
  assert.equal(parseBriefReply("done 100"), null);
});

test("ack names what changed, so a typo is visible", () => {
  const ack = formatBriefAck("done", "Review the flagged Amex card-not-present purchase");
  assert.match(ack, /done/);
  assert.match(ack, /Amex/);
  assert.match(formatBriefAck("snooze", "Pay bill"), /snoozed/);
  assert.match(formatBriefAck("dismiss", "Pay bill"), /dismissed/);
});

test("long titles are truncated, not wrapped", () => {
  const ack = formatBriefAck("done", "x".repeat(200));
  assert.ok(ack.length < 80, `ack should stay short, got ${ack.length}`);
});
