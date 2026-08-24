// Tests for live-watch — proactive follow-up on live situations.
// Regression target: "flight diverted to Cincinnati" got "keep me posted"
// and then silence; the watch loop is what texts "just saw he landed".
//   cd packages/bridge-core && npx tsx --test src/live-watch.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectLiveWatch,
  checkLiveWatch,
  composeWatchFollowUp,
  extractJson,
  WatchStore,
  type LiveWatch,
  watchContextBlock,
  contactWatchBlock,
} from "./live-watch.ts";

const NOW = 1_783_120_000_000;

function watchFixture(over: Partial<LiveWatch> = {}): LiveWatch {
  return {
    id: "j1:1",
    jid: "j1",
    contactName: "Harika",
    topic: "Sowmyadhar's Frontier flight FFT3990 diverted to Cincinnati, still in the air",
    searchQuery: "Frontier flight 3990 status",
    doneCondition: "the flight has landed",
    createdTs: NOW,
    nextCheckTs: NOW,
    intervalMs: 30 * 60_000,
    expiresTs: NOW + 6 * 3_600_000,
    checks: 0,
    status: "active",
    ...over,
  };
}

test("extractJson tolerates prose and fences", () => {
  assert.deepEqual(extractJson('sure!\n```json\n{"watch": false}\n```'), { watch: false });
  assert.equal(extractJson("no json here"), null);
});

test("detectLiveWatch builds a clamped watch from LLM JSON", async () => {
  const w = await detectLiveWatch({
    jid: "j1",
    contactName: "Harika",
    inbound: "Sowmyadhar flight redirected to cincinatte because of weather",
    reply: "oh no, weather ah",
    llmCall: async () =>
      JSON.stringify({
        watch: true,
        topic: "Frontier FFT3990 diverted to Cincinnati",
        searchQuery: "Frontier flight 3990 status",
        doneCondition: "the flight has landed",
        checkMinutes: 5, // below floor — must clamp up
        maxHours: 48, // above ceiling — must clamp down
      }),
    now: NOW,
  });
  assert.ok(w);
  assert.equal(w.status, "active");
  assert.equal(w.intervalMs, 15 * 60_000); // clamped to MIN_INTERVAL
  assert.equal(w.expiresTs, NOW + 12 * 3_600_000); // clamped to MAX_WATCH_HOURS
  assert.equal(w.nextCheckTs, NOW + w.intervalMs);
});

test("detectLiveWatch fails closed on no-watch / bad JSON / llm error", async () => {
  assert.equal(
    await detectLiveWatch({ jid: "j", inbound: "hi", reply: "hey", llmCall: async () => '{"watch": false}' }),
    null,
  );
  assert.equal(
    await detectLiveWatch({ jid: "j", inbound: "hi", reply: "hey", llmCall: async () => "garbage" }),
    null,
  );
  assert.equal(
    await detectLiveWatch({
      jid: "j",
      inbound: "hi",
      reply: "hey",
      llmCall: async () => {
        throw new Error("boom");
      },
    }),
    null,
  );
  // watch:true but missing searchQuery → unusable → null
  assert.equal(
    await detectLiveWatch({
      jid: "j",
      inbound: "hi",
      reply: "hey",
      llmCall: async () => '{"watch": true, "topic": "x", "doneCondition": "y"}',
    }),
    null,
  );
});

test("checkLiveWatch parses state and defaults to unknown", async () => {
  const done = await checkLiveWatch(watchFixture(), async () =>
    '{"state": "done", "summary": "FFT3990 landed CVG 4:12pm"}',
  );
  assert.equal(done.state, "done");
  assert.match(done.summary, /landed/);

  const bad = await checkLiveWatch(watchFixture(), async () => "no idea");
  assert.equal(bad.state, "unknown");

  const threw = await checkLiveWatch(watchFixture(), async () => {
    throw new Error("net");
  });
  assert.equal(threw.state, "unknown");
});

test("composeWatchFollowUp returns short text, rejects junk", async () => {
  const ok = await composeWatchFollowUp({
    watch: watchFixture(),
    summary: "FFT3990 landed CVG 4:12pm",
    ownerName: "Shekhar",
    llmCall: async () => "just saw the flight landed 🙏",
  });
  assert.equal(ok, "just saw the flight landed 🙏");

  const junk = await composeWatchFollowUp({
    watch: watchFixture(),
    summary: "s",
    ownerName: "Shekhar",
    llmCall: async () => '{"state":"done"}', // JSON leak — must be rejected
  });
  assert.equal(junk, null);
});

test("WatchStore persists, dedupes per-jid, expires, prunes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-"));
  const store = new WatchStore(dir);
  assert.ok(store.add(watchFixture()));
  // Second active watch for the same jid is refused.
  assert.equal(store.add(watchFixture({ id: "j1:2" })), false);
  // Different jid ok.
  assert.ok(store.add(watchFixture({ id: "j2:1", jid: "j2" })));

  // Survives reload.
  const reloaded = new WatchStore(dir);
  assert.equal(reloaded.all().length, 2);
  assert.ok(reloaded.hasActive("j1", NOW));

  // due() returns due watches; past-expiry watches flip to expired.
  const due = reloaded.due(NOW + 1);
  assert.equal(due.length, 2);
  const afterExpiry = reloaded.due(NOW + 13 * 3_600_000);
  assert.equal(afterExpiry.length, 0);
  assert.ok(reloaded.all().every((w) => w.status === "expired"));
  assert.equal(reloaded.hasActive("j1", NOW + 13 * 3_600_000), false);

  // update() persists a status flip.
  const s2 = new WatchStore(mkdtempSync(join(tmpdir(), "lw2-")));
  const w = watchFixture();
  s2.add(w);
  s2.update({ ...w, status: "done" });
  assert.equal(s2.hasActive("j1", NOW), false);
});

// Regression: the owner asked "track above flight" 70 minutes after the bot
// announced it was watching that exact flight, and got "I don't see a flight
// in our conversation". The announcement is bot-self text, so history filters
// it out — the store must reach the prompt directly.
test("watchContextBlock surfaces active watches (and only those)", () => {
  const base = {
    jid: "1@lid", topic: "United DFW→IAD Aug 23, seat 38F",
    searchQuery: "q", doneCondition: "the flight has landed at IAD",
    createdTs: NOW, nextCheckTs: NOW, intervalMs: 60_000,
    expiresTs: NOW + 3_600_000, checks: 3, contactName: "Sowmyadhar G",
    lastSummary: "no date-specific status found yet",
  };

  const block = watchContextBlock([{ ...base, id: "a", status: "active" }], NOW);
  assert.match(block, /United DFW→IAD/);
  assert.match(block, /Sowmyadhar G/);
  assert.match(block, /3 check\(s\)/);
  assert.match(block, /no date-specific status/);   // last check must carry over
  assert.match(block, /NEVER say you don't see it/);

  // Resolved, failed, and expired watches are not live commitments.
  assert.equal(watchContextBlock([{ ...base, id: "b", status: "done" }], NOW), "");
  assert.equal(
    watchContextBlock([{ ...base, id: "c", status: "active" }], NOW + 7_200_000),
    "",
  );
  assert.equal(watchContextBlock([], NOW), "");
});

// The contact-facing twin. Isolation is the load-bearing property: a watch
// started off ANOTHER contact's message must never appear in this thread.
test("contactWatchBlock is scoped to one thread", () => {
  const mk = (id: string, jid: string, topic: string) => ({
    id, jid, topic, searchQuery: "q", doneCondition: "it lands",
    createdTs: NOW, nextCheckTs: NOW, intervalMs: 60_000,
    expiresTs: NOW + 3_600_000, checks: 1, status: "active" as const,
  });
  const all = [mk("a", "sowmya@lid", "UA flight to IAD"), mk("b", "raju@lid", "raju's package")];

  const mine = contactWatchBlock(all, "sowmya@lid", NOW);
  assert.match(mine, /UA flight to IAD/);
  assert.doesNotMatch(mine, /package/);            // no cross-contact leak
  assert.match(mine, /never act surprised/);

  assert.match(contactWatchBlock(all, "raju@lid", NOW), /package/);
  assert.equal(contactWatchBlock(all, "nobody@lid", NOW), "");
  // Expired commitments are not live promises.
  assert.equal(contactWatchBlock(all, "sowmya@lid", NOW + 7_200_000), "");
});
