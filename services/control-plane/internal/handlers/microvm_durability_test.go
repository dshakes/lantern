package handlers

// microvm_durability_test.go — integration tests for microVM-tier durability parity (task #8).
//
// Covers:
//  1. Report kind=step_event → journal_events row written with correct kind/step_id.
//  2. Report kind=vm_exit exit_code=0 → run finalized as 'succeeded', output stored.
//  3. Report kind=vm_exit exit_code=1 → run finalized as 'failed', typed error stored.
//  4. Crash-resume: dead VM → recovery sweep re-schedules via dispatcher with same run_id.
//  5. Crash-resume cap: 3 VMs terminated → recovery sweep marks run failed with microvm_resume_exhausted.
//
// All tests are gated on DATABASE_URL (same convention as the rest of the DB suite).
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	    go test ./internal/handlers/ -run TestMicroVMDurability -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- helpers ----------

// seedMicroVMRun creates an agent with isolation=microvm and a corresponding
// run in 'running' status. Returns (runID, agentVersionID). The test is
// responsible for cleanup via t.Cleanup.
func seedMicroVMRun(t *testing.T, tenantID string) (runID, agentVersionID string) {
	t.Helper()
	pool := openTestPool(t)
	ctx := context.Background()

	agentName := fmt.Sprintf("mv-durability-agent-%d", time.Now().UnixNano())
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'microvm durability test')
		RETURNING id::text
	`, tenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("seedMicroVMRun: insert agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID) })

	manifest := map[string]any{
		"isolation":   "microvm",
		"imageDigest": "sha256:cafebabe",
	}
	manifestJSON, _ := json.Marshal(manifest)
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-durability', decode(md5($2), 'hex'), 'local://test', $3::jsonb)
		RETURNING id::text
	`, agentID, agentName, string(manifestJSON)).Scan(&agentVersionID); err != nil {
		t.Fatalf("seedMicroVMRun: insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, agentVersionID, agentID); err != nil {
		t.Fatalf("seedMicroVMRun: promote version: %v", err)
	}

	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now())
		RETURNING id::text
	`, tenantID, agentID, agentVersionID).Scan(&runID); err != nil {
		t.Fatalf("seedMicroVMRun: insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM runtime_vms WHERE run_id = $1::uuid`, runID)
	})
	return runID, agentVersionID
}

// seedTerminalVM inserts a runtime_vms row in the given state for a run.
// Used to simulate past VM attempts for crash-resume cap tests.
func seedTerminalVM(t *testing.T, tenantID, runID, state string) string {
	t.Helper()
	pool := openTestPool(t)
	vmID := fmt.Sprintf("vm-test-%d", time.Now().UnixNano())
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, isolation_class, state, spec, created_at, terminated_at)
		VALUES ($1, $2, $3::uuid, 'microvm', $4, '{}', now() - interval '2 minutes', now() - interval '1 minute')
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, runID, state)
	if err != nil {
		t.Fatalf("seedTerminalVM: %v", err)
	}
	return vmID
}

// doReportReq fires a POST /v1/runtime/report authenticated with the
// testRuntimeSecretToken and returns the recorder.
func doReportReq(h *RuntimeReportHandler, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/report", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(runtimeTokenHeader, testRuntimeSecretToken)
	w := httptest.NewRecorder()
	h.Report(w, req)
	return w
}

// ---------- Test 1: step_event → journal_events row ----------

func TestMicroVMDurability_StepEvent(t *testing.T) {
	pool := openTestPool(t)
	setReportToken(t, testRuntimeSecretToken)

	tenantID := recoveryTestDevTenantID
	runID, _ := seedMicroVMRun(t, tenantID)

	// Seed a running VM bound to the run.
	vmID := fmt.Sprintf("vm-step-event-%d", time.Now().UnixNano())
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, state, spec, created_at)
		VALUES ($1, $2, $3::uuid, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, runID)
	if err != nil {
		t.Fatalf("seed vm: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewRuntimeReportHandler(srv)

	// Send a step_started event.
	w := doReportReq(h, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"run_id":    runID,
		"kind":      "step_event",
		"step_event": map[string]any{
			"event_kind": "step_started",
			"step_id":    "tool:fetch-data",
			"attempt":    1,
			"payload":    map[string]any{"url": "https://example.com"},
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("step_event: got HTTP %d, want 202; body: %s", w.Code, w.Body.String())
	}

	// Verify journal_events row was written.
	var kind, stepID string
	if err := pool.QueryRow(context.Background(), `
		SELECT kind, step_id FROM journal_events
		WHERE run_id = $1 ORDER BY seq DESC LIMIT 1
	`, runID).Scan(&kind, &stepID); err != nil {
		t.Fatalf("read journal_events: %v", err)
	}
	if kind != "step_started" {
		t.Errorf("journal kind: got %q, want %q", kind, "step_started")
	}
	if stepID != "tool:fetch-data" {
		t.Errorf("journal step_id: got %q, want %q", stepID, "tool:fetch-data")
	}

	// Send step_completed to verify the second event lands with a higher seq.
	w = doReportReq(h, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"run_id":    runID,
		"kind":      "step_event",
		"step_event": map[string]any{
			"event_kind": "step_completed",
			"step_id":    "tool:fetch-data",
			"attempt":    1,
			"payload":    map[string]any{"result": "ok"},
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("step_completed: got HTTP %d, want 202", w.Code)
	}
	kinds := journalKindsForRun(t, pool, runID)
	if len(kinds) < 2 || kinds[len(kinds)-1] != "step_completed" {
		t.Errorf("journal kinds after step_completed: %v", kinds)
	}
}

// ---------- Test 2: vm_exit exit_code=0 → run succeeded ----------

func TestMicroVMDurability_VMExit_Success(t *testing.T) {
	pool := openTestPool(t)
	setReportToken(t, testRuntimeSecretToken)

	tenantID := recoveryTestDevTenantID
	runID, _ := seedMicroVMRun(t, tenantID)

	vmID := fmt.Sprintf("vm-exit-ok-%d", time.Now().UnixNano())
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, state, spec, created_at)
		VALUES ($1, $2, $3::uuid, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, runID)
	if err != nil {
		t.Fatalf("seed vm: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewRuntimeReportHandler(srv)

	w := doReportReq(h, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"run_id":    runID,
		"kind":      "vm_exit",
		"vm_exit": map[string]any{
			"exit_code": 0,
			"output":    map[string]any{"answer": "42"},
		},
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("vm_exit (success): got HTTP %d, want 202; body: %s", w.Code, w.Body.String())
	}

	// Run must be 'succeeded'.
	if got := twoTierRunStatus(t, pool, runID); got != "succeeded" {
		t.Errorf("run status: got %q, want succeeded", got)
	}

	// output column must contain the reported value.
	var outputJSON []byte
	_ = pool.QueryRow(context.Background(), `SELECT output FROM runs WHERE id = $1`, runID).Scan(&outputJSON)
	var out map[string]any
	if json.Unmarshal(outputJSON, &out) != nil || out["answer"] != "42" {
		t.Errorf("run.output: got %s, want {answer:42}", outputJSON)
	}

	// A terminal journal event must be present.
	kinds := journalKindsForRun(t, pool, runID)
	if len(kinds) == 0 || kinds[len(kinds)-1] != "step_completed" {
		t.Errorf("journal: last kind should be step_completed, got %v", kinds)
	}
}

// ---------- Test 3: vm_exit exit_code=1 → run failed ----------

func TestMicroVMDurability_VMExit_Failure(t *testing.T) {
	pool := openTestPool(t)
	setReportToken(t, testRuntimeSecretToken)

	tenantID := recoveryTestDevTenantID
	runID, _ := seedMicroVMRun(t, tenantID)

	vmID := fmt.Sprintf("vm-exit-fail-%d", time.Now().UnixNano())
	_, err := pool.Exec(context.Background(), `
		INSERT INTO runtime_vms (vm_id, tenant_id, run_id, state, spec, created_at)
		VALUES ($1, $2, $3::uuid, 'running', '{}', now())
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, runID)
	if err != nil {
		t.Fatalf("seed vm: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, vmID)
	})

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewRuntimeReportHandler(srv)

	w := doReportReq(h, map[string]any{
		"vm_id":     vmID,
		"tenant_id": tenantID,
		"run_id":    runID,
		"kind":      "vm_exit",
		"vm_exit":   map[string]any{"exit_code": 137}, // OOM-killed
	})
	if w.Code != http.StatusAccepted {
		t.Fatalf("vm_exit (failure): got HTTP %d, want 202; body: %s", w.Code, w.Body.String())
	}

	// Run must be 'failed'.
	if got := twoTierRunStatus(t, pool, runID); got != "failed" {
		t.Errorf("run status: got %q, want failed", got)
	}

	// error column must carry microvm_exit code.
	var errJSON []byte
	_ = pool.QueryRow(context.Background(), `SELECT error FROM runs WHERE id = $1`, runID).Scan(&errJSON)
	var errMap map[string]any
	if json.Unmarshal(errJSON, &errMap) != nil || errMap["code"] != "microvm_exit" {
		t.Errorf("run.error: got %s, want code=microvm_exit", errJSON)
	}
	if ec, _ := errMap["exitCode"].(float64); int(ec) != 137 {
		t.Errorf("run.error.exitCode: got %v, want 137", errMap["exitCode"])
	}

	// Terminal journal event must be step_failed.
	kinds := journalKindsForRun(t, pool, runID)
	if len(kinds) == 0 || kinds[len(kinds)-1] != "step_failed" {
		t.Errorf("journal: last kind should be step_failed, got %v", kinds)
	}
}

// ---------- Test 4: crash-resume → new VM re-scheduled ----------

func TestMicroVMDurability_CrashResume_Redrive(t *testing.T) {
	pool := openTestPool(t)
	tenantID := recoveryTestDevTenantID
	runID, agentVersionID := seedMicroVMRun(t, tenantID)

	// Seed 1 terminated VM (first attempt failed).
	_ = agentVersionID
	seedTerminalVM(t, tenantID, runID, "terminated")

	// Build a RESTHandler with a fake dispatcher.
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)

	disp := &fakeDispatcher{}
	h.SetMicroVMDispatcher(disp)

	// Insert an expired run_lock so findOrphanedRuns returns this run.
	wid := workerID()
	_, _ = pool.Exec(context.Background(), `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1::uuid, $2, now() - interval '20 minutes', now() - interval '10 minutes')
		ON CONFLICT (run_id) DO UPDATE SET expires_at = now() - interval '10 minutes'
	`, runID, "some-other-worker")

	// Run the recovery sweep once.
	recovered, skipped := h.RecoverOrphanedRuns(context.Background())
	t.Logf("recovery: recovered=%d skipped=%d", recovered, skipped)

	// The dispatcher must have been called exactly once (new VM for the run).
	if disp.calls != 1 {
		t.Errorf("dispatcher.calls: got %d, want 1", disp.calls)
	}

	// Clean up the lock inserted by the sweep.
	_, _ = pool.Exec(context.Background(), `DELETE FROM run_locks WHERE worker_id = $1`, wid)
}

// ---------- Test 5: crash-resume cap → run failed with microvm_resume_exhausted ----------

func TestMicroVMDurability_CrashResume_Cap(t *testing.T) {
	pool := openTestPool(t)
	tenantID := recoveryTestDevTenantID
	runID, _ := seedMicroVMRun(t, tenantID)

	// Seed maxMicroVMResumeAttempts terminated VMs (all attempts exhausted).
	for i := 0; i < maxMicroVMResumeAttempts; i++ {
		seedTerminalVM(t, tenantID, runID, "terminated")
		// Ensure unique timestamps so vm_id generator doesn't collide.
		time.Sleep(time.Millisecond)
	}

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)

	disp := &fakeDispatcher{}
	h.SetMicroVMDispatcher(disp)

	// Insert an expired run_lock so the sweep picks up the run.
	_, _ = pool.Exec(context.Background(), `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1::uuid, $2, now() - interval '20 minutes', now() - interval '10 minutes')
		ON CONFLICT (run_id) DO UPDATE SET expires_at = now() - interval '10 minutes'
	`, runID, "some-other-worker-cap")

	// Run the recovery sweep.
	h.RecoverOrphanedRuns(context.Background())

	// Dispatcher must NOT have been called (cap exceeded).
	if disp.calls != 0 {
		t.Errorf("dispatcher.calls: got %d, want 0 (cap reached)", disp.calls)
	}

	// Poll briefly for the async DB write.
	deadline := time.Now().Add(3 * time.Second)
	var status string
	for time.Now().Before(deadline) {
		status = twoTierRunStatus(t, pool, runID)
		if status == "failed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status != "failed" {
		t.Errorf("run status: got %q, want failed (resume_exhausted)", status)
	}

	// error column must carry microvm_resume_exhausted code.
	var errJSON []byte
	_ = pool.QueryRow(context.Background(), `SELECT error FROM runs WHERE id = $1`, runID).Scan(&errJSON)
	var errMap map[string]any
	if json.Unmarshal(errJSON, &errMap) != nil || errMap["code"] != "microvm_resume_exhausted" {
		t.Errorf("run.error: got %s, want code=microvm_resume_exhausted", errJSON)
	}
}
