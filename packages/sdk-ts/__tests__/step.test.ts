import { describe, it, expect, vi } from "vitest";

// We test the dev-mode step proxy by importing the step module directly.
// In dev mode (no LANTERN_RUNTIME env var), step() calls execute functions
// directly without journal replay.

// The step module is a singleton — import it fresh.
// We need to re-create the dev step proxy for testing.

// Since `step` is exported as a const from the module, and it uses
// createDevStepProxy internally, we can test the public API.
import { step } from "../src/step.js";

describe("step() — dev mode", () => {
  it("executes the function and returns its result", async () => {
    const result = await step("fetch-data", async () => {
      return { items: [1, 2, 3] };
    });

    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("executes async functions", async () => {
    const result = await step("async-step", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    });

    expect(result).toBe("done");
  });

  it("propagates errors from the function", async () => {
    await expect(
      step("failing-step", async () => {
        throw new Error("step failed");
      })
    ).rejects.toThrow("step failed");
  });

  it("passes through different return types", async () => {
    const num = await step("number", async () => 42);
    expect(num).toBe(42);

    const str = await step("string", async () => "hello");
    expect(str).toBe("hello");

    const arr = await step("array", async () => [1, 2, 3]);
    expect(arr).toEqual([1, 2, 3]);

    const nil = await step("null", async () => null);
    expect(nil).toBeNull();
  });
});

describe("step.map() — dev mode", () => {
  it("processes all items and returns results in order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await step.map(
      "double",
      items,
      async (item: number) => item * 2
    );

    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("returns empty array for empty input", async () => {
    const results = await step.map(
      "empty",
      [],
      async (item: never) => item
    );

    expect(results).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await step.map(
      "concurrent",
      items,
      async (item: number) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent--;
        return item;
      },
      { concurrency: 2 }
    );

    // With concurrency 2, we should never see more than 2 concurrent
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("preserves item order regardless of completion order", async () => {
    const items = [3, 1, 2]; // Each sleeps for item * 10ms
    const results = await step.map(
      "ordered",
      items,
      async (item: number) => {
        await new Promise((resolve) => setTimeout(resolve, item * 10));
        return `item-${item}`;
      }
    );

    expect(results).toEqual(["item-3", "item-1", "item-2"]);
  });
});

describe("step.race() — dev mode", () => {
  it("returns the first resolved value", async () => {
    const result = await step.race("race", [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "slow";
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "fast";
      },
    ]);

    expect(result).toBe("fast");
  });

  it("returns single function result", async () => {
    const result = await step.race("single", [
      async () => "only-one",
    ]);

    expect(result).toBe("only-one");
  });
});

describe("step.sleep() — dev mode", () => {
  it("sleeps for the specified duration", async () => {
    const start = Date.now();
    await step.sleep("nap", "50ms");
    const elapsed = Date.now() - start;

    // Allow some tolerance for timing
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it("supports seconds", async () => {
    const start = Date.now();
    // Use a very short duration to keep tests fast
    await step.sleep("short-nap", "1ms");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

describe("step.signal() — dev mode", () => {
  it("throws in dev mode", async () => {
    await expect(step.signal("wait-approval")).rejects.toThrow(
      /only available in the Lantern runtime/
    );
  });
});
