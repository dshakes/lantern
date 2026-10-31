import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PalClient, PalApiError, asPolicyDenied, isVersionConflict } from "../src/client.js";
import type { AgentPolicy } from "../src/types.js";

const realFetch = globalThis.fetch;

function mockFetch(body: unknown = {}, status = 200) {
  globalThis.fetch = vi.fn().mockImplementation(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function lastCall() {
  const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

const policy: AgentPolicy = {
  mode: "enforce",
  tools: ["web_search"],
  connectors: { github: ["list_*"] },
  mcpServers: [],
  egressHosts: [],
  a2aTargets: [],
  a2aInbound: [],
  secrets: [],
  budget: { maxToolCallsPerRun: 50, maxA2AInboundPerMinute: 30 },
  version: 3,
};

describe("agent identity + policy", () => {
  let client: PalClient;
  beforeEach(() => {
    mockFetch();
    client = new PalClient({ apiKey: "k", baseUrl: "http://localhost:9" });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("getPolicy / putPolicy hit the policy path with the version in the body", async () => {
    await client.agents.getPolicy("my agent");
    expect(lastCall().url).toBe("http://localhost:9/v1/agents/my%20agent/policy");
    await client.agents.putPolicy("a", policy);
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/agents/a/policy");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string).version).toBe(3);
  });

  it("proposePolicy POSTs with no body", async () => {
    await client.agents.proposePolicy("a");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/agents/a/policy/propose");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("identity methods use the right paths and bodies", async () => {
    await client.agents.getIdentity("a");
    expect(lastCall().url).toMatch(/\/v1\/agents\/a\/identity$/);
    await client.agents.rotateIdentity("a");
    expect(lastCall().url).toMatch(/\/identity\/rotate$/);
    expect(lastCall().init.method).toBe("POST");
    await client.agents.revokeIdentity("a", "leaked");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ reason: "leaked" });
    await client.agents.mintAgentToken("a", { audience: "pal:dispatch", runId: "r1" });
    expect(lastCall().url).toMatch(/\/identity\/token$/);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ audience: "pal:dispatch", runId: "r1" });
  });

  it("listAudit builds the query string and drops undefined", async () => {
    await client.agents.listAudit("a", { limit: 25, event: "policy.denied" });
    expect(lastCall().url).toBe("http://localhost:9/v1/agents/a/audit?limit=25&event=policy.denied");
    await client.agents.listAudit("a");
    expect(lastCall().url).toBe("http://localhost:9/v1/agents/a/audit");
  });

  it("surfaces a 409 version_conflict", async () => {
    mockFetch({ code: "version_conflict" }, 409);
    const err = await client.agents.putPolicy("a", policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PalApiError);
    expect((err as PalApiError).status).toBe(409);
    expect(isVersionConflict(err)).toBe(true);
    expect(asPolicyDenied(err)).toBeNull();
  });

  it("surfaces a 403 agent_policy_denied with kind and target", async () => {
    mockFetch({ code: "agent_policy_denied", kind: "connector", target: "slack__post", error: "denied" }, 403);
    const err = await client.agents.getPolicy("a").catch((e: unknown) => e);
    expect(asPolicyDenied(err)).toEqual({
      code: "agent_policy_denied",
      kind: "connector",
      target: "slack__post",
      error: "denied",
    });
    expect(isVersionConflict(err)).toBe(false);
  });

  it("does not treat other 403s or non-JSON bodies as policy denials", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response("nope", { status: 403 }));
    const err = await client.agents.getPolicy("a").catch((e: unknown) => e);
    expect(asPolicyDenied(err)).toBeNull();
    expect(asPolicyDenied(new Error("x"))).toBeNull();
  });
});
