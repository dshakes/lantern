# Eval-gated deploy

A CI pipeline that cannot ship a worse agent: run the eval suite, record it, and let the control plane's
`422` stop the job before `lantern deploy`. A passing change deploys and gets a signed receipt that anyone
can verify.

```
eval.sh   stage candidate -> run each case (POST /v1/runs) -> score -> POST /v1/eval-runs
              422 regressed vs. baseline  -> exit 1, job stops, nothing deploys
              200                         -> .eval-result.json
release.sh   lantern deploy --json -> POST /v1/runs/{id}/receipt -> POST /v1/runs/receipts/verify
```

| Path | What |
| --- | --- |
| `agent.yaml` | The version on main (what `lantern deploy` reads) |
| `candidates/regressed/` | A PR change that breaks the `standard-delivery` case (score 2/3, gate fails) |
| `candidates/improved/` | A PR change that keeps every case passing (gate passes, deploys) |
| `eval/suite.json` | Three cases with `assert.contains` |
| `fixtures/llm-rules.json` | Rules for `cmd/llm-replay` so the run is deterministic without a model key |
| `scripts/eval.sh`, `scripts/release.sh` | What the workflow calls (needs `curl`, `jq`) |
| `.github/workflows/eval-gated-deploy.yml` | Sample workflow. Inert here: copy it into your repo's `.github/workflows/` |

## How cases are scored

The server does **not** score cases. `POST /v1/eval-runs` stores the per-case `{name, passed, score, actual}`
you send, averages the scores, and answers `422` when the average is more than 1% below the baseline pinned for
`(agent, branch)`. `eval.sh` does the scoring: a case passes when the run output contains `assert.contains`.
It runs the candidate on a staging agent (`<name>-ci`), because runs execute a stored agent, then records
the result against the real agent name so the baseline gates that agent.

PRs gate against the baseline on `main` (`EVAL_BRANCH=main`); a push to `main` passes `EVAL_PIN=1` to pin the
new run as the baseline after it passes.

## Try it

```bash
make dev-infra && make run-api   # terminal 1; add a provider key, or run llm-replay (below)
export LANTERN_API_URL=http://localhost:8080 LANTERN_API_KEY=<jwt or key with agents:write, runs:execute, runs:write>
cd examples/eval-gated-deploy

EVAL_PIN=1 scripts/eval.sh .                    # baseline: 3/3, pinned
scripts/eval.sh candidates/regressed; echo $?   # 1: HTTP 422, regressed, baselineScore 1
scripts/eval.sh candidates/improved && scripts/release.sh candidates/improved
```

Without a provider key, start `go run ./services/control-plane/cmd/llm-replay -rules fixtures/llm-rules.json` and
point the control plane at it with `LANTERN_LLM_BASEURL_OPENAI` / `LANTERN_LLM_BASEURL_ANTHROPIC`.

The end-to-end test (`e2e/examples/eval_gated_deploy_test.go`, run by `make test-e2e-examples`) drives exactly these
scripts: the regressing candidate exits 1 on `422` and no agent or deployment row is created; the passing one
deploys, and its receipt verifies while a corrupted or re-pointed one does not.

## Limits

- The receipt is for the eval run that gated the deploy (it carries the `eval_result` journal event), not for a
  production run.
- `eval.sh` reads only a `system_prompt: |` block scalar from `agent.yaml`.
- `lantern test` is not used: it expects HTTP 200 and a finished run from `POST /v1/runs`, which answers 201 and
  runs asynchronously, so `eval.sh` does that part itself.
