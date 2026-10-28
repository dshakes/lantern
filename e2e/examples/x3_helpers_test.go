//go:build e2e

// Helpers for digest_test.go, telegram_test.go and voice_test.go, which drive the
// daily-digest, telegram-assistant and voice-receptionist examples against a
// live local stack whose LLM and SaaS connectors are fixtures (see
// scripts/e2e-examples.sh). Nothing here reaches a real provider.
// TestMain lives in helpers_test.go.
package examples_e2e

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"gopkg.in/yaml.v3"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

// need returns env[key]; when unset it fails the test (or skips under
// E2E_ALLOW_SKIP=1), mirroring e2ekit's stack-down policy.
func need(t *testing.T, key string) string {
	t.Helper()
	if v := os.Getenv(key); v != "" {
		return v
	}
	msg := key + " is not set — start the fixture stack with scripts/e2e-examples.sh"
	if os.Getenv("E2E_ALLOW_SKIP") == "1" {
		t.Skip(msg)
	}
	t.Fatal(msg)
	return ""
}

func openDB(t *testing.T) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), need(t, "DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect DATABASE_URL: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

// replayRequest is one call recorded by cmd/connector-replay.
type replayRequest struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Query   string `json:"query"`
	Body    string `json:"body"`
	HasAuth bool   `json:"hasAuth"`
}

func replayRequests(t *testing.T) []replayRequest {
	t.Helper()
	resp, err := http.Get(need(t, "LANTERN_E2E_REPLAY_URL") + "/__requests")
	if err != nil {
		t.Fatalf("GET /__requests: %v", err)
	}
	defer resp.Body.Close()
	var out []replayRequest
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode /__requests: %v", err)
	}
	return out
}

func countReplay(reqs []replayRequest, method, path string) int {
	n := 0
	for _, r := range reqs {
		if r.Method == method && r.Path == path {
			n++
		}
	}
	return n
}

// agentFromManifest reads examples/<dir>/agent.yaml (the file `lantern deploy`
// reads) and creates the e2e agent from it the way deploy does: the manifest's
// description + system_prompt, then its workflow via PUT /v1/agents/{name}/workflow.
func agentFromManifest(t *testing.T, k *e2ekit.Kit, name, dir string) *e2ekit.Agent {
	t.Helper()
	var m struct {
		Description  string         `yaml:"description"`
		SystemPrompt string         `yaml:"system_prompt"`
		Workflow     map[string]any `yaml:"workflow"`
	}
	if err := yaml.Unmarshal(readFile(t, dir+"/agent.yaml"), &m); err != nil {
		t.Fatalf("parse %s/agent.yaml: %v", dir, err)
	}
	a := k.CreateAgent(t, name, map[string]any{"description": m.Description, "systemPrompt": m.SystemPrompt})
	if m.Workflow != nil {
		if st, raw := k.DoAuth(t, http.MethodPut, "/v1/agents/"+name+"/workflow", m.Workflow, nil); st != http.StatusOK {
			t.Fatalf("save workflow: HTTP %d: %s", st, raw)
		}
	}
	return a
}

// waitUntil polls fn every 500ms until it returns true or the deadline passes.
func waitUntil(t *testing.T, d time.Duration, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out after %v waiting for %s", d, what)
}

// runsFor lists runs of one agent (GET /v1/runs?agent=).
func runsFor(t *testing.T, k *e2ekit.Kit, agent string) []map[string]any {
	t.Helper()
	var runs []map[string]any
	k.DoAuth(t, http.MethodGet, "/v1/runs?agent="+agent, nil, &runs)
	return runs
}

func postForm(t *testing.T, target string, form url.Values, sig string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, target, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if sig != "" {
		req.Header.Set("X-Twilio-Signature", sig)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", target, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}
