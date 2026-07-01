import { describe, it, expect } from "vitest";
import { buildGroundingContract } from "../src/runtime/llm-client.js";

describe("buildGroundingContract", () => {
  it("embeds the ground-or-abstain rule and enumerates sources", () => {
    const c = buildGroundingContract(["invoice #A-102 total $59.40", "due 2026-07-15"]);
    expect(c).toMatch(/GROUND-OR-ABSTAIN/);
    expect(c).toMatch(/never as fact/i);
    expect(c).toMatch(/\[1\] invoice #A-102/);
    expect(c).toMatch(/\[2\] due 2026-07-15/);
  });

  it("says '(none provided)' when there are no sources — model must abstain", () => {
    const c = buildGroundingContract([]);
    expect(c).toMatch(/\(none provided\)/);
    expect(c).toMatch(/say you don't know/i);
  });
});
