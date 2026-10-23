import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { appendSentLog, noteDraftMeta, hashHandle } from "./sent-log.ts";
import { readSecureLines } from "./secure-store.ts";

test("sent log is encrypted at rest, carries tier/delta, hashes the handle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentlog-"));
  const key = randomBytes(32);
  noteDraftMeta("+15125551234", { tier: "MEDIUM", voiceDelta: 0.42 }, 1000);
  await appendSentLog(dir, { channel: "imessage", to: "+15125551234", text: "sounds good, see you at 7", now: 2000 }, key);
  const raw = readFileSync(join(dir, "sent-log.jsonl"), "utf8");
  assert.ok(raw.startsWith("enc1:"));
  assert.ok(!raw.includes("sounds good") && !raw.includes("5125551234"));
  const [line] = await readSecureLines(join(dir, "sent-log.jsonl"), key);
  assert.deepEqual(JSON.parse(line), { ts: 2000, channel: "imessage", handleHash: hashHandle("+15125551234"), tier: "MEDIUM", voiceDelta: 0.42, text: "sounds good, see you at 7" });
});

test("no draft meta (or expired) -> entry still written without tier; WA jid hashes like bare number", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentlog-"));
  const key = randomBytes(32);
  noteDraftMeta("15125551234", { tier: "LOW" }, 0);
  await appendSentLog(dir, { channel: "whatsapp", to: "15125551234@s.whatsapp.net", text: "ok", now: 11 * 60_000 }, key);
  const [line] = await readSecureLines(join(dir, "sent-log.jsonl"), key);
  const e = JSON.parse(line);
  assert.equal(e.tier, undefined);
  assert.equal(e.handleHash, hashHandle("15125551234"));
});

test("write failure never throws", async () => {
  await appendSentLog("/nonexistent-dir/x/y", { channel: "imessage", to: "a", text: "b" }, randomBytes(32));
});

test("appendSentLog never rejects when the state key is unusable (fire-and-forget callers)", async () => {
  // A state dir that is a FILE: key creation throws inside loadOrCreateStateKey.
  const dir = mkdtempSync(join(tmpdir(), "sentlog-badkey-"));
  const notADir = join(dir, "file");
  writeFileSync(notADir, "x");
  await assert.doesNotReject(appendSentLog(notADir, { channel: "imessage", to: "+15550001", text: "hi" }));
});
