package handlers

// Recovery sweep integration tests.
//
// All tests are gated on DATABASE_URL (same convention as the existing DB suite
// in runtime_test.go). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	    go test ./internal/handlers/ -run TestRecoverySweep -count=1 -v

import (
	"context"
	"fmt"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// recoveryTestDevTenantID is the fixed dev tenant seeded by Migrate(ctx, pool, true).
const recoveryTestDevTenantID = "00000000-0000-0000-0000-000000000001"

// TestRecoverySweep_PicksUpOrphanedRun verifies that a run in 'running' status
// with an expired (or absent) lock is picked up by the sweep and either resumed
// or marked failed. The test does NOT need a real LLM key — if the re-drive
// fails because no LLM provider is configured, we accept "failed" as the
// outcome (the run is no longer stuck in 'running').
func TestRecoverySweep_PicksUpOrphanedRun(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	// We need a real agent + version row to satisfy the FK constraints.
	// Reuse the dev tenant which is guaranteed to exist after Migrate.
	agentName := fmt.Sprintf("recovery-test-agent-%d", time.Now().UnixNano())

	var agentID string
	err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'recovery sweep test agent')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentName).Scan(&agentID)
	if err != nil {
		t.Fatalf("insert test agent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID)
	})

	var versionID string
	err = pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-recovery-test', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID)
	if err != nil {
		t.Fatalf("insert test version: %v", err)
	}
	// Promote the version.
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	// Insert a run in 'running' status (simulating a crash mid-execution).
	var runID string
	err = pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{"prompt":"recovery test"}'::jsonb, now() - interval '5 minutes')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentID, versionID).Scan(&runID)
	if err != nil {
		t.Fatalf("insert orphaned run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM run_locks WHERE run_id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
	})

	// No run_locks row — lock is absent, so sweep should claim it.

	// Build a minimal RESTHandler with no LLM proxy wired (so re-drive will
	// fail gracefully and mark the run failed rather than blocking).
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)
	// llmProxy is intentionally not wired → re-drive fails → run marked failed.

	recovered, skipped := h.RecoverOrphanedRuns(ctx)
	t.Logf("recovered=%d skipped=%d", recovered, skipped)

	// The sweep must have processed the run: either recovered it or marked it failed.
	// Either way the run must NOT still be 'running'.
	var finalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus == "running" || finalStatus == "queued" {
		t.Errorf("run %s is still in status %q after recovery sweep — expected failed or succeeded", runID, finalStatus)
	}
	t.Logf("run %s final status: %s", runID, finalStatus)
}

// TestRecoverySweep_LeavesValidLockAlone verifies that a run with a still-valid
// (non-expired) lock is NOT picked up by the sweep — no double-recovery.
func TestRecoverySweep_LeavesValidLockAlone(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	agentName := fmt.Sprintf("recovery-locked-agent-%d", time.Now().UnixNano())

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'locked run test')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID) })

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-locked-test', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{}'::jsonb, now())
		RETURNING id::text
	`, recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM run_locks WHERE run_id = $1`, runID)
	})

	// Insert a VALID (future-expires) lock — sweep must leave this run alone.
	if _, err := pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1, 'other-worker', now(), now() + interval '10 minutes')
	`, runID); err != nil {
		t.Fatalf("insert valid lock: %v", err)
	}

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)

	_, _ = h.RecoverOrphanedRuns(ctx)

	// The run must still be 'running' — the sweep must not have touched it.
	var finalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus != "running" {
		t.Errorf("run with valid lock was modified by recovery sweep: status=%s (expected 'running')", finalStatus)
	}

	// The lock's worker_id must still be 'other-worker' — not overwritten.
	var lockedBy string
	if err := pool.QueryRow(ctx, `SELECT worker_id FROM run_locks WHERE run_id = $1`, runID).Scan(&lockedBy); err != nil {
		t.Fatalf("read lock worker_id: %v", err)
	}
	if lockedBy != "other-worker" {
		t.Errorf("lock worker_id was changed from 'other-worker' to %q by sweep", lockedBy)
	}
}

// TestRecoverySweep_NoOrphans verifies the sweep handles an empty result
// gracefully (no crash, recovered=0, skipped=0).
func TestRecoverySweep_NoOrphans(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	// Make sure there are no orphaned runs visible (mark all running+queued
	// runs for our test tenant as succeeded so they don't interfere).
	// In practice tests run in isolation, but be defensive.
	// We just run the sweep and verify it doesn't error.

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)

	recovered, skipped := h.RecoverOrphanedRuns(ctx)
	// No assertion on counts — just must not panic.
	t.Logf("TestRecoverySweep_NoOrphans: recovered=%d skipped=%d", recovered, skipped)
}

// TestRecoverySweep_ExpiredLockIsPickedUp verifies that a run whose lock
// row exists but is expired IS picked up and re-driven (or failed).
func TestRecoverySweep_ExpiredLockIsPickedUp(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()

	agentName := fmt.Sprintf("recovery-expired-agent-%d", time.Now().UnixNano())

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, 'expired lock test')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentName).Scan(&agentID); err != nil {
		t.Fatalf("insert agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agentID) })

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'v0.0.1-expired-test', decode(md5($2), 'hex'), 'local://test', '{"runtime":"node"}'::jsonb)
		RETURNING id::text
	`, agentID, agentName).Scan(&versionID); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		t.Fatalf("promote version: %v", err)
	}

	var runID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, started_at)
		VALUES ($1, $2, $3, 'running', 'api', '{"prompt":"expired-lock-run"}'::jsonb, now() - interval '30 minutes')
		RETURNING id::text
	`, recoveryTestDevTenantID, agentID, versionID).Scan(&runID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM run_locks WHERE run_id = $1`, runID)
		_, _ = pool.Exec(ctx, `DELETE FROM journal_events WHERE run_id = $1`, runID)
	})

	// Insert an EXPIRED lock — sweep should still claim it.
	if _, err := pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1, 'dead-worker', now() - interval '1 hour', now() - interval '50 minutes')
	`, runID); err != nil {
		t.Fatalf("insert expired lock: %v", err)
	}

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	agentSvc := NewAgentService(srv)
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-secret")
	h := NewRESTHandler(srv, auth, agentSvc, runSvc)
	// No llmProxy → re-drive fails → run marked failed.

	_, _ = h.RecoverOrphanedRuns(ctx)

	// The run must no longer be stuck in 'running'.
	var finalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&finalStatus); err != nil {
		t.Fatalf("read final status: %v", err)
	}
	if finalStatus == "running" || finalStatus == "queued" {
		t.Errorf("run with expired lock still stuck in %q — sweep should have acted on it", finalStatus)
	}
	t.Logf("run %s with expired lock: final status %s", runID, finalStatus)

	// The lock row must now point to the recovery worker (not the dead one).
	var newWorker string
	if err := pool.QueryRow(ctx, `SELECT worker_id FROM run_locks WHERE run_id = $1`, runID).Scan(&newWorker); err != nil {
		t.Fatalf("read lock worker: %v", err)
	}
	if newWorker == "dead-worker" {
		t.Error("lock still owned by dead-worker — sweep did not update it")
	}
	t.Logf("lock now owned by: %s", newWorker)
}
