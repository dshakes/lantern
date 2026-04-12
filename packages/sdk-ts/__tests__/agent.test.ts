import { describe, it, expect } from "vitest";
import { agent } from "../src/agent.js";

describe("agent()", () => {
  it("returns a frozen config for valid input", () => {
    const config = agent({
      name: "my-agent",
      run: async () => ({ result: "ok" }),
    });

    expect(config.name).toBe("my-agent");
    expect(typeof config.run).toBe("function");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("preserves optional fields", () => {
    const config = agent({
      name: "test-agent",
      version: "1.2.3",
      description: "A test agent",
      model: "reasoning-large",
      labels: { env: "test" },
      run: async () => ({}),
    });

    expect(config.version).toBe("1.2.3");
    expect(config.description).toBe("A test agent");
    expect(config.model).toBe("reasoning-large");
    expect(config.labels).toEqual({ env: "test" });
  });

  // --- Name validation ---

  it("throws for empty name", () => {
    expect(() =>
      agent({ name: "", run: async () => ({}) })
    ).toThrow(/Agent name must match/);
  });

  it("throws for uppercase name", () => {
    expect(() =>
      agent({ name: "MyAgent", run: async () => ({}) })
    ).toThrow(/Agent name must match/);
  });

  it("throws for name with spaces", () => {
    expect(() =>
      agent({ name: "my agent", run: async () => ({}) })
    ).toThrow(/Agent name must match/);
  });

  it("throws for name with underscores", () => {
    expect(() =>
      agent({ name: "my_agent", run: async () => ({}) })
    ).toThrow(/Agent name must match/);
  });

  it("throws for name longer than 63 chars", () => {
    const longName = "a".repeat(64);
    expect(() =>
      agent({ name: longName, run: async () => ({}) })
    ).toThrow(/Agent name must match/);
  });

  it("accepts 63-char name", () => {
    const name = "a".repeat(63);
    const config = agent({ name, run: async () => ({}) });
    expect(config.name).toBe(name);
  });

  it("accepts name with hyphens and numbers", () => {
    const config = agent({
      name: "my-agent-v2",
      run: async () => ({}),
    });
    expect(config.name).toBe("my-agent-v2");
  });

  // --- Run function validation ---

  it("throws when run is missing", () => {
    expect(() =>
      // @ts-expect-error testing missing run
      agent({ name: "test" })
    ).toThrow(/Agent must have a run function/);
  });

  it("throws when run is not a function", () => {
    expect(() =>
      // @ts-expect-error testing non-function run
      agent({ name: "test", run: "not-a-function" })
    ).toThrow(/Agent must have a run function/);
  });
});
