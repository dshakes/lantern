import { describe, it, expect, vi } from "vitest";
import * as sdk from "../src/index.js";
import * as rt from "../src/runtime/index.js";
import { PalClient, PalApiError } from "../src/client.js";

describe("deprecated Lantern* aliases (ADR 0032)", () => {
  it("client aliases are the same objects", () => {
    expect(sdk.LanternClient).toBe(PalClient);
    expect(sdk.LanternApiError).toBe(PalApiError);
    expect(new PalApiError(500, "x")).toBeInstanceOf(sdk.LanternApiError);
    expect(new PalApiError(500, "x").name).toBe("PalApiError");
  });

  it("runtime error + runtime aliases are the same objects from both entry points", () => {
    const names = ["Error", "GrpcError", "StepError", "LlmError", "LlmJsonError", "ToolError", "MemoryError", "ConnectorError", "TimeoutError", "CancelledError", "Runtime"] as const;
    for (const n of names) {
      expect((sdk as Record<string, unknown>)[`Lantern${n}`]).toBe((sdk as Record<string, unknown>)[`Pal${n}`]);
      expect((rt as Record<string, unknown>)[`Lantern${n}`]).toBe((rt as Record<string, unknown>)[`Pal${n}`]);
    }
    expect(new rt.PalToolError("t", "m")).toBeInstanceOf(rt.LanternError);
  });

  it("readFile honours X-Pal-Truncated and the legacy X-Lantern-Truncated", async () => {
    const client = new PalClient({ baseUrl: "http://x", apiKey: "k" });
    for (const [h, want] of [["X-Pal-Truncated", true], ["X-Lantern-Truncated", true], ["X-Other", false]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a", { status: 200, headers: { [h]: "true" } })));
      expect((await client.runtime.readFile("vm1", "f")).truncated).toBe(want);
    }
    vi.unstubAllGlobals();
  });
});
