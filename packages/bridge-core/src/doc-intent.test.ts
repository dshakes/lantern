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
    contact: "",
    channel: "auto",
  });
});

test("parseDocIntent: tolerant of code fences and prose around the JSON", () => {
  const r = parseDocIntent('```json\n{"isDocRequest": true, "document": "passport"}\n```');
  assert.deepEqual(r, { isDocRequest: true, document: "passport", contact: "", channel: "auto" });
  const r2 = parseDocIntent('Sure — {"isDocRequest": false, "document": ""} hope that helps');
  assert.equal(r2.isDocRequest, false);
});

test("parseDocIntent: FAIL-SAFE — any junk/empty yields no relay (never a wrong send)", () => {
  for (const bad of [null, undefined, "", "not json", "{", "{bad}", "yes send it"]) {
    assert.deepEqual(parseDocIntent(bad as string), {
      isDocRequest: false,
      document: "",
      contact: "",
      channel: "auto",
    });
  }
});

test("parseDocIntent: FAIL-SAFE — true with no document is unusable → no relay", () => {
  assert.equal(parseDocIntent('{"isDocRequest": true, "document": ""}').isDocRequest, false);
  assert.equal(parseDocIntent('{"isDocRequest": true}').isDocRequest, false);
});

test("parseDocIntent owner-direction: extracts contact + normalized channel", () => {
  const r = parseDocIntent(
    '{"isDocRequest": true, "document": "passport", "contact": "Chikka", "channel": "message"}',
    "owner",
  );
  assert.deepEqual(r, { isDocRequest: true, document: "passport", contact: "Chikka", channel: "imessage" });
  // channel aliases normalize like the marker parser
  assert.equal(parseDocIntent('{"isDocRequest":true,"document":"pan","contact":"Sam","channel":"wa"}', "owner").channel, "whatsapp");
  assert.equal(parseDocIntent('{"isDocRequest":true,"document":"pan","contact":"Sam","channel":"text"}', "owner").channel, "sms");
  assert.equal(parseDocIntent('{"isDocRequest":true,"document":"pan","contact":"Sam"}', "owner").channel, "auto");
});

test("parseDocIntent owner-direction: FAIL-SAFE — no recipient → no send", () => {
  // valid doc but no contact: unusable on the owner path (who would it go to?)
  assert.equal(
    parseDocIntent('{"isDocRequest": true, "document": "passport", "contact": ""}', "owner").isDocRequest,
    false,
  );
  // inbound direction ignores contact (recipient is the messaging contact)
  assert.equal(
    parseDocIntent('{"isDocRequest": true, "document": "passport"}', "inbound").isDocRequest,
    true,
  );
});

test("buildDocIntentPrompt: distinguishes direction + demands strict JSON", () => {
  const inbound = buildDocIntentPrompt("send me ur pan", "Shekhar", "inbound");
  assert.match(inbound, /contact/i);
  assert.match(inbound, /STRICT JSON/);
  assert.doesNotMatch(inbound, /"channel"/); // inbound shape has no channel field
  const owner = buildDocIntentPrompt("send Manasa my pan on imessage", "Shekhar", "owner");
  assert.match(owner, /assistant/i);
  assert.match(owner, /"channel"/); // owner shape asks for recipient + channel
  assert.match(owner, /send it TO/i);
});
