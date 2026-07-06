import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DislikeMemory } from "./dislike-memory.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "dislike-")), "dislike-patterns.jsonl");
}

describe("DislikeMemory encryption at rest", () => {
  test("record encrypts on disk; a fresh instance reads it back", async () => {
    const file = tmpFile();
    const mem = new DislikeMemory({ path: file });
    await mem.record({
      jid: "raju@x",
      inbound: "how much do I owe?",
      badReply: "YOUOWE4200DOLLARS exactly",
      channel: "imessage",
    });

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("YOUOWE4200DOLLARS"), "bad reply text not in plaintext on disk");
    assert.ok(raw.split("\n").filter(Boolean).every((l) => l.startsWith("enc1:")));

    const entries = await new DislikeMemory({ path: file }).all();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].badReply, "YOUOWE4200DOLLARS exactly");
  });

  test("patchLastWithGood append is also encrypted + merges on read", async () => {
    const file = tmpFile();
    const mem = new DislikeMemory({ path: file });
    await mem.record({ jid: "raju@x", inbound: "hi", badReply: "bad one", channel: "imessage" });
    await mem.patchLastWithGood("raju@x", "GOODREPLY7777");

    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("GOODREPLY7777"), "patched good reply not in plaintext");

    const entries = await new DislikeMemory({ path: file }).forJid("raju@x");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].goodReply, "GOODREPLY7777");
  });

  test("mixed legacy-plaintext + encrypted lines both read", async () => {
    const file = tmpFile();
    appendFileSync(
      file,
      JSON.stringify({ jid: "raju@x", inbound: "hi", badReply: "legacy bad", channel: "imessage", ts: Date.now() }) + "\n",
    );
    const mem = new DislikeMemory({ path: file });
    await mem.record({ jid: "madhu@x", inbound: "yo", badReply: "new bad", channel: "imessage" });

    const bad = (await new DislikeMemory({ path: file }).all()).map((e) => e.badReply);
    assert.ok(bad.includes("legacy bad"), "legacy plaintext still readable");
    assert.ok(bad.includes("new bad"), "new encrypted readable");
  });
});
