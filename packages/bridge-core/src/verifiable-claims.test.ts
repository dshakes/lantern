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

test("verifyClaims: scheduled/confirmed honored when performed, rewritten otherwise", () => {
  assert.match(verifyClaims("I scheduled the meeting for Tuesday").text, /i'll schedule the meeting/i);
  assert.equal(
    verifyClaims("I scheduled the meeting for Tuesday", { performedActions: new Set(["schedule"]) }).text,
    "I scheduled the meeting for Tuesday",
  );
  assert.match(verifyClaims("I confirmed the appointment").text, /i'll confirm the appointment/i);
  assert.equal(
    verifyClaims("I confirmed the appointment", { performedActions: new Set(["confirm"]) }).text,
    "I confirmed the appointment",
  );
});

test("verifyClaims: calls + reminders ALWAYS rewritten (no mid-thread path, even if 'performed')", () => {
  assert.match(verifyClaims("I called the doctor").text, /i'll call the doctor/i);
  assert.match(verifyClaims("I phoned him about it").text, /i'll call him about it/i);
  // even a bogus 'performed' claim can't honor a call — the bridge can't dial mid-thread
  assert.match(verifyClaims("I called him", { performedActions: new Set(["call"]) }).text, /i'll call him/i);
  assert.match(verifyClaims("I set a reminder to renew your passport").text, /i'll set a reminder to renew your passport/i);
  assert.match(verifyClaims("I've set a reminder for tomorrow").text, /i'll set a reminder for tomorrow/i);
});
