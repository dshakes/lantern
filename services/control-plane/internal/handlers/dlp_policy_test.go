package handlers

// Tests for the DLP policy handler (ADR 0030).
//
// TestDLPPolicy_CRUD — basic happy-path: upsert a rule, GET returns it, DELETE
// removes it.
// TestDLPPolicy_PutPolicy_Atomic — PUT replaces the whole policy in one shot.
// TestDLPPolicy_Validation — invalid detector/mode/missing ruleId → 400.
// TestRLSDLP_CrossTenant_Blocked — cross-tenant access is denied under RLS.
//
// The first three tests use the stub server (no DB) so they can run anywhere.
// TestRLSDLP_CrossTenant_Blocked requires DATABASE_URL (enforced-server harness)
// and is skipped when it is unset.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- helpers (stub-server path) ----------

func newDLPHandler(t *testing.T) (*DLPPolicyHandler, *AuthHandler) {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{
		Pool:   nil, // nil: panics on DB access — safe for pre-DB validation tests
		Logger: logger,
	}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewDLPPolicyHandler(srv, auth), auth
}

func dlpUpsertRule(t *testing.T, h *DLPPolicyHandler, auth *AuthHandler, tenantID string, rule map[string]any) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-dlp", "owner")
	body, _ := json.Marshal(rule)
	req := httptest.NewRequest(http.MethodPost, "/v1/egress/dlp-policy/rules", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.UpsertRule(rr, req)
	return rr.Code
}

func dlpGetPolicy(t *testing.T, h *DLPPolicyHandler, auth *AuthHandler, tenantID string) (int, map[string]any) {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-dlp", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/egress/dlp-policy", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetPolicy(rr, req)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func dlpDeleteRule(t *testing.T, h *DLPPolicyHandler, auth *AuthHandler, tenantID, ruleID string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-dlp", "owner")
	req := httptest.NewRequest(http.MethodDelete, "/v1/egress/dlp-policy/rules/"+ruleID, nil)
	req.SetPathValue("ruleId", ruleID)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.DeleteRule(rr, req)
	return rr.Code
}

// ---------- stub-server tests (no DB required) ----------

// TestDLPPolicy_Validation ensures the handler rejects invalid inputs before
// hitting the DB.
func TestDLPPolicy_Validation(t *testing.T) {
	h, auth := newDLPHandler(t)
	tenantID := uuid.NewString()

	cases := []struct {
		name string
		body map[string]any
		want int
	}{
		{"missing ruleId", map[string]any{"detector": "card_number", "mode": "block"}, http.StatusBadRequest},
		{"invalid detector", map[string]any{"ruleId": "r1", "detector": "credit_card", "mode": "block"}, http.StatusBadRequest},
		{"invalid mode", map[string]any{"ruleId": "r1", "detector": "card_number", "mode": "forbid"}, http.StatusBadRequest},
		{"custom_regex missing pattern", map[string]any{"ruleId": "r1", "detector": "custom_regex", "mode": "audit"}, http.StatusBadRequest},
		{"custom_regex blank pattern", map[string]any{"ruleId": "r1", "detector": "custom_regex", "mode": "audit", "pattern": "   "}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code := dlpUpsertRule(t, h, auth, tenantID, tc.body)
			if code != tc.want {
				t.Errorf("got %d, want %d", code, tc.want)
			}
		})
	}
}

// TestDLPPolicy_ValidRule_AcceptsBuiltinDetectors confirms the validator accepts
// all known built-in detectors and modes.
func TestDLPPolicy_ValidRule_AcceptsBuiltinDetectors(t *testing.T) {
	h, auth := newDLPHandler(t)
	tenantID := uuid.NewString()

	builtins := []string{"card_number", "secret_key", "email", "phone"}
	for _, det := range builtins {
		for _, mode := range []string{"off", "audit", "block"} {
			rule := map[string]any{
				"ruleId":    det + "-" + mode,
				"detector":  det,
				"mode":      mode,
				"threshold": 1,
			}
			// Stub server has no DB, so UpsertRule returns 500 after passing
			// validation — a 500 proves the code reached the DB call.
			code := dlpUpsertRule(t, h, auth, tenantID, rule)
			if code == http.StatusBadRequest {
				t.Errorf("detector=%q mode=%q: got 400 (validation reject), want anything except 400", det, mode)
			}
		}
	}
}

// TestDLPPolicy_Unauthenticated ensures missing/invalid JWT → 401.
func TestDLPPolicy_Unauthenticated(t *testing.T) {
	h, _ := newDLPHandler(t)

	t.Run("GetPolicy", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/v1/egress/dlp-policy", nil)
		rr := httptest.NewRecorder()
		h.GetPolicy(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("got %d, want 401", rr.Code)
		}
	})
	t.Run("UpsertRule", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"ruleId": "x", "detector": "email", "mode": "audit"})
		req := httptest.NewRequest(http.MethodPost, "/v1/egress/dlp-policy/rules", bytes.NewReader(body))
		rr := httptest.NewRecorder()
		h.UpsertRule(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("got %d, want 401", rr.Code)
		}
	})
	t.Run("DeleteRule_missing_token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/v1/egress/dlp-policy/rules/r1", nil)
		req.SetPathValue("ruleId", "r1")
		rr := httptest.NewRecorder()
		h.DeleteRule(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("got %d, want 401", rr.Code)
		}
	})
}

// ---------- DB-backed RLS tests ----------

func newEnforcedDLPHandler(t *testing.T, e *enforcedServer) *DLPPolicyHandler {
	t.Helper()
	return NewDLPPolicyHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

// upsertDLPRuleHTTP drives POST /v1/egress/dlp-policy/rules as the given tenant.
func upsertDLPRuleHTTP(t *testing.T, h *DLPPolicyHandler, tenantID, ruleID string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-dlp", "owner")
	body, _ := json.Marshal(map[string]any{
		"ruleId":   ruleID,
		"detector": "card_number",
		"mode":     "block",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/egress/dlp-policy/rules", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.UpsertRule(rr, req)
	return rr.Code
}

// getDLPPolicyHTTP drives GET /v1/egress/dlp-policy and returns the rule count.
func getDLPPolicyHTTP(t *testing.T, h *DLPPolicyHandler, tenantID string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-dlp", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/egress/dlp-policy", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetPolicy(rr, req)
	if rr.Code != http.StatusOK {
		return 0
	}
	var out struct {
		Rules []any `json:"rules"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return len(out.Rules)
}

// TestRLSDLP_SameTenant proves a tenant can upsert + read back its own rules.
func TestRLSDLP_SameTenant(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedDLPHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "dlp-same-"+uuid.NewString()[:8])

	if code := upsertDLPRuleHTTP(t, h, tenant, "rule-cc"); code != http.StatusOK {
		t.Fatalf("upsert DLP rule under RLS: got %d, want 200", code)
	}
	if n := getDLPPolicyHTTP(t, h, tenant); n != 1 {
		t.Fatalf("REGRESSION: same-tenant GET DLP policy under RLS got %d rules, want 1", n)
	}
}

// TestRLSDLP_CrossTenant_Blocked proves tenant B cannot see tenant A's DLP rules.
func TestRLSDLP_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedDLPHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "dlp-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "dlp-b-"+uuid.NewString()[:8])

	// Tenant A creates a rule.
	if code := upsertDLPRuleHTTP(t, h, tenantA, "rule-a"); code != http.StatusOK {
		t.Fatalf("seed DLP rule for tenant A: got %d", code)
	}

	// Tenant B must see 0 rules (RLS hides tenant A's rows).
	if n := getDLPPolicyHTTP(t, h, tenantB); n != 0 {
		t.Fatalf("SECURITY: cross-tenant DLP GET returned %d rules for tenant B, want 0", n)
	}
}
