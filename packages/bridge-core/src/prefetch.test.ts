// Regression tests for appointment-intent detection.
//
// The "when is my green card expiring" query (a personal-DOCS lookup) was
// matching the broad "when is my ..." appointment pattern and pulling a full
// calendar dump into the LLM prompt — context bloat that blew the OpenAI TPM
// budget and leaked a raw error to the owner. Identity-document/expiry
// lookups must NOT be treated as calendar-appointment queries.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { looksLikeAppointmentQuery, prefetchAppointmentContext } from "./prefetch.ts";
import type { ConnectorClient } from "./prefetch.ts";

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

// Mock logger — satisfies the pino Logger interface for testing (type-only import in prefetch.ts).
const noopLogger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } as never;

// Unrelated appointment email: subject/from say nothing about colonoscopy.
// Query uses "when is my ..." which triggers looksLikeAppointmentQuery.
test("prefetch: unrelated-provider appointment email is NOT cited — returns hedged form", async () => {
  const client: ConnectorClient = {
    execute: async (id) => {
      if (id === "gmail") {
        return {
          data: {
            messages: [{
              from: "noreply@genericdoctor.com",
              subject: "Your appointment is confirmed",
              snippet: "You have an upcoming appointment with us.",
              date: new Date().toISOString(),
            }],
          },
        };
      }
      return { data: { items: [] } }; // empty calendar
    },
  };
  const result = await prefetchAppointmentContext(client, "when is my colonoscopy?", noopLogger);
  assert.ok(result !== null, "should return context block, not null");
  assert.match(result!, /found some appointment emails but none from a relevant provider/i);
});

// Matching appointment email: subject explicitly names the procedure.
test("prefetch: matching-provider appointment email IS cited as the answer", async () => {
  const client: ConnectorClient = {
    execute: async (id) => {
      if (id === "gmail") {
        return {
          data: {
            messages: [{
              from: "scheduling@gastrogroup.com",
              subject: "Your Colonoscopy Appointment Confirmation",
              snippet: "Your colonoscopy is scheduled for July 15 at 8am.",
              date: new Date().toISOString(),
            }],
          },
        };
      }
      return { data: { items: [] } };
    },
  };
  const result = await prefetchAppointmentContext(client, "when is my colonoscopy?", noopLogger);
  assert.ok(result !== null, "should return context block");
  assert.match(result!, /Colonoscopy/i, "specific email should be cited");
  assert.doesNotMatch(result!, /found some appointment emails but none from a relevant provider/i);
});
