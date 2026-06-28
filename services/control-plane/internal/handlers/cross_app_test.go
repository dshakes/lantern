package handlers

// Tests for the cross-app workflow feature.
//
// Two layers:
//   - Pure-function tests (TestSideEffectingAction, TestParseCrossAppLLMResponse)
//     run with no infrastructure.
//   - DB-backed tests (TestCrossApp_Propose, TestCrossApp_ExecuteAction_*) skip
//     when DATABASE_URL is unset, matching the rest of this package's pattern.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Pure-function tests — no DB
// ---------------------------------------------------------------------------

func TestSideEffectingAction_Reads(t *testing.T) {
	reads := [][2]string{
		{"gmail", "list_messages"},
		{"gmail", "list_recent"},
		{"gmail", "search"},
		{"google-calendar", "list_events"},
		{"google-drive", "list_files"},
		{"google-sheets", "get_spreadsheet"},
		{"google-sheets", "get_values"},
		{"github", "list_repos"},
		{"github", "list_prs"},
		{"github", "get_pr"},
		{"github", "list_issues"},
		{"github", "get_issue"},
		{"notion", "search"},
		{"notion", "list_databases"},
		{"linear", "list_issues"},
		{"jira", "list_issues"},
		{"hubspot", "list_contacts"},
		{"hubspot", "list_deals"},
		{"stripe", "list_charges"},
		{"stripe", "list_customers"},
		{"sentry", "list_issues"},
		{"vercel", "list_projects"},
		{"vercel", "list_deployments"},
		{"salesforce", "query"},
		{"slack", "list_channels"},
		{"slack", "list_users"},
		{"telegram", "get_updates"},
		{"twilio", "list_messages"},
	}
	for _, c := range reads {
		if isSideEffectingAction(c[0], c[1]) {
			t.Errorf("expected read (false): isSideEffectingAction(%q, %q) = true", c[0], c[1])
		}
	}
}

func TestSideEffectingAction_Writes(t *testing.T) {
	writes := [][2]string{
		{"gmail", "send_message"},
		{"slack", "post_message"},
		{"discord", "send_message"},
		{"telegram", "send_message"},
		{"twilio", "send_sms"},
		{"twilio", "send_message"},
		{"twilio", "place_call"},
		{"github", "create_issue"},
		{"linear", "create_issue"},
		{"jira", "create_issue"},
		{"notion", "create_page"},
	}
	for _, c := range writes {
		if !isSideEffectingAction(c[0], c[1]) {
			t.Errorf("expected write (true): isSideEffectingAction(%q, %q) = false", c[0], c[1])
		}
	}
}

func TestSideEffectingAction_Unknown(t *testing.T) {
	// Unknown connector → true (fail-safe).
	if !isSideEffectingAction("my-custom-app", "do_thing") {
		t.Error("unknown connector should be side-effecting (fail-safe)")
	}
	// Known connector, unknown action → true (fail-safe).
	if !isSideEffectingAction("gmail", "delete_message") {
		t.Error("unknown action on known connector should be side-effecting (fail-safe)")
	}
}

func TestParseCrossAppLLMResponse(t *testing.T) {
	t.Run("valid JSON", func(t *testing.T) {
		raw := `{"summary":"Send a reply email","action":{"connector":"gmail","action":"send_message","params":{"to":"x@y.com"}}}`
		prop, sum, err := parseCrossAppLLMResponse(raw)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if sum != "Send a reply email" {
			t.Errorf("summary = %q", sum)
		}
		if prop.Connector != "gmail" || prop.Action != "send_message" {
			t.Errorf("action = %+v", prop)
		}
	})

	t.Run("code-fenced JSON", func(t *testing.T) {
		raw := "```json\n{\"summary\":\"Do it\",\"action\":{\"connector\":\"slack\",\"action\":\"post_message\",\"params\":{}}}\n```"
		_, sum, err := parseCrossAppLLMResponse(raw)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if sum != "Do it" {
			t.Errorf("summary = %q", sum)
		}
	})

	t.Run("missing summary", func(t *testing.T) {
		raw := `{"action":{"connector":"gmail","action":"send_message","params":{}}}`
		_, _, err := parseCrossAppLLMResponse(raw)
		if err == nil {
			t.Error("expected error for missing summary")
		}
	})

	t.Run("incomplete action", func(t *testing.T) {
		raw := `{"summary":"do it","action":{"connector":"","action":"","params":{}}}`
		_, _, err := parseCrossAppLLMResponse(raw)
		if err == nil {
			t.Error("expected error for empty connector/action")
		}
	})
}

// ---------------------------------------------------------------------------
// DB-backed tests
// ---------------------------------------------------------------------------

// newTestCrossAppHandler builds a CrossAppHandler backed by a real pool.
func newTestCrossAppHandler(t *testing.T, pool *pgxpool.Pool) *CrossAppHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewCrossAppHandler(srv, auth)
}

// seedCrossAppTenant inserts a minimal tenant and registers cleanup.
func seedCrossAppTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "ca-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'CrossApp Test', 'personal', 'ns-ca-' || $2)
		ON CONFLICT (id) DO NOTHING
	`, id, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM commitments WHERE tenant_id = $1::uuid", id)
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants WHERE id = $1::uuid", id)
	})
	return id
}

// TestCrossApp_SideEffecting_ReadStep verifies the propose endpoint rejects
// side-effecting actions in the read position.
func TestCrossApp_SideEffecting_ReadStep(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestCrossAppHandler(t, pool)
	// LLM and connector stubs not needed — should reject before reaching them.

	t.Setenv("LANTERN_CROSS_APP", "on")

	body, _ := json.Marshal(map[string]any{
		"goal":          "reply to the email",
		"readConnector": "gmail",
		"readAction":    "send_message", // this is a WRITE, not a read
		"readParams":    map[string]any{},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/cross-app/propose", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Propose(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d; body: %s", w.Code, w.Body.String())
	}
}

// TestCrossApp_Propose verifies that propose creates a kind='cross_app'
// commitment with a proposedAction stored in action_plan, and does NOT
// execute the proposed action.
func TestCrossApp_Propose(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestCrossAppHandler(t, pool)

	// Stub connector read — returns mock email data, no DB/network needed.
	var connectorCalled []string
	h.connectorFn = func(_ context.Context, _, _, action string, _ map[string]any) (any, error) {
		connectorCalled = append(connectorCalled, action)
		return map[string]any{"messages": []any{map[string]any{"subject": "meeting request"}}}, nil
	}

	// Stub LLM — returns a well-formed proposal JSON.
	h.completeFn = func(_ context.Context, _, _, _ string) (string, error) {
		return `{"summary":"Create a calendar event for the meeting","action":{"connector":"google-calendar","action":"create_event","params":{"title":"Meeting","start":"2026-07-01T10:00:00Z"}}}`, nil
	}

	t.Setenv("LANTERN_CROSS_APP", "on")

	body, _ := json.Marshal(map[string]any{
		"goal":          "schedule the meeting from this email",
		"readConnector": "gmail",
		"readAction":    "list_recent",
		"readParams":    map[string]any{"limit": 5},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/cross-app/propose", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Propose(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		CommitmentID   string           `json:"commitmentId"`
		ProposedAction crossAppProposed `json:"proposedAction"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.CommitmentID == "" {
		t.Fatal("expected commitmentId in response")
	}
	if resp.ProposedAction.Connector != "google-calendar" {
		t.Errorf("proposedAction.connector = %q", resp.ProposedAction.Connector)
	}

	// Verify connector was called exactly once (for the READ), not twice.
	if len(connectorCalled) != 1 || connectorCalled[0] != "list_recent" {
		t.Errorf("connector calls = %v, want [list_recent]", connectorCalled)
	}

	// Verify the commitment was stored with kind='cross_app' and status='suggested'.
	ctx := context.Background()
	var kind, status string
	var planJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT kind, status, action_plan FROM commitments WHERE id = $1 AND tenant_id = $2
	`, resp.CommitmentID, tenantID).Scan(&kind, &status, &planJSON); err != nil {
		t.Fatalf("load commitment: %v", err)
	}
	if kind != "cross_app" {
		t.Errorf("kind = %q, want cross_app", kind)
	}
	if status != "suggested" {
		t.Errorf("status = %q, want suggested", status)
	}

	// Verify proposedAction is in action_plan.
	var plan crossAppPlan
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("parse action_plan: %v", err)
	}
	if plan.ProposedAction.Connector != "google-calendar" {
		t.Errorf("plan.ProposedAction.Connector = %q", plan.ProposedAction.Connector)
	}
	// Verify ExecutionResult is nil — propose must NOT execute.
	if plan.ExecutionResult != nil {
		t.Error("propose must NOT populate ExecutionResult (no side-effect without confirm)")
	}
}

// TestCrossApp_ExecuteAction_Executes verifies execute-action fires the
// connector and marks the commitment done.
func TestCrossApp_ExecuteAction_Executes(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	// Seed a cross_app commitment directly.
	plan := crossAppPlan{
		Goal:          "schedule the meeting",
		ReadConnector: "gmail",
		ReadAction:    "list_recent",
		ProposedAction: crossAppProposed{
			Connector: "google-calendar",
			Action:    "create_event",
			Params:    map[string]any{"title": "Meeting"},
		},
	}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'Schedule meeting', 'self', 'cross_app', 'meso', 'normal', 'suggested', $2::jsonb)
		RETURNING id
	`, tenantID, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestCrossAppHandler(t, pool)
	var executedConnector, executedAction string
	h.connectorFn = func(_ context.Context, _, connector, action string, _ map[string]any) (any, error) {
		executedConnector = connector
		executedAction = action
		return map[string]any{"event_id": "evt-123"}, nil
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+commitmentID+"/execute-action", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.ExecuteAction(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body: %s", w.Code, w.Body.String())
	}

	// Verify connector was called with the proposed action.
	if executedConnector != "google-calendar" || executedAction != "create_event" {
		t.Errorf("executed (%s, %s), want (google-calendar, create_event)", executedConnector, executedAction)
	}

	// Verify commitment is now done.
	var status string
	var updatedPlanJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT status, action_plan FROM commitments WHERE id = $1
	`, commitmentID).Scan(&status, &updatedPlanJSON); err != nil {
		t.Fatalf("load commitment: %v", err)
	}
	if status != "done" {
		t.Errorf("status = %q, want done", status)
	}
	// Verify execution result was stored.
	var updatedPlan crossAppPlan
	_ = json.Unmarshal(updatedPlanJSON, &updatedPlan)
	if updatedPlan.ExecutionResult == nil {
		t.Error("ExecutionResult should be set after execute-action")
	}
}

// TestCrossApp_ExecuteAction_RejectsNonCrossApp verifies that execute-action
// refuses a commitment that is not kind='cross_app'.
func TestCrossApp_ExecuteAction_RejectsNonCrossApp(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	// Seed a plain commitment (kind=NULL, not cross_app).
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, tier, urgency, status)
		VALUES ($1, 'Plain task', 'self', 'meso', 'normal', 'open')
		RETURNING id
	`, tenantID).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestCrossAppHandler(t, pool)
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+commitmentID+"/execute-action", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.ExecuteAction(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d; body: %s", w.Code, w.Body.String())
	}
}

// TestCrossApp_ExecuteAction_RejectsAlreadyDone verifies that execute-action
// refuses to re-execute a done commitment (idempotency guard).
func TestCrossApp_ExecuteAction_RejectsAlreadyDone(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	plan := crossAppPlan{
		ProposedAction: crossAppProposed{Connector: "gmail", Action: "send_message"},
	}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'Done task', 'self', 'cross_app', 'meso', 'normal', 'done', $2::jsonb)
		RETURNING id
	`, tenantID, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestCrossAppHandler(t, pool)
	called := false
	h.connectorFn = func(_ context.Context, _, _, _ string, _ map[string]any) (any, error) {
		called = true
		return nil, nil
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+commitmentID+"/execute-action", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.ExecuteAction(w, req)

	if w.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d; body: %s", w.Code, w.Body.String())
	}
	if called {
		t.Error("connector must NOT be called on an already-done commitment")
	}
}

// TestCrossApp_ExecuteAction_CrossTenant verifies cross-tenant → 404.
func TestCrossApp_ExecuteAction_CrossTenant(t *testing.T) {
	pool := openTestPool(t)
	tenantA := seedCrossAppTenant(t, pool)
	tenantB := seedCrossAppTenant(t, pool)

	// Seed commitment owned by tenant A.
	plan := crossAppPlan{
		ProposedAction: crossAppProposed{Connector: "gmail", Action: "send_message"},
	}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'A task', 'self', 'cross_app', 'meso', 'normal', 'suggested', $2::jsonb)
		RETURNING id
	`, tenantA, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestCrossAppHandler(t, pool)
	// Authenticate as tenant B — should not see tenant A's commitment.
	tokB := mintTestToken(t, tenantB, uuid.NewString(), "owner")
	req := httptest.NewRequest(http.MethodPost, "/v1/commitments/"+commitmentID+"/execute-action", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tokB)
	w := httptest.NewRecorder()
	h.ExecuteAction(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 for cross-tenant, got %d; body: %s", w.Code, w.Body.String())
	}
}

// TestCrossApp_DisabledByDefault verifies propose returns 404 when
// LANTERN_CROSS_APP is unset.
func TestCrossApp_DisabledByDefault(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestCrossAppHandler(t, pool)

	t.Setenv("LANTERN_CROSS_APP", "") // explicitly unset

	body, _ := json.Marshal(map[string]any{
		"goal":          "test",
		"readConnector": "gmail",
		"readAction":    "list_recent",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/cross-app/propose", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Propose(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404 when disabled, got %d", w.Code)
	}
}

// TestCrossApp_NoAutonomousSideEffect is a structural test: run propose with a
// stub that panics if it's called more than once (the read). This verifies that
// propose never calls the connector for the proposed write action.
func TestCrossApp_NoAutonomousSideEffect(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedCrossAppTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestCrossAppHandler(t, pool)

	callCount := 0
	h.connectorFn = func(_ context.Context, _, _, action string, _ map[string]any) (any, error) {
		callCount++
		if callCount > 1 {
			t.Errorf("connector called %d times in propose — expected exactly 1 (read only)", callCount)
		}
		return map[string]any{"data": "some email context"}, nil
	}
	h.completeFn = func(_ context.Context, _, _, _ string) (string, error) {
		return fmt.Sprintf(`{"summary":"Send reply","action":{"connector":"gmail","action":"send_message","params":{"to":"x@y.com","subject":"Re: Meeting","body":"Sure!"}}}`), nil
	}

	t.Setenv("LANTERN_CROSS_APP", "on")

	body, _ := json.Marshal(map[string]any{
		"goal":          "reply to the meeting request",
		"readConnector": "gmail",
		"readAction":    "list_recent",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/cross-app/propose", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Propose(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("propose failed: %d %s", w.Code, w.Body.String())
	}
	if callCount != 1 {
		t.Errorf("connector called %d times, want exactly 1", callCount)
	}
}
