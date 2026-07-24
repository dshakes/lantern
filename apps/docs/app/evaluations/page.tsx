import { Concept } from "../_components/Concept";

export default function EvaluationsPage() {
  return (
    <>
      <h1>Evaluations</h1>
      <p>
        Lantern has a built-in evaluation system for testing agents against
        declarative test cases, gating CI on regressions, running A/B
        experiments, and collecting human feedback — all from the same API the
        dashboard uses.
      </p>

      <Concept>
        How do you know your agent is actually good — and stays good after you
        change its prompt? Evaluations are the answer: a set of example
        questions with known-good answers that you run against the agent like a
        test suite. Pin today&apos;s score as your baseline, and if a future
        change makes the agent worse, Lantern blocks it in CI before your users
        ever see the regression. A/B experiments and thumbs-up/down feedback
        feed the same loop.
      </Concept>

      <h2 id="eval-suites">Eval suites</h2>
      <p>
        An eval suite is a named collection of test cases for an agent. Each
        case defines an input and expected output (or a scoring function).
        Suites are upserted by <code>(tenant, agent, name)</code>.
      </p>

      <h3>Create or update a suite</h3>
      <pre>
        <code>{`POST /v1/eval-suites
{
  "agentName": "research-agent",
  "name": "factual-accuracy",
  "cases": [
    {
      "id": "case-1",
      "input": { "question": "What year did WWII end?" },
      "expectedOutput": "1945",
      "scoreThreshold": 0.9
    }
  ]
}

Response: 200 OK
{ "id": "suite-uuid", "agentName": "research-agent", "name": "factual-accuracy" }`}</code>
      </pre>

      <h3>Other suite endpoints</h3>
      <pre>
        <code>{`GET    /v1/eval-suites              — list all suites (bare array)
GET    /v1/eval-suites?agentName=  — filter by agent
GET    /v1/eval-suites/{id}        — get suite
DELETE /v1/eval-suites/{id}        — delete suite`}</code>
      </pre>

      <h2 id="eval-runs">Recording a run + CI gate</h2>
      <p>
        After running your agent against a suite&apos;s cases, post the results.
        If the score has regressed vs. the branch baseline, the API returns{" "}
        <strong>HTTP 422</strong> — wire this into your CI pipeline to block
        merges on regression.
      </p>

      <pre>
        <code>{`POST /v1/eval-runs
{
  "suiteId": "suite-uuid",
  "agentName": "research-agent",
  "agentVersion": "v2",
  "commitSha": "abc1234",
  "branch": "main",
  "passed": 9,
  "score": 0.91,
  "casesResult": [
    { "id": "case-1", "passed": true, "score": 0.95, "actual": "1945" }
  ]
}

Response: 200 OK — passed baseline check
{ "id": "run-uuid", "score": 0.91, "passed": 9, "regressed": false }

Response: 422 Unprocessable Entity — regressed vs. baseline
{ "error": "score 0.91 is below baseline 0.94 on branch main", "regressed": true }`}</code>
      </pre>

      <h3>Other eval-run endpoints</h3>
      <pre>
        <code>{`GET /v1/eval-runs?suiteId=&agentName=&branch=  — list runs (bare array)`}</code>
      </pre>

      <h2 id="baselines">Baselines</h2>
      <p>
        Pin a specific eval run as the baseline for an agent + branch. Future
        runs on that branch are compared against it.
      </p>
      <pre>
        <code>{`POST /v1/eval-baselines
{ "agentName": "research-agent", "branch": "main", "evalRunId": "run-uuid" }

GET /v1/eval-baselines?agentName=research-agent&branch=main`}</code>
      </pre>

      <h2 id="observability">Eval observability</h2>
      <p>
        Two read-only endpoints over existing <code>eval_runs</code> data for
        the dashboard quality-trend sparkline and top-failing-cases view.
      </p>

      <h3>Failure clusters</h3>
      <pre>
        <code>{`GET /v1/eval-observability/failures?agentName=research-agent&branch=main&limit=50

Response:
{
  "clusters": [
    {
      "case": "What year did WWII end?",
      "failures": 3,
      "seen": 5,
      "failRate": 0.6,
      "sampleError": "Agent said 1944 instead of 1945",
      "firstSeen": "2026-07-01T...",
      "lastSeen": "2026-07-20T..."
    }
  ],
  "runsScanned": 50
}`}</code>
      </pre>

      <h3>Score trend</h3>
      <pre>
        <code>{`GET /v1/eval-observability/trends?agentName=research-agent&branch=main

Response:
{
  "points": [
    {
      "runId": "run-uuid",
      "createdAt": "2026-07-01T...",
      "score": 0.94,
      "passRate": 0.9,
      "passed": 9,
      "costUsd": 0.12,
      "agentVersion": "v1",
      "commitSha": "abc1234"
    }
  ],
  "latestVsMean": -0.03,
  "regressing": true
}`}</code>
      </pre>

      <h2 id="experiments">A/B experiments</h2>
      <p>
        Run two agent versions side by side with deterministic traffic
        splitting (FNV-1a hash on a caller-supplied bucketing key). Record
        per-request outcomes and let Lantern auto-promote the winner when it
        has a statistically significant lift.
      </p>

      <h3>Create an experiment</h3>
      <pre>
        <code>{`POST /v1/experiments
{
  "agentName": "research-agent",
  "variantAVersion": "v1",
  "variantBVersion": "v2",
  "trafficSplitB": 0.2,     // 20% to variant B
  "autoPromote": true       // auto-flip to B if lift > 2%
}

Response: 201 Created
{ "id": "exp-uuid", "status": "running", ... }`}</code>
      </pre>

      <h3>Record an outcome</h3>
      <pre>
        <code>{`POST /v1/experiments/{id}/record
{
  "bucketingKey": "user-123",  // determines which variant this caller gets
  "score": 0.95                // 0–1; your metric (e.g. task success rate)
}

// Auto-promotion fires when:
// - variant B score - variant A score > 0.02
// - both arms have ≥ minRunsPerArm samples`}</code>
      </pre>

      <h3>Conclude manually</h3>
      <pre>
        <code>{`POST /v1/experiments/{id}/conclude
{
  "winner": "b",     // "a" | "b" | null (inconclusive)
  "promote": true    // flip agent's currentVersionId to the winner
}`}</code>
      </pre>

      <h3>Other experiment endpoints</h3>
      <pre>
        <code>{`GET /v1/experiments         — list (bare array)
GET /v1/experiments/{id}    — get with current a_score / b_score`}</code>
      </pre>

      <h2 id="feedback">Human feedback (RLHF)</h2>
      <p>
        Collect thumbs-up / thumbs-down reactions on individual runs. Score is
        1–5; 4–5 is positive, 1–2 is negative. Negative runs feed the
        rehearsal queue automatically.
      </p>

      <pre>
        <code>{`POST /v1/runs/{id}/feedback
{
  "score": 2,
  "comment": "The agent missed the follow-up question",
  "preferredOutput": "It should have asked for clarification first"
}

GET /v1/runs/{id}/feedback                   — per-run history (bare array)
GET /v1/agents/{name}/feedback               — aggregate summary
  → { avgScore, thumbsUp, thumbsDown, trend7d: [...] }`}</code>
      </pre>

      <h2 id="rehearsals">Rehearsals</h2>
      <p>
        Replay past failed or low-scoring runs as synthetic test cases against
        a candidate version before you flip production traffic. Uses the same
        CI-gate baseline machinery as eval runs.
      </p>

      <pre>
        <code>{`POST /v1/runs/rehearse
{
  "agentName": "research-agent",
  "candidateVersion": "v3",
  "window": "7d",   // look-back window for source runs
  "limit": 20,      // max synthetic cases to generate
  "maxScore": 2     // only pull runs with feedback score ≤ this
}`}</code>
      </pre>

      <h2 id="otel">OTel traces</h2>
      <p>
        Every HTTP request and gRPC call carries a span enriched with{" "}
        <code>lantern.tenant_id</code>, <code>lantern.run_id</code>,{" "}
        <code>lantern.step_id</code>, and <code>lantern.user_id</code> via{" "}
        <code>middleware.EnrichSpan</code>. Traces are no-op safe when{" "}
        <code>LANTERN_OTEL_ENABLED</code> is unset. Export to any OTel backend
        by setting <code>OTEL_EXPORTER_OTLP_ENDPOINT</code>.
      </p>
    </>
  );
}
