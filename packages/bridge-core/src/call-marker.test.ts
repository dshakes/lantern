// Tests for the [CALL:...] action marker — the intelligent replacement for
// brittle "call X" regexes. The LLM understands intent in any phrasing and
// emits this marker; extractActionMarkers turns it into a CallSpec the
// bridge runs through the Twilio orchestrator.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractActionMarkers } from "./mac-actions.ts";

test("parses a conference [CALL] marker", () => {
  const r = extractActionMarkers("sure, setting that up.\n[CALL:Maya|conference|owner wants to talk]");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].target, "Maya");
  assert.equal(r.calls[0].mode, "conference");
  assert.equal(r.calls[0].message, "owner wants to talk");
  assert.ok(!r.cleanedText.includes("[CALL:"), "marker stripped from reply text");
});

test("defaults mode to conference when omitted", () => {
  const r = extractActionMarkers("[CALL:Madhu]");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].target, "Madhu");
  assert.equal(r.calls[0].mode, "conference");
});

test("parses voicemail + task modes", () => {
  const r = extractActionMarkers(
    "[CALL:Mom|voicemail|running late]\n[CALL:CVS Pharmacy|task|refill prescription #123]",
  );
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].mode, "voicemail");
  assert.equal(r.calls[1].mode, "task");
  assert.equal(r.calls[1].target, "CVS Pharmacy");
});

test("no marker → no calls, text untouched", () => {
  const r = extractActionMarkers("i'll reach out to Maya when she's free");
  assert.equal(r.calls.length, 0);
  assert.equal(r.cleanedText, "i'll reach out to Maya when she's free");
});

test("CALL coexists with other action markers", () => {
  const r = extractActionMarkers("[NOTE:Title|body]\n[CALL:Anil|conference|sync up]");
  assert.equal(r.notes.length, 1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].target, "Anil");
});
