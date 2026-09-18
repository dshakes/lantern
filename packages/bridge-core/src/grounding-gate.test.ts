import { test } from "node:test";
import assert from "node:assert/strict";
import { groundingBackstop, judgeGrounding, parseGroundingVerdict, groundingHoldPage } from "./grounding-gate.js";

// The three live turns of 2026-09-18 (Bharath, opening day) — replayed.
test("backstop holds a date stated in answer to a timing question", () => {
  const v = groundingBackstop("Showtime today??", "not today, sep 10 is the big day 🎉");
  assert.equal(v.hold, true);
  assert.equal(v.reason, "date-assertion");
  assert.equal(v.quote, "sep 10");
});

test("backstop holds a draft that corrects the contact's date", () => {
  const v = groundingBackstop("18th anukuna", "haha no worries, it was 10th 😄");
  assert.equal(v.hold, true);
  assert.equal(v.reason, "contradicts-contact");
  assert.equal(v.quote, "10th");
});

test("a date the contact themselves named is not a contradiction", () => {
  const v = groundingBackstop("still on for the 18th?", "yep, 18th it is");
  assert.equal(v.hold, false);
});

test("scheduling chatter without an explicit calendar date passes the backstop", () => {
  assert.equal(groundingBackstop("free sat?", "sat works, evening?").hold, false);
  assert.equal(groundingBackstop("how's it going", "good good, busy week").hold, false);
  assert.equal(groundingBackstop("thanks bro", "anytime 🙏").hold, false);
});

// The 2026-09-17 memorial card, as the vision model captioned it.
test("backstop holds a celebratory reply to a memorial-card caption", () => {
  const caption = "[image — looks like: this image is an invitation for a ceremony related to someone named vishaka. it includes details about the event dates, contact information, and a photo of the person.]";
  const v = groundingBackstop(caption, "oh nice, sounds like an exciting party 🎉");
  assert.equal(v.hold, true);
  assert.equal(v.reason, "register-mismatch");
});

test("backstop holds loss words answered with a laugh, in Telugu memorial vocabulary too", () => {
  assert.equal(groundingBackstop("nanna gari dasadina karma next sunday", "haha lets go 😂").reason, "register-mismatch");
  assert.equal(groundingBackstop("rest in peace uncle 🙏", "congrats!!").reason, "register-mismatch");
});

test("a somber reply to loss passes the backstop", () => {
  assert.equal(groundingBackstop("nanna passed away last night", "so sorry to hear. I'm here, call me anytime 🙏").hold, false);
});

test("judge: LLM hold wins even when the backstop is silent; LLM failure degrades to backstop", async () => {
  const llmHold = async () => `{"hold": true, "reason": "unverifiable-claim", "quote": "all done and rolling now"}`;
  const v = await judgeGrounding({ inbound: "Oh done ha", draft: "ha, all done and rolling now", llmCall: llmHold });
  assert.equal(v.hold, true);
  assert.equal(v.reason, "unverifiable-claim");
  assert.equal(v.source, "llm");

  const llmThrows = async () => { throw new Error("outage"); };
  const b = await judgeGrounding({ inbound: "Showtime today??", draft: "not today, sep 10 is the big day", llmCall: llmThrows });
  assert.equal(b.hold, true);
  assert.equal(b.source, "backstop");

  const llmPass = async () => `{"hold": false, "reason": "none", "quote": ""}`;
  const p = await judgeGrounding({ inbound: "how's it going", draft: "good, busy", llmCall: llmPass });
  assert.equal(p.hold, false);
});

test("parse is tolerant of prose around the JSON and rejects unknown reasons", () => {
  assert.equal(parseGroundingVerdict('sure: {"hold": true, "reason": "date-assertion", "quote": "sep 10"} ok')?.hold, true);
  assert.equal(parseGroundingVerdict('{"hold": true, "reason": "made-up"}')?.hold, false);
  assert.equal(parseGroundingVerdict("no json"), null);
});

test("hold page names the claim and says the draft was not sent", () => {
  const page = groundingHoldPage({ contactLabel: "Bharath", inbound: "Showtime today??", draft: "not today, sep 10 is the big day", verdict: { hold: true, reason: "date-assertion", quote: "sep 10", source: "backstop" } });
  assert.match(page, /^⚠️ HELD — Bharath asked about timing/);
  assert.match(page, /I have NOT replied/);
  assert.match(page, /sep 10/);
});
