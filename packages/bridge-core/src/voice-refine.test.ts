//   cd packages/bridge-core && npx tsx --test src/voice-refine.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildRefinePrompt, parseRefine } from "./voice-refine.ts";

test("the prompt grounds the edit in the owner's real messages and forbids new commitments", () => {
  const p = buildRefinePrompt({ ownerName: "Shekhar", draft: "Sure! I will check and get back to you.", inbound: "did you see it?", exemplars: ["ha will check", "sare cheptha 👍"] });
  assert.match(p, /1\. ha will check/);
  assert.match(p, /do not add new promises/);
  assert.match(p, /Output ONLY the message text/);
});

test("parseRefine returns a sendable message or nothing", () => {
  const draft = "Sure! I will check and get back to you.";
  assert.equal(parseRefine("ha will check and tell you", draft), "ha will check and tell you");
  assert.equal(parseRefine('"ha will check"', draft), "ha will check");
  assert.equal(parseRefine("```\nha will check\n```", draft), "ha will check");
  assert.equal(parseRefine("Rewritten: ha will check", draft), "ha will check");
  assert.equal(parseRefine("", draft), null);
  assert.equal(parseRefine('{"text":"ha"}', draft), null);
  assert.equal(parseRefine("Here is the rewritten message:\nha will check", draft), null);
  assert.equal(parseRefine("x".repeat(400), draft), null, "a paragraph is not a refinement of a one-liner");
});
