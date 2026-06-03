// Cross-channel bucket-merge + PII-file-mode tests for the three local
// memory stores. Verifies that record/read transparently bucket the SAME
// human by canonical key (WhatsApp jid vs iMessage phone share a bucket),
// that legacy raw-key rows on disk still merge on read, and that the JSONL
// PII files are written 0600.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DislikeMemory } from "./dislike-memory.ts";
import { EpisodicMemory } from "./episodic-memory.ts";
import { SocialGraph } from "./social-graph.ts";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lantern-mem-"));
  return join(dir, name);
}

// 0600 = owner read/write only. Mask off the file-type bits.
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("episodic: WhatsApp jid and iMessage phone share one bucket", async () => {
  const path = tmpFile("episodes.jsonl");
  const mem = new EpisodicMemory({ path });
  await mem.record({
    jid: "15125551234@s.whatsapp.net",
    date: "2026-05-30",
    topic: "refi",
    outcome: "sent the rate sheet",
  });
  await mem.record({
    jid: "+15125551234", // same human, iMessage
    date: "2026-05-31",
    topic: "refi",
    outcome: "they said thanks",
  });
  // Read via either channel handle → both episodes.
  const viaWa = await mem.forJid("15125551234@s.whatsapp.net");
  const viaIm = await mem.forJid("+15125551234");
  assert.equal(viaWa.length, 2);
  assert.equal(viaIm.length, 2);
});

test("episodic: legacy raw-key row on disk merges with new canonical row", async () => {
  const path = tmpFile("episodes.jsonl");
  // Pre-seed a legacy row keyed by a raw jid (pre-canonicalization world).
  writeFileSync(
    path,
    JSON.stringify({
      jid: "15125559999@s.whatsapp.net",
      date: "2026-05-01",
      topic: "trip",
      outcome: "booked flights",
      ts: Date.now() - 1000,
    }) + "\n",
  );
  const mem = new EpisodicMemory({ path });
  // New episode for the same person via iMessage.
  await mem.record({ jid: "+15125559999", date: "2026-05-02", topic: "trip", outcome: "packed" });
  const got = await mem.forJid("+15125559999");
  assert.equal(got.length, 2, "legacy raw-jid row should merge with new canonical row");
});

test("episodic: JSONL is written 0600", async () => {
  const path = tmpFile("episodes.jsonl");
  const mem = new EpisodicMemory({ path });
  await mem.record({ jid: "+15125551234", date: "2026-05-31", topic: "x", outcome: "y" });
  assert.equal(mode(path), 0o600);
});

test("dislike: cross-channel bucket merge + 0600", async () => {
  const path = tmpFile("dislike.jsonl");
  const mem = new DislikeMemory({ path });
  await mem.record({
    jid: "15125551234@s.whatsapp.net",
    inbound: "yo",
    badReply: "Greetings, esteemed colleague.",
    channel: "whatsapp",
  });
  await mem.record({
    jid: "+15125551234",
    inbound: "sup",
    badReply: "Salutations.",
    channel: "imessage",
  });
  const viaIm = await mem.forJid("+15125551234");
  assert.equal(viaIm.length, 2, "both channels' dislikes share one person bucket");
  assert.equal(mode(path), 0o600);
});

test("dislike: patchLastWithGood works across the canonical bucket", async () => {
  const path = tmpFile("dislike.jsonl");
  const mem = new DislikeMemory({ path });
  await mem.record({
    jid: "15125551234@s.whatsapp.net",
    inbound: "hi",
    badReply: "Greetings, esteemed colleague.",
    channel: "whatsapp",
  });
  // Patch using the OTHER channel's handle for the same person.
  await mem.patchLastWithGood("+15125551234", "hey!");
  const got = await mem.forJid("+15125551234");
  assert.equal(got.length, 1);
  assert.equal(got[0].goodReply, "hey!");
});

test("social-graph: 'other threads' excludes the same person on any channel", async () => {
  const path = tmpFile("topics.jsonl");
  const sg = new SocialGraph({ path });
  // Same person, two channels, same topic.
  await sg.record({
    jid: "15125551234@s.whatsapp.net",
    text: "did you connect with Sarah?",
    fromMe: false,
    topics: ["sarah"],
  });
  await sg.record({
    jid: "+15125551234",
    text: "Sarah again",
    fromMe: false,
    topics: ["sarah"],
  });
  // A DIFFERENT person mentioning Sarah.
  await sg.record({
    jid: "+15125550000",
    text: "Sarah said hi",
    fromMe: false,
    topics: ["sarah"],
  });
  // Querying as the first person (via the iMessage handle) must exclude BOTH
  // of their own channel rows and surface only the other person's message.
  const related = await sg.related({ topics: ["sarah"], excludeJid: "+15125551234" });
  assert.equal(related.length, 1);
  assert.equal(related[0].jid, "+15125550000");
});

test("social-graph: JSONL is written 0600", async () => {
  const path = tmpFile("topics.jsonl");
  const sg = new SocialGraph({ path });
  await sg.record({ jid: "+15125551234", text: "hi", fromMe: false, topics: ["sarah"] });
  assert.equal(mode(path), 0o600);
});

test("@lid and group ids are NOT merged into a phone bucket", async () => {
  const path = tmpFile("episodes.jsonl");
  const mem = new EpisodicMemory({ path });
  await mem.record({ jid: "84729130000000@lid", date: "2026-05-31", topic: "x", outcome: "lid one" });
  await mem.record({ jid: "84729130000000", date: "2026-05-31", topic: "x", outcome: "phone one" });
  // The @lid privacy id must stay its own bucket, distinct from the bare
  // digit string (which canonicalizes as an international phone).
  const lidBucket = await mem.forJid("84729130000000@lid");
  assert.equal(lidBucket.length, 1);
  assert.equal(lidBucket[0].outcome, "lid one");
});
