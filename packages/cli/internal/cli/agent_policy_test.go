package cli

// agent_policy_test.go — `pal agent policy|identity|audit` against a mock
// control-plane mirroring the ADR 0052 REST shapes.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakePolicyServer struct {
	policy      map[string]any // stored policy
	dropOnPut   string         // field silently dropped on PUT (simulates a server that doesn't persist it)
	puts        []map[string]any
	auditChain  bool
	proposal    map[string]any
	identityRaw string
	revokeBody  string
}

func (f *fakePolicyServer) handler() http.Handler {
	mux := http.NewServeMux()
	env := func() []byte {
		b, _ := json.Marshal(map[string]any{"agentName": "triage", "agentId": "a1", "policy": f.policy, "warnings": []string{"legacy"}})
		return b
	}
	mux.HandleFunc("GET /v1/agents/{name}/policy", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(env()) })
	mux.HandleFunc("PUT /v1/agents/{name}/policy", func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		_ = json.NewDecoder(r.Body).Decode(&p)
		rec := map[string]any{}
		for k, v := range p {
			rec[k] = v
		}
		f.puts = append(f.puts, rec)
		if p["version"] != f.policy["version"] {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"version_conflict"}`))
			return
		}
		if f.dropOnPut != "" {
			delete(p, f.dropOnPut)
		}
		p["version"] = f.policy["version"].(float64) + 1
		f.policy = p
		_, _ = w.Write(env())
	})
	mux.HandleFunc("POST /v1/agents/{name}/policy/propose", func(w http.ResponseWriter, _ *http.Request) {
		b, _ := json.Marshal(map[string]any{
			"proposal":   f.proposal,
			"rationale":  []map[string]string{{"field": "tools", "reason": "used in 12 runs"}},
			"sources":    []string{"runs"},
			"unresolved": []string{},
		})
		_, _ = w.Write(b)
	})
	mux.HandleFunc("GET /v1/agents/{name}/identity", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(f.identityRaw))
	})
	mux.HandleFunc("POST /v1/agents/{name}/identity/revoke", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.revokeBody = string(b)
		_, _ = w.Write([]byte(strings.Replace(f.identityRaw, `"active"`, `"revoked"`, 1)))
	})
	mux.HandleFunc("GET /v1/agents/{name}/audit", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "5" || r.URL.Query().Get("event") != "policy_denied" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		chain := "false"
		if f.auditChain {
			chain = "true"
		}
		_, _ = w.Write([]byte(`{"events":[{"id":9,"event":"policy_denied","actionKind":"tool","target":"shell_exec","decision":"deny","reason":"not allowed","principal":"agent:a1","createdAt":"2026-10-30T00:00:00Z"}],"chainValid":` + chain + `}`))
	})
	return mux
}

func runAgentCmd(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newAgentsCommand()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	err := cmd.ExecuteContext(context.Background())
	return out.String(), err
}

func setup(t *testing.T, f *fakePolicyServer) {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	withAPIURL(t, srv.URL)
	prev := flags.output
	t.Cleanup(func() { flags.output = prev })
	flags.output = "text"
}

func TestPolicyGet(t *testing.T) {
	f := &fakePolicyServer{policy: map[string]any{"mode": "enforce", "tools": []any{"web_search"}, "version": float64(3)}}
	setup(t, f)
	out, err := runAgentCmd(t, "policy", "get", "triage")
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"enforce", "web_search", "version:      3", "warning:      legacy"} {
		if !strings.Contains(out, w) {
			t.Errorf("missing %q in:\n%s", w, out)
		}
	}
	flags.output = "json"
	out, err = runAgentCmd(t, "policy", "get", "triage")
	if err != nil || !json.Valid([]byte(out)) || !strings.Contains(out, `"agentId"`) {
		t.Fatalf("json output: %v\n%s", err, out)
	}
}

func TestPolicySet_ReadsVersionWhenOmitted(t *testing.T) {
	f := &fakePolicyServer{policy: map[string]any{"mode": "enforce", "version": float64(7)}}
	setup(t, f)
	file := filepath.Join(t.TempDir(), "p.json")
	_ = os.WriteFile(file, []byte(`{"mode":"enforce","tools":["a"]}`), 0o600)
	out, err := runAgentCmd(t, "policy", "set", "triage", "-f", file)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.puts) != 1 || f.puts[0]["version"] != float64(7) {
		t.Fatalf("puts=%v", f.puts)
	}
	if !strings.Contains(out, "version 8") {
		t.Errorf("out=%s", out)
	}
}

func TestPolicySet_ConflictMessage(t *testing.T) {
	f := &fakePolicyServer{policy: map[string]any{"mode": "enforce", "version": float64(7)}}
	setup(t, f)
	file := filepath.Join(t.TempDir(), "p.json")
	_ = os.WriteFile(file, []byte(`{"mode":"enforce","version":2}`), 0o600)
	_, err := runAgentCmd(t, "policy", "set", "triage", "-f", file)
	if err == nil || !strings.Contains(err.Error(), "version conflict") || !strings.Contains(err.Error(), "policy get triage") {
		t.Fatalf("err=%v", err)
	}
}

func TestPolicyPropose_NoApplyDoesNotWrite(t *testing.T) {
	f := &fakePolicyServer{
		policy:   map[string]any{"mode": "legacy_permissive", "version": float64(1)},
		proposal: map[string]any{"mode": "enforce", "tools": []any{"web_search"}, "version": float64(0)},
	}
	setup(t, f)
	out, err := runAgentCmd(t, "policy", "propose", "triage")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.puts) != 0 || !strings.Contains(out, "used in 12 runs") || !strings.Contains(out, "Not applied") {
		t.Fatalf("puts=%v out=%s", f.puts, out)
	}
}

func TestPolicyPropose_ApplyVerified(t *testing.T) {
	f := &fakePolicyServer{
		policy:   map[string]any{"mode": "legacy_permissive", "version": float64(1)},
		proposal: map[string]any{"mode": "enforce", "tools": []any{"web_search"}, "mcpServers": []any{}, "version": float64(0)},
	}
	setup(t, f)
	out, err := runAgentCmd(t, "policy", "propose", "triage", "--apply")
	if err != nil {
		t.Fatalf("err=%v\n%s", err, out)
	}
	if !strings.Contains(out, "verified") || f.puts[0]["version"] != float64(1) {
		t.Fatalf("puts=%v out=%s", f.puts, out)
	}
}

func TestPolicyPropose_ApplyMismatchFails(t *testing.T) {
	f := &fakePolicyServer{
		policy:    map[string]any{"mode": "legacy_permissive", "version": float64(1)},
		proposal:  map[string]any{"mode": "enforce", "tools": []any{"web_search"}, "version": float64(0)},
		dropOnPut: "tools",
	}
	setup(t, f)
	out, err := runAgentCmd(t, "policy", "propose", "triage", "--apply")
	if err == nil || !strings.Contains(err.Error(), "NOT verified") || strings.Contains(out, "verified:") {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestIdentityShowAndRevoke(t *testing.T) {
	f := &fakePolicyServer{identityRaw: `{"agentId":"a1","spiffeId":"spiffe://x/a1","keyGeneration":2,"status":"active","jwksUri":"u","tokenTtlSeconds":300,"createdAt":"c","rotatedAt":null,"revokedAt":null,"revokedReason":null}`}
	setup(t, f)
	out, err := runAgentCmd(t, "identity", "show", "triage")
	if err != nil || !strings.Contains(out, "spiffe://x/a1") || !strings.Contains(out, "active") {
		t.Fatalf("err=%v out=%s", err, out)
	}
	out, err = runAgentCmd(t, "identity", "revoke", "triage", "--reason", "leaked")
	if err != nil || !strings.Contains(out, "revoked") || !strings.Contains(f.revokeBody, `"reason":"leaked"`) {
		t.Fatalf("err=%v out=%s body=%s", err, out, f.revokeBody)
	}
}

func TestAudit_TableAndChain(t *testing.T) {
	f := &fakePolicyServer{auditChain: true}
	setup(t, f)
	out, err := runAgentCmd(t, "audit", "triage", "--limit", "5", "--event", "policy_denied")
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []string{"DECISION", "deny", "shell_exec", "chain integrity: valid"} {
		if !strings.Contains(out, w) {
			t.Errorf("missing %q in:\n%s", w, out)
		}
	}
	f.auditChain = false
	_, err = runAgentCmd(t, "audit", "triage", "--limit", "5", "--event", "policy_denied")
	if err == nil || !strings.Contains(err.Error(), "BROKEN") {
		t.Fatalf("err=%v", err)
	}
}
