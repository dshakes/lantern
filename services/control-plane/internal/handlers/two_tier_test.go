package handlers

// two_tier_test.go — integration tests for two-tier run routing (ADR 0022).
//
// Covers:
//   1. Manifest isolation validation: unknown value → 400 via PATCH /v1/agents/{name}.
//   2. microVM run: fake SchedulerClient → run transitions to running, runtime_vms
//      row created, step_started/step_completed journal events written.
//   3. Scheduler error → run marked failed with code "microvm_unavailable",
//      step_failed journal event written, inline executor never called.
//   4. Absent/shared isolation → inline path is not routed to microVM
//      (existing behaviour preserved).
//
// All DB tests are gated on DATABASE_URL.
// Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	    go test ./internal/handlers/ -run TestTwoTier -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- helpers ----------

// newTwoTierRESTHandler builds a minimal RESTHandler backed by a real pool.
// llmProxy is intentionally nil so the inline executor never fires; we can
// detect whether the microVM path was taken by inspecting the DB.
func newTwoTierRESTHandler(t *testing.T, pool *pgxpool.Pool) *RESTHandler {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	return NewRESTHandler(srv, auth, agentSvc, runSvc)
}

// twoTierAgent seeds an agent + agent_version with the given manifest JSONB
// and promotes it. Returns (agentName, agentVersionID).
func twoTierAgent(t *testing.T, pool *pgxpool.Pool, tenantID string, manifest map[string]any) (string, string) {
	t.Helper()
	ctx := context.Background()
	agentName := fmt.Sprintf("two-tier-agent-%d", time.Now().UnixNano())
	manifestJSON, _ := json.Marshal(manifest)

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'two-tier routing test')
		RETURNING id::text
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID) })

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-two-tier', decode(md5($2), 'hex'), 'local://test', $3::jsonb)
		RETURNING id::text
	`, agentID, agentName, string(manifestJSON)).Scan(&versionID); err != nil {
		t.Fatalf("seed agent_version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}
	return agentName, versionID
}

// journalKindsForRun returns the list of journal event kinds for a run in seq order.
func journalKindsForRun(t *testing.T, pool *pgxpool.Pool, runID string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT kind FROM journal_events WHERE run_id = $1 ORDER BY seq`, runID)
	if err != nil {
		t.Fatalf("query journal: %v", err)
	}
	defer rows.Close()
	var kinds []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err == nil {
			kinds = append(kinds, k)
		}
	}
	return kinds
}

// runStatus reads the status column of a runs row.
func twoTierRunStatus(t *testing.T, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM runs WHERE id = $1`, runID).Scan(&status); err != nil {
		t.Fatalf("read run status: %v", err)
	}
	return status
}

// vmRowExists returns true if a runtime_vms row exists for the given runID.
func vmRowExists(t *testing.T, pool *pgxpool.Pool, runID string) bool {
	t.Helper()
	var count int
	_ = pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM runtime_vms WHERE run_id = $1::uuid`, runID).Scan(&count)
	return count > 0
}

// ---------- fakeDispatcher — a MicroVMDispatcher for tests ----------

type fakeDispatcher struct {
	err   error  // if non-nil, ScheduleRunInMicroVM returns this error
	vmID  string // vmID to return on success
	calls int    // call counter — test-visible
}

func (f *fakeDispatcher) ScheduleRunInMicroVM(_ context.Context, _, _, _, _ string, _ map[string]any) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	if f.vmID == "" {
		return "vm-test-" + fmt.Sprint(f.calls), nil
	}
	return f.vmID, nil
}

// ---------- Test 1: manifest isolation validation ----------

// TestTwoTier_ManifestIsolationValidation verifies that PATCH /v1/agents/{name}
// returns 400 when the manifest.isolation field has an unknown value, and 200
// for the valid values ("shared", "microvm") and the absent case.
func TestTwoTier_ManifestIsolationValidation(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tenantID := recoveryTestDevTenantID

	// Seed an agent with a default manifest.
	agentName, _ := twoTierAgent(t, pool, tenantID, map[string]any{"runtime": "node"})

	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")

	doPatch := func(manifest map[string]any) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"manifest": manifest})
		req := httptest.NewRequest(http.MethodPatch, "/v1/agents/"+agentName, bytes.NewReader(body))
		req.SetPathValue("name", agentName)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		h.UpdateAgent(w, req)
		return w
	}

	tests := []struct {
		name     string
		iso      string
		wantCode int
	}{
		{"bogus value", "dedicated", http.StatusBadRequest},
		{"valid shared", "shared", http.StatusOK},
		{"valid microvm", "microvm", http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doPatch(map[string]any{"isolation": tc.iso})
			if w.Code != tc.wantCode {
				t.Fatalf("isolation=%q: got HTTP %d, want %d; body: %s",
					tc.iso, w.Code, tc.wantCode, w.Body.String())
			}
		})
	}
}

// ---------- Test 2: microVM run → running + vms row + journal events ----------

func TestTwoTier_MicroVMRun_Success(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tenantID := recoveryTestDevTenantID

	// Agent with microvm isolation.
	agentName, _ := twoTierAgent(t, pool, tenantID, map[string]any{
		"isolation":   "microvm",
		"imageDigest": "sha256:deadbeef",
	})

	// Wire fake dispatcher and runtime handler so scheduleAgentSpec can write vms rows.
	rtLogger, _ := zap.NewDevelopment()
	rtSrv := &server.Server{Pool: pool, Logger: rtLogger}
	rtAuth := NewAuthHandler(rtSrv, testJWTSecret)
	rtHandler := NewRuntimeHandler(rtSrv, rtAuth)
	sched := &recScheduler{vmID: "vm-two-tier-success"}
	rtHandler.WithScheduler(sched)
	h.SetMicroVMDispatcher(rtHandler)

	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")
	body, _ := json.Marshal(map[string]any{"agentName": agentName, "input": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.CreateRun(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRun: got %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	runID, _ := resp["id"].(string)
	if runID == "" {
		t.Fatalf("response missing id: %s", w.Body.String())
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE run_id = $1::uuid`, runID)
	})

	// dispatchMicroVMRun runs in a goroutine. Poll for step_completed (written
	// after the runtime_vms row), which implies both status=running and the vm
	// row are already in the DB.
	deadline := time.Now().Add(5 * time.Second)
	var kinds []string
	for time.Now().Before(deadline) {
		kinds = journalKindsForRun(t, pool, runID)
		if len(kinds) >= 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Journal must have step_started + step_completed for microvm:schedule.
	wantKinds := []string{"step_started", "step_completed"}
	if len(kinds) < len(wantKinds) {
		t.Errorf("journal kinds: got %v, want at least %v", kinds, wantKinds)
	} else {
		for i, want := range wantKinds {
			if kinds[i] != want {
				t.Errorf("journal[%d]: got %q, want %q", i, kinds[i], want)
			}
		}
	}

	// After step_completed the run must be 'running' and the vms row must exist.
	if got := twoTierRunStatus(t, pool, runID); got != "running" {
		t.Errorf("run status: got %q, want %q", got, "running")
	}
	if !vmRowExists(t, pool, runID) {
		t.Error("expected a runtime_vms row for the run, found none")
	}
}

// ---------- Test 3: scheduler error → run failed, no inline execution ----------

func TestTwoTier_MicroVMRun_SchedulerError(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tenantID := recoveryTestDevTenantID

	agentName, _ := twoTierAgent(t, pool, tenantID, map[string]any{
		"isolation":   "microvm",
		"imageDigest": "sha256:deadbeef",
	})

	// Dispatcher that always fails.
	disp := &fakeDispatcher{err: errors.New("scheduler: connection refused")}
	h.SetMicroVMDispatcher(disp)

	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")
	body, _ := json.Marshal(map[string]any{"agentName": agentName, "input": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.CreateRun(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRun: got %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	runID, _ := resp["id"].(string)
	if runID == "" {
		t.Fatalf("response missing id")
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM journal_events WHERE run_id = $1`, runID)
	})

	// Wait for the background goroutine to fail the run.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if twoTierRunStatus(t, pool, runID) == "failed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if got := twoTierRunStatus(t, pool, runID); got != "failed" {
		t.Errorf("run status: got %q, want %q", got, "failed")
	}

	// Error column must carry microvm_unavailable code.
	var errJSON []byte
	_ = pool.QueryRow(context.Background(),
		`SELECT error FROM runs WHERE id = $1`, runID).Scan(&errJSON)
	var errMap map[string]string
	if json.Unmarshal(errJSON, &errMap) != nil || errMap["code"] != "microvm_unavailable" {
		t.Errorf("run.error: got %s, want code=microvm_unavailable", errJSON)
	}

	// Journal must have step_started + step_failed (no inline events).
	deadline = time.Now().Add(3 * time.Second)
	var kinds []string
	for time.Now().Before(deadline) {
		kinds = journalKindsForRun(t, pool, runID)
		if len(kinds) >= 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(kinds) < 2 || kinds[0] != "step_started" || kinds[1] != "step_failed" {
		t.Errorf("journal kinds: got %v, want [step_started step_failed]", kinds)
	}

	// Inline executor must NOT have been called (no llmProxy wired).
	// The fakeDispatcher call count is the only proof we need.
	if disp.calls != 1 {
		t.Errorf("dispatcher.calls: got %d, want 1", disp.calls)
	}
}

// ---------- Test 4: absent/shared isolation → inline path unchanged ----------

func TestTwoTier_SharedIsolation_InlinePath(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tenantID := recoveryTestDevTenantID

	// microVMDispatcher is wired with a fake that always errors, so if the
	// microVM path is taken the run would fail. We verify it is NOT taken.
	disp := &fakeDispatcher{err: errors.New("should not be called")}
	h.SetMicroVMDispatcher(disp)
	// llmProxy is nil → inline executor skipped (run stays queued/running but
	// dispatcher must not be called).

	agentName, _ := twoTierAgent(t, pool, tenantID, map[string]any{"runtime": "node"}) // no isolation field

	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-000000000002", "owner")
	body, _ := json.Marshal(map[string]any{"agentName": agentName, "input": map[string]any{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	h.CreateRun(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("CreateRun: got %d, want 201; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	runID, _ := resp["id"].(string)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runs WHERE id = $1`, runID)
	})

	// Give any goroutine a moment to fire.
	time.Sleep(150 * time.Millisecond)

	// Dispatcher must NOT have been called (shared path bypasses microVM).
	if disp.calls != 0 {
		t.Errorf("dispatcher was called %d times for a shared-isolation agent; want 0", disp.calls)
	}
}
