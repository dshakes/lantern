// Doc-intent backstop classifier — the reliable path when the persona drops the
// [DOCREQ]/[SENDDOC] marker (the GA silent-non-delivery incident).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { maybeDocRequest, buildDocIntentPrompt, parseDocIntent } from "./doc-intent.ts";

test("maybeDocRequest: fires on real doc asks (the incident phrasings)", () => {
  assert.equal(maybeDocRequest("Can u send me ur pan card"), true);
  assert.equal(maybeDocRequest("send me your passport scan"), true);
  assert.equal(maybeDocRequest("forward the aadhaar copy pls"), true);
  assert.equal(maybeDocRequest("need your driving licence"), true);
});

test("maybeDocRequest: does NOT fire on ordinary chatter (cost gate stays cheap)", () => {
  assert.equal(maybeDocRequest("hey what's up"), false);
  assert.equal(maybeDocRequest("running 5 min late"), false);
  assert.equal(maybeDocRequest("happy anniversary bro"), false);
  assert.equal(maybeDocRequest(""), false);
});

test("parseDocIntent: accepts strict JSON", () => {
  assert.deepEqual(parseDocIntent('{"isDocRequest": true, "document": "PAN card"}'), {
    isDocRequest: true,
    document: "PAN card",
  });
});

test("parseDocIntent: tolerant of code fences and prose around the JSON", () => {
  const r = parseDocIntent('```json\n{"isDocRequest": true, "document": "passport"}\n```');
  assert.deepEqual(r, { isDocRequest: true, document: "passport" });
  const r2 = parseDocIntent('Sure — {"isDocRequest": false, "document": ""} hope that helps');
  assert.equal(r2.isDocRequest, false);
});

test("parseDocIntent: FAIL-SAFE — any junk/empty yields no relay (never a wrong send)", () => {
  for (const bad of [null, undefined, "", "not json", "{", "{bad}", "yes send it"]) {
    assert.deepEqual(parseDocIntent(bad as string), { isDocRequest: false, document: "" });
  }
});

test("parseDocIntent: FAIL-SAFE — true with no document is unusable → no relay", () => {
  assert.deepEqual(parseDocIntent('{"isDocRequest": true, "document": ""}'), {
    isDocRequest: false,
    document: "",
  });
  assert.deepEqual(parseDocIntent('{"isDocRequest": true}'), { isDocRequest: false, document: "" });
});

test("buildDocIntentPrompt: distinguishes direction + demands strict JSON", () => {
  const inbound = buildDocIntentPrompt("send me ur pan", "Shekhar", "inbound");
  assert.match(inbound, /contact/i);
  assert.match(inbound, /STRICT JSON/);
  const owner = buildDocIntentPrompt("send Manasa my pan", "Shekhar", "owner");
  assert.match(owner, /assistant/i);
});
