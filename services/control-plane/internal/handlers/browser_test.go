package handlers

// Tests for the browser-as-skill feature (increment 1 — contract layer only).
//
// Two layers:
//   - Gate tests: no DB needed; verify 404 when LANTERN_BROWSER_SKILL is unset.
//   - DB-backed tests: skip when DATABASE_URL is unset, matching the rest of
//     this package's pattern.
//
// The execFn seam is set directly on the handler struct (same pattern as
// cross_app's connectorFn) — no gRPC server required in tests.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

func newTestBrowserHandler(t *testing.T, pool *pgxpool.Pool) *BrowserHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	return NewBrowserHandler(srv, auth)
}

func seedBrowserTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	slug := "br-test-" + id[:8]
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Browser Test', 'personal', 'ns-br-' || $2)
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

// stubUnavailable is a browserExecFn that always returns TOOL_STATUS_UNAVAILABLE.
func stubUnavailable(_ context.Context, _ string, _ map[string]any) (*lanternv1.ExecToolResponse, error) {
	return &lanternv1.ExecToolResponse{
		Status: lanternv1.ToolStatus_TOOL_STATUS_UNAVAILABLE,
		Error:  "browser runtime not yet wired",
	}, nil
}

// ---------------------------------------------------------------------------
// TestBrowser_FeatureGateOff — all endpoints 404 when gate is unset
// ---------------------------------------------------------------------------

func TestBrowser_FeatureGateOff(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestBrowserHandler(t, pool)

	t.Setenv("LANTERN_BROWSER_SKILL", "") // explicitly off

	cases := []struct {
		name    string
		method  string
		path    string
		body    any
		handler func(w http.ResponseWriter, r *http.Request)
	}{
		{
			name:    "read",
			method:  http.MethodPost,
			path:    "/v1/browser/read",
			body:    map[string]string{"url": "https://example.com", "task": "get title"},
			handler: h.Read,
		},
		{
			name:    "propose",
			method:  http.MethodPost,
			path:    "/v1/browser/propose",
			body:    map[string]string{"url": "https://example.com", "action": "click", "goal": "submit"},
			handler: h.Propose,
		},
		{
			name:    "execute",
			method:  http.MethodPost,
			path:    "/v1/browser/commitments/nonexistent/execute",
			body:    nil,
			handler: func(w http.ResponseWriter, r *http.Request) { h.Execute(w, r) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyBytes []byte
			if tc.body != nil {
				bodyBytes, _ = json.Marshal(tc.body)
			}
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewReader(bodyBytes))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+tok)
			req.SetPathValue("id", "nonexistent")
			w := httptest.NewRecorder()
			tc.handler(w, req)
			if w.Code != http.StatusNotFound {
				t.Errorf("%s: expected 404, got %d; body: %s", tc.name, w.Code, w.Body.String())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TestBrowser_Propose — creates kind='browser_act' status='suggested' commitment
// ---------------------------------------------------------------------------

func TestBrowser_Propose(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")
	h := newTestBrowserHandler(t, pool)

	t.Setenv("LANTERN_BROWSER_SKILL", "on")

	body, _ := json.Marshal(map[string]string{
		"url":      "https://example.com/form",
		"action":   "click",
		"selector": "#submit-btn",
		"goal":     "submit the contact form",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/browser/propose", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Propose(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d; body: %s", w.Code, w.Body.String())
	}

	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID == "" {
		t.Fatal("expected id in response")
	}

	// Verify commitment stored with correct kind/status/action_plan.
	ctx := context.Background()
	var kind, status string
	var planJSON []byte
	if err := pool.QueryRow(ctx, `
		SELECT kind, status, action_plan FROM commitments WHERE id = $1 AND tenant_id = $2
	`, resp.ID, tenantID).Scan(&kind, &status, &planJSON); err != nil {
		t.Fatalf("load commitment: %v", err)
	}
	if kind != "browser_act" {
		t.Errorf("kind = %q, want browser_act", kind)
	}
	if status != "suggested" {
		t.Errorf("status = %q, want suggested", status)
	}

	var plan browserActPlan
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		t.Fatalf("parse action_plan: %v", err)
	}
	if plan.URL != "https://example.com/form" {
		t.Errorf("plan.URL = %q", plan.URL)
	}
	if plan.Action != "click" {
		t.Errorf("plan.Action = %q", plan.Action)
	}
	if plan.Selector != "#submit-btn" {
		t.Errorf("plan.Selector = %q", plan.Selector)
	}
	if plan.Goal != "submit the contact form" {
		t.Errorf("plan.Goal = %q", plan.Goal)
	}
	// Propose must NOT populate ExecutionResult.
	if plan.ExecutionResult != nil {
		t.Error("propose must NOT populate ExecutionResult (no side-effect without confirm)")
	}
}

// ---------------------------------------------------------------------------
// TestBrowser_Execute_NonOwnerForbidden — 403 for non-owner/admin
// ---------------------------------------------------------------------------

func TestBrowser_Execute_NonOwnerForbidden(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "member") // NOT owner/admin

	// Seed a browser_act commitment.
	plan := browserActPlan{URL: "https://example.com", Action: "click", Goal: "submit"}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'Submit form', 'browser', 'browser_act', 'meso', 'normal', 'suggested', $2::jsonb)
		RETURNING id
	`, tenantID, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestBrowserHandler(t, pool)
	execCalled := false
	h.execFn = func(_ context.Context, _ string, _ map[string]any) (*lanternv1.ExecToolResponse, error) {
		execCalled = true
		return stubUnavailable(nil, "", nil)
	}
	t.Setenv("LANTERN_BROWSER_SKILL", "on")

	req := httptest.NewRequest(http.MethodPost, "/v1/browser/commitments/"+commitmentID+"/execute", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Execute(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("non-owner: expected 403, got %d; body: %s", w.Code, w.Body.String())
	}
	if execCalled {
		t.Error("SECURITY: execFn fired for a non-owner caller")
	}
}

// ---------------------------------------------------------------------------
// TestBrowser_Execute_RuntimeUnavailable — 503 + status stays 'suggested'
// ---------------------------------------------------------------------------

func TestBrowser_Execute_RuntimeUnavailable(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	plan := browserActPlan{URL: "https://example.com", Action: "click", Goal: "submit form"}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'Submit form', 'browser', 'browser_act', 'meso', 'normal', 'suggested', $2::jsonb)
		RETURNING id
	`, tenantID, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	h := newTestBrowserHandler(t, pool)
	// execFn is nil — no runtime manager configured.
	t.Setenv("LANTERN_BROWSER_SKILL", "on")

	req := httptest.NewRequest(http.MethodPost, "/v1/browser/commitments/"+commitmentID+"/execute", nil)
	req.SetPathValue("id", commitmentID)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.Execute(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d; body: %s", w.Code, w.Body.String())
	}

	// Status must still be 'suggested' — commitment is retryable.
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM commitments WHERE id = $1`, commitmentID).Scan(&status); err != nil {
		t.Fatalf("load status: %v", err)
	}
	if status != "suggested" {
		t.Errorf("status = %q after 503, want suggested (retryable)", status)
	}
}

// ---------------------------------------------------------------------------
// TestBrowser_Execute_ConcurrentExactlyOnce — exactly-once claim semantics
// under concurrent load; UNAVAILABLE winner reverts to 'suggested'.
// ---------------------------------------------------------------------------

func TestBrowser_Execute_ConcurrentExactlyOnce(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	plan := browserActPlan{URL: "https://example.com", Action: "click", Goal: "submit form"}
	planJSON, _ := json.Marshal(plan)
	ctx := context.Background()
	var commitmentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO commitments (tenant_id, title, source, kind, tier, urgency, status, action_plan)
		VALUES ($1, 'Concurrent test', 'browser', 'browser_act', 'meso', 'normal', 'suggested', $2::jsonb)
		RETURNING id
	`, tenantID, string(planJSON)).Scan(&commitmentID); err != nil {
		t.Fatalf("seed commitment: %v", err)
	}

	// Stub: counts ExecTool invocations. Must be called AT MOST once (the one
	// goroutine that wins the atomic claim). Returns UNAVAILABLE so the winner
	// reverts to 'suggested'.
	var execCalls int64
	h := newTestBrowserHandler(t, pool)
	h.execFn = func(_ context.Context, _ string, _ map[string]any) (*lanternv1.ExecToolResponse, error) {
		atomic.AddInt64(&execCalls, 1)
		return &lanternv1.ExecToolResponse{
			Status: lanternv1.ToolStatus_TOOL_STATUS_UNAVAILABLE,
			Error:  "increment 2 not yet shipped",
		}, nil
	}
	t.Setenv("LANTERN_BROWSER_SKILL", "on")

	const N = 10
	codes := make([]int, N)
	var wg sync.WaitGroup
	for i := range N {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/v1/browser/commitments/"+commitmentID+"/execute", nil)
			req.SetPathValue("id", commitmentID)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			h.Execute(w, req)
			codes[i] = w.Code
		}()
	}
	wg.Wait()

	// ExecTool must have been called exactly once.
	if got := atomic.LoadInt64(&execCalls); got != 1 {
		t.Errorf("execFn called %d times, want exactly 1 (atomic claim broken)", got)
	}

	// Exactly 1 × 503 (winner — UNAVAILABLE → reverted); N-1 × 409 (losers — claim failed).
	var unavailableCount, conflictCount int
	for _, c := range codes {
		switch c {
		case http.StatusServiceUnavailable:
			unavailableCount++
		case http.StatusConflict:
			conflictCount++
		default:
			t.Errorf("unexpected status code %d (want 503 or 409)", c)
		}
	}
	if unavailableCount != 1 {
		t.Errorf("expected 1 winner (503), got %d", unavailableCount)
	}
	if conflictCount != N-1 {
		t.Errorf("expected %d conflicts (409), got %d", N-1, conflictCount)
	}

	// Winner reverted status to 'suggested' and deleted the receipt, so the
	// commitment is retryable.
	var finalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM commitments WHERE id = $1`, commitmentID).Scan(&finalStatus); err != nil {
		t.Fatalf("load final status: %v", err)
	}
	if finalStatus != "suggested" {
		t.Errorf("final status = %q, want suggested (winner must revert on UNAVAILABLE)", finalStatus)
	}
}

// ---------------------------------------------------------------------------
// TestBrowser_Read_RuntimeUnavailable — 503 when no manager / UNAVAILABLE
// ---------------------------------------------------------------------------

func TestBrowser_Read_RuntimeUnavailable(t *testing.T) {
	pool := openTestPool(t)
	tenantID := seedBrowserTenant(t, pool)
	tok := mintTestToken(t, tenantID, uuid.NewString(), "owner")

	t.Setenv("LANTERN_BROWSER_SKILL", "on")

	t.Run("no manager configured", func(t *testing.T) {
		h := newTestBrowserHandler(t, pool)
		// execFn is nil.

		body, _ := json.Marshal(map[string]string{"url": "https://example.com", "task": "get title"})
		req := httptest.NewRequest(http.MethodPost, "/v1/browser/read", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		h.Read(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("expected 503, got %d; body: %s", w.Code, w.Body.String())
		}
	})

	t.Run("manager returns UNAVAILABLE", func(t *testing.T) {
		h := newTestBrowserHandler(t, pool)
		h.execFn = stubUnavailable

		body, _ := json.Marshal(map[string]string{"url": "https://example.com", "task": "get title"})
		req := httptest.NewRequest(http.MethodPost, "/v1/browser/read", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		h.Read(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("expected 503, got %d; body: %s", w.Code, w.Body.String())
		}
	})
}
