package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func runPromoCmd(t *testing.T, srvURL string, args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PAL_API_URL", srvURL)
	t.Setenv("PAL_API_TOKEN", "test-token")
	root := NewRootCommand("t", "t", "t")
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestPromote_GateFailureIsNonZeroAndShowsGates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(422)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "gate_failed", "error": "gate_failed: eval: stale",
			"gates": []any{map[string]any{"name": "eval", "status": "fail", "detail": "latest eval is stale"}}})
	}))
	defer srv.Close()
	out, err := runPromoCmd(t, srv.URL, "promote", "a", "--to", "prod")
	if err == nil || !strings.Contains(out, "BLOCKED") || !strings.Contains(out, "[FAIL] eval") {
		t.Fatalf("want blocked + non-zero, got err=%v out=%q", err, out)
	}
}

func TestPromote_ProdProposalIsPendingAndPointsToHuman(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/a/promote" || r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected request %s auth=%s", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.WriteHeader(202)
		_ = json.NewEncoder(w).Encode(map[string]any{"promotion": map[string]any{"id": "p1", "status": "pending_approval", "version": "v2", "env": "prod"}})
	}))
	defer srv.Close()
	out, err := runPromoCmd(t, srv.URL, "promote", "a", "--to", "prod", "--canary", "10")
	if err != nil || !strings.Contains(out, "pal approve p1") {
		t.Fatalf("err=%v out=%q", err, out)
	}
}

func TestApprove_ForbiddenForAgentsIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": "human_approval_required", "error": "only a human"})
	}))
	defer srv.Close()
	if _, err := runPromoCmd(t, srv.URL, "approve", "p1"); err == nil || !strings.Contains(err.Error(), "only a human") {
		t.Fatalf("want 403 surfaced, got %v", err)
	}
}

func TestRollback_ReportsNoopWhenAlreadyRolledBack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"alreadyRolledBack": true, "version": "v1", "mode": "noop"})
	}))
	defer srv.Close()
	out, err := runPromoCmd(t, srv.URL, "rollback", "a")
	if err != nil || !strings.Contains(out, "already rolled back") {
		t.Fatalf("err=%v out=%q", err, out)
	}
}

func TestPromoteContract_IsValidJSONAndExcludesApproval(t *testing.T) {
	out, err := runPromoCmd(t, "http://127.0.0.1:1", "promote", "contract")
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Tool string   `json:"tool"`
		Not  []string `json:"not_available_to_the_model"`
	}
	if err := json.Unmarshal([]byte(out), &c); err != nil || c.Tool != "propose_promotion" || len(c.Not) == 0 {
		t.Fatalf("bad contract: %v %q", err, out)
	}
}
