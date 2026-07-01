// Note-save id fidelity: the saved document number must be the id as READ from
// the source, never the LLM's re-transcription (O↔0, 1↔l corruption).
//   cd packages/bridge-core && npx tsx --test src/humanize-note-id.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectOfferInReply } from "./humanize.ts";

const OFFER = "your passport number is B0123456. want me to save this as a note for easy access?";

test("prefers the id from the raw source over the LLM's transcription", () => {
  // The LLM wrote "B0123456" but the raw doc actually reads "BО123456"-style —
  // here the source has the true "B0123456" (zero). Source wins.
  const raw = "PASSPORT No. B0123456  UNITED STATES OF AMERICA";
  const offer = detectOfferInReply(OFFER.replace("B0123456", "BO123456"), undefined, raw);
  assert.ok(offer && offer.kind === "save-note");
  assert.match(offer!.noteBody ?? "", /B0123456/, "should store the id from the source, not the reply");
  assert.ok(!/BO123456/.test(offer!.noteBody ?? ""), "must not store the mis-transcribed reply id");
});

test("stores the reply id verbatim when no raw source is threaded in", () => {
  const offer = detectOfferInReply(OFFER);
  assert.ok(offer && offer.kind === "save-note");
  assert.match(offer!.noteBody ?? "", /B0123456/, "verbatim id preserved, not reformatted");
});
