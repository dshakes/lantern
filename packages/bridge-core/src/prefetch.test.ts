// Regression tests for appointment-intent detection.
//
// The "when is my green card expiring" query (a personal-DOCS lookup) was
// matching the broad "when is my ..." appointment pattern and pulling a full
// calendar dump into the LLM prompt — context bloat that blew the OpenAI TPM
// budget and leaked a raw error to the owner. Identity-document/expiry
// lookups must NOT be treated as calendar-appointment queries.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { looksLikeAppointmentQuery } from "./prefetch.ts";

const NOT_APPOINTMENTS = [
  "when is my green card expiring",
  "when does my passport expire",
  "when does my license expire",
  "when's my visa expiration",
  "when is my insurance policy expiring",
  "when does my work permit expire",
];

const ARE_APPOINTMENTS = [
  "when is my doctor appointment",
  "when is my next haircut",
  "when is my visa interview appointment", // doc word BUT explicit appointment noun
  "do I have any meetings tomorrow",
  "when is my flight",
];

test("prefetch: identity-document expiry queries are NOT appointment queries", () => {
  for (const q of NOT_APPOINTMENTS) {
    assert.equal(looksLikeAppointmentQuery(q), false, `expected NOT appointment: ${JSON.stringify(q)}`);
  }
});

test("prefetch: real appointment queries still detected", () => {
  for (const q of ARE_APPOINTMENTS) {
    assert.equal(looksLikeAppointmentQuery(q), true, `expected appointment: ${JSON.stringify(q)}`);
  }
});
