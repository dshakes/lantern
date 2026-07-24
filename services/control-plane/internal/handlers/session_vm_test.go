package handlers

// DB-gated tests for session-scoped microVM affinity (scheduleSessionVM,
// TerminateSessionVM, sweepIdleSessionVMs).
//
// Skipped automatically when DATABASE_URL is unset. Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run TestSessionVM -v -count=1 -p 1

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newSessionVMHandler builds a RuntimeHandler with a real pool and a
// recording scheduler for session-VM tests. Runs pending migrations so the
// 0016_session_vm columns exist before any test logic runs.
func newSessionVMHandler(t *testing.T) (*RuntimeHandler, *recScheduler) {
	t.Helper()
	pool := openTestPool(t)
	if err := db.Migrate(context.Background(), pool, false); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	sched := &recScheduler{}
	h := &RuntimeHandler{
		srv:       srv,
		auth:      auth,
		scheduler: sched,
		identity:  agentidentity.New(auth.JWTSecret()),
	}
	return h, sched
}

// cleanupVMs deletes runtime_vms rows created by a test.
func cleanupVMs(t *testing.T, h *RuntimeHandler, vmIDs ...string) {
	t.Helper()
	for _, id := range vmIDs {
		_, _ = h.srv.Pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE vm_id = $1`, id)
	}
}

// scheduleCount returns the number of "schedule" entries in the scheduler's call log.
func scheduleCount(sched *recScheduler) int {
	n := 0
	for _, c := range sched.calls {
		if c == "schedule" {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestSessionVM_Reuse verifies that two consecutive scheduleSessionVM calls
// for the same session return the same vm_id (reuse, no double-spawn).
func TestSessionVM_Reuse(t *testing.T) {
	h, sched := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	sessionID := "sess-reuse-" + newID()
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	vmID1, err := h.scheduleSessionVM(ctx, devTenantID, sessionID, spec)
	if err != nil {
		t.Fatalf("first scheduleSessionVM: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmID1) })

	vmID2, err := h.scheduleSessionVM(ctx, devTenantID, sessionID, spec)
	if err != nil {
		t.Fatalf("second scheduleSessionVM: %v", err)
	}

	if vmID1 != vmID2 {
		t.Errorf("expected reuse: vmID1=%q vmID2=%q differ", vmID1, vmID2)
	}
	if n := scheduleCount(sched); n != 1 {
		t.Errorf("expected 1 scheduler.Schedule call, got %d", n)
	}
}

// TestSessionVM_NoReuseAcrossSessions verifies different sessions spawn distinct VMs.
func TestSessionVM_NoReuseAcrossSessions(t *testing.T) {
	h, _ := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	vmA, err := h.scheduleSessionVM(ctx, devTenantID, "sess-a-"+newID(), spec)
	if err != nil {
		t.Fatalf("scheduleSessionVM A: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmA) })

	vmB, err := h.scheduleSessionVM(ctx, devTenantID, "sess-b-"+newID(), spec)
	if err != nil {
		t.Fatalf("scheduleSessionVM B: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmB) })

	if vmA == vmB {
		t.Errorf("different sessions must not share a VM (both returned %q)", vmA)
	}
}

// TestSessionVM_NoReuseAcrossTenants verifies that a session VM for tenant A is
// invisible to tenant B even when session IDs collide.
func TestSessionVM_NoReuseAcrossTenants(t *testing.T) {
	h, _ := newSessionVMHandler(t)
	// devTenantID is the seeded dev tenant. We use a fabricated UUID for tenant B
	// — the DB check is (tenant_id, session_id), so a mismatched tenant_id is
	// enough to prove isolation without inserting a real second tenant row.
	const tenantB = "00000000-0000-0000-0000-000000000099"
	sharedSID := "sess-shared-" + newID()
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	vmA, err := h.scheduleSessionVM(tenantCtx(devTenantID), devTenantID, sharedSID, spec)
	if err != nil {
		t.Fatalf("tenant A scheduleSessionVM: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmA) })

	// Direct DB check: tenant B must find no live VM for the same session_id.
	var found string
	_ = h.srv.Pool.QueryRow(context.Background(), `
		SELECT COALESCE(vm_id, '') FROM runtime_vms
		WHERE tenant_id = $1 AND session_id = $2
		  AND state IN ('pending','spawning','running')
		LIMIT 1
	`, tenantB, sharedSID).Scan(&found)

	if found != "" {
		t.Errorf("cross-tenant leak: tenant B found VM %q owned by tenant A", found)
	}
}

// TestSessionVM_ConcurrentDoubleSchedule fires two goroutines for the same
// session concurrently. singleflight must deduplicate them to one spawn.
func TestSessionVM_ConcurrentDoubleSchedule(t *testing.T) {
	h, sched := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	sessionID := "sess-concurrent-" + newID()
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		vmIDs []string
		errs  []error
	)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			vmID, err := h.scheduleSessionVM(ctx, devTenantID, sessionID, spec)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
			} else {
				vmIDs = append(vmIDs, vmID)
			}
		}()
	}
	wg.Wait()

	if len(errs) > 0 {
		t.Fatalf("concurrent scheduleSessionVM errors: %v", errs)
	}
	if len(vmIDs) != 2 {
		t.Fatalf("expected 2 results, got %d", len(vmIDs))
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmIDs[0]) })

	if vmIDs[0] != vmIDs[1] {
		t.Errorf("concurrent calls got different vm_ids (%q vs %q) — double-spawn", vmIDs[0], vmIDs[1])
	}
	if n := scheduleCount(sched); n != 1 {
		t.Errorf("expected 1 scheduler.Schedule call, got %d (double-spawn?)", n)
	}
}

// TestSessionVM_TeardownOnDelete verifies TerminateSessionVM terminates the VM
// and writes a session_vm_terminated audit event.
func TestSessionVM_TeardownOnDelete(t *testing.T) {
	h, sched := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	sessionID := "sess-teardown-" + newID()
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	vmID, err := h.scheduleSessionVM(ctx, devTenantID, sessionID, spec)
	if err != nil {
		t.Fatalf("scheduleSessionVM: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, vmID) })

	if err := h.TerminateSessionVM(ctx, devTenantID, sessionID); err != nil {
		t.Fatalf("TerminateSessionVM: %v", err)
	}

	// Scheduler must have received a Terminate call for this VM.
	found := false
	for _, c := range sched.calls {
		if c == "terminate:"+vmID {
			found = true
		}
	}
	if !found {
		t.Errorf("scheduler.Terminate(%q) not called; calls: %v", vmID, sched.calls)
	}

	// DB row must be marked terminated.
	var state string
	_ = h.srv.Pool.QueryRow(context.Background(),
		`SELECT state FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&state)
	if state != "terminated" {
		t.Errorf("runtime_vms.state = %q, want %q", state, "terminated")
	}

	// Audit event must exist.
	var auditN int
	_ = h.srv.Pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM runtime_audit_events
		WHERE vm_id = $1 AND action = 'session_vm_terminated'
	`, vmID).Scan(&auditN)
	if auditN == 0 {
		t.Error("expected session_vm_terminated audit event, got none")
	}
}

// TestSessionVM_TeardownNoVM verifies TerminateSessionVM is a no-op (no error,
// no panic) when no live VM exists for the session.
func TestSessionVM_TeardownNoVM(t *testing.T) {
	h, _ := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	if err := h.TerminateSessionVM(ctx, devTenantID, "sess-no-vm-"+newID()); err != nil {
		t.Errorf("TerminateSessionVM with no VM: got %v, want nil", err)
	}
}

// TestSessionVM_IdleSweep verifies sweepIdleSessionVMs terminates stale session
// VMs (last_used_at past TTL) and leaves fresh ones running.
func TestSessionVM_IdleSweep(t *testing.T) {
	h, sched := newSessionVMHandler(t)
	ctx := tenantCtx(devTenantID)
	logger, _ := zap.NewDevelopment()
	spec := agentSpecDTO{ImageDigest: "sha256:test", Isolation: "microvm"}

	staleVMID, err := h.scheduleSessionVM(ctx, devTenantID, "sess-stale-"+newID(), spec)
	if err != nil {
		t.Fatalf("spawn stale VM: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, staleVMID) })

	freshVMID, err := h.scheduleSessionVM(ctx, devTenantID, "sess-fresh-"+newID(), spec)
	if err != nil {
		t.Fatalf("spawn fresh VM: %v", err)
	}
	t.Cleanup(func() { cleanupVMs(t, h, freshVMID) })

	// Wind back the stale VM's last_used_at past the TTL.
	_, _ = h.srv.Pool.Exec(context.Background(), `
		UPDATE runtime_vms SET last_used_at = now() - interval '2 hours' WHERE vm_id = $1
	`, staleVMID)
	// Ensure the fresh VM is marked as recently used.
	_, _ = h.srv.Pool.Exec(context.Background(), `
		UPDATE runtime_vms SET last_used_at = now() WHERE vm_id = $1
	`, freshVMID)

	sweepIdleSessionVMs(ctx, h, 30*time.Minute, logger)

	var staleState, freshState string
	_ = h.srv.Pool.QueryRow(context.Background(),
		`SELECT state FROM runtime_vms WHERE vm_id = $1`, staleVMID).Scan(&staleState)
	_ = h.srv.Pool.QueryRow(context.Background(),
		`SELECT state FROM runtime_vms WHERE vm_id = $1`, freshVMID).Scan(&freshState)

	if staleState != "terminated" {
		t.Errorf("stale VM state = %q, want %q", staleState, "terminated")
	}
	if freshState == "terminated" {
		t.Errorf("fresh VM was incorrectly terminated by idle sweep")
	}

	staleGotTerminated, freshGotTerminated := false, false
	for _, c := range sched.calls {
		if c == "terminate:"+staleVMID {
			staleGotTerminated = true
		}
		if c == "terminate:"+freshVMID {
			freshGotTerminated = true
		}
	}
	if !staleGotTerminated {
		t.Errorf("expected scheduler.Terminate for stale VM %q", staleVMID)
	}
	if freshGotTerminated {
		t.Errorf("fresh VM %q was incorrectly terminated", freshVMID)
	}
}
