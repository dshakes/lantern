# ADR 0052 — Agentic eval authoring, LLM-as-judge, hermetic tool mocks

- Status: Accepted
- Date: 2026-10-30
- Scope: control-plane (`internal/handlers/eval_{assert,judge,runner,generate}.go`, `evals.go`, one seam in `llm_proxy.go`), CLI `pal eval`, SDKs (TS / Python / Go), dashboard Eval Suites
- Plan: AGENT-LIFECYCLE-PLAN Phase 4 (gaps 1c + 1d)

## Context

Eval suites, runs, baselines and the 422-on-regression gate existed, but grading
was substring/`grounded` only (`evals.go`), cases ran client-side against live
runs (`pal test`), so any case touching a connector hit the real connector, and
nobody wrote the cases but a human. SOTA eval platforms (OpenAI Evals,
Braintrust, LangSmith, Inspect) ship model-graded rubrics with reference
answers, pairwise comparison, trajectory/tool-call scorers, fixtures, multiple
samples with variance, and regression gating. Phase 4 closes that gap and makes
the loop agentic: the agent drafts its own suite, a human approves, the suite
runs hermetically, CI gates on it.

## Decision

### 1. Case schema v2 (backward compatible)

`assert` stays a free-form JSON object in `eval_suites.cases`; v2 keys are parsed
(`parseAssert`) and validated at the API boundary (`POST /v1/eval-suites` → 400 on
a malformed known key). Legacy `contains` / `expected` / `grounded` keep their
exact semantics. No migration: run detail (samples, assertions, trajectories)
lives in the existing `eval_runs.cases_result` JSONB.

```jsonc
{
  "name": "refund-window",
  "input": "Can I return shoes after 40 days?",
  "expected": "",                       // legacy substring
  "weight": 1,
  "samples": 3,                         // independent agent samples, 1..5
  "mocks": [                            // deterministic tool fixtures
    {"tool": "shopify__get_policy", "match": {"topic": "returns"},
     "result": {"window_days": 30}, "error": "", "description": "", "parameters": {}}
  ],
  "assert": {
    "contains": "30", "notContains": "60", "regex": "\\b30\\b", "minLen": 10, "maxLen": 1200,
    "grounded": true,
    "judge":        {"rubric": "...", "reference": "...", "threshold": 0.75, "samples": 3, "model": "reasoning-large"},
    "faithfulness": {"threshold": 0.75},  // every claim supported by the tool results it received
    "pairwise":     {"criteria": "...", "threshold": 0.5},  // vs the pinned baseline's output
    "trajectory":   {"expect": [{"tool": "shopify__get_policy", "args": {"topic": {"$contains": "return"}}}],
                     "order": "any|in_order|exact", "forbid": ["stripe__refund"], "maxCalls": 3},
    "maxLatencyMs": 30000, "maxCostUsd": 0.05
  }
}
```

Arg matchers (mocks `match`, trajectory `args`): literal (JSON-equal) or
`{"$any":true}` / `{"$contains":"x"}` / `{"$regex":"…"}`.

Scoring: a sample passes iff every non-skipped assertion passes; its score is
their mean (judge scores are fractional). A case passes only if **every** sample
passes (pass^k); its score is the sample mean, with sample stddev and pass rate
reported; 0 < pass rate < 1 marks it **flaky**. Run score = weight-averaged case
score.

### 2. Hermetic server-side runs — `POST /v1/eval-suites/{id}/run`

The server executes the agent's real system prompt, model preference and tool
surface through the same `callLLMWithFailover` tool loop the inline executor
uses, but the dispatcher is `mockDispatcher`: a tool call is answered by the
first matching fixture; an unmocked tool returns an error to the model. **No
real tool, connector, web search or delivery ever runs in an eval** — that
function is the entire tool surface. Mocked tools not installed on the tenant
get a schema from the connector catalog (or the mock), so suites are portable
to a bare CI tenant. Recorded tool calls are the trajectory.

Request: `{branch, commitSha, agentVersion, samples, judgeSamples, judgeModel, maxCostUsd, cases[], setBaseline}`.
Limits: ≤25 cases, ≤60 case×sample executions, concurrency 4, 3 min per unit,
`maxCostUsd` default $1 (cap $25) — samples after the ceiling are recorded as
not executed and `stoppedEarly` is set. Budget: hard-fail budget → 402 up front;
spend is metered with `RecordUsageSpend` (does not bump runs/day).

Workflow-graph and loop agents → 400 `unsupported_agent_kind`; they keep `pal
test` (live runs). Template prefetch is not replayed hermetically (the agent
sees tools instead).

Not a run: no `runs` row is written (invariant #2 untouched) and there are no
side effects, so it is not a durable workflow step (invariant #3): a crash loses
only the in-flight measurement and the caller retries. This is the same stance
as `generate-spec` and `assist/explain`.

### 3. LLM-as-judge

Kinds: `judge` (rubric + optional reference, integer 1–5 normalised to 0..1),
`faithfulness` (claims vs the tool results the agent got), `pairwise`
(candidate vs the baseline run's output for the same case, judged twice with
positions swapped — a position-biased judge yields a tie). N judge samples
(default 3); pass = mean ≥ threshold (default 0.75; pairwise 0.5); a majority of
samples must yield a valid verdict or the assertion **fails closed**.

**Routing (invariant #6).** The judge model is a capability only
(`reasoning-large` default; `PAL_EVAL_JUDGE_MODEL`, the run request's
`judgeModel`, or the case's `judge.model` override). Vendor ids are rejected.
Calls go through `callLLMWithFailover` (and so the model-router seam when
`PAL_USE_MODEL_ROUTER` is on).

**Maker ≠ checker.** The judge call carries `withExcludedModels(<model that
produced the output>)`; `callLLMWithFailover` drops that model from its chain
before routing. If nothing distinct remains the judge returns
`errNoDistinctModel` and the assertion fails closed — a model never grades
itself. A tenant with one provider still gets a different tier (e.g. sonnet
under test, opus or haiku judging); a second provider gives full separation.

**Prompt-injection hardening** (the agent output is attacker-influenced):
1. Deterministic pre-screen `graderDirected`: text addressed to the grader,
   "ignore previous instructions", "give this a 5", forged verdict JSON, or a
   fence tag → fail closed without consulting the judge (`injectionSuspected`).
2. Untrusted text is fenced in `<untrusted_<tag>_<nonce>>` with a per-call random
   nonce; anything tag-like that could close a fence is stripped first.
3. The verdict must echo the nonce — output produced before the nonce existed
   cannot forge an accepted verdict even if the judge parrots it.
4. Strict parse (integer 1–5 / `A|B|tie`), else a judge error.

Calibration — `POST /v1/eval-judge/calibrate {agentName, rubric?, judgeModel?, limit≤20}`
re-judges runs that carry `run_feedback` and reports agreement, Cohen's κ (human
4–5 = pass, 1–2 = fail, 3 unlabeled) and MAE, with a verdict (κ ≥ 0.6 "safe to
gate on"). A rubric is trusted only as far as it agrees with real users.

### 4. Regression gate

422 semantics are kept. Server runs regress when the aggregate rule fires
(unchanged: score more than 0.01 below the branch baseline) **or** any case that
passed in the baseline now fails and is not flaky (within-run flaky, or ≥2
pass/fail flips over the suite's last 10 runs). Responses carry `caseDeltas`
(per-case score delta, worst first), `regressedCases`, `flakyCases`.
`setBaseline` pins only an all-pass, non-regressed run. Client-posted results
(`POST /v1/eval-runs`, `pal test`) keep the aggregate-only 422 and gain
`caseDeltas` as information — tightening their gate would change CI behaviour
for existing users without warning.

### 5. Agent-authored suites — `POST /v1/eval-suites/generate`

`{agentName, goal?, maxCases≤12}` → a **draft**, never saved. Evidence: agent
instructions, tools, last 10 finished runs (input/output/tools called), last 20
feedback items. Run text is fenced as untrusted. Grounding is enforced in code
(`groundDraft`), not trusted to the prompt: an `expected` / `assert.contains` /
`judge.reference` survives only if it appears verbatim in the output of a cited
**succeeded, not thumbs-downed** run, or in a human's `preferred_output`;
otherwise it is stripped and the case is rubric-only. Regexes and trajectory
args are always stripped; mocks and trajectory tools must name tools the agent
has or used; every mock is marked `synthetic`. A case with no gradable
assertion left is dropped. The response lists per-case provenance and drop
reasons. **Approval is the human's `POST /v1/eval-suites`** of the (edited)
draft — the generator cannot write.

Scopes: generate / run / calibrate need `runs:execute` (they spend LLM tokens);
saving a suite keeps `agents:write`.

### 6. Agentic wiring (onboarding agent, #402)

#402 (onboarding-agent harness) is not on this branch. Endpoints land here; the
harness wires these tools when both are merged (tool → real REST mux in-process,
same pattern as its other server tools):

| tool | kind | gate (`allowedOnboardingTools`) | call | done when |
| --- | --- | --- | --- | --- |
| `generate_eval_suite` | server | agent created ∧ first run `succeeded` | `POST /v1/eval-suites/generate {agentName, goal}` | draft returned |
| `approve_eval_suite` | client | a draft exists ∧ user turn | dashboard/CLI shows draft; user edits → `POST /v1/eval-suites` | suite row reads back (`GET /v1/eval-suites?agentName=`) |
| `run_eval_suite` | server | suite saved | `POST /v1/eval-suites/{id}/run {branch:"main", setBaseline:true}` | eval_run reads back with `passed:true` (`GET /v1/eval-runs/{id}`) |

The agent narrates `caseResults[].assertions[].rationale` and `regressedCases`
from the readback, never from its own memory of the call.

## Consequences

- Evals are deterministic in their tool inputs and side-effect free; variance
  comes only from the models and is now measured, not hidden.
- Judge spend is real: N judge samples × judged assertions × agent samples.
  Defaults (1 agent sample, 3 judge samples, $1 ceiling) keep a 6-case suite in
  cents; the ceiling is hard.
- `graderDirected` can fail an honest output that discusses graders by name;
  the failure says why. Accepted: a false fail is visible, a hijacked pass is not.
- Hermetic runs do not cover workflow-graph / loop agents or template prefetch;
  those stay on live `pal test`.
- Temperature is not pinned per call (the failover chain has no knob); unit
  tests get determinism from a fake LLM seam, production gets measured variance.
