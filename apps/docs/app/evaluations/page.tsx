import { Concept } from "../_components/Concept";

export default function EvaluationsPage() {
  return (
    <>
      <h1>Evaluations</h1>
      <p>
        Test agents against fixed cases, fail CI on regressions, split traffic
        between versions, and collect human feedback. All of it is on the same
        REST API the dashboard uses.
      </p>

      <Concept>
        Change a prompt and the agent may get worse. An eval suite is a set of
        inputs with expected results. Run it like a test suite, pin today&apos;s
        score as the baseline, and the API answers 422 when a later run scores
        lower, so CI fails before users see it.
      </Concept>

      <h2 id="eval-suites">Eval suites</h2>
      <p>
        A suite is a named list of cases for one agent. A case has a{" "}
        <code>name</code>, an <code>input</code> string, and an{" "}
        <code>expected</code> string and/or an <code>assert</code> object
        (e.g. <code>{`{"contains":"1945"}`}</code>, or <code>{`{"grounded":true}`}</code>{" "}
        to fail outputs that claim actions nothing backed). Suites are upserted by{" "}
        <code>(tenant, agent, name)</code>.
      </p>

      <h3>Create or update a suite</h3>
      <pre>
        <code>{`POST /v1/eval-suites
{
  "agentName": "research-agent",
  "name": "factual-accuracy",
  "cases": [
    {
      "name": "case-1",
      "input": "What year did WWII end?",
      "expected": "1945",
      "assert": { "contains": "1945" }
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
        Run the agent on each case yourself (or use <code>lantern test</code>, which waits for each run to finish; <code>--timeout</code> caps the wait, default 2m),
        then post the per-case results. The server computes the score (mean of
        case scores) and compares it with the branch baseline. A regression
        returns <strong>HTTP 422</strong>, which fails a CI step.
      </p>

      <pre>
        <code>{`POST /v1/eval-runs
{
  "suiteId": "suite-uuid",
  "agentVersion": "v2",
  "commitSha": "abc1234",
  "branch": "main",
  "durationMs": 4200,
  "totalCostUsd": 0.12,
  "caseResults": [
    { "name": "case-1", "passed": true, "score": 0.95, "actual": "1945" }
  ]
}

Response: 200 OK — no regression
{ "id": "run-uuid", "passed": true, "score": 0.95, "casesTotal": 1,
  "casesPassed": 1, "regressed": false, "baselineScore": 0.94 }

Response: 422 Unprocessable Entity — regressed vs. baseline
{ "id": "run-uuid", "score": 0.91, "regressed": true, "baselineScore": 0.94, ... }`}</code>
      </pre>

      <h3>Other eval-run endpoints</h3>
      <pre>
        <code>{`GET /v1/eval-runs?suiteId=&agentName=&branch=  — list runs (bare array)`}</code>
      </pre>

      <h2 id="baselines">Baselines</h2>
      <p>
        Pin an eval run as the baseline for an agent and branch. Later runs on
        that branch are compared against it. From the CLI:{" "}
        <code>lantern test --agent a --suite s --set-baseline</code>.
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
        Split traffic between two agent versions. The split is deterministic
        (FNV-1a hash of the run ID), so a run always lands on the same variant.
        Record a score per run; with <code>autoPromote</code> on, Lantern
        promotes the winner once both arms have enough runs and one leads by
        more than 0.02. This is a fixed margin, not a significance test.
      </p>

      <h3>Create an experiment</h3>
      <pre>
        <code>{`POST /v1/experiments
{
  "agentName": "research-agent",
  "name": "prompt-v2-test",
  "variantAVersion": "v1",
  "variantBVersion": "v2",
  "trafficSplitB": 20,        // percent of traffic to B (0-100)
  "autoPromote": true,        // promote the leader at +0.02 score
  "minRunsToPromote": 100     // per arm; default 100
}

Response: 201 Created
{ "id": "exp-uuid", "status": "running", ... }`}</code>
      </pre>

      <h3>Record an outcome</h3>
      <pre>
        <code>{`POST /v1/experiments/{id}/record
{
  "variant": "b",   // "a" | "b"
  "score": 0.95     // 0-1; the stored score is a running mean per variant
}

// Auto-promotion fires when:
// - both arms have >= minRunsToPromote runs
// - one arm's mean score beats the other by more than 0.02`}</code>
      </pre>

      <h3>Conclude manually</h3>
      <pre>
        <code>{`POST /v1/experiments/{id}/conclude
{
  "winner": "b",     // "a" | "b" | "tie"
  "promote": true    // flip the agent's current version to the winner
}`}</code>
      </pre>

      <h3>Other experiment endpoints</h3>
      <pre>
        <code>{`GET /v1/experiments         — list (bare array)
GET /v1/experiments/{id}    — get with aScore / bScore and run counts`}</code>
      </pre>

      <h2 id="feedback">Human feedback (RLHF)</h2>
      <p>
        Collect thumbs-up / thumbs-down reactions on individual runs. Score is
        1–5; 4–5 is positive, 1–2 is negative. Runs scored 2 or
        lower are pulled in by rehearsals.
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
  → { totalFeedback, avgScore, thumbsUp, thumbsDown, last7DaysAvgScore, ... }`}</code>
      </pre>

      <h2 id="rehearsals">Rehearsals</h2>
      <p>
        Pull past failed or low-scored runs (feedback score of 2 or lower) as
        synthetic test cases, then replay them against a candidate version
        before you flip traffic. The endpoint returns the cases;{" "}
        <code>lantern test --rehearse</code> runs them.
      </p>

      <pre>
        <code>{`POST /v1/runs/rehearse
{
  "agentName": "research-agent",
  "window": "7d",            // look-back (default 7d)
  "limit": 20,               // default 25, max 200
  "includeFailures": true,   // status=failed runs (default true)
  "includeLowScore": true    // feedback score <= 2 (default true)
}

Response: { "agentName", "window", "cases": [{ "originalRunId", "input",
  "expectedOutput", ... }], "count", "reason"? }`}</code>
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
