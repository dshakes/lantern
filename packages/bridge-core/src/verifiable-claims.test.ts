import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClaims } from "./verifiable-claims.ts";

test("verifyClaims: media-share claims rewritten to intent (bridge can't attach mid-thread)", () => {
  assert.match(verifyClaims("sending you the invoice now").text, /i'll get the invoice.* over to you/i);
  assert.match(verifyClaims("here's the receipt").text, /i'll send the receipt over/i);
  // a real completed action stays honored when performed
  assert.equal(verifyClaims("I sent him the deck", { performedActions: new Set(["send-message"]) }).text, "I sent him the deck");
  // plain reply with no claim is untouched
  assert.equal(verifyClaims("sounds good, talk later").text, "sounds good, talk later");
});

test("verifyClaims: completed-action lies still rewritten to intent", () => {
  assert.match(verifyClaims("I sent him an email").text, /i'll send/i);
  assert.match(verifyClaims("I added it to your calendar").text, /i'll add/i);
});
