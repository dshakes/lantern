import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { parseAgentMessageFrame } from "./agent.ts";

// The SSE frame → TurnResult seam that carries the control-plane's optional
// docText (id ground truth) to respondToWithSources. See humanizeWithOffer.
describe("parseAgentMessageFrame", () => {
  test("returns docText when the server sent it (doc-query turn)", () => {
    const frame = JSON.stringify({
      type: "agent.message",
      data: { content: "your passport is A1234567", docText: "Passport No: A1234567\nExp 2031" },
    });
    const r = parseAgentMessageFrame(frame);
    assert.deepEqual(r, { text: "your passport is A1234567", docText: "Passport No: A1234567\nExp 2031" });
  });

  test("docText undefined when the field is absent (normal reply turn)", () => {
    const frame = JSON.stringify({ type: "agent.message", data: { content: "sounds good" } });
    const r = parseAgentMessageFrame(frame);
    assert.equal(r?.text, "sounds good");
    assert.equal(r?.docText, undefined);
  });

  test("docText undefined when the server sent an empty string", () => {
    const frame = JSON.stringify({ type: "agent.message", data: { content: "hi", docText: "" } });
    assert.equal(parseAgentMessageFrame(frame)?.docText, undefined);
  });

  test("returns null for non-agent.message events", () => {
    assert.equal(parseAgentMessageFrame(JSON.stringify({ type: "agent.thinking", data: {} })), null);
  });

  test("returns null for malformed JSON", () => {
    assert.equal(parseAgentMessageFrame("{not json"), null);
  });
});
