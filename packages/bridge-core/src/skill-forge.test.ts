// Tests for the skill forge: request grammar, spec parse/validate, schedule
// matching, once-per-day guard.
//   cd packages/bridge-core && npx tsx --test src/skill-forge.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  matchSkillRequest, matchSkillCommand, parseSkillSpec, buildSkillSpecPrompt,
  formatSchedule, formatSkillProposal, formatSkillList, dueSkills, localDayKey,
  defaultSkillState, type StoredSkill,
} from "./skill-forge.ts";

test("matchSkillRequest: anchored triggers only", () => {
  assert.equal(matchSkillRequest("new skill: text me a week-ahead preview every sunday"), "text me a week-ahead preview every sunday");
  assert.equal(matchSkillRequest("Teach yourself to summarize my unread emails at 7am"), "to summarize my unread emails at 7am");
  assert.equal(matchSkillRequest("what's a good skill to learn?"), null);
  assert.equal(matchSkillRequest("skills"), null);
});

test("matchSkillCommand: list + drop", () => {
  assert.equal(matchSkillCommand("skills"), "list");
  assert.deepEqual(matchSkillCommand("drop skill 2"), { drop: 2 });
  assert.deepEqual(matchSkillCommand("remove skill 10"), { drop: 10 });
  assert.equal(matchSkillCommand("drop 2"), null);
});

test("parseSkillSpec: happy path + clamps + honest refusal + garbage", () => {
  const ok = parseSkillSpec('here! {"name":"week-ahead","description":"Sunday preview","schedule":{"hour":18,"minute":0,"daysOfWeek":[0]},"prompt":"Compose a week-ahead preview."}');
  assert.ok(ok && !("error" in ok));
  if (ok && !("error" in ok)) {
    assert.equal(ok.name, "week-ahead");
    assert.deepEqual(ok.schedule.daysOfWeek, [0]);
  }
  const refusal = parseSkillSpec('{"error":"needs hardware access"}');
  assert.deepEqual(refusal, { error: "needs hardware access" });
  assert.equal(parseSkillSpec("not json"), null);
  assert.equal(parseSkillSpec('{"name":"BAD NAME!","description":"x","schedule":{"hour":8,"minute":0,"daysOfWeek":[]},"prompt":"p"}'), null);
  assert.equal(parseSkillSpec('{"name":"ok-name","description":"x","schedule":{"hour":25,"minute":0,"daysOfWeek":[]},"prompt":"p"}'), null);
});

test("prompt demands strict JSON and forbids invention", () => {
  const p = buildSkillSpecPrompt("remind me to water plants", new Date(), "America/New_York");
  assert.match(p, /STRICT JSON/);
  assert.match(p, /Never invent facts/);
});

test("formatting", () => {
  assert.equal(formatSchedule({ hour: 18, minute: 0, daysOfWeek: [0] }), "Sun at 6:00pm");
  assert.equal(formatSchedule({ hour: 7, minute: 30, daysOfWeek: [] }), "daily at 7:30am");
  const spec = { name: "x", description: "d", prompt: "p", schedule: { hour: 8, minute: 0, daysOfWeek: [] } };
  assert.match(formatSkillProposal(spec), /approve skill/);
  assert.match(formatSkillList([]), /no skills yet/);
});

function skill(over: Partial<StoredSkill>): StoredSkill {
  return {
    name: "s", description: "d", prompt: "p", createdAt: 0, enabled: true,
    schedule: { hour: 9, minute: 0, daysOfWeek: [] },
    ...over,
  };
}

test("dueSkills: fires in window, respects day filter + once-per-day + enabled", () => {
  // 2026-07-06 is a Monday. Use UTC timezone for determinism.
  const now = new Date(Date.UTC(2026, 6, 6, 9, 5)); // Mon 09:05 UTC
  const state = defaultSkillState();
  state.skills = [
    skill({ name: "daily-hit" }),
    skill({ name: "too-early", schedule: { hour: 10, minute: 0, daysOfWeek: [] } }),
    skill({ name: "aged-out", schedule: { hour: 8, minute: 30, daysOfWeek: [] } }), // 35 min ago > 20 window
    skill({ name: "sunday-only", schedule: { hour: 9, minute: 0, daysOfWeek: [0] } }),
    skill({ name: "monday-only", schedule: { hour: 9, minute: 0, daysOfWeek: [1] } }),
    skill({ name: "already-fired", lastFiredDay: localDayKey(now, "UTC") }),
    skill({ name: "disabled", enabled: false }),
  ];
  const due = dueSkills(state, now, "UTC").map((s) => s.name);
  assert.deepEqual(due.sort(), ["daily-hit", "monday-only"].sort());
});
