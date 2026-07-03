// REGRESSION: the SDK must send the control-plane's camelCase wire contract.
// rest.go CreateRun decodes `json:"agentName"` — the SDK shipped `agent_name`
// for a while, which the handler silently dropped (runs created with an empty
// agent). Locks the body field names against drift.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternClient } from "../src/client.js";

describe("runs.create wire contract", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "run-1", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends agentName (camelCase), never agent_name", async () => {
    const client = new LanternClient({ apiKey: "k", baseUrl: "http://localhost:9" });
    await client.runs.create({ agent: "support-triage", input: { q: "hi" } });

    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mock.mock.calls[0][1].body as string);
    expect(body.agentName).toBe("support-triage");
    expect(body).not.toHaveProperty("agent_name");
    expect(body.input).toEqual({ q: "hi" });
  });
});
