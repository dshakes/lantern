import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relationshipInferPrompt, parseRelationshipInference, shouldInferRelationship, InferredRelationshipStore, inferredRelationshipLabel, inferredRelationshipFyi, INFER_TTL_MS } from "./relationship-infer.ts";

test("prompt is grounded in the thread and the owner's own label style; parse is strict and never trusts a name", () => {
  const p = relationshipInferPrompt({ ownerName: "Shekhar", contactName: "Satthi", transcript: "They: bava, harika number send\nYou: sare", knownLabels: ["brother", "college friend"] });
  assert.match(p, /bava = brother-in-law/);
  assert.match(p, /brother, college friend/);
  assert.deepEqual(parseRelationshipInference('{"relationship":"Brother-in-law","confidence":0.9,"evidence":"bava, harika number send"}'), { label: "brother-in-law", confidence: 0.9, evidence: "bava, harika number send" });
  assert.equal(parseRelationshipInference('{"relationship":"unknown","confidence":0.2}'), null);
  assert.equal(parseRelationshipInference("nope"), null);
});

test("inference is asked only with enough thread, then cached for a week or 20 more inbounds", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldInferRelationship(undefined, 3, 3, now), false);
  assert.equal(shouldInferRelationship(undefined, 8, 8, now), true);
  const cached = { label: "cousin", confidence: 0.8, evidence: "", ts: now - 1000, inboundCount: 8 };
  assert.equal(shouldInferRelationship(cached, 9, 9, now), false);
  assert.equal(shouldInferRelationship(cached, 40, 30, now), true, "20 more inbounds");
  assert.equal(shouldInferRelationship(cached, 9, 9, now + INFER_TTL_MS + 1), true, "a week later");
});

test("the store round-trips 0600 and the persona label is explicit about being unconfirmed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rel-")), "inferred-relationships.json");
  const s = new InferredRelationshipStore(path);
  s.set("+15551", { label: "cousin", confidence: 0.85, evidence: "x", ts: 1, inboundCount: 8 });
  const s2 = new InferredRelationshipStore(path);
  assert.equal(s2.get("+15551")?.label, "cousin");
  assert.match(inferredRelationshipLabel(s2.get("+15551")) ?? "", /^cousin \(inferred from the thread, unconfirmed/);
  assert.equal(inferredRelationshipLabel({ label: "vendor", confidence: 0.5, evidence: "", ts: 1, inboundCount: 1 }), undefined, "below the floor → nothing");
  assert.match(inferredRelationshipFyi("Ravi", s2.get("+15551")!), /^🧭 I think Ravi is your cousin/);
});
