// Retry/backoff behavior for PalClient's private fetch: 429/503 and
// network errors are retried with bounded exponential backoff; 4xx
// auth/validation errors are never retried.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PalClient, PalApiError } from "../src/client.js";

describe("PalClient retry", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("retries once on 503 then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("service unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ id: "a1", name: "triage" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new PalClient({ apiKey: "k", baseUrl: "http://localhost:9" });
    const agent = await client.agents.get("triage");

    expect(calls).toBe(2);
    expect(agent).toEqual({ id: "a1", name: "triage" });
  });

  it("does not retry on 400", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    });

    const client = new PalClient({ apiKey: "k", baseUrl: "http://localhost:9" });
    await expect(client.agents.get("triage")).rejects.toBeInstanceOf(PalApiError);
    expect(calls).toBe(1);
  });

  it("exhausts retries and surfaces the last error as PalApiError", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return new Response("still down", { status: 503 });
    });

    const client = new PalClient({ apiKey: "k", baseUrl: "http://localhost:9" });
    await expect(client.agents.get("triage")).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3); // default maxAttempts = 3
  });
});
