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
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// ---------- helpers (stub-server path) ----------

func newDLPHandler(t *testing.T) (*DLPPolicyHandler, *AuthHandler) {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	// Lazy pool to a closed port: never connects, so any DB call fails with an
	// error (→ 500) instead of panicking — fine for pre-DB validation tests.
	pool, err := pgxpool.New(context.Background(), "postgres://x:x@127.0.0.1:1/x?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	srv := &server.Server{Pool: pool, Logger: logger}
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
		{"custom_regex invalid pattern", map[string]any{"ruleId": "r1", "detector": "custom_regex", "mode": "block", "pattern": "[unclosed"}, http.StatusBadRequest},
		{"legacy manager name regex", map[string]any{"ruleId": "r1", "detector": "regex", "mode": "block", "pattern": "x"}, http.StatusBadRequest},
		{"empty mode", map[string]any{"ruleId": "r1", "detector": "card_number", "mode": ""}, http.StatusBadRequest},
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

// TestDLPPolicy_PutPolicy_InvalidRegex: the bulk PUT validates custom_regex
// patterns too (400 before any DB write).
func TestDLPPolicy_PutPolicy_InvalidRegex(t *testing.T) {
	h, _ := newDLPHandler(t)
	tok := mintTestToken(t, uuid.NewString(), "user-dlp", "owner")
	body, _ := json.Marshal(map[string]any{"rules": []map[string]any{
		{"ruleId": "ok", "detector": "card_number", "mode": "block"},
		{"ruleId": "bad", "detector": "custom_regex", "mode": "block", "pattern": "(a"},
	}})
	req := httptest.NewRequest(http.MethodPut, "/v1/egress/dlp-policy", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.PutPolicy(rr, req)
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "rule[1]") {
		t.Fatalf("got %d %s, want 400 naming rule[1]", rr.Code, rr.Body.String())
	}
}

// TestDLPDetectors_ParityWithManager pins the detector names the API accepts
// (validDetectors), the DB CHECK (migration 0028) and the runtime-manager's
// dlp::DETECTORS (whose test reads the same fixture). They once disagreed:
// the API stored custom_regex, the manager only knew "regex", and the rule
// silently never matched.
func TestDLPDetectors_ParityWithManager(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/dlp_detectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Detectors []string `json:"detectors"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	var got []string
	for d := range validDetectors {
		got = append(got, d)
	}
	want := append([]string(nil), fx.Detectors...)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("validDetectors %v != fixture %v", got, want)
	}
	sql, err := os.ReadFile("../db/migrations/0028_dlp_policies.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range want {
		if !strings.Contains(string(sql), "'"+d+"'") {
			t.Errorf("migration 0028 CHECK is missing detector %q", d)
		}
	}
}

// TestAgentSpecFromMap_DLPRules: the map loadDLPRules builds becomes the
// typed AgentSpec.DlpPolicy the manager compiles — names, modes, patterns
// and thresholds carried verbatim (custom_regex included).
func TestAgentSpecFromMap_DLPRules(t *testing.T) {
	a := agentSpecFromMap(map[string]any{
		"image_digest": "sha256:abc",
		"dlp_rules": []map[string]any{
			{"rule_id": "ssn", "detector": "custom_regex", "pattern": `SSN-\d{3}`, "mode": "block", "threshold": int64(1)},
			{"rule_id": "mail", "detector": "email", "pattern": "", "mode": "audit", "threshold": int64(3)},
		},
	})
	p := a.GetDlpPolicy()
	if p == nil || len(p.Rules) != 2 {
		t.Fatalf("DlpPolicy = %v, want 2 rules", p)
	}
	r := p.Rules[0]
	if r.RuleId != "ssn" || r.Detector != "custom_regex" || r.Pattern != `SSN-\d{3}` || r.Mode != "block" || r.Threshold != 1 {
		t.Fatalf("rule 0 = %+v", r)
	}
	if p.Rules[1].Mode != "audit" || p.Rules[1].Threshold != 3 {
		t.Fatalf("rule 1 = %+v", p.Rules[1])
	}
	if p.MaxInspectBytes != 0 {
		t.Fatalf("MaxInspectBytes = %d, want 0 (manager default)", p.MaxInspectBytes)
	}
	if agentSpecFromMap(map[string]any{"image_digest": "sha256:abc"}).GetDlpPolicy() != nil {
		t.Fatal("no dlp_rules must mean no DlpPolicy")
	}
}

// TestRLSDLP_CrossTenant_WritesBlocked: tenant B can neither delete nor
// overwrite tenant A's rule by its rule_id, and a raw read under B's GUC with
// no WHERE clause sees none of A's rows (RLS, not the handler's WHERE).
func TestRLSDLP_CrossTenant_WritesBlocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedDLPHandler(t, e)
	tenantA := seedEnforcedTenant(t, e, "dlp-wa-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "dlp-wb-"+uuid.NewString()[:8])

	if code := upsertDLPRuleHTTP(t, h, tenantA, "shared-id"); code != http.StatusOK {
		t.Fatalf("seed A: %d", code)
	}
	if code := dlpDeleteRule(t, h, nil, tenantB, "shared-id"); code != http.StatusNotFound {
		t.Fatalf("SECURITY: B deleting A's rule got %d, want 404", code)
	}
	// B upserting the same rule_id lands in B's own row, never A's.
	if code := dlpUpsertRule(t, h, nil, tenantB, map[string]any{"ruleId": "shared-id", "detector": "email", "mode": "off"}); code != http.StatusOK {
		t.Fatalf("B upsert: %d", code)
	}

	var seen []string
	if err := e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		rows, err := tx.Query(context.Background(), `SELECT tenant_id::text FROM dlp_policies`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var tid string
			if err := rows.Scan(&tid); err != nil {
				return err
			}
			seen = append(seen, tid)
		}
		return rows.Err()
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0] != tenantB {
		t.Fatalf("SECURITY: unfiltered read under B's GUC saw tenants %v, want only B", seen)
	}

	// A's rule is intact: still there, still card_number/block.
	code, out := dlpGetPolicy(t, h, nil, tenantA)
	rules, _ := out["rules"].([]any)
	if code != http.StatusOK || len(rules) != 1 {
		t.Fatalf("A's policy after B's writes: %d %v", code, out)
	}
	r, _ := rules[0].(map[string]any)
	if r["detector"] != "card_number" || r["mode"] != "block" {
		t.Fatalf("SECURITY: A's rule changed by B: %v", r)
	}
}
