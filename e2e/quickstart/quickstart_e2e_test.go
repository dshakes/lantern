//go:build e2e

// Package quickstart_e2e is the guard that the examples/quickstart/ agents
// stay GENUINELY RUNNABLE against a LIVE local stack: real HTTP on :8080, real
// JWT auth, real Postgres rows, the real inline executor — no httptest, no
// mocks. Each test creates the agent from its committed spec.json, posts the
// committed run.json, polls to terminal, and asserts status == "succeeded"
// plus a real output-shape invariant for that example.
//
// This is the regression gate behind the README walkthroughs: if the inline
// executor stops producing structured output, or the receipt path regresses,
// these go red.
//
// Preconditions (see e2e/README.md):
//   - make dev-infra        (Postgres + Redis + MinIO)
//   - make run-api          (control-plane on :8080)
//   - LLM providers configured for the dev tenant (anthropic/openai)
//
// When :8080 is unreachable every test SKIPS with a clear message so CI stays
// green when the stack is down. A reachable API with broken dev credentials —
// or a stack with no LLM provider configured (runs end "failed") — is a real
// failure, not a skip.
//
// Override the target / credentials with:
//
//	LANTERN_E2E_API_URL   (default http://localhost:8080)
//	LANTERN_E2E_EMAIL     (default admin@lantern.dev)
//	LANTERN_E2E_PASSWORD  (default lantern)
package quickstart_e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- config ----------

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func baseURL() string {
	return strings.TrimRight(envOr("LANTERN_E2E_API_URL", "http://localhost:8080"), "/")
}

// examplesDir resolves examples/quickstart/ relative to this test file's
// module, which lives at <repo>/e2e/quickstart. So the specs are two levels up.
func examplesDir() string {
	return filepath.Join("..", "..", "examples", "quickstart")
}

// ---------- stack probe (skip-not-fail when the stack is down) ----------

var (
	probeOnce sync.Once
	probeErr  error
)

func requireStack(t *testing.T) {
	t.Helper()
	probeOnce.Do(func() {
		c := &http.Client{Timeout: 2 * time.Second}
		resp, err := c.Get(baseURL() + "/healthz")
		if err != nil {
			probeErr = err
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			probeErr = fmt.Errorf("healthz returned HTTP %d", resp.StatusCode)
		}
	})
	if probeErr != nil {
		t.Skipf("SKIP: control-plane not reachable at %s (%v) — start it with `make dev-infra` + `make run-api`, then re-run `make test-e2e`", baseURL(), probeErr)
	}
}

// ---------- tiny API client ----------

type apiClient struct {
	t        *testing.T
	http     *http.Client
	token    string
	tenantID string
}

func newClient(t *testing.T) *apiClient {
	t.Helper()
	requireStack(t)
	c := &apiClient{t: t, http: &http.Client{Timeout: 60 * time.Second}}
	c.login()
	return c
}

func (c *apiClient) login() {
	c.t.Helper()
	body := map[string]string{
		"email":    envOr("LANTERN_E2E_EMAIL", "admin@lantern.dev"),
		"password": envOr("LANTERN_E2E_PASSWORD", "lantern"),
	}
	var resp struct {
		Token string `json:"token"`
		User  struct {
			TenantID string `json:"tenantId"`
		} `json:"user"`
	}
	status, _ := c.doJSON(http.MethodPost, "/auth/login", body, &resp, false)
	if status != http.StatusOK {
		c.t.Fatalf("login failed: HTTP %d (stack is up but dev credentials rejected — is the dev tenant seeded?)", status)
	}
	if resp.Token == "" || resp.User.TenantID == "" {
		c.t.Fatalf("login returned empty token/tenant: %+v", resp)
	}
	c.token = resp.Token
	c.tenantID = resp.User.TenantID
}

// doJSON issues a request with an optional JSON body, decodes the JSON response
// into out (when non-nil and the body is valid JSON), and returns the HTTP
// status plus the raw body. The raw body is returned because some run echoes
// embed unescaped newlines in input strings — callers that only need a couple
// of fields decode tolerantly, see decodeLoose.
func (c *apiClient) doJSON(method, path string, body any, out any, auth bool) (int, []byte) {
	c.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal request body: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, baseURL()+path, rdr)
	if err != nil {
		c.t.Fatalf("build request %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		c.t.Fatalf("%s %s: read body: %v", method, path, err)
	}
	if out != nil && len(raw) > 0 {
		// Best-effort decode; callers assert on status when this fails.
		_ = json.Unmarshal(raw, out)
	}
	return resp.StatusCode, raw
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// ---------- example fixtures ----------

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

// createAgent posts the spec; 201 (created) or 409/200 (already exists) are
// both fine — these examples are named, durable agents.
func (c *apiClient) createAgent(spec map[string]any) {
	c.t.Helper()
	status, raw := c.doJSON(http.MethodPost, "/v1/agents", spec, nil, true)
	switch status {
	case http.StatusCreated, http.StatusOK, http.StatusConflict:
	default:
		c.t.Fatalf("create agent: HTTP %d: %s", status, truncate(raw, 300))
	}
}

// runExampleIsolated creates a UNIQUELY-NAMED copy of the example agent and runs
// it. The guard must NOT reuse the durable demo agent: the README walkthroughs
// set a tight per-day budget on it (pr-triage caps $0.50/day to demo the 402),
// so a shared name accumulates spend across runs and eventually 402s — a flaky
// guard. A fresh per-run name (no budget) makes the guard deterministic. The
// agent is deleted on cleanup.
func (c *apiClient) runExampleIsolated(name string) map[string]any {
	c.t.Helper()
	spec := readSpec(c.t, name)
	run := readRun(c.t, name)
	unique := fmt.Sprintf("%s-e2e-%d", name, time.Now().UnixNano())
	spec["name"] = unique
	run["agentName"] = unique
	c.createAgent(spec)
	c.t.Cleanup(func() { _, _ = c.doJSON(http.MethodDelete, "/v1/agents/"+unique, nil, nil, true) })
	return c.runToTerminal(run)
}

// runToTerminal posts the run body and polls until the run is terminal,
// returning the parsed run map (decoded loosely so an unescaped-newline echo in
// `input` doesn't break the poll). Fails the test if the run does not reach
// "succeeded" before the deadline.
func (c *apiClient) runToTerminal(run map[string]any) map[string]any {
	c.t.Helper()
	var created struct {
		ID string `json:"id"`
	}
	status, raw := c.doJSON(http.MethodPost, "/v1/runs", run, &created, true)
	if status != http.StatusCreated {
		c.t.Fatalf("POST /v1/runs: HTTP %d: %s", status, truncate(raw, 300))
	}
	if created.ID == "" {
		c.t.Fatalf("run create returned no id: %s", truncate(raw, 300))
	}

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		_, body := c.doJSON(http.MethodGet, "/v1/runs/"+created.ID, nil, nil, true)
		m := decodeLoose(c.t, body)
		st, _ := m["status"].(string)
		switch st {
		case "succeeded":
			return m
		case "failed", "cancelled":
			c.t.Fatalf("run %s ended %q (is an LLM provider configured for the dev tenant?): %s",
				created.ID, st, truncate(body, 400))
		}
		time.Sleep(2 * time.Second)
	}
	c.t.Fatalf("run %s did not reach terminal state within deadline", created.ID)
	return nil
}

// decodeLoose parses a run JSON body into a map. Go's encoding/json accepts the
// raw control bytes (unescaped newlines in the echoed `input` strings) that
// stricter parsers reject, so a plain Unmarshal is sufficient here.
func decodeLoose(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode run body: %v: %s", err, truncate(body, 300))
	}
	return m
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

// ---------- tests ----------

// TestExample_PRTriage proves the pr-triage example runs and emits structured
// JSON with a "risk" key — the README's load-bearing invariant.
func TestExample_PRTriage(t *testing.T) {
	c := newClient(t)
	run := c.runExampleIsolated("pr-triage")

	result := grabResult(t, run)
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
	c := newClient(t)
	run := c.runExampleIsolated("incident-summarizer")

	result := grabResult(t, run)
	for _, want := range []string{"## Severity", "## Timeline", "## Next actions"} {
		if !strings.Contains(result, want) {
			t.Fatalf("incident-summarizer output missing %q section:\n%s", want, result)
		}
	}

	runID, _ := run["id"].(string)
	if runID == "" {
		t.Fatal("run has no id; cannot issue receipt")
	}

	// Issue the receipt (auth required).
	var receipt map[string]any
	status, raw := c.doJSON(http.MethodPost, "/v1/runs/"+runID+"/receipt", nil, &receipt, true)
	if status != http.StatusOK {
		t.Fatalf("issue receipt: HTTP %d: %s", status, truncate(raw, 300))
	}
	if receipt["algorithm"] == nil || receipt["signature"] == nil {
		t.Fatalf("receipt missing algorithm/signature: %s", truncate(raw, 300))
	}

	// Verify it through the PUBLIC no-auth endpoint (auth=false).
	var verify struct {
		Valid bool `json:"valid"`
	}
	vstatus, vraw := c.doJSON(http.MethodPost, "/v1/runs/receipts/verify", receipt, &verify, false)
	if vstatus != http.StatusOK {
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
	c := newClient(t)
	run := c.runExampleIsolated("daily-standup-digest")

	result := grabResult(t, run)
	for _, want := range []string{"## Shipped", "## In progress", "## Blockers"} {
		if !strings.Contains(result, want) {
			t.Fatalf("daily-standup-digest output missing %q section:\n%s", want, result)
		}
	}
	t.Logf("daily-standup-digest produced a digest (%d chars)", len(result))
}

// extractJSON returns the first {...} object in s. The pr-triage prompt asks
// for raw JSON, but a model may occasionally wrap it in prose or a code fence;
// the README's contract is "output parses as JSON with a risk key", so we
// extract the object rather than demanding byte-exact rawness.
func extractJSON(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < 0 || end < start {
		return s
	}
	return s[start : end+1]
}
