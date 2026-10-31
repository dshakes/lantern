package pal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return New(WithBaseURL(srv.URL), WithMaxRetries(1))
}

func TestAgentPolicy_GetPutPropose(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/agents/triage/policy":
			w.Write([]byte(`{"agentName":"triage","agentId":"a1","policy":{"mode":"enforce","tools":["web_search"],"connectors":{"slack":["post"]},"budget":{"maxToolCallsPerRun":5},"version":3},"warnings":["w"]}`))
		case "PUT /v1/agents/triage/policy":
			var p AgentPolicy
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.Version != 3 {
				t.Errorf("bad put body: %+v %v", p, err)
			}
			p.Version = 4
			json.NewEncoder(w).Encode(AgentPolicyResponse{AgentName: "triage", Policy: p})
		case "POST /v1/agents/triage/policy/propose":
			w.Write([]byte(`{"proposal":{"mode":"enforce","version":0},"rationale":[{"field":"tools","reason":"used"}],"sources":["runs"],"unresolved":["x"]}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	ctx := context.Background()
	got, err := c.GetAgentPolicy(ctx, "triage")
	if err != nil {
		t.Fatal(err)
	}
	if got.Policy.Version != 3 || got.Policy.Connectors["slack"][0] != "post" || got.Warnings[0] != "w" || got.Policy.Budget.MaxToolCallsPerRun != 5 {
		t.Fatalf("unexpected: %+v", got)
	}
	put, err := c.PutAgentPolicy(ctx, "triage", got.Policy)
	if err != nil || put.Policy.Version != 4 {
		t.Fatalf("put: %+v %v", put, err)
	}
	prop, err := c.ProposeAgentPolicy(ctx, "triage")
	if err != nil || prop.Rationale[0].Field != "tools" || prop.Unresolved[0] != "x" {
		t.Fatalf("propose: %+v %v", prop, err)
	}
}

func TestPutAgentPolicy_VersionConflict(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"code":"version_conflict"}`))
	})
	_, err := c.PutAgentPolicy(context.Background(), "a", AgentPolicy{})
	if !errors.Is(err, ErrPolicyVersionConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 409 {
		t.Fatalf("want APIError 409 via As, got %v", err)
	}
}

func TestPutAgentPolicy_Invalid400(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad","field":"tools"}`))
	})
	_, err := c.PutAgentPolicy(context.Background(), "a", AgentPolicy{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 || errors.Is(err, ErrPolicyVersionConflict) {
		t.Fatalf("got %v", err)
	}
}

func TestPolicyDenied_TypedError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"code":"agent_policy_denied","kind":"tool","target":"shell_exec","error":"not allowed"}`))
	})
	_, err := c.GetAgent(context.Background(), "a")
	var denied *AgentPolicyDeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("want AgentPolicyDeniedError, got %T %v", err, err)
	}
	if denied.Kind != "tool" || denied.Target != "shell_exec" || denied.Message != "not allowed" {
		t.Fatalf("fields: %+v", denied)
	}
	if !errors.Is(err, ErrAgentPolicyDenied) {
		t.Fatal("errors.Is sentinel failed")
	}
}

func TestPlain403StaysAPIError(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"nope"}`))
	})
	_, err := c.GetAgent(context.Background(), "a")
	var denied *AgentPolicyDeniedError
	if errors.As(err, &denied) {
		t.Fatal("plain 403 must not be a policy denial")
	}
}

func TestAgentIdentity_Lifecycle(t *testing.T) {
	const ident = `{"agentId":"a1","spiffeId":"spiffe://x/a1","keyGeneration":2,"status":"active","publicKeyJwk":{"kty":"OKP"},"jwksUri":"u","tokenTtlSeconds":300,"createdAt":"2026-01-01T00:00:00Z","rotatedAt":"2026-02-01T00:00:00Z","revokedAt":null,"revokedReason":null}`
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/agents/t/identity", "POST /v1/agents/t/identity/rotate":
		case "POST /v1/agents/t/identity/revoke":
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			if b["reason"] != "leak" {
				t.Errorf("reason=%v", b)
			}
		case "POST /v1/agents/t/identity/token":
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			if b["audience"] != "svc" || b["runId"] != "r1" {
				t.Errorf("token body=%v", b)
			}
			w.Write([]byte(`{"token":"jwt","expiresAt":"e","jti":"j","audience":"svc"}`))
			return
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(ident))
	})
	ctx := context.Background()
	id, err := c.GetAgentIdentity(ctx, "t")
	if err != nil || id.KeyGeneration != 2 || id.Status != "active" || id.RotatedAt == nil || id.RevokedAt != nil {
		t.Fatalf("%+v %v", id, err)
	}
	if _, err := c.RotateAgentIdentity(ctx, "t"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.RevokeAgentIdentity(ctx, "t", "leak"); err != nil {
		t.Fatal(err)
	}
	tok, err := c.MintAgentToken(ctx, "t", "svc", "r1")
	if err != nil || tok.Token != "jwt" || tok.JTI != "j" {
		t.Fatalf("%+v %v", tok, err)
	}
}

func TestListAgentAudit(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") != "5" || r.URL.Query().Get("event") != "policy_denied" {
			t.Errorf("query=%s", r.URL.RawQuery)
		}
		w.Write([]byte(`{"events":[{"id":7,"event":"policy_denied","actionKind":"tool","target":"x","decision":"deny","reason":"r","runId":"r1","principal":"p"}],"chainValid":true}`))
	})
	out, err := c.ListAgentAudit(context.Background(), "t", AuditOptions{Limit: 5, Event: "policy_denied"})
	if err != nil || !out.ChainValid || out.Events[0].ID != 7 || out.Events[0].Decision != "deny" {
		t.Fatalf("%+v %v", out, err)
	}
}
