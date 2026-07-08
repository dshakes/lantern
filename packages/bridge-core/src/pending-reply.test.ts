// Regression tests for classifyPendingReply — the confirm matrix that the
// owner-self-chat draft/SEND/doc-relay flow turns on. Two bugs this guards:
//   1) a bare "send" (the word the preview tells the owner to reply) must APPROVE
//      — looksLikeConfirmation() alone did not cover it.
//   2) on the DRAIN path (confirmOnly), a non-confirm must NOT be treated as a
//      replacement and blasted to a contact; it flows to the LLM instead.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyPendingReply } from "./humanize.ts";

const textDraft = { kind: undefined as string | undefined };
const docRelay = { kind: "doc-relay" };

test("bare 'send' approves (the confirm word the preview asks for)", () => {
  for (const w of ["send", "Send", "send it", "send now", "SEND.", "deliver"]) {
    assert.equal(classifyPendingReply(w, textDraft, false), "approve", w);
    assert.equal(classifyPendingReply(w, docRelay, true), "approve", `${w} (drain)`);
  }
});

test("standard confirmations still approve", () => {
  for (const w of ["yes", "yep", "ok", "do it", "go ahead"]) {
    assert.equal(classifyPendingReply(w, textDraft, false), "approve", w);
  }
});

test("rejections reject on both paths", () => {
  for (const w of ["no", "nope", "skip", "cancel"]) {
    assert.equal(classifyPendingReply(w, textDraft, false), "reject", w);
    assert.equal(classifyPendingReply(w, docRelay, true), "reject", `${w} (drain)`);
  }
});

test("'send Raju hi' is a fresh request, NOT a bare confirm", () => {
  // live: treated as a free-text replacement; drain: flows to LLM
  assert.equal(classifyPendingReply("send Raju hi", textDraft, false), "replace");
  assert.equal(classifyPendingReply("send Raju hi", textDraft, true), "none");
});

test("DRAIN path never replaces — a queued free-text message flows to the LLM", () => {
  assert.equal(classifyPendingReply("what's the weather tomorrow", textDraft, true), "none");
});

test("LIVE path free-text becomes a replacement send", () => {
  assert.equal(classifyPendingReply("tell them I'll be 10 min late", textDraft, false), "replace");
});

test("doc-relay is never replaced by free text (only send/no act on it)", () => {
  assert.equal(classifyPendingReply("actually never mind the wording", docRelay, false), "none");
  assert.equal(classifyPendingReply("what time is it", docRelay, true), "none");
});
