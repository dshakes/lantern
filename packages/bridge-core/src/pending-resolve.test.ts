import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildPendingResolvePrompt, parsePendingResolution, type PendingDescriptor } from "./pending-resolve.ts";

const pendings: PendingDescriptor[] = [
  { id: "owner::+1a", kind: "doc", target: "Bhavik", summary: "Shekhar_PAN_Card.pdf" },
  { id: "owner::+1b", kind: "text", target: "Chinna", summary: "running late" },
];

test("prompt lists each staged action with id, kind, target, summary", () => {
  const p = buildPendingResolvePrompt(pendings, "send");
  assert.match(p, /id=owner::\+1a/);
  assert.match(p, /Shekhar_PAN_Card\.pdf/);
  assert.match(p, /Bhavik/);
  assert.match(p, /the text "running late" to Chinna/);
  assert.match(p, /"decision":"ask"/);
});

test("parse: send with a valid id", () => {
  assert.deepEqual(parsePendingResolution('{"decision":"send","id":"owner::+1a"}', ["owner::+1a", "owner::+1b"]), {
    decision: "send",
    id: "owner::+1a",
  });
});

test("parse: reject with a valid id", () => {
  assert.deepEqual(parsePendingResolution('sure: {"decision":"reject","id":"owner::+1b"}', ["owner::+1a", "owner::+1b"]), {
    decision: "reject",
    id: "owner::+1b",
  });
});

test("parse: ask carries the question", () => {
  const r = parsePendingResolution('{"decision":"ask","question":"the PAN to Bhavik or the text to Chinna?"}', ["owner::+1a"]);
  assert.equal(r.decision, "ask");
  assert.match((r as any).question, /Bhavik/);
});

test("parse: SAFETY — unknown/blank id degrades to ask, never fires the wrong one", () => {
  assert.equal(parsePendingResolution('{"decision":"send","id":"nope"}', ["owner::+1a"]).decision, "ask");
  assert.equal(parsePendingResolution('{"decision":"send"}', ["owner::+1a"]).decision, "ask");
});

test("parse: junk / no JSON → none", () => {
  assert.deepEqual(parsePendingResolution("uhh not sure", ["owner::+1a"]), { decision: "none" });
  assert.deepEqual(parsePendingResolution("", ["owner::+1a"]), { decision: "none" });
});
