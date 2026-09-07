import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mergeRelated, formatRelatedBlock } from "./social-graph.ts";

test("semantic hits lead, local topic hits fill, duplicates collapse, and the block renders them", () => {
  const sem = [
    { personName: "Madhu", channel: "whatsapp", direction: "in", content: "the wedding venue is booked for the 20th", occurredAt: "2026-09-05T10:00:00Z" },
    { personName: "", channel: "imessage", direction: "out", content: "sent the marriage invite list", occurredAt: "not-a-date" },
  ];
  const local = [
    { jid: "1@s.whatsapp.net", contactName: "Ravi", fromMe: false, ts: 1, text: "The wedding venue is booked for the 20th ", topics: ["wedding"] },
    { jid: "2@s.whatsapp.net", contactName: "Sita", fromMe: false, ts: 2, text: "who is doing the decorations", topics: ["decorations"] },
  ];
  const merged = mergeRelated(sem, local, 5);
  assert.equal(merged.length, 3, "the duplicate venue line counted once");
  assert.equal(merged[0].contactName, "Madhu");
  assert.equal(merged[1].fromMe, true);
  assert.ok(Number.isFinite(merged[1].ts));
  const block = formatRelatedBlock(merged);
  assert.match(block, /you told someone: sent the marriage invite list/);
  assert.match(block, /they asked Sita/);
  assert.equal(mergeRelated([], [], 5).length, 0);
});
