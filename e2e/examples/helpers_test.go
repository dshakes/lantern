//go:build e2e

// Package examples_e2e drives the webhook-triggered examples (pr-triage-webhook,
// incident-responder) end to end against a LIVE control-plane that runs on
// fixtures: signed provider webhook -> POST /v1/hooks/{id} -> workflow run ->
// connector calls recorded by cmd/connector-replay.
//
// Needs the fixture stack from scripts/e2e-examples.sh (or equivalent):
//
//	PAL_E2E_API_URL               control-plane started with
//	                                  PAL_CONNECTOR_BASEURL_{SLACK,GITHUB,SENTRY,PAGERDUTY}
//	                                  and PAL_LLM_BASEURL_{OPENAI,ANTHROPIC}
//	PAL_E2E_CONNECTOR_REPLAY_URL  that connector-replay (default http://127.0.0.1:9191)
//	PAL_E2E_LLM_REPLAY_URL        that llm-replay, started with the example's
//	                                  fixtures/llm-rules.json (default http://127.0.0.1:9192)
//
// The tests install connectors in the target tenant, so they refuse to overwrite
// an install they did not create. Spend policy: e2ekit (e2e-* names, hard-fail
// budget); with the fixture LLM no provider is ever called.
package examples_e2e

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dshakes/pal/e2e/internal/e2ekit"
)

func TestMain(m *testing.M) {
	e2ekit.Sweep(e2ekit.DefaultBase(), e2ekit.DefaultEmail(), e2ekit.DefaultPassword())
	os.Exit(m.Run())
}

const fixtureDisplayPrefix = "e2e fixture "

func readFile(t *testing.T, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile("../../examples/" + rel)
	if err != nil {
		t.Fatalf("read examples/%s: %v", rel, err)
	}
	return b
}

func readJSON(t *testing.T, rel string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(readFile(t, rel), &m); err != nil {
		t.Fatalf("parse examples/%s: %v", rel, err)
	}
	return m
}

// ---- fixture servers ----

type replayReq struct {
	Method string              `json:"method"`
	Path   string              `json:"path"`
	Body   string              `json:"body"`
	Header map[string][]string `json:"header"`
}

func replayURL(env, def string) string {
	return strings.TrimRight(e2ekit.EnvOr(env, def), "/")
}

// fetchReplay reads GET /__requests from a connector-replay or llm-replay server.
func fetchReplay(t *testing.T, base string) []replayReq {
	t.Helper()
	resp, err := http.Get(base + "/__requests")
	if err != nil {
		t.Fatalf("fixture server %s not reachable: %v (start it with scripts/e2e-examples.sh)", base, err)
	}
	defer resp.Body.Close()
	var out []replayReq
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode %s/__requests: %v", base, err)
	}
	return out
}

// newRequests returns the requests recorded after the first `before` ones.
func newRequests(t *testing.T, base string, before int) []replayReq {
	t.Helper()
	all := fetchReplay(t, base)
	if len(all) < before {
		return all
	}
	return all[before:]
}

func find(reqs []replayReq, method, path string) []replayReq {
	var out []replayReq
	for _, r := range reqs {
		if r.Method == method && r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

func bodyJSON(t *testing.T, r replayReq) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(r.Body), &m); err != nil {
		t.Fatalf("outbound body is not JSON: %q", r.Body)
	}
	return m
}

// ---- tenant setup ----

type stack struct {
	kit       *e2ekit.Kit
	connector string // connector-replay URL
	llm       string // llm-replay URL
	tok       string // cached login token (login is rate limited)
}

var (
	stackMu     sync.Mutex
	cachedStack *stack
)

// connect logs in once per test binary: the API rate-limits logins (429) and
// seven tests would otherwise exceed it.
func connect(t *testing.T) *stack {
	t.Helper()
	stackMu.Lock()
	defer stackMu.Unlock()
	if cachedStack != nil {
		return cachedStack
	}
	k := e2ekit.Connect(t)
	s := &stack{
		kit:       k,
		connector: replayURL("PAL_E2E_CONNECTOR_REPLAY_URL", "http://127.0.0.1:9191"),
		llm:       replayURL("PAL_E2E_LLM_REPLAY_URL", "http://127.0.0.1:9192"),
	}
	// Both must be up: a run against anything else would hit real SaaS / a real model.
	fetchReplay(t, s.connector)
	fetchReplay(t, s.llm)
	cachedStack = s
	return s
}

// installConnector installs a fixture-credentialed connector, refusing to
// overwrite one it did not create, and removes it on cleanup.
func (s *stack) installConnector(t *testing.T, id, tokenField string) {
	t.Helper()
	var installed []struct {
		ConnectorID string `json:"connectorId"`
		DisplayName string `json:"displayName"`
	}
	st, raw := s.kit.DoAuth(t, http.MethodGet, "/v1/connectors", nil, &installed)
	if st != http.StatusOK {
		t.Fatalf("list connectors: HTTP %d: %s", st, raw)
	}
	for _, c := range installed {
		if c.ConnectorID == id && !strings.HasPrefix(c.DisplayName, fixtureDisplayPrefix) {
			t.Fatalf("refusing to overwrite the real %q connector install (%q) - run against a throwaway stack", id, c.DisplayName)
		}
	}
	st, raw = s.kit.DoAuth(t, http.MethodPost, "/v1/connectors/install", map[string]any{
		"connectorId": id, "displayName": fixtureDisplayPrefix + id,
		"config": map[string]any{tokenField: "fixture-token"},
	}, nil)
	if st != http.StatusOK && st != http.StatusCreated {
		t.Fatalf("install %s: HTTP %d: %s", id, st, raw)
	}
	t.Cleanup(func() { s.kit.DoAuth(t, http.MethodDelete, "/v1/connectors/"+id, nil, nil) })
}

// setupAgent creates the e2e agent and saves the example's workflow on it.
func (s *stack) setupAgent(t *testing.T, name, example string) *e2ekit.Agent {
	t.Helper()
	a := s.kit.CreateAgent(t, name, map[string]any{
		"description":  "e2e fixture of examples/" + example,
		"systemPrompt": "Workflow agent: see examples/" + example + "/workflow.json.",
	})
	st, raw := s.kit.DoAuth(t, http.MethodPut, "/v1/agents/"+name+"/workflow", readJSON(t, example+"/workflow.json"), nil)
	if st != http.StatusOK && st != http.StatusNoContent {
		t.Fatalf("save workflow: HTTP %d: %s", st, raw)
	}
	applyProposedPolicy(t, s.kit, name)
	return a
}

// applyProposedPolicy grants a new (default-deny, ADR 0055) agent exactly what
// its workflow needs: propose → apply → verify by read-back, the same flow a
// user confirms in the dashboard Security tab (and `pal deploy` runs for a new agent).
func applyProposedPolicy(t *testing.T, k *e2ekit.Kit, name string) {
	t.Helper()
	var prop struct {
		Proposal map[string]any `json:"proposal"`
	}
	st, raw := k.DoAuth(t, http.MethodPost, "/v1/agents/"+name+"/policy/propose", nil, &prop)
	if st != http.StatusOK {
		t.Fatalf("propose policy: HTTP %d: %s", st, raw)
	}
	var got struct {
		Policy map[string]any `json:"policy"`
	}
	st, raw = k.DoAuth(t, http.MethodPut, "/v1/agents/"+name+"/policy", prop.Proposal, &got)
	if st != http.StatusOK {
		t.Fatalf("apply policy: HTTP %d: %s", st, raw)
	}
	if fmt.Sprint(got.Policy["connectors"]) != fmt.Sprint(prop.Proposal["connectors"]) ||
		fmt.Sprint(got.Policy["tools"]) != fmt.Sprint(prop.Proposal["tools"]) {
		t.Fatalf("policy read-back %v != proposal %v", got.Policy, prop.Proposal)
	}
}

type hook struct{ ID, Secret string }

// createHook creates a trigger from the example's trigger JSON.
func (s *stack) createHook(t *testing.T, agent, triggerFile string) hook {
	t.Helper()
	var out struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
	}
	st, raw := s.kit.DoAuth(t, http.MethodPost, "/v1/agents/"+agent+"/triggers", readJSON(t, triggerFile), &out)
	if st != http.StatusCreated || out.ID == "" || out.Secret == "" {
		t.Fatalf("create trigger from %s: HTTP %d: %s", triggerFile, st, raw)
	}
	return hook{out.ID, out.Secret}
}

// ---- signing + delivery ----

func hmacHex(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// deliver POSTs body to the public hook URL with the given headers.
func deliver(t *testing.T, id string, hdr map[string]string, body []byte) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, e2ekit.DefaultBase()+"/v1/hooks/"+id, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp.StatusCode, m
}

// ---- run inspection ----

func (s *stack) getRun(t *testing.T, id string) map[string]any {
	t.Helper()
	var m map[string]any
	if st, raw := s.kit.DoAuth(t, http.MethodGet, "/v1/runs/"+id, nil, &m); st != http.StatusOK {
		t.Fatalf("get run %s: HTTP %d: %s", id, st, raw)
	}
	return m
}

// waitStatus polls until the run reaches want (failing fast on any other terminal status).
func (s *stack) waitStatus(t *testing.T, id, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		m := s.getRun(t, id)
		st, _ := m["status"].(string)
		if st == want {
			return m
		}
		if st == "succeeded" || st == "failed" || st == "cancelled" {
			t.Fatalf("run %s ended %q, want %q: %v", id, st, want, m["error"])
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("run %s never reached %q", id, want)
	return nil
}

// journal returns "kind:stepId" for every journal event, read from the SSE
// stream. A parked run's stream stays open, so it is read for a short window.
func (s *stack) journal(t *testing.T, id string) []string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e2ekit.DefaultBase()+"/v1/runs/"+id+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+s.token(t))
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body) // a timeout mid-stream returns what arrived
	var out []string
	var kind string
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "event: "):
			kind = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			var d struct {
				StepID string `json:"stepId"`
			}
			_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &d)
			out = append(out, fmt.Sprintf("%s:%s", kind, d.StepID))
		}
	}
	return out
}

func (s *stack) token(t *testing.T) string {
	t.Helper()
	if s.tok != "" {
		return s.tok
	}
	var out struct {
		Token string `json:"token"`
	}
	body, _ := json.Marshal(map[string]string{"email": e2ekit.DefaultEmail(), "password": e2ekit.DefaultPassword()})
	resp, err := http.Post(e2ekit.DefaultBase()+"/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" {
		t.Fatal("login returned no token")
	}
	s.tok = out.Token
	return out.Token
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// awaitApproval waits for the run to park at the approval node and returns the
// pending takeover id. (A parked run's status is not a stable string in the run
// API, so the pending takeover row is the signal.)
func (s *stack) awaitApproval(t *testing.T, runID string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var rows []struct {
			ID     string `json:"id"`
			StepID string `json:"stepId"`
			Status string `json:"status"`
		}
		s.kit.DoAuth(t, http.MethodGet, "/v1/runs/"+runID+"/takeover", nil, &rows)
		for _, r := range rows {
			if r.Status == "pending" && r.StepID == "approve" {
				return r.ID
			}
		}
		if st, _ := s.getRun(t, runID)["status"].(string); st == "failed" || st == "succeeded" {
			t.Fatalf("run %s ended %q before reaching the approval", runID, st)
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("run %s never parked at the approval node", runID)
	return ""
}

func uniq(prefix string) string { return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano()) }
