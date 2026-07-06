import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicMemory } from "./episodic-memory.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "episodic-")), "episodes.jsonl");
}

describe("EpisodicMemory encryption at rest", () => {
  test("record encrypts on disk; a fresh instance reads it back", async () => {
    const file = tmpFile();
    const mem = new EpisodicMemory({ path: file });
    await mem.record({
      jid: "raju@x",
      date: "2026-05-12",
      topic: "house refi",
      outcome: "PASSPORTX1234567 shared with the agent",
    });

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("PASSPORTX1234567"), "PII not in plaintext on disk");
    assert.ok(!raw.includes("house refi"), "topic text not in plaintext on disk");
    assert.ok(raw.split("\n").filter(Boolean).every((l) => l.startsWith("enc1:")));

    const fresh = new EpisodicMemory({ path: file });
    const eps = await fresh.forJid("raju@x");
    assert.equal(eps.length, 1);
    assert.equal(eps[0].outcome, "PASSPORTX1234567 shared with the agent");
  });

  test("mixed legacy-plaintext + encrypted lines both read", async () => {
    const file = tmpFile();
    // Legacy plaintext line already on disk from before encryption landed.
    appendFileSync(
      file,
      JSON.stringify({ jid: "raju@x", date: "2026-01-01", topic: "old", outcome: "legacy outcome" }) + "\n",
    );
    const mem = new EpisodicMemory({ path: file });
    await mem.record({ jid: "raju@x", date: "2026-05-12", topic: "new", outcome: "new outcome" });

    const outcomes = (await new EpisodicMemory({ path: file }).forJid("raju@x")).map((e) => e.outcome);
    assert.ok(outcomes.includes("legacy outcome"), "legacy plaintext still readable");
    assert.ok(outcomes.includes("new outcome"), "new encrypted readable");
  });
});
