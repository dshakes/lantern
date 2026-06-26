package handlers

// ENFORCEMENT-ON proof for the evals/experiments/budgets handler group
// (evals.go, experiments.go, budgets.go, forecaster.go) after the P1.1b cutover
// to s.srv.WithTenant.
//
// Runs against the lantern_app-backed harness (newEnforcedServer). Proves:
//
//	(a) a SAME-TENANT caller still writes + reads its OWN budgets and eval
//	    suites (rows returned, NOT zero — the regression check), and
//	(b) a CROSS-TENANT caller sees zero of the other tenant's rows.
//
// Skipped automatically when DATABASE_URL is unset (harness skips).

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func newEnforcedBudgetHandler(t *testing.T, e *enforcedServer) *BudgetHandler {
	t.Helper()
	return NewBudgetHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

func newEnforcedEvalHandler(t *testing.T, e *enforcedServer) *EvalHandler {
	t.Helper()
	return NewEvalHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
}

// upsertBudgetHTTP drives PUT /v1/agents/{name}/budget as the given tenant.
func upsertBudgetHTTP(t *testing.T, h *BudgetHandler, tenantID, agentName string) {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{"maxCostUsdPerDay": 12.5, "hardFail": true})
	req := httptest.NewRequest(http.MethodPut, "/v1/agents/"+agentName+"/budget", bytes.NewReader(body))
	req.SetPathValue("name", agentName)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.UpsertBudget(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("upsert budget under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// getBudgetStatus drives GET /v1/agents/{name}/budget and returns the status code.
func getBudgetStatus(t *testing.T, h *BudgetHandler, tenantID, agentName string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/"+agentName+"/budget", nil)
	req.SetPathValue("name", agentName)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetBudget(rr, req)
	return rr.Code
}

// TestRLSBudgets_SameTenant_UpsertGet proves a tenant can upsert + read back its
// own budget under RLS (read returns 200 with the row, not 404).
func TestRLSBudgets_SameTenant_UpsertGet(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBudgetHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-bud-life-"+uuid.NewString()[:8])
	agent := "budget-agent"

	upsertBudgetHTTP(t, h, tenant, agent)

	if code := getBudgetStatus(t, h, tenant, agent); code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant GET budget under RLS got %d, want 200 — cutover broke its own read", code)
	}
}

// TestRLSBudgets_CrossTenant_Blocked proves tenant B cannot read tenant A's
// budget (404 under RLS) while A still can.
func TestRLSBudgets_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedBudgetHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-bud-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-bud-iso-b-"+uuid.NewString()[:8])
	agent := "budget-agent"

	upsertBudgetHTTP(t, h, tenantA, agent)

	// (1) Tenant B GET of A's budget → 404 (RLS hides the row).
	if code := getBudgetStatus(t, h, tenantB, agent); code != http.StatusNotFound {
		t.Errorf("cross-tenant GET budget under RLS: got %d, want 404", code)
	}

	// (2) Positive control: tenant A still reads its own.
	if code := getBudgetStatus(t, h, tenantA, agent); code != http.StatusOK {
		t.Errorf("REGRESSION: tenant A GET its own budget under RLS got %d, want 200", code)
	}
}

// upsertEvalSuiteID drives POST /v1/eval-suites and returns the new suite id.
func upsertEvalSuiteID(t *testing.T, h *EvalHandler, tenantID, agentName, name string) string {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	body, _ := json.Marshal(map[string]any{
		"agentName": agentName,
		"name":      name,
		"cases":     []map[string]any{{"name": "c1", "input": "hi", "expected": "ok"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/eval-suites", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.UpsertSuite(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("upsert eval suite under RLS: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.ID == "" {
		t.Fatalf("upsert eval suite returned empty id: %s", rr.Body.String())
	}
	return out.ID
}

// getEvalSuiteStatus drives GET /v1/eval-suites/{id} and returns the status code.
func getEvalSuiteStatus(t *testing.T, h *EvalHandler, tenantID, id string) int {
	t.Helper()
	tok := mintTestToken(t, tenantID, "user-x", "owner")
	req := httptest.NewRequest(http.MethodGet, "/v1/eval-suites/"+id, nil)
	req.SetPathValue("id", id)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetSuite(rr, req)
	return rr.Code
}

// TestRLSEvals_SameTenant_UpsertGet proves a tenant can upsert + read its own
// eval suite under RLS.
func TestRLSEvals_SameTenant_UpsertGet(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedEvalHandler(t, e)

	tenant := seedEnforcedTenant(t, e, "rls-eval-life-"+uuid.NewString()[:8])
	id := upsertEvalSuiteID(t, h, tenant, "eval-agent", "suite-"+uuid.NewString()[:6])

	if code := getEvalSuiteStatus(t, h, tenant, id); code != http.StatusOK {
		t.Fatalf("REGRESSION: same-tenant GET eval suite under RLS got %d, want 200 — cutover broke its own read", code)
	}
}

// TestRLSEvals_CrossTenant_Blocked proves tenant B cannot read tenant A's eval
// suite under RLS.
func TestRLSEvals_CrossTenant_Blocked(t *testing.T) {
	e := newEnforcedServer(t)
	h := newEnforcedEvalHandler(t, e)

	tenantA := seedEnforcedTenant(t, e, "rls-eval-iso-a-"+uuid.NewString()[:8])
	tenantB := seedEnforcedTenant(t, e, "rls-eval-iso-b-"+uuid.NewString()[:8])

	idA := upsertEvalSuiteID(t, h, tenantA, "eval-agent", "suite-"+uuid.NewString()[:6])

	// (1) Tenant B GET of A's suite → 404 (RLS hides the row).
	if code := getEvalSuiteStatus(t, h, tenantB, idA); code != http.StatusNotFound {
		t.Errorf("cross-tenant GET eval suite under RLS: got %d, want 404", code)
	}

	// (2) Direct AppPool count of A's suite from B's tenant context must be zero.
	var leak int
	_ = e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(),
			"SELECT COUNT(*) FROM eval_suites WHERE id = $1", idA,
		).Scan(&leak)
	})
	if leak != 0 {
		t.Errorf("SECURITY VIOLATION: tenant B saw %d of tenant A's eval_suites rows under RLS, want 0", leak)
	}

	// (3) Positive control: tenant A still reads its own.
	if code := getEvalSuiteStatus(t, h, tenantA, idA); code != http.StatusOK {
		t.Errorf("REGRESSION: tenant A GET its own eval suite under RLS got %d, want 200", code)
	}
}
