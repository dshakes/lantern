// Tests for looksLikeBriefingRequest — the on-demand briefing trigger.
//   cd packages/bridge-core && npx tsx --test src/daily-digest.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { looksLikeBriefingRequest, formatNextEvent, buildDigest, type DigestData } from "./daily-digest.ts";

test("triggers on explicit briefing asks", () => {
  for (const s of [
    "brief me",
    "brief me on my day",
    "morning briefing",
    "give me my briefing",
    "what's on my plate",
    "whats on my plate today",
    "what's on for today",
    "what do i have today",
    "what do i have going on today",
    "catch me up on my day",
    "run me through my day",
    "how's my day looking",
    "where do things stand",
    "my schedule today",
  ]) {
    assert.equal(looksLikeBriefingRequest(s), true, s);
  }
});

test("does NOT trigger on generic / unrelated chatter", () => {
  for (const s of [
    "what's up",
    "hi",
    "hey what's good",
    "what's the weather today",
    "what did Arun say",
    "where am I",
    "what's on Netflix tonight",
    "",
  ]) {
    assert.equal(looksLikeBriefingRequest(s), false, s);
  }
});

test("formatNextEvent: all-day event renders a date, never a bogus minutes-from-now", () => {
  const now = new Date(2026, 5, 29, 22, 0, 0).getTime(); // Jun 29 2026, 10pm local
  // A date-only event tomorrow. Date.parse would UTC-midnight this and, for a
  // negative-offset user, read as "in ~60 min" — the bug we're fixing.
  const line = formatNextEvent([{ summary: "dentist", start: { date: "2026-06-30" } }], now);
  assert.match(line ?? "", /\(all day\)/);
  assert.match(line ?? "", /Jun 30/);
  assert.ok(!/ in \d+ min/.test(line ?? ""), "must not fabricate a minutes-from-now for an all-day event");
});

test("formatNextEvent: timed event still computes minutes-from-now", () => {
  const now = new Date(2026, 5, 29, 10, 0, 0).getTime();
  const soon = new Date(2026, 5, 29, 10, 45, 0).toISOString();
  const line = formatNextEvent([{ summary: "standup", start: { dateTime: soon } }], now);
  assert.equal(line, "standup in 45 min");
});

test("formatNextEvent: skips past all-day events", () => {
  const now = new Date(2026, 5, 29, 10, 0, 0).getTime();
  assert.equal(formatNextEvent([{ summary: "old", start: { date: "2026-06-01" } }], now), null);
});

test("buildDigest deterministic fallback renders attention items (commitments/overdue/sleep)", async () => {
  const data: DigestData = {
    autoReplies: 2,
    pausedContacts: [],
    watchedThreads: 0,
    escalations: 1,
    commitments: [
      { title: "send Raju the deck", assignedBy: "Raju" },
      { title: "renew passport" },
    ],
    overdueContacts: [{ displayName: "Madhu", daysOverdue: 3 }],
    sleepHours: 6.5,
    // Pre-supplied so the fallback makes zero network calls in tests.
    drafts: { count: 1, sample: "Sam" },
    nextEvent: null,
  } as DigestData;

  const body = await buildDigest(data);
  assert.match(body, /on your plate/);
  assert.match(body, /send Raju the deck \(for Raju\)/);
  assert.match(body, /renew passport/);
  assert.match(body, /waiting on you: Madhu \(3d\)/);
  assert.match(body, /6\.5h sleep/);
  assert.match(body, /1 VIP draft/);
});

test("buildDigest fallback omits attention lines when empty", async () => {
  const data = {
    autoReplies: 0,
    pausedContacts: [],
    watchedThreads: 0,
    escalations: 0,
    commitments: [],
    overdueContacts: [],
    sleepHours: null,
    drafts: { count: 0, sample: "" },
    nextEvent: null,
  } as unknown as DigestData;

  const body = await buildDigest(data);
  assert.doesNotMatch(body, /on your plate|waiting on you|sleep/);
});
