import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeCommitments, runCommitmentJudgment, type Commitment } from "./commitments-edge.ts";

const open: Commitment[] = [
  { id: "c1", title: "send Raju the deck", status: "open", deadline: "2026-10-25" },
  { id: "c2", title: "call the plumber", status: "open" },
];
const evidence = ["me: just sent Raju the deck, check your inbox", "mom: dinner at 7?"];

test("done with verbatim evidence -> done", async () => {
  const llm = async () => JSON.stringify([{ id: "c1", state: "done", evidence: "me: just sent Raju the deck, check your inbox" }]);
  const r = await judgeCommitments(open, evidence, llm, 5);
  assert.equal(r[0].state, "done");
  assert.equal(r[0].lastJudgedAt, 5);
  assert.equal(r[0].due, "2026-10-25");
  assert.equal(r[1].state, "open");
});

test("done citing non-present evidence stays open", async () => {
  const llm = async () => '```json\n[{"id":"c1","state":"done","evidence":"I definitely emailed him the slides"}]\n```';
  assert.equal((await judgeCommitments(open, evidence, llm))[0].state, "open");
});

test("LLM throws / garbage -> unchanged", async () => {
  assert.deepEqual((await judgeCommitments(open, evidence, async () => { throw new Error("x"); })).map((e) => e.state), ["open", "open"]);
  assert.deepEqual((await judgeCommitments(open, evidence, async () => "not json")).map((e) => e.state), ["open", "open"]);
});

test("runCommitmentJudgment closes via client, FYIs, and respects cadence", async () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json");
  const doneCalls: string[] = [];
  const sent: string[] = [];
  const deps = {
    client: { list: async () => open, done: async (id: string) => { doneCalls.push(id); return true; } },
    stateFile, now: 1_000_000_000, gatherEvidence: () => evidence,
    llmCall: async () => JSON.stringify([{ id: "c1", state: "done", evidence: "just sent Raju the deck" }]),
    send: async (t: string) => { sent.push(t); },
  };
  assert.deepEqual(await runCommitmentJudgment(deps), { ran: true, closed: 1 });
  assert.deepEqual(doneCalls, ["c1"]);
  assert.match(sent[0], /^✅ closed: send Raju the deck/);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).entries[0].state, "done");
  assert.equal((await runCommitmentJudgment({ ...deps, now: deps.now + 3_600_000 })).ran, false); // <6h
  assert.equal((await runCommitmentJudgment({ ...deps, now: deps.now + 7 * 3_600_000 })).ran, true);
});

test("done() failure leaves it open and sends no FYI", async () => {
  const sent: string[] = [];
  const r = await runCommitmentJudgment({
    client: { list: async () => open, done: async () => false },
    stateFile: join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json"), now: 1e9, gatherEvidence: () => evidence,
    llmCall: async () => JSON.stringify([{ id: "c1", state: "done", evidence: "just sent Raju the deck" }]),
    send: async (t) => { sent.push(t); },
  });
  assert.deepEqual(r, { ran: true, closed: 0 });
  assert.equal(sent.length, 0);
});
