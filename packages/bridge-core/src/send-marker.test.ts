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

// [SENDDOC] — owner-initiated DOCUMENT send. Unlike [SEND] (text only), this
// carries a file. The GA fix: "send Manasa my pan card" must attach the file,
// not text a "here's the pan card" with docRelay:false.

test("parses a [SENDDOC] marker (file, not text)", () => {
  const r = extractActionMarkers("on it.\n[SENDDOC:auto|Manasa|PAN card]");
  assert.equal(r.sendDocs.length, 1);
  assert.equal(r.sendDocs[0].channel, "auto");
  assert.equal(r.sendDocs[0].contact, "Manasa");
  assert.equal(r.sendDocs[0].doc, "PAN card");
  assert.ok(!r.cleanedText.includes("[SENDDOC:"), "marker stripped from reply text");
  assert.equal(r.sends.length, 0, "SENDDOC must not be parsed as a text SEND");
});

test("[SENDDOC] channel aliases + a note-plus-file turn", () => {
  const r = extractActionMarkers("[SENDDOC:wa|Dad|passport]\n[SEND:imessage|Dad|sending it now]");
  assert.equal(r.sendDocs.length, 1);
  assert.equal(r.sendDocs[0].channel, "whatsapp");
  assert.equal(r.sends.length, 1, "a note + a file = both markers");
});

test("[SENDDOC] with a missing field is ignored (no half-formed send)", () => {
  assert.equal(extractActionMarkers("[SENDDOC:auto|Manasa]").sendDocs.length, 0);
  assert.equal(extractActionMarkers("[SENDDOC:auto||PAN card]").sendDocs.length, 0);
});
