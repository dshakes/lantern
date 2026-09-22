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

test("a freeform message landing right after the draft was staged is NOT a replacement — the owner couldn't have read it yet", () => {
  // 11ms after issuedAt: reproduces the real incident — an unrelated self-chat
  // message about business ops got auto-forwarded to a contact as a "reply"
  // to a draft staged a moment earlier.
  assert.equal(classifyPendingReply("morning, those are auto-nudges not real tasks", textDraft, false, 11), "none");
});

test("a freeform message well after the dwell window still replaces (deliberate rewrite)", () => {
  assert.equal(classifyPendingReply("tell them I'll be 10 min late", textDraft, false, 5000), "replace");
});

test("approve/reject are never gated by dwell time — a quick 👍 still fires immediately", () => {
  assert.equal(classifyPendingReply("send", textDraft, false, 0), "approve");
  assert.equal(classifyPendingReply("no", textDraft, false, 0), "reject");
});

test("doc-relay is never replaced by free text (only send/no act on it)", () => {
  assert.equal(classifyPendingReply("actually never mind the wording", docRelay, false), "none");
  assert.equal(classifyPendingReply("what time is it", docRelay, true), "none");
});
