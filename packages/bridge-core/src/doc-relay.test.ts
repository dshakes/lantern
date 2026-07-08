// Tests for the doc-relay owner ping — the LLM writes the natural lead, code
// guarantees the confirm affordance and a truthful fallback.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildDocRelayPrompt, finalizeDocRelayPing, docNotFoundPing, docMatchesRequest, docMismatchPing } from "./doc-relay.ts";

test("docMatchesRequest: THE bug — 'aadhaar card' must NOT match Shekhar_PAN_Card.pdf", () => {
  assert.equal(docMatchesRequest("Shekhar's aadhaar card", "Shekhar_PAN_Card.pdf"), false);
});

test("docMatchesRequest: right file matches", () => {
  assert.equal(docMatchesRequest("Shekhar's aadhaar card", "Shekhar-Aadhaar - Oct 1 2020.pdf"), true);
  assert.equal(docMatchesRequest("PAN card", "Shekhar_PAN_Card.pdf"), true);
  assert.equal(docMatchesRequest("green card copy", "Shekhar-GreenCard.pdf"), true);
  assert.equal(docMatchesRequest("passport", "Manasa_Passport_2023.pdf"), true);
});

test("docMatchesRequest: distinct person — wrong person's doc doesn't match", () => {
  // "manasa aadhaar" must not pass a Shekhar aadhaar file
  assert.equal(docMatchesRequest("Manasa aadhaar", "Shekhar-Aadhaar.pdf"), false);
});

test("docMatchesRequest: word-boundary — 'pan' must NOT match 'japan_trip.pdf'", () => {
  assert.equal(docMatchesRequest("PAN card", "japan_trip.pdf"), false);
  assert.equal(docMatchesRequest("PAN card", "Shekhar_PAN_card.pdf"), true);
  assert.equal(docMatchesRequest("visa", "advisage_notes.pdf"), false);
});

test("docMatchesRequest: all-generic request can't confirm a file", () => {
  assert.equal(docMatchesRequest("send me a copy please", "Shekhar_PAN_Card.pdf"), false);
});

test("docMismatchPing refuses to send + names the closest", () => {
  const m = docMismatchPing({ contactLabel: "Manasa", request: "aadhaar card", closest: "Shekhar_PAN_Card.pdf" });
  assert.match(m, /couldn't find an exact match/);
  assert.match(m, /Shekhar_PAN_Card\.pdf/);
  assert.match(m, /won't send the wrong document/);
});

const ctx = {
  ownerName: "Shekhar",
  contactLabel: "Manasa",
  relationship: "wife",
  request: "PAN card",
  fileName: "Shekhar_PAN_Card.pdf",
  folder: "I-485/Shekhar",
};

test("prompt carries who/relationship/request/file/folder and forbids a CTA", () => {
  const p = buildDocRelayPrompt(ctx);
  assert.match(p, /Manasa/);
  assert.match(p, /wife/);
  assert.match(p, /PAN card/);
  assert.match(p, /Shekhar_PAN_Card\.pdf/);
  assert.match(p, /I-485\/Shekhar/);
  assert.match(p, /Do NOT ask a question/i);
});

test("finalize uses the LLM lead + always appends the confirm affordance", () => {
  const out = finalizeDocRelayPing("manasa wants your pan card — found Shekhar_PAN_Card.pdf in your i-485 folder", ctx);
  assert.match(out, /^📄 manasa wants your pan card/);
  assert.match(out, /send it to Manasa\? reply "send" or "no"\.$/);
});

test("finalize falls back to a truthful line when the LLM returns nothing", () => {
  const out = finalizeDocRelayPing("", ctx);
  assert.match(out, /Manasa \(your wife\) asked for your PAN card — found Shekhar_PAN_Card\.pdf/);
  assert.match(out, /reply "send" or "no"/);
});

test("finalize rejects self-narrating / overlong junk and falls back", () => {
  assert.match(finalizeDocRelayPing("As an AI, I have located the document you requested", ctx), /asked for your PAN card/);
  assert.match(finalizeDocRelayPing("x".repeat(300), ctx), /asked for your PAN card/);
});

test("finalize takes only the first non-empty line", () => {
  const out = finalizeDocRelayPing("\n\nmanasa wants the pan card, found it\nreply send\n", ctx);
  assert.match(out, /^📄 manasa wants the pan card, found it\n/);
});

test("not-found ping is honest — never claims to have the file", () => {
  const out = docNotFoundPing({ contactLabel: "Manasa", request: "PAN card" });
  assert.match(out, /couldn't find it/);
  assert.doesNotMatch(out, /found/);
});
