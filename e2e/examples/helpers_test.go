//go:build e2e

// Package examples_e2e drives the three Wave 2 examples (daily-digest,
// telegram-assistant, voice-receptionist) against a live local stack whose LLM
// and SaaS connectors are fixtures (see README.md in this directory and
// scripts/e2e-examples-stack.sh). Nothing here reaches a real provider.
package examples_e2e

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

func TestMain(m *testing.M) {
	e2ekit.Sweep(e2ekit.DefaultBase(), e2ekit.DefaultEmail(), e2ekit.DefaultPassword())
	os.Exit(m.Run())
}

var (
	kitOnce sync.Once
	kit     *e2ekit.Kit
)

// connect logs in once per package run: the API rate-limits logins, and four
// tests plus Sweep would otherwise trip it.
func connect(t *testing.T) *e2ekit.Kit {
	t.Helper()
	kitOnce.Do(func() { kit = e2ekit.Connect(t) })
	if kit == nil {
		t.Fatal("e2ekit.Connect failed in an earlier test")
	}
	return kit
}

// need returns env[key]; when unset it fails the test (or skips under
// E2E_ALLOW_SKIP=1), mirroring e2ekit's stack-down policy.
func need(t *testing.T, key string) string {
	t.Helper()
	if v := os.Getenv(key); v != "" {
		return v
	}
	msg := key + " is not set — start the fixture stack with scripts/e2e-examples-stack.sh"
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

func readJSON(t *testing.T, rel string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(rel)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse %s: %v", rel, err)
	}
	return m
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

// installConnector installs a connector for the dev tenant and uninstalls it
// when the test ends.
func installConnector(t *testing.T, k *e2ekit.Kit, connectorID string, config map[string]any) {
	t.Helper()
	var out struct {
		ID string `json:"id"`
	}
	st, raw := k.DoAuth(t, http.MethodPost, "/v1/connectors/install", map[string]any{
		"connectorId": connectorID, "displayName": "e2e " + connectorID, "config": config,
	}, &out)
	if st != http.StatusCreated || out.ID == "" {
		t.Fatalf("install %s: HTTP %d: %s", connectorID, st, raw)
	}
	t.Cleanup(func() { k.DoAuth(t, http.MethodDelete, "/v1/connectors/"+out.ID, nil, nil) })
}

// putWorkflow saves a workflow graph (PUT /v1/agents/{name}/workflow).
func putWorkflow(t *testing.T, k *e2ekit.Kit, agent string, wf map[string]any) {
	t.Helper()
	if st, raw := k.DoAuth(t, http.MethodPut, "/v1/agents/"+agent+"/workflow", wf, nil); st != http.StatusOK {
		t.Fatalf("save workflow: HTTP %d: %s", st, raw)
	}
}

// waitFor polls fn every 500ms until it returns true or the deadline passes.
func waitFor(t *testing.T, d time.Duration, what string, fn func() bool) {
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
