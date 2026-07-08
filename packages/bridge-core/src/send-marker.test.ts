// Tests for the [SEND:...] action marker — owner-initiated outbound message.
// The LLM emits it when the owner asks to send/text someone; the bridge
// resolves the contact, confirms once, then sends from the owner's account.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractActionMarkers } from "./mac-actions.ts";

test("parses a whatsapp [SEND] marker", () => {
  const r = extractActionMarkers("on it.\n[SEND:whatsapp|Chikka|sorry, docs pampaledu inka. ee roju pamptha]");
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].channel, "whatsapp");
  assert.equal(r.sends[0].contact, "Chikka");
  assert.equal(r.sends[0].text, "sorry, docs pampaledu inka. ee roju pamptha");
  assert.ok(!r.cleanedText.includes("[SEND:"), "marker stripped from reply text");
});

test("parses imessage, sms, and channel aliases", () => {
  const r = extractActionMarkers(
    "[SEND:imessage|Sam|running late]\n[SEND:text|Mom|call you tonight]\n[SEND:wa|Anil|sent]",
  );
  assert.equal(r.sends.length, 3);
  assert.equal(r.sends[0].channel, "imessage");
  assert.equal(r.sends[1].channel, "sms"); // "text" → sms
  assert.equal(r.sends[2].channel, "whatsapp"); // "wa" → whatsapp
});

test("unknown/missing channel defaults to auto", () => {
  const r = extractActionMarkers("[SEND:|Raju|yo]");
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].channel, "auto");
  assert.equal(r.sends[0].contact, "Raju");
});

test("keeps pipes inside the message body", () => {
  const r = extractActionMarkers("[SEND:whatsapp|Kai|a | b | c]");
  assert.equal(r.sends[0].text, "a | b | c");
});

test("skips malformed markers (no contact or no body)", () => {
  const r = extractActionMarkers("[SEND:whatsapp|Chikka]\n[SEND:whatsapp||just text]");
  assert.equal(r.sends.length, 0);
});

test("no marker → no sends, text untouched", () => {
  const r = extractActionMarkers("i'll text him when i get a sec");
  assert.equal(r.sends.length, 0);
  assert.equal(r.cleanedText, "i'll text him when i get a sec");
});

test("SEND coexists with other action markers", () => {
  const r = extractActionMarkers("[NOTE:Title|body]\n[SEND:whatsapp|Anil|sync up]");
  assert.equal(r.notes.length, 1);
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0].contact, "Anil");
});
