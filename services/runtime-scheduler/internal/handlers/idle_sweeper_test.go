package handlers_test

// Idle-sweeper tests exercise sweepIdleVMs / tryIdlePause through
// StartIdleSweeper. All tests use a real InMemoryStore so the CAS-based
// state transitions and the quota accounting are verified end-to-end.

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/handlers"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/placement"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
)

var errBoom = errors.New("boom")

// newIdleService builds a SchedulerService backed by a real InMemoryStore and
// a lifecycleDialer so tests can inspect snapshot/stop calls.
func newIdleService(store cluster.ClusterStore, d *lifecycleDialer) *handlers.SchedulerService {
	pl := &placement.Engine{Store: store, Weights: scoring.DefaultWeights()}
	return handlers.NewSchedulerService(store, pl, d, zap.NewNop(), 20)
}

// seedIdleVM seeds a VM with IdleTimeoutSecs and LastActivityAt pre-set.
// If lastActivityAt.IsZero() the VM's LastActivityAt is left zero (active / no heartbeat).
func seedIdleVM(store cluster.ClusterStore, id, tenant string, idleTimeout int32, lastActivityAt time.Time) {
	vm := &cluster.VM{
		Handle: &lanternv1.VmHandle{VmId: id, Node: "n1"},
		Spec: &lanternv1.AgentSpec{
			ImageDigest:     "sha256:abc",
			TenantId:        tenant,
			IdleTimeoutSecs: idleTimeout,
		},
		State:           lanternv1.VmState_VM_STATE_RUNNING,
		TenantID:        tenant,
		NodeName:        "n1",
		IdleTimeoutSecs: idleTimeout,
		LastActivityAt:  lastActivityAt,
	}
	store.CreateVM(vm)
	store.IncrTenantVMs(tenant, 1)
}

// runSweep calls sweepIdleVMs synchronously by starting the sweeper with a
// very short tick and waiting for at least one cycle to complete.
// For tests that need deterministic timing we call it through StartIdleSweeper
// but that's async; we expose an internal test-only helper instead.
// Actually we'll use StartIdleSweeper with a zero-timeout then wait.

// driveOneSweep triggers exactly one sweep cycle synchronously by manually
// calling the package-internal sweepIdleVMs — but that function is unexported.
// Instead, we start the sweeper with a 1ms tick, let it fire once, then cancel.
func driveOneSweep(t *testing.T, svc *handlers.SchedulerService, sweepNow time.Time) {
	t.Helper()
	// Start a sweeper with a 1ms tick that always leads.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	alwaysLeader := func() bool { return true }
	handlers.StartIdleSweeper(ctx, svc, time.Millisecond, alwaysLeader)

	// Give the goroutine two ticks worth of time to run.
	time.Sleep(20 * time.Millisecond)
	cancel()
	// Allow the async goroutines spawned by the sweeper to complete.
	time.Sleep(50 * time.Millisecond)
}

// --- Tests ---

func TestIdleSweeper_NotEligible_NoTimeout(t *testing.T) {
	// VM without an idle timeout must never be auto-suspended.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	// IdleTimeoutSecs = 0, already long past any threshold
	seedIdleVM(store, "vm-1", "t1", 0, time.Now().Add(-10*time.Minute))
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, ok := store.GetVM("vm-1")
	if !ok {
		t.Fatal("VM disappeared")
	}
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v, want RUNNING (no timeout set)", vm.State)
	}
	if len(d.snaps) != 0 {
		t.Errorf("snapshot called %d times, want 0", len(d.snaps))
	}
}

func TestIdleSweeper_NotEligible_NotYetIdle(t *testing.T) {
	// VM with timeout but not yet idle long enough.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	// Last activity 1 second ago, timeout is 60 seconds.
	seedIdleVM(store, "vm-1", "t1", 60, time.Now().Add(-1*time.Second))
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v, want RUNNING", vm.State)
	}
	if len(d.snaps) != 0 {
		t.Errorf("snapshot called %d times, want 0", len(d.snaps))
	}
}

func TestIdleSweeper_NotEligible_ZeroLastActivity(t *testing.T) {
	// VM with timeout but no harness heartbeat (LastActivityAt zero) must be
	// treated as active (conservative).
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Time{}) // zero LastActivityAt
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v, want RUNNING", vm.State)
	}
}

func TestIdleSweeper_AutoSuspend_Success(t *testing.T) {
	// VM idle for > timeout — should be snapshot+stopped and settled to PAUSED.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	// IdleTimeoutSecs=30, last activity 2 minutes ago.
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-2*time.Minute))
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, ok := store.GetVM("vm-1")
	if !ok {
		t.Fatal("VM disappeared")
	}
	if vm.State != lanternv1.VmState_VM_STATE_PAUSED {
		t.Errorf("state = %v, want PAUSED", vm.State)
	}
	if vm.SnapshotID == "" {
		t.Error("SnapshotID should be set after auto-suspend")
	}
	if got := store.TenantLiveVMs("t1"); got != 0 {
		t.Errorf("live VMs = %d, want 0 (slot released)", got)
	}
	if len(d.snaps) != 1 {
		t.Errorf("snapshot calls = %d, want 1", len(d.snaps))
	}
	if len(d.stops) != 1 {
		t.Errorf("stop calls = %d, want 1", len(d.stops))
	}
}

func TestIdleSweeper_QuotaReleased(t *testing.T) {
	// After auto-suspend the quota slot is released (IncrTenantVMs -1).
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-5*time.Minute))

	// Also add a second running VM with no idle timeout to confirm it doesn't
	// lose its slot.
	seedVM(store, "vm-2", "t1", lanternv1.VmState_VM_STATE_RUNNING, "")
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("live VMs = %d, want 1 (vm-1 released, vm-2 keeps slot)", got)
	}
}

func TestIdleSweeper_SnapshotFailure_RestoredToRunning(t *testing.T) {
	// When snapshot fails the VM must be restored to RUNNING (not left DRAINING).
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{snapErr: errBoom}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-2*time.Minute))
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v after snapshot failure, want RUNNING", vm.State)
	}
	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("live VMs = %d, want 1 (slot not released on failure)", got)
	}
}

func TestIdleSweeper_StopFailure_RestoredToRunning(t *testing.T) {
	// When stop fails the VM must be restored to RUNNING.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{stopErr: errBoom}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-2*time.Minute))
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v after stop failure, want RUNNING", vm.State)
	}
	if got := store.TenantLiveVMs("t1"); got != 1 {
		t.Errorf("live VMs = %d, want 1", got)
	}
}

func TestIdleSweeper_StandbyDoesNotSweep(t *testing.T) {
	// A standby replica (isLeader=false) must never auto-pause.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-5*time.Minute))
	svc := newIdleService(store, d)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	neverLeader := func() bool { return false }
	handlers.StartIdleSweeper(ctx, svc, time.Millisecond, neverLeader)
	time.Sleep(20 * time.Millisecond)
	cancel()
	time.Sleep(20 * time.Millisecond)

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		t.Errorf("state = %v (standby should not sweep)", vm.State)
	}
	if len(d.snaps) != 0 {
		t.Errorf("snapshot called on standby — must not happen")
	}
}

func TestIdleSweeper_ConcurrentSweep_NoDoubleRelease(t *testing.T) {
	// Two concurrent sweep goroutines racing on the same VM must not double-
	// release the quota slot. TransitionVMState's CAS ensures exactly one wins.
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)
	seedIdleVM(store, "vm-1", "t1", 30, time.Now().Add(-5*time.Minute))
	svc := newIdleService(store, d)

	// Launch two sweepers simultaneously.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	alwaysLeader := func() bool { return true }
	handlers.StartIdleSweeper(ctx, svc, time.Millisecond, alwaysLeader)
	handlers.StartIdleSweeper(ctx, svc, time.Millisecond, alwaysLeader)

	time.Sleep(60 * time.Millisecond)
	cancel()
	time.Sleep(60 * time.Millisecond)

	vm, _ := store.GetVM("vm-1")
	if vm.State != lanternv1.VmState_VM_STATE_PAUSED {
		t.Errorf("state = %v, want PAUSED", vm.State)
	}
	// Quota must be exactly 0, not negative (double-release would give -1).
	if got := store.TenantLiveVMs("t1"); got != 0 {
		t.Errorf("live VMs = %d, want 0 (no double-release)", got)
	}
}

func TestIdleSweeper_AlreadyPaused_Skipped(t *testing.T) {
	// A VM that was paused by an operator between the list and the lock
	// must be skipped (state check under the lock).
	store := cluster.NewInMemoryStore()
	d := &lifecycleDialer{}
	addNode(store, "n1", 8000, 16<<30)

	// Create it PAUSED (no slot held).
	store.CreateVM(&cluster.VM{
		Handle:          &lanternv1.VmHandle{VmId: "vm-1", Node: "n1"},
		Spec:            &lanternv1.AgentSpec{IdleTimeoutSecs: 30},
		State:           lanternv1.VmState_VM_STATE_PAUSED,
		TenantID:        "t1",
		NodeName:        "n1",
		IdleTimeoutSecs: 30,
		LastActivityAt:  time.Now().Add(-5 * time.Minute),
	})
	svc := newIdleService(store, d)

	driveOneSweep(t, svc, time.Now())

	if len(d.snaps) != 0 {
		t.Errorf("snapshot on already-PAUSED VM — must not happen")
	}
}
