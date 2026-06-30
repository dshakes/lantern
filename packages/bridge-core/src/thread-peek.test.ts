import { test } from "node:test";
import { strict as assert } from "node:assert";
import { looksLikeThreadPeek } from "./thread-peek.ts";

// ---- positive cases -------------------------------------------------------

test("see messages from Manu", () => {
  assert.deepEqual(looksLikeThreadPeek("see messages from Manu"), {
    contact: "Manu",
  });
});

test("show me what Arun said", () => {
  assert.deepEqual(looksLikeThreadPeek("show me what Arun said"), {
    contact: "Arun",
  });
});

test("check my texts with Sarika", () => {
  assert.deepEqual(looksLikeThreadPeek("check my texts with Sarika"), {
    contact: "Sarika",
  });
});

test("catch me up on Raju's messages", () => {
  assert.deepEqual(looksLikeThreadPeek("catch me up on Raju's messages"), {
    contact: "Raju",
  });
});

test("read the latest from mom", () => {
  assert.deepEqual(looksLikeThreadPeek("read the latest from mom"), {
    contact: "mom",
  });
});

// extra coverage
test("show me messages from dad", () => {
  assert.deepEqual(looksLikeThreadPeek("show me messages from dad"), {
    contact: "dad",
  });
});

test("get messages from Priya", () => {
  assert.deepEqual(looksLikeThreadPeek("get messages from Priya"), {
    contact: "Priya",
  });
});

test("what did Kiran say", () => {
  assert.deepEqual(looksLikeThreadPeek("what did Kiran say"), {
    contact: "Kiran",
  });
});

// ---- negative cases -------------------------------------------------------

test("send a message to Sam → null", () => {
  assert.equal(looksLikeThreadPeek("send a message to Sam"), null);
});

test("what did the meeting cover → null", () => {
  assert.equal(looksLikeThreadPeek("what did the meeting cover"), null);
});

test("message Arun that I'll be late → null", () => {
  assert.equal(looksLikeThreadPeek("message Arun that I'll be late"), null);
});

test("news openai → null", () => {
  assert.equal(looksLikeThreadPeek("news openai"), null);
});

test("text Sam happy birthday → null", () => {
  assert.equal(looksLikeThreadPeek("text Sam happy birthday"), null);
});

test("empty string → null", () => {
  assert.equal(looksLikeThreadPeek(""), null);
});

// ---- adversarial ----------------------------------------------------------

test("'what did you say' → null (pronoun, not a contact)", () => {
  assert.equal(looksLikeThreadPeek("what did you say"), null);
  assert.equal(looksLikeThreadPeek("what did i say"), null);
});

test("send-intents stay null even with a name", () => {
  assert.equal(looksLikeThreadPeek("forward Arun the address"), null);
  assert.equal(looksLikeThreadPeek("reply to Sam that I'm in"), null);
});

test("generic 'what did the meeting decide' → null", () => {
  assert.equal(looksLikeThreadPeek("what did the meeting decide"), null);
});
