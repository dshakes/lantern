import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClaims, performedClaimActions } from "./verifiable-claims.ts";

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

test("verifyClaims: doc-send lies rewritten to intent (the production incident)", () => {
  // the exact failing phrasings — "your <doc>" evaded the old determiner/noun lists
  assert.match(verifyClaims("done, I sent your passport to Chikka").text, /i'll send your passport to chikka/i);
  assert.match(verifyClaims("here's your passport").text, /i'll send your passport over/i);
  assert.match(verifyClaims("sharing your license now").text, /i'll get your license.* over to you/i);
  // verbs the generic send-message pattern doesn't know
  assert.match(verifyClaims("I shared your aadhaar with Manasa").text, /i'll send your aadhaar with manasa/i);
  assert.match(verifyClaims("forwarded your PAN card to him").text, /i'll send your pan card to him/i);
  // non-doc "your" phrasing still rewrites via send-message (no false pass)
  assert.match(verifyClaims("I sent your message to the group").text, /i'll send your message/i);
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

test("W2.2: a claim the bridge provably performed in the last 10 min stands; older or unrecorded claims are rewritten", () => {
  const now = 1_800_000_000_000;
  const fresh = performedClaimActions([{ kind: "calendar_added", ts: now - 30_000, summary: "added dinner with Madhu" }], now, { contactName: "Madhu" });
  assert.ok(fresh.has("calendar-or-note-add") && fresh.has("set-reminder"));
  assert.equal(verifyClaims("I added it to your calendar", { performedActions: fresh }).rewrites.length, 0, "true claim untouched");
  const stale = performedClaimActions([{ kind: "calendar_added", ts: now - 3 * 3_600_000, summary: "added dinner with Madhu" }], now, { contactName: "Madhu" });
  assert.equal(stale.size, 0, "an action three hours ago does not make 'just added' true");
  assert.ok(verifyClaims("I added it to your calendar", { performedActions: stale }).rewrites.length > 0);
  assert.equal(performedClaimActions([{ kind: "custom", ts: now, summary: "Madhu" }], now, { contactName: "Madhu" }).size, 0, "untyped kinds prove nothing");
  assert.ok(performedClaimActions([{ kind: "call_placed", ts: now, summary: "called Madhu" }], now, { contactName: "Madhu" }).has("call"));
  assert.equal(performedClaimActions([{ kind: "calendar_added", ts: now, summary: "added dinner with Madhu" }], now).size, 0, "no contact name → fail closed (review on #244)");
});

test("W2.2: doc sends and owner relays are honoured only for THAT contact, and 'I let him know' needs a record", () => {
  const now = 1_800_000_000_000;
  const log = [
    { kind: "doc_sent", ts: now - 20_000, summary: "sent passport.pdf to Ravi" },
    { kind: "owner_notified", ts: now - 10_000, summary: "told the owner that Madhu asked for the lease" },
  ];
  const forRavi = performedClaimActions(log, now, { contactName: "Ravi Kumar" });
  assert.ok(forRavi.has("send-doc") && !forRavi.has("notify-third-party"));
  const forMadhu = performedClaimActions(log, now, { contactName: "Madhu" });
  assert.ok(forMadhu.has("notify-third-party") && !forMadhu.has("send-doc"), "Ravi's document never justifies a claim to Madhu");
  assert.equal(verifyClaims("I let him know", { performedActions: forMadhu }).rewrites.length, 0, "a recorded relay makes it true");
  assert.ok(verifyClaims("I let him know", { performedActions: forRavi }).rewrites.length > 0, "no record → rewritten as before");
});
