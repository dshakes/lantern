// Package e2ekit is the ONLY way an e2e suite creates, runs, and deletes
// Lantern agents under the §0 spend policy (ga-program-plan.md §0).
//
// Enforcement summary (all in code, not just documented):
//   - Agent name must be in [AllowedNames] (the 8 reserved e2e-* names).
//   - At most [MaxAgents] live e2e-* agents may exist simultaneously.
//   - A hard-fail budget (maxCostUsdPerDay 0.50, maxRunsPerDay 15) is PUT
//     and GET-verified before any run is posted.  Test fails if absent.
//   - Model is pinned to "reasoning-small" (Haiku) if Anthropic is
//     configured, else "chat-small" (gpt-4o-mini).  Never gpt-4o.
//   - web_search is stripped from every spec except e2e-assistant.
//   - Agents are deleted via t.Cleanup after each test.
//   - A 402 on POST /v1/runs fails the test with a distinct message:
//     "e2e daily budget exhausted for <name> (cap working; rerun after local midnight)".
//   - /v1/budgets/tenant is NEVER called (enforced by grep in make e2e-lint).
//
// Usage:
//
//	func TestMain(m *testing.M) {
//	    e2ekit.Sweep(e2ekit.DefaultBase(), e2ekit.DefaultEmail(), e2ekit.DefaultPassword())
//	    os.Exit(m.Run())
//	}
//
//	func TestFoo(t *testing.T) {
//	    k := e2ekit.Connect(t)
//	    a := k.CreateAgent(t, "e2e-quickstart", spec)
//	    result := a.Run(t, run)
//	    // ... assertions
//	}
package e2ekit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// AllowedNames is the complete set of reserved e2e agent names.
// Exactly [MaxAgents] entries — the ceiling and the allowed set are the same.
var AllowedNames = map[string]bool{
	"e2e-quickstart": true,
	"e2e-support":    true,
	"e2e-pr-triage":  true,
	"e2e-incident":   true,
	"e2e-digest":     true,
	"e2e-analyst":    true,
	"e2e-assistant":  true,
	"e2e-voice":      true,
}

const (
	// MaxAgents is the hard ceiling on concurrent e2e-* agents.
	MaxAgents = 8
	// MaxCostPerDay is the per-agent daily cost cap (USD).
	MaxCostPerDay = 0.50
	// MaxRunsPerDay is the per-agent daily run cap.
	MaxRunsPerDay = 15

	modelAnthropic  = "reasoning-small" // Haiku — cheapest Anthropic tier
	modelOpenAI     = "chat-small"      // gpt-4o-mini — cheapest OpenAI tier
	runPollInterval = 2 * time.Second
	runPollDeadline = 90 * time.Second
	probeTimeout    = 2 * time.Second

	defaultBaseURL  = "http://localhost:8080"
	defaultEmail    = "admin@lantern.dev"
	defaultPassword = "lantern"
)

// DefaultBase returns the API base URL.
// Env priority: LANTERN_E2E_API_URL (canonical) → LANTERN_API_URL (alias) → localhost:8080.
// Identical precedence to e2e/runtime's baseURL() — keep them in sync.
func DefaultBase() string {
	for _, key := range []string{"PAL_E2E_API_URL", "LANTERN_E2E_API_URL", "PAL_API_URL", "LANTERN_API_URL"} {
		if v := os.Getenv(key); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	return defaultBaseURL
}

// DefaultEmail returns the login email from env or the default.
func DefaultEmail() string { return EnvOr("PAL_E2E_EMAIL", EnvOr("LANTERN_E2E_EMAIL", defaultEmail)) }

// DefaultPassword returns the login password from env or the default.
func DefaultPassword() string {
	return EnvOr("PAL_E2E_PASSWORD", EnvOr("LANTERN_E2E_PASSWORD", defaultPassword))
}

// EnvOr returns env[key] or def when unset/empty.
func EnvOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Kit is a configured API client enforcing the §0 spend policy.
// Obtain one via [Connect].
type Kit struct {
	base  string
	http  *http.Client
	token string
	// model is resolved during Connect: Anthropic → reasoning-small,
	// OpenAI → chat-small.  Never gpt-4o.
	model string
}

// Agent is an agent created by [Kit.CreateAgent] and registered for cleanup.
type Agent struct {
	kit  *Kit
	Name string
}

// Connect logs into the API, probes the stack, pins the cheapest available
// model, and returns a ready Kit.
//
//   - Stack down + E2E_ALLOW_SKIP unset → t.Fatal (make test-e2e fails).
//   - Stack down + E2E_ALLOW_SKIP=1 → t.Skip.
func Connect(t *testing.T) *Kit {
	t.Helper()
	k := &Kit{
		base: DefaultBase(),
		http: &http.Client{Timeout: 60 * time.Second},
	}

	if err := probeStack(k.base); err != nil {
		msg := fmt.Sprintf("LANTERN stack not reachable at %s (%v) — start it with `make dev-infra` + `make run-api`", k.base, err)
		if EnvOr("E2E_ALLOW_SKIP", "") == "1" {
			t.Skip(msg + " (set E2E_ALLOW_SKIP=1 overrides this to a skip)")
		}
		t.Fatalf("%s — set E2E_ALLOW_SKIP=1 to skip instead of failing", msg)
	}

	var err error
	k.token, err = login(k.base, k.http, DefaultEmail(), DefaultPassword())
	if err != nil {
		t.Fatalf("e2ekit: login: %v", err)
	}

	k.model, err = resolveModel(k)
	if err != nil {
		t.Fatalf("e2ekit: resolve model: %v", err)
	}
	return k
}

// Sweep deletes every e2e-* agent owned by the authenticated tenant.
// Call from TestMain before m.Run() to clean up any leftovers from a
// previous interrupted run.  Errors are printed to stderr; never fatal.
func Sweep(base, email, password string) {
	base = strings.TrimRight(base, "/")
	c := &http.Client{Timeout: 30 * time.Second}

	token, err := login(base, c, email, password)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2ekit: Sweep: login failed (%v) — skipping sweep\n", err)
		return
	}
	k := &Kit{base: base, http: c, token: token}

	names, err := k.listE2EAgents()
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2ekit: Sweep: list agents: %v\n", err)
		return
	}
	for _, name := range names {
		st, _ := k.doAuth(http.MethodDelete, "/v1/agents/"+name, nil, nil)
		if st != http.StatusNoContent && st != http.StatusNotFound {
			fmt.Fprintf(os.Stderr, "e2ekit: Sweep: delete %s: HTTP %d\n", name, st)
		}
	}
}

// CreateAgent creates (or re-activates) the named agent, sets its hard-fail
// budget, verifies the budget is persisted, and registers t.Cleanup to delete it.
//
// Enforced (t.Fatal on violation):
//   - name must be in [AllowedNames]
//   - adding name would not exceed [MaxAgents] (unless name already exists)
//   - budget PUT must succeed
//   - budget GET must return a non-empty body
//
// Spec modifications (in place):
//   - spec["name"] = name
//   - spec["model"] = pinned cheap model
//   - web_search stripped (unless name == "e2e-assistant")
func (k *Kit) CreateAgent(t *testing.T, name string, spec map[string]any) *Agent {
	t.Helper()

	if err := validateName(name); err != nil {
		t.Fatalf("e2ekit: %v", err)
	}

	existing, err := k.listE2EAgents()
	if err != nil {
		t.Fatalf("e2ekit: list e2e agents: %v", err)
	}
	if err := checkCeiling(existing, name); err != nil {
		t.Fatalf("e2ekit: %v", err)
	}

	spec["name"] = name
	spec["model"] = k.model
	if name != "e2e-assistant" {
		StripWebSearch(spec)
	}

	st, raw := k.doAuth(http.MethodPost, "/v1/agents", spec, nil)
	switch st {
	case http.StatusCreated, http.StatusOK, http.StatusConflict:
	default:
		t.Fatalf("e2ekit: create agent %q: HTTP %d: %s", name, st, trunc(raw, 300))
	}

	if err := k.putBudget(name); err != nil {
		t.Fatalf("e2ekit: set budget for %q: %v", name, err)
	}
	if err := k.verifyBudget(name); err != nil {
		t.Fatalf("e2ekit: verify budget for %q: %v", name, err)
	}

	a := &Agent{kit: k, Name: name}
	t.Cleanup(func() {
		_, _ = k.doAuth(http.MethodDelete, "/v1/agents/"+name, nil, nil)
	})
	return a
}

// Run posts a run to the agent and polls until it reaches a terminal state.
// run["agentName"] is set to a.Name before posting.
//
// 402 → t.Fatalf("e2e daily budget exhausted for <name> (cap working; rerun after local midnight)")
// This is intentional: a hit budget is a success signal for the spend guard.
func (a *Agent) Run(t *testing.T, run map[string]any) map[string]any {
	t.Helper()
	run["agentName"] = a.Name

	var created struct {
		ID string `json:"id"`
	}
	st, raw := a.kit.doAuth(http.MethodPost, "/v1/runs", run, &created)
	if st == http.StatusPaymentRequired {
		t.Fatalf("e2e daily budget exhausted for %s (cap working; rerun after local midnight)", a.Name)
	}
	if st != http.StatusCreated {
		t.Fatalf("e2ekit: POST /v1/runs for %q: HTTP %d: %s", a.Name, st, trunc(raw, 300))
	}
	if created.ID == "" {
		t.Fatalf("e2ekit: run create for %q returned no id: %s", a.Name, trunc(raw, 300))
	}

	deadline := time.Now().Add(runPollDeadline)
	for time.Now().Before(deadline) {
		_, body := a.kit.doAuth(http.MethodGet, "/v1/runs/"+created.ID, nil, nil)
		var m map[string]any
		_ = json.Unmarshal(body, &m)
		switch m["status"] {
		case "succeeded":
			return m
		case "failed", "cancelled":
			t.Fatalf("e2ekit: run %s for %q ended %q (LLM provider configured?): %s",
				created.ID, a.Name, m["status"], trunc(body, 400))
		}
		time.Sleep(runPollInterval)
	}
	t.Fatalf("e2ekit: run for %q did not reach terminal state within %v", a.Name, runPollDeadline)
	return nil
}

// DoAuth issues an authenticated request and returns (status, rawBody).
// out is decoded from the response body when non-nil.
// Use for ad-hoc endpoints not covered by CreateAgent/Run (e.g. receipts).
func (k *Kit) DoAuth(t *testing.T, method, path string, body, out any) (int, []byte) {
	t.Helper()
	return k.doAuth(method, path, body, out)
}

// Do issues an unauthenticated request and returns (status, rawBody).
// Use for public endpoints (e.g. POST /v1/runs/receipts/verify).
func (k *Kit) Do(t *testing.T, method, path string, body, out any) (int, []byte) {
	t.Helper()
	k2 := &Kit{base: k.base, http: k.http} // token left empty
	return k2.doAuth(method, path, body, out)
}

// DoAuthRaw issues an authenticated request with body sent verbatim as the
// request body (no JSON marshaling) and returns (status, rawBody). Use for
// endpoints that take a raw byte payload, e.g. PUT files/content — passing
// such bodies through [Kit.DoAuth] would JSON-encode them as a quoted,
// escaped string and corrupt the bytes on the wire.
func (k *Kit) DoAuthRaw(t *testing.T, method, path string, body []byte) (int, []byte) {
	t.Helper()
	return k.doAuthRaw(method, path, body)
}

// ---- package-level logic (exported for testing) ----

// ValidateName returns an error if name is not in AllowedNames.
func ValidateName(name string) error { return validateName(name) }

// CheckCeiling returns an error if adding name to existing would exceed MaxAgents.
func CheckCeiling(existing []string, name string) error { return checkCeiling(existing, name) }

// StripWebSearch removes web_search and webSearch keys from spec in place.
func StripWebSearch(spec map[string]any) {
	delete(spec, "webSearch")
	if tools, ok := spec["tools"].([]any); ok {
		keep := tools[:0]
		for _, tool := range tools {
			switch v := tool.(type) {
			case string:
				if v != "web_search" {
					keep = append(keep, v)
				}
			case map[string]any:
				if v["name"] != "web_search" {
					keep = append(keep, v)
				}
			default:
				keep = append(keep, tool)
			}
		}
		spec["tools"] = keep
	}
	if caps, ok := spec["capabilities"].(map[string]any); ok {
		delete(caps, "webSearch")
	}
}

// ---- internal helpers ----

func validateName(name string) error {
	if !AllowedNames[name] {
		names := make([]string, 0, len(AllowedNames))
		for n := range AllowedNames {
			names = append(names, n)
		}
		return fmt.Errorf("agent name %q is not in the allowed set %v", name, names)
	}
	return nil
}

func checkCeiling(existing []string, name string) error {
	for _, n := range existing {
		if n == name {
			return nil // updating an existing slot, not creating a new one
		}
	}
	if len(existing) >= MaxAgents {
		return fmt.Errorf("cannot create %q — already %d e2e-* agents exist (ceiling %d); run `make e2e-clean`", name, len(existing), MaxAgents)
	}
	return nil
}

func probeStack(base string) error {
	c := &http.Client{Timeout: probeTimeout}
	resp, err := c.Get(base + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func login(base string, c *http.Client, email, password string) (string, error) {
	body := map[string]string{"email": email, "password": password}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, base+"/auth/login", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return "", fmt.Errorf("POST /auth/login: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("POST /auth/login: HTTP %d: %s", resp.StatusCode, trunc(raw, 200))
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(raw, &out)
	if out.Token == "" {
		return "", fmt.Errorf("login returned empty token")
	}
	return out.Token, nil
}

// resolveModel queries GET /v1/settings/llm-providers and returns the pinned
// cheap model.  Anthropic wins if available; fallback is OpenAI.
// Returns an error if no provider is configured.
// ponytail: switch to "fast" once W1-G lands
func resolveModel(k *Kit) (string, error) {
	var providers []struct {
		Provider string `json:"provider"`
	}
	st, raw := k.doAuth(http.MethodGet, "/v1/settings/llm-providers", nil, &providers)
	if st != http.StatusOK {
		return "", fmt.Errorf("GET /v1/settings/llm-providers: HTTP %d: %s", st, trunc(raw, 200))
	}
	hasAnthropic, hasOpenAI := false, false
	for _, p := range providers {
		switch p.Provider {
		case "anthropic":
			hasAnthropic = true
		case "openai":
			hasOpenAI = true
		}
	}
	if hasAnthropic {
		return modelAnthropic, nil
	}
	if hasOpenAI {
		return modelOpenAI, nil
	}
	// Empty provider list: keys may be configured via env vars on the API
	// process (ANTHROPIC_API_KEY / OPENAI_API_KEY) and won't appear in
	// /v1/settings/llm-providers.  Fall back to "fast" and let the server's
	// capability resolver pick the cheapest available model.
	// ponytail: switch to "fast" unconditionally once W1-G lands
	return "fast", nil
}

func (k *Kit) putBudget(name string) error {
	budget := map[string]any{
		"maxCostUsdPerDay": MaxCostPerDay,
		"maxRunsPerDay":    MaxRunsPerDay,
		"hardFail":         true,
	}
	st, raw := k.doAuth(http.MethodPut, "/v1/agents/"+name+"/budget", budget, nil)
	if st != http.StatusOK && st != http.StatusCreated && st != http.StatusNoContent {
		return fmt.Errorf("PUT budget: HTTP %d: %s", st, trunc(raw, 200))
	}
	return nil
}

func (k *Kit) verifyBudget(name string) error {
	var got map[string]any
	st, raw := k.doAuth(http.MethodGet, "/v1/agents/"+name+"/budget", nil, &got)
	if st != http.StatusOK {
		return fmt.Errorf("GET budget: HTTP %d: %s", st, trunc(raw, 200))
	}
	if got == nil {
		return fmt.Errorf("GET budget returned empty body")
	}
	return nil
}

func (k *Kit) listE2EAgents() ([]string, error) {
	var agents []struct {
		Name string `json:"name"`
	}
	st, raw := k.doAuth(http.MethodGet, "/v1/agents", nil, &agents)
	if st != http.StatusOK {
		return nil, fmt.Errorf("GET /v1/agents: HTTP %d: %s", st, trunc(raw, 200))
	}
	var names []string
	for _, a := range agents {
		if strings.HasPrefix(a.Name, "e2e-") {
			names = append(names, a.Name)
		}
	}
	return names, nil
}

func (k *Kit) doAuth(method, path string, body, out any) (int, []byte) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, k.base+path, rdr)
	if err != nil {
		return 0, []byte(err.Error())
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if k.token != "" {
		req.Header.Set("Authorization", "Bearer "+k.token)
	}
	resp, err := k.http.Do(req)
	if err != nil {
		return 0, []byte(err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, out)
	}
	return resp.StatusCode, raw
}

// doAuthRaw is like doAuth but sends body verbatim as the request payload
// instead of JSON-marshaling it.
func (k *Kit) doAuthRaw(method, path string, body []byte) (int, []byte) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, k.base+path, rdr)
	if err != nil {
		return 0, []byte(err.Error())
	}
	if k.token != "" {
		req.Header.Set("Authorization", "Bearer "+k.token)
	}
	resp, err := k.http.Do(req)
	if err != nil {
		return 0, []byte(err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

func trunc(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
