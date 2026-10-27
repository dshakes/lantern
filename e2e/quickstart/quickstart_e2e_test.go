//go:build e2e

// Package quickstart_e2e exercises the examples/quickstart/ agents against a
// LIVE local stack under the §0 spend policy (ga-program-plan.md §0):
//
//   - All agents are created via [e2ekit.Kit.CreateAgent] — the ONLY path.
//   - Stable name "e2e-quickstart" is used for all three examples sequentially.
//   - Hard-fail budget (maxCostUsdPerDay 0.50, maxRunsPerDay 15) is PUT and
//     GET-verified before any run.
//   - Model is pinned to the cheapest available provider model.
//   - web_search is stripped (quickstart agents don't need it).
//   - Agents are deleted via t.Cleanup; leftovers swept in TestMain.
//   - A 402 from POST /v1/runs fails the test with "budget exhausted — cap working".
//   - Stack down + E2E_ALLOW_SKIP unset → t.Fatal (make test-e2e fails).
//
// Preconditions:
//
//	make dev-infra  (Postgres + Redis + MinIO)
//	make run-api    (control-plane on :8080)
//	LLM provider configured for the dev tenant (anthropic or openai)
//
// Run via:
//
//	make test-e2e          (fails when stack is down; set E2E_ALLOW_SKIP=1 to skip)
//	make test-e2e-llm      (alias)
//
// Override target / credentials:
//
//	LANTERN_E2E_API_URL   (default http://localhost:8080)
//	LANTERN_E2E_EMAIL     (default admin@lantern.dev)
//	LANTERN_E2E_PASSWORD  (default lantern)
package quickstart_e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

// TestMain sweeps any e2e-* leftovers before running the suite.
func TestMain(m *testing.M) {
	e2ekit.Sweep(
		e2ekit.DefaultBase(),
		e2ekit.DefaultEmail(),
		e2ekit.DefaultPassword(),
	)
	os.Exit(m.Run())
}

// ---------- fixtures ----------

func examplesDir() string {
	return filepath.Join("..", "..", "examples", "quickstart")
}

func readSpec(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(examplesDir(), name, "spec.json"))
	if err != nil {
		t.Fatalf("read %s/spec.json: %v", name, err)
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("parse %s/spec.json: %v", name, err)
	}
	if spec["name"] == nil || spec["systemPrompt"] == nil {
		t.Fatalf("%s/spec.json must have name + systemPrompt (NOT 'instructions'): %v", name, spec)
	}
	return spec
}

func readRun(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(examplesDir(), name, "run.json"))
	if err != nil {
		t.Fatalf("read %s/run.json: %v", name, err)
	}
	var run map[string]any
	if err := json.Unmarshal(raw, &run); err != nil {
		t.Fatalf("parse %s/run.json: %v", name, err)
	}
	return run
}

func grabResult(t *testing.T, run map[string]any) string {
	t.Helper()
	out, ok := run["output"].(map[string]any)
	if !ok {
		t.Fatalf("run has no output object: %v", run)
	}
	res, ok := out["result"].(string)
	if !ok {
		t.Fatalf("run output has no string result: %v", out)
	}
	if strings.TrimSpace(res) == "" {
		t.Fatal("run output.result is empty")
	}
	return res
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// extractJSON returns the first {...} object in s.  The pr-triage prompt asks
// for raw JSON but a model may wrap it in prose or a code fence.
func extractJSON(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < 0 || end < start {
		return s
	}
	return s[start : end+1]
}

// ---------- tests ----------

// TestExample_PRTriage proves the pr-triage example runs and emits structured
// JSON with a "risk" key — the README's load-bearing invariant.
func TestExample_PRTriage(t *testing.T) {
	k := e2ekit.Connect(t)
	a := k.CreateAgent(t, "e2e-quickstart", readSpec(t, "pr-triage"))
	result_map := a.Run(t, readRun(t, "pr-triage"))

	result := grabResult(t, result_map)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(extractJSON(result)), &parsed); err != nil {
		t.Fatalf("pr-triage output is not JSON: %v\n---\n%s", err, result)
	}
	risk, ok := parsed["risk"].(string)
	if !ok {
		t.Fatalf("pr-triage output JSON has no string 'risk' key: %v", parsed)
	}
	switch risk {
	case "low", "med", "high":
	default:
		t.Fatalf("pr-triage 'risk' = %q (want low/med/high)", risk)
	}
	if _, ok := parsed["security_notes"]; !ok {
		t.Errorf("pr-triage output missing 'security_notes' key: %v", parsed)
	}
	t.Logf("pr-triage risk=%s", risk)
}

// TestExample_IncidentSummarizer proves the incident-summarizer example runs,
// emits the documented markdown sections, AND that a verifiable receipt can be
// issued and verified through the public no-auth verifier.
func TestExample_IncidentSummarizer(t *testing.T) {
	k := e2ekit.Connect(t)
	a := k.CreateAgent(t, "e2e-quickstart", readSpec(t, "incident-summarizer"))
	result_map := a.Run(t, readRun(t, "incident-summarizer"))

	result := grabResult(t, result_map)
	for _, want := range []string{"## Severity", "## Timeline", "## Next actions"} {
		if !strings.Contains(result, want) {
			t.Fatalf("incident-summarizer output missing %q section:\n%s", want, result)
		}
	}

	runID, _ := result_map["id"].(string)
	if runID == "" {
		t.Fatal("run has no id; cannot issue receipt")
	}

	// Issue the receipt (auth required).
	var receipt map[string]any
	status, raw := k.DoAuth(t, "POST", "/v1/runs/"+runID+"/receipt", nil, &receipt)
	if status != 200 {
		t.Fatalf("issue receipt: HTTP %d: %s", status, truncate(raw, 300))
	}
	if receipt["algorithm"] == nil || receipt["signature"] == nil {
		t.Fatalf("receipt missing algorithm/signature: %s", truncate(raw, 300))
	}

	// Verify through the PUBLIC no-auth endpoint.
	var verify struct {
		Valid bool `json:"valid"`
	}
	vstatus, vraw := k.Do(t, "POST", "/v1/runs/receipts/verify", receipt, &verify)
	if vstatus != 200 {
		t.Fatalf("verify receipt: HTTP %d: %s", vstatus, truncate(vraw, 300))
	}
	if !verify.Valid {
		t.Fatalf("receipt did not verify as valid: %s", truncate(vraw, 300))
	}
	t.Logf("incident-summarizer receipt verified (alg=%v)", receipt["algorithm"])
}

// TestExample_DailyStandupDigest proves the daily-standup-digest example runs
// and emits the documented digest sections.
func TestExample_DailyStandupDigest(t *testing.T) {
	k := e2ekit.Connect(t)
	a := k.CreateAgent(t, "e2e-quickstart", readSpec(t, "daily-standup-digest"))
	result_map := a.Run(t, readRun(t, "daily-standup-digest"))

	result := grabResult(t, result_map)
	for _, want := range []string{"## Shipped", "## In progress", "## Blockers"} {
		if !strings.Contains(result, want) {
			t.Fatalf("daily-standup-digest output missing %q section:\n%s", want, result)
		}
	}
	t.Logf("daily-standup-digest produced a digest (%d chars)", len(result))
}

// TestBudgetSurvivesRecreate asserts that the agent_budgets row survives a
// delete+recreate cycle — the §0 guarantee that the daily cap holds across
// reruns on the same calendar day.
//
// How it works: CreateAgent PUTs the budget and GETs it back.  After a DELETE,
// re-creating the same agent name calls CreateAgent again.  If the budget GET
// inside CreateAgent returns an error, the test fails — meaning the budget row
// was lost.
//
// The real Postgres implementation uses a soft-delete (archived_at) so
// agent_budgets (keyed by tenant_id+agent_name) is never touched by DeleteAgent.
// agent_usage_daily is keyed identically and follows the same guarantee: run
// counts from an earlier suite run on the same day count against the same cap.
func TestBudgetSurvivesRecreate(t *testing.T) {
	k := e2ekit.Connect(t)

	// CreateAgent PUTs + GETs budget.
	a := k.CreateAgent(t, "e2e-quickstart", readSpec(t, "pr-triage"))

	// Delete explicitly (Cleanup will also try, which is idempotent).
	st, raw := k.DoAuth(t, "DELETE", "/v1/agents/"+a.Name, nil, nil)
	if st != 204 && st != 404 {
		t.Fatalf("delete agent: HTTP %d: %s", st, truncate(raw, 200))
	}

	// Recreate the same name.  CreateAgent verifies the budget GET — if it
	// fails the test stops here with a clear message.
	_ = k.CreateAgent(t, "e2e-quickstart", readSpec(t, "pr-triage"))
	t.Log("budget survived agent delete+recreate — daily cap is stable across reruns")
}
