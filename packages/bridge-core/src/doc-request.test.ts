// Tests for the [DOCREQ:...] contact-path marker — a contact asking the owner
// for a document. The bridge strips it, replies intent-only, and surfaces the
// ask to the owner for confirm-then-send.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractDocRequests } from "./mac-actions.ts";

test("parses a doc request and strips the marker", () => {
  const r = extractDocRequests("yeah, let me grab it and send it over.\n[DOCREQ:PAN card copy]");
  assert.deepEqual(r.docRequests, ["PAN card copy"]);
  assert.equal(r.cleanedText, "yeah, let me grab it and send it over.");
  assert.ok(!r.cleanedText.includes("[DOCREQ"));
});

test("handles multiple doc requests", () => {
  const r = extractDocRequests("[DOCREQ:passport]\n[DOCREQ:driver license]");
  assert.deepEqual(r.docRequests, ["passport", "driver license"]);
});

test("skips an empty marker", () => {
  const r = extractDocRequests("sure[DOCREQ: ]");
  assert.equal(r.docRequests.length, 0);
  assert.equal(r.cleanedText, "sure");
});

test("no marker → empty list, text untouched", () => {
  const r = extractDocRequests("on my way, see you soon");
  assert.equal(r.docRequests.length, 0);
  assert.equal(r.cleanedText, "on my way, see you soon");
});
