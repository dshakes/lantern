// Unit tests for canonicalHandle — the cross-channel bucket key.
//
// Semantics under test:
//   - phone-like handles (raw, +E.164, WhatsApp/iMessage jids) collapse to
//     digits-only, with US numbers promoted to the "1" country code so the
//     same human on WhatsApp vs iMessage shares ONE bucket.
//   - email handles lowercase, kept as-is.
//   - "@lid" (WhatsApp privacy id) and "@g.us" (group) are NOT
//     phone-canonicalizable — they must survive verbatim, never mangled.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { canonicalHandle } from "./canonical-handle.ts";

test("WhatsApp phone jid and iMessage phone collapse to the same key", () => {
  const wa = canonicalHandle("15125551234@s.whatsapp.net");
  const im = canonicalHandle("+15125551234");
  assert.equal(wa, "15125551234");
  assert.equal(im, "15125551234");
  assert.equal(wa, im); // same person, one bucket
});

test("US national 10-digit promotes to +1 form and matches the jid", () => {
  assert.equal(canonicalHandle("5125551234"), "15125551234");
  assert.equal(canonicalHandle("(512) 555-1234"), "15125551234");
  assert.equal(canonicalHandle("5125551234@c.us"), "15125551234");
});

test("international number keeps its country code (no US promotion)", () => {
  assert.equal(canonicalHandle("+91 94936 78486"), "919493678486");
  assert.equal(canonicalHandle("919493678486@s.whatsapp.net"), "919493678486");
  assert.equal(canonicalHandle("919493678486"), "919493678486");
});

test("email handle lowercases and is kept as-is", () => {
  assert.equal(canonicalHandle("Alice@Example.com"), "alice@example.com");
  // iMessage email handle.
  assert.equal(canonicalHandle("bob.smith@icloud.com"), "bob.smith@icloud.com");
});

test("@lid privacy id is NOT phone-canonicalized (verbatim, lowercased suffix)", () => {
  const lid = canonicalHandle("84729130000000@lid");
  assert.equal(lid, "84729130000000@lid");
  // Critically: must NOT collapse to a bare digit phone bucket.
  assert.notEqual(lid, "84729130000000");
});

test("@g.us group id is NOT phone-canonicalized (verbatim)", () => {
  const grp = canonicalHandle("120363012345678901@g.us");
  assert.equal(grp, "120363012345678901@g.us");
  assert.notEqual(grp, "120363012345678901");
});

test("opaque / non-phone tokens fall through to trimmed lowercase", () => {
  assert.equal(canonicalHandle("  SelfChat  "), "selfchat");
  assert.equal(canonicalHandle("not-a-number"), "not-a-number");
});

test("empty / whitespace input is returned as-is (no throw)", () => {
  assert.equal(canonicalHandle(""), "");
  assert.equal(canonicalHandle("   "), "");
  // @ts-expect-error — exercising the null-safe path.
  assert.equal(canonicalHandle(undefined), "");
});
