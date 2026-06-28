// doc-ingest.test.ts — Unit tests for classifyDocForDomain and parseDocExtraction.
// Pure: no network, no file I/O, no LLM calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDocForDomain, parseDocExtraction } from "./doc-ingest.js";

// ── classifyDocForDomain ──────────────────────────────────────────────────────

describe("classifyDocForDomain — health", () => {
  it("classifies lab result", () => {
    assert.deepEqual(classifyDocForDomain("lab_result_2024.pdf"), { domain: "health", kind: "lab_result" });
  });
  it("classifies blood test", () => {
    const r = classifyDocForDomain("blood_test_cbc_jan2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "lab_result");
  });
  it("classifies prescription", () => {
    const r = classifyDocForDomain("Prescription_Metformin.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "prescription");
  });
  it("classifies EOB via snippet", () => {
    const r = classifyDocForDomain("insurance_doc.pdf", "Explanation of Benefit: BCBS claim...");
    assert.ok(r);
    assert.equal(r!.domain, "health");
  });
  it("classifies immunization record", () => {
    const r = classifyDocForDomain("immunization_record.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "immunization");
  });
  it("classifies insurance card", () => {
    const r = classifyDocForDomain("health_insurance_card.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "insurance");
  });
  it("classifies discharge summary", () => {
    const r = classifyDocForDomain("discharge_summary_2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "discharge_summary");
  });
});

describe("classifyDocForDomain — vehicle", () => {
  it("classifies vehicle registration", () => {
    const r = classifyDocForDomain("vehicle_registration_2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
    assert.equal(r!.kind, "registration");
  });
  it("classifies plain registration", () => {
    const r = classifyDocForDomain("registration.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
  });
  it("classifies auto insurance", () => {
    const r = classifyDocForDomain("auto_insurance_geico.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
    assert.equal(r!.kind, "insurance");
  });
  it("classifies VIN title", () => {
    const r = classifyDocForDomain("VIN_title_doc.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
    assert.equal(r!.kind, "title");
  });
  it("classifies service record", () => {
    const r = classifyDocForDomain("oil_change_service_record.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
    assert.equal(r!.kind, "service_record");
  });
  it("classifies dmv", () => {
    const r = classifyDocForDomain("dmv_letter.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "vehicle");
    assert.equal(r!.kind, "dmv");
  });
});

describe("classifyDocForDomain — home", () => {
  it("classifies lease agreement", () => {
    const r = classifyDocForDomain("lease_agreement_2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "home");
    assert.equal(r!.kind, "lease");
  });
  it("classifies mortgage statement", () => {
    const r = classifyDocForDomain("mortgage_statement.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "home");
    assert.equal(r!.kind, "mortgage");
  });
  it("classifies HOA docs", () => {
    const r = classifyDocForDomain("HOA_docs_2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "home");
    assert.equal(r!.kind, "hoa");
  });
  it("classifies property tax", () => {
    const r = classifyDocForDomain("property_tax_2023.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "home");
    assert.equal(r!.kind, "tax");
  });
  it("classifies home insurance", () => {
    const r = classifyDocForDomain("homeowners_insurance_policy.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "home");
    assert.equal(r!.kind, "insurance");
  });
});

describe("classifyDocForDomain — travel", () => {
  it("classifies passport", () => {
    const r = classifyDocForDomain("passport_scan.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "travel");
    assert.equal(r!.kind, "passport");
  });
  it("classifies boarding pass", () => {
    const r = classifyDocForDomain("boarding_pass_DFW.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "travel");
    assert.equal(r!.kind, "boarding_pass");
  });
  it("classifies flight itinerary", () => {
    const r = classifyDocForDomain("flight_confirmation_AA123.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "travel");
    assert.equal(r!.kind, "itinerary");
  });
  it("classifies visa", () => {
    const r = classifyDocForDomain("US_visa_approval.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "travel");
    assert.equal(r!.kind, "visa");
  });
  it("classifies hotel reservation", () => {
    const r = classifyDocForDomain("hotel_reservation_Marriott.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "travel");
    assert.equal(r!.kind, "reservation");
  });
});

describe("classifyDocForDomain — career", () => {
  it("classifies resume", () => {
    const r = classifyDocForDomain("resume_2024.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "resume");
  });
  it("classifies offer letter", () => {
    const r = classifyDocForDomain("offer_letter_google.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "offer_letter");
  });
  it("classifies diploma", () => {
    const r = classifyDocForDomain("diploma_UT_Austin.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "certificate");
  });
  it("classifies transcript", () => {
    const r = classifyDocForDomain("official_transcript.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "transcript");
  });
  it("classifies certificate", () => {
    const r = classifyDocForDomain("aws_certification.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "certificate");
  });
  it("classifies W-2", () => {
    const r = classifyDocForDomain("w2_2023_employer.pdf");
    assert.ok(r);
    assert.equal(r!.domain, "career");
    assert.equal(r!.kind, "tax_doc");
  });
});

describe("classifyDocForDomain — negatives", () => {
  it("returns null for generic doc name", () => {
    assert.equal(classifyDocForDomain("document.pdf"), null);
  });
  it("returns null for photo", () => {
    assert.equal(classifyDocForDomain("IMG_1234.jpg"), null);
  });
  it("returns null for plain notes", () => {
    assert.equal(classifyDocForDomain("notes.txt"), null);
  });
  it("returns null for screenshot", () => {
    assert.equal(classifyDocForDomain("Screenshot 2024-01-01.png"), null);
  });
  it("returns null for untitled invoice (no snippet)", () => {
    assert.equal(classifyDocForDomain("invoice_untitled.docx"), null);
  });
  it("returns null when snippet is also generic", () => {
    assert.equal(classifyDocForDomain("doc.pdf", "Hello world, this is a test"), null);
  });
  it("matches via snippet when filename is generic", () => {
    const r = classifyDocForDomain("doc.pdf", "Your prescription for lisinopril 10mg");
    assert.ok(r);
    assert.equal(r!.domain, "health");
    assert.equal(r!.kind, "prescription");
  });
  it("returns null for empty filename", () => {
    assert.equal(classifyDocForDomain(""), null);
  });
});

// ── parseDocExtraction ────────────────────────────────────────────────────────

describe("parseDocExtraction", () => {
  it("parses clean JSON", () => {
    const json = JSON.stringify({
      records: [{ kind: "registration", title: "Tesla Model 3 2024", fields: { vin: "5YJ3E1..." }, validUntil: "2025-01-15" }],
      obligations: [{ title: "Renew registration by Jan 15 2025", dueDate: "2025-01-15", kind: "renewal" }],
    });
    const r = parseDocExtraction(json);
    assert.ok(r);
    assert.equal(r!.records.length, 1);
    assert.equal(r!.records[0].kind, "registration");
    assert.equal(r!.records[0].validUntil, "2025-01-15");
    assert.equal(r!.obligations.length, 1);
    assert.equal(r!.obligations[0].kind, "renewal");
  });

  it("parses fenced JSON (```json ... ```)", () => {
    const inner = JSON.stringify({ records: [{ kind: "lab_result", title: "CBC Panel" }], obligations: [] });
    const r = parseDocExtraction("```json\n" + inner + "\n```");
    assert.ok(r);
    assert.equal(r!.records[0].kind, "lab_result");
  });

  it("parses fenced JSON (``` ... ```)", () => {
    const inner = JSON.stringify({ records: [{ kind: "passport", title: "US Passport" }], obligations: [] });
    const r = parseDocExtraction("```\n" + inner + "\n```");
    assert.ok(r);
    assert.equal(r!.records[0].kind, "passport");
  });

  it("parses JSON with prose wrapper", () => {
    const inner = JSON.stringify({ records: [{ kind: "offer_letter", title: "Google SWE Offer" }], obligations: [] });
    const r = parseDocExtraction(`Here is the extracted data:\n${inner}\nLet me know if you need more.`);
    assert.ok(r);
    assert.equal(r!.records[0].kind, "offer_letter");
  });

  it("returns null for garbage input", () => {
    assert.equal(parseDocExtraction("not JSON at all"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseDocExtraction(""), null);
  });

  it("filters records missing required fields", () => {
    const json = JSON.stringify({
      records: [
        { kind: "passport", title: "US Passport" },       // valid
        { kind: "", title: "No kind" },                     // invalid: empty kind
        { kind: "visa", title: "" },                        // invalid: empty title
        { notKind: "x" },                                   // invalid: missing both
        null,                                               // invalid: null
      ],
      obligations: [],
    });
    const r = parseDocExtraction(json);
    assert.ok(r);
    assert.equal(r!.records.length, 1);
    assert.equal(r!.records[0].kind, "passport");
  });

  it("filters obligations missing required fields", () => {
    const json = JSON.stringify({
      records: [],
      obligations: [
        { title: "Renew passport", kind: "renewal" },  // valid
        { title: "", kind: "renewal" },                 // invalid: empty title
        { title: "Check", kind: "" },                   // invalid: empty kind
        { nope: true },                                  // invalid: missing fields
      ],
    });
    const r = parseDocExtraction(json);
    assert.ok(r);
    assert.equal(r!.obligations.length, 1);
  });

  it("returns empty arrays for empty sections", () => {
    const r = parseDocExtraction(JSON.stringify({ records: [], obligations: [] }));
    assert.ok(r);
    assert.equal(r!.records.length, 0);
    assert.equal(r!.obligations.length, 0);
  });

  it("tolerates missing obligations key", () => {
    const json = JSON.stringify({ records: [{ kind: "visa", title: "US Visa" }] });
    const r = parseDocExtraction(json);
    assert.ok(r);
    assert.equal(r!.records.length, 1);
    assert.equal(r!.obligations.length, 0);
  });
});
