// Wire-contract tests for the parity namespaces added to LanternClient
// (sessions, connectors, budgets, evalSuites, evalRuns, evalBaselines,
// experiments, marketplace, mcp, receipts, feedback, rehearsals,
// runs.forecast). Field casing and paths are checked against the Go
// handlers in services/control-plane/internal/handlers/ — see that
// package for the source of truth. Follows the mock-fetch pattern in
// client-wire-contract.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternClient } from "../src/client.js";

const realFetch = globalThis.fetch;

function mockFetch(body: unknown = {}, status = 200) {
  // A fresh Response per call (a mocked value's body can only be read once,
  // and 204 responses may not carry a body at all).
  globalThis.fetch = vi.fn().mockImplementation(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function lastCall() {
  const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return init.body ? JSON.parse(init.body as string) : {};
}

describe("LanternClient namespaces (wire contract)", () => {
  let client: LanternClient;

  beforeEach(() => {
    mockFetch();
    client = new LanternClient({ apiKey: "k", baseUrl: "http://localhost:9" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // -- config -----------------------------------------------------------

  it("accepts baseURL (camelCase) as an alias for baseUrl", async () => {
    const c = new LanternClient({ baseURL: "http://alt:1234" });
    await c.agents.get("x");
    const { url } = lastCall();
    expect(url).toBe("http://alt:1234/v1/agents/x");
  });

  // -- agents/runs list bare-array regression ----------------------------

  it("agents.list parses a bare JSON array response", async () => {
    mockFetch([{ id: "1", name: "a", createdAt: "now", labels: {} }]);
    const result = await client.agents.list();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("a");
  });

  it("runs.list parses a bare JSON array response", async () => {
    mockFetch([{ id: "r1", status: "queued" }]);
    const result = await client.runs.list({ agent: "triage" });
    expect(result.runs).toHaveLength(1);
    const { url } = lastCall();
    expect(url).toContain("agent=triage");
  });

  // -- runs.forecast ------------------------------------------------------

  it("runs.forecast sends agentName/input to /v1/runs/forecast", async () => {
    await client.runs.forecast({ agentName: "triage", input: "hi" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/runs/forecast");
    expect(init.method).toBe("POST");
    expect(bodyOf(init)).toEqual({ agentName: "triage", input: "hi" });
  });

  it("runs.forecast accepts a server response with no estimatedCostUsd (noHistoricalData case)", async () => {
    // Server sends estimatedCostUsd/estimatedTokensIn/estimatedTokensOut as omitempty:
    // when the agent has no run history the fields are absent. The SDK type must not
    // declare them required or callers crash accessing .estimatedCostUsd on a new agent.
    mockFetch({
      agentName: "triage",
      model: "gpt-4o",
      provider: "openai",
      confidence: 0,
      calibrated: false,
      noHistoricalData: true,
      reasoning: {},
      wouldExceedBudget: false,
      // estimatedCostUsd / estimatedTokensIn / estimatedTokensOut intentionally absent
    });
    const result = await client.runs.forecast({ agentName: "triage", input: "hi" });
    expect(result.estimatedCostUsd).toBeUndefined();
    expect(result.estimatedTokensIn).toBeUndefined();
    expect(result.estimatedTokensOut).toBeUndefined();
    expect(result.noHistoricalData).toBe(true);
    expect(result.wouldExceedBudget).toBe(false);
  });

  // -- sessions -------------------------------------------------------

  it("sessions.create posts agentName (not agent_name) to /v1/sessions", async () => {
    await client.sessions.create({ agent: "triage" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/sessions");
    expect(init.method).toBe("POST");
    const body = bodyOf(init);
    expect(body.agentName).toBe("triage");
    expect(body).not.toHaveProperty("agent_name");
  });

  it("sessions.get fetches /v1/sessions/{id}", async () => {
    await client.sessions.get("s1");
    expect(lastCall().url).toBe("http://localhost:9/v1/sessions/s1");
  });

  it("sessions.list parses a bare JSON array response", async () => {
    mockFetch([{ id: "s1", agentName: "triage", status: "active", messages: [] }]);
    const result = await client.sessions.list();
    expect(result.sessions).toHaveLength(1);
  });

  it("sessions.sendMessage posts content to /v1/sessions/{id}/messages", async () => {
    await client.sessions.sendMessage("s1", { content: "hello" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/sessions/s1/messages");
    expect(bodyOf(init)).toEqual({ content: "hello" });
  });

  it("sessions.stop posts to /v1/sessions/{id}/stop", async () => {
    await client.sessions.stop("s1");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/sessions/s1/stop");
    expect(init.method).toBe("POST");
  });

  it("sessions.delete issues DELETE on /v1/sessions/{id}", async () => {
    mockFetch(undefined, 204);
    await client.sessions.delete("s1");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/sessions/s1");
    expect(init.method).toBe("DELETE");
  });

  it("sessions.close is a backward-compat alias that also issues DELETE", async () => {
    mockFetch(undefined, 204);
    await client.sessions.close("s1");
    const { init } = lastCall();
    expect(init.method).toBe("DELETE");
  });

  // -- connectors -------------------------------------------------------

  it("connectors.list fetches /v1/connectors", async () => {
    mockFetch([]);
    await client.connectors.list();
    expect(lastCall().url).toBe("http://localhost:9/v1/connectors");
  });

  it("connectors.get fetches /v1/connectors/{id}", async () => {
    await client.connectors.get("slack");
    expect(lastCall().url).toBe("http://localhost:9/v1/connectors/slack");
  });

  it("connectors.execute sends action as a query param and params as the raw body", async () => {
    await client.connectors.execute("slack", "post_message", { channel: "#general", text: "hi" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/connectors/slack/execute?action=post_message");
    expect(init.method).toBe("POST");
    // Raw params, no {params: ...} wrapper.
    expect(bodyOf(init)).toEqual({ channel: "#general", text: "hi" });
  });

  it("connectors.test posts to /v1/connectors/{id}/test", async () => {
    await client.connectors.test("slack");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/connectors/slack/test");
    expect(init.method).toBe("POST");
  });

  it("connectors.uninstall issues DELETE on /v1/connectors/{id}", async () => {
    mockFetch(undefined, 204);
    await client.connectors.uninstall("slack");
    expect(lastCall().init.method).toBe("DELETE");
  });

  // -- budgets ----------------------------------------------------------

  it("budgets.upsert PUTs to /v1/agents/{name}/budget with camelCase fields", async () => {
    await client.budgets.upsert("triage", { maxCostUsdPerDay: 25, maxCostUsdPerRun: 0.1, hardFail: true });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/agents/triage/budget");
    expect(init.method).toBe("PUT");
    expect(bodyOf(init)).toEqual({ maxCostUsdPerDay: 25, maxCostUsdPerRun: 0.1, hardFail: true });
  });

  it("budgets.get fetches /v1/agents/{name}/budget", async () => {
    await client.budgets.get("triage");
    expect(lastCall().url).toBe("http://localhost:9/v1/agents/triage/budget");
  });

  it("budgets.delete issues DELETE on /v1/agents/{name}/budget", async () => {
    mockFetch(undefined, 204);
    await client.budgets.delete("triage");
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("budgets.list fetches the bare array at /v1/budgets", async () => {
    mockFetch([{ agentName: "triage", hardFail: false, notifyAtPct: 0 }]);
    const result = await client.budgets.list();
    expect(result).toHaveLength(1);
    expect(lastCall().url).toBe("http://localhost:9/v1/budgets");
  });

  // -- evalSuites / evalRuns / evalBaselines -----------------------------

  it("evalSuites.upsert posts agentName/name/cases to /v1/eval-suites", async () => {
    await client.evalSuites.upsert({ agentName: "triage", name: "smoke", cases: [{ name: "c1", input: "hi" }] });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/eval-suites");
    expect(bodyOf(init)).toMatchObject({ agentName: "triage", name: "smoke" });
  });

  it("evalSuites.list passes agentName as a query param over the bare array", async () => {
    mockFetch([{ id: "e1", agentName: "triage", name: "smoke", cases: [] }]);
    const result = await client.evalSuites.list({ agentName: "triage" });
    expect(result).toHaveLength(1);
    expect(lastCall().url).toContain("agentName=triage");
  });

  it("evalRuns.record posts caseResults to /v1/eval-runs", async () => {
    await client.evalRuns.record({ suiteId: "e1", caseResults: [{ name: "c1", passed: true, score: 1 }] });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/eval-runs");
    expect(bodyOf(init)).toMatchObject({ suiteId: "e1", durationMs: 0, totalCostUsd: 0 });
  });

  it("evalBaselines.set posts agentName/branch/evalRunId to /v1/eval-baselines", async () => {
    await client.evalBaselines.set({ agentName: "triage", branch: "main", evalRunId: "run-1" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/eval-baselines");
    expect(bodyOf(init)).toEqual({ agentName: "triage", branch: "main", evalRunId: "run-1" });
  });

  it("evalBaselines.get sends agentName/branch as query params", async () => {
    await client.evalBaselines.get({ agentName: "triage", branch: "main" });
    expect(lastCall().url).toBe("http://localhost:9/v1/eval-baselines?agentName=triage&branch=main");
  });

  // -- experiments --------------------------------------------------------

  it("experiments.create posts variantAVersion/variantBVersion (camelCase) to /v1/experiments", async () => {
    await client.experiments.create({
      agentName: "triage",
      name: "v2-test",
      variantAVersion: "v1",
      variantBVersion: "v2",
    });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/experiments");
    expect(bodyOf(init)).toMatchObject({
      variantAVersion: "v1",
      variantBVersion: "v2",
      trafficSplitB: 50,
    });
  });

  it("experiments.recordOutcome posts variant/score to /v1/experiments/{id}/record", async () => {
    await client.experiments.recordOutcome("exp-1", { variant: "b", score: 0.9 });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/experiments/exp-1/record");
    expect(bodyOf(init)).toEqual({ variant: "b", score: 0.9 });
  });

  it("experiments.conclude posts winner/promote to /v1/experiments/{id}/conclude", async () => {
    await client.experiments.conclude("exp-1", { winner: "b", promote: true });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/experiments/exp-1/conclude");
    expect(bodyOf(init)).toEqual({ winner: "b", promote: true });
  });

  // -- marketplace --------------------------------------------------------

  it("marketplace.publish posts agentName/category (no slug — server-generated)", async () => {
    await client.marketplace.publish({ agentName: "triage", category: "support" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/marketplace/publish");
    const body = bodyOf(init);
    expect(body).toMatchObject({ agentName: "triage", category: "support", tags: [] });
    expect(body).not.toHaveProperty("slug");
  });

  it("marketplace.fork posts newName to /v1/marketplace/{slug}/fork", async () => {
    await client.marketplace.fork("triage-bot", "my-triage");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/marketplace/triage-bot/fork");
    expect(bodyOf(init)).toEqual({ newName: "my-triage" });
  });

  it("marketplace.star POSTs and unstar DELETEs the same URL", async () => {
    await client.marketplace.star("triage-bot");
    expect(lastCall().init.method).toBe("POST");
    await client.marketplace.unstar("triage-bot");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/marketplace/triage-bot/star");
    expect(init.method).toBe("DELETE");
  });

  // -- mcp ------------------------------------------------------------------

  it("mcp.attach posts serverSlug (not slug) to /v1/agents/{name}/mcp-servers", async () => {
    await client.mcp.attach("triage", "github-mcp", { token: "x" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/agents/triage/mcp-servers");
    expect(bodyOf(init)).toEqual({ serverSlug: "github-mcp", config: { token: "x" } });
  });

  it("mcp.listServers passes category/q as query params", async () => {
    mockFetch([]);
    await client.mcp.listServers({ category: "dev", query: "git" });
    expect(lastCall().url).toBe("http://localhost:9/v1/mcp/servers?category=dev&q=git");
  });

  it("mcp.detach issues DELETE on /v1/agents/{name}/mcp-servers/{slug}", async () => {
    mockFetch(undefined, 204);
    await client.mcp.detach("triage", "github-mcp");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/agents/triage/mcp-servers/github-mcp");
    expect(init.method).toBe("DELETE");
  });

  // -- receipts -------------------------------------------------------------

  it("receipts.issue posts to /v1/runs/{id}/receipt", async () => {
    await client.receipts.issue("run-1");
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/runs/run-1/receipt");
    expect(init.method).toBe("POST");
  });

  it("receipts.verify posts the full signed receipt (no wrapper)", async () => {
    const receipt = {
      payload: { runId: "run-1", agentName: "triage", costUsd: 0, issuedAt: "now", journalHash: "x", status: "succeeded", tenantId: "t1", tokensIn: 1, tokensOut: 1, version: 1 },
      signature: "sig",
      algorithm: "ed25519",
    };
    await client.receipts.verify(receipt);
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/runs/receipts/verify");
    expect(bodyOf(init)).toEqual(receipt);
  });

  // -- feedback ---------------------------------------------------------

  it("feedback.submit posts score/comment to /v1/runs/{id}/feedback", async () => {
    await client.feedback.submit("run-1", { score: 5, comment: "great" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/runs/run-1/feedback");
    expect(bodyOf(init)).toEqual({ source: "sdk", score: 5, comment: "great" });
  });

  it("feedback.summaryForAgent fetches /v1/agents/{name}/feedback", async () => {
    await client.feedback.summaryForAgent("triage");
    expect(lastCall().url).toBe("http://localhost:9/v1/agents/triage/feedback");
  });

  // -- rehearsals -------------------------------------------------------

  it("rehearsals.pull posts agentName to /v1/runs/rehearse", async () => {
    await client.rehearsals.pull({ agentName: "triage" });
    const { url, init } = lastCall();
    expect(url).toBe("http://localhost:9/v1/runs/rehearse");
    expect(bodyOf(init)).toEqual({
      includeFailures: true,
      includeLowScore: true,
      agentName: "triage",
    });
  });
});
