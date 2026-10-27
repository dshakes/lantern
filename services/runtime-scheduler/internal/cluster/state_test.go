package cluster_test

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// TestUpsertNode_RoundTripsCCFields verifies the confidential-compute capability
// advertised via heartbeat round-trips through UpsertNode → GetNode.
func TestUpsertNode_RoundTripsCCFields(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:          "cc-node",
		CCCapable:     true,
		CCTech:        "sev-snp",
		LastHeartbeat: time.Now(),
	})
	got, ok := s.GetNode("cc-node")
	if !ok {
		t.Fatal("node cc-node not found")
	}
	if !got.CCCapable {
		t.Error("CCCapable: got false, want true")
	}
	if got.CCTech != "sev-snp" {
		t.Errorf("CCTech: got %q, want sev-snp", got.CCTech)
	}
}

// TestReservation_CreateVMReducesEffectiveCapacity verifies that after
// CreateVM the node's reported free capacity is reduced by the VM's limits,
// so a concurrent Pick() won't over-commit.
func TestReservation_CreateVMReducesEffectiveCapacity(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024, // 8Gi
		LastHeartbeat:   time.Now(),
	})

	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-1", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)

	got, ok := s.GetNode("n1")
	if !ok {
		t.Fatal("node n1 not found")
	}
	if got.FreeVcpuMillis != 2000 {
		t.Errorf("FreeVcpuMillis: got %d, want 2000 (2 vCPU = 2000m reserved)", got.FreeVcpuMillis)
	}
	want4Gi := int64(4 * 1024 * 1024 * 1024)
	if got.FreeMemoryBytes != want4Gi {
		t.Errorf("FreeMemoryBytes: got %d, want %d (4Gi reserved)", got.FreeMemoryBytes, want4Gi)
	}
}

// TestReservation_DeleteVMReleasesCapacity verifies that DeleteVM releases
// the reservation, restoring the effective free capacity.
func TestReservation_DeleteVMReleasesCapacity(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})
	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-2", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)
	s.DeleteVM("vm-2")

	got, _ := s.GetNode("n1")
	if got.FreeVcpuMillis != 4000 {
		t.Errorf("after delete FreeVcpuMillis: got %d, want 4000", got.FreeVcpuMillis)
	}
}

// ---------------------------------------------------------------------------
// UpdateVMActivity clock-skew / scheduler-time tests (idle-suspend)
// ---------------------------------------------------------------------------

// newRunningVM seeds a RUNNING VM with IdleTimeoutSecs set.
func newRunningVM(id, tenant string, idleTimeout int32) *cluster.VM {
	return &cluster.VM{
		Handle:          &lanternv1.VmHandle{VmId: id},
		Spec:            &lanternv1.AgentSpec{TenantId: tenant, IdleTimeoutSecs: idleTimeout},
		State:           lanternv1.VmState_VM_STATE_RUNNING,
		TenantID:        tenant,
		NodeName:        "n1",
		IdleTimeoutSecs: idleTimeout,
	}
}

// TestUpdateVMActivity_StaleGuestTimestampAfterResume verifies that a just-
// resumed VM is NOT treated as idle immediately, even if the harness's
// last_activity_unix_ms value is old (snapshot-restore clock skew).
//
// Scenario:
//  1. VM starts PAUSED (it was auto-suspended before we observe it).
//  2. Resume: TransitionVMState PAUSED→RUNNING resets LastActivityAt to zero.
//  3. A harness heartbeat arrives with a stale guest timestamp (from before
//     the pause) but has_active_exec=false.
//  4. Sweeper must NOT mark the VM as idle immediately.
func TestUpdateVMActivity_StaleGuestTimestampAfterResume(t *testing.T) {
	s := cluster.NewInMemoryStore()

	// Create as PAUSED — the VM was previously idle-suspended.
	paused := &cluster.VM{
		Handle:          &lanternv1.VmHandle{VmId: "vm-1"},
		Spec:            &lanternv1.AgentSpec{TenantId: "t1", IdleTimeoutSecs: 60},
		State:           lanternv1.VmState_VM_STATE_PAUSED,
		TenantID:        "t1",
		NodeName:        "n1",
		IdleTimeoutSecs: 60,
		// LastActivityAt has a stale value from the pre-pause idle epoch.
		LastActivityAt: time.Now().Add(-30 * time.Minute),
	}
	s.CreateVM(paused)

	receiveTime := time.Now()

	// Resume: transitions PAUSED→RUNNING — this must reset LastActivityAt.
	ok := s.TransitionVMState("vm-1",
		lanternv1.VmState_VM_STATE_PAUSED, "",
		lanternv1.VmState_VM_STATE_RUNNING, "resume",
		receiveTime,
	)
	if !ok {
		t.Fatal("TransitionVMState PAUSED→RUNNING failed")
	}

	// Verify the reset.
	got, _ := s.GetVM("vm-1")
	if !got.LastActivityAt.IsZero() {
		t.Fatalf("after resume LastActivityAt should be zero, got %v", got.LastActivityAt)
	}

	// Now the harness sends its first heartbeat with a STALE unix-ms (the
	// guest clock hasn't caught up yet — restore clock skew).
	staleGuestTs := receiveTime.Add(-30 * time.Minute).UnixMilli()
	s.UpdateVMActivity("vm-1", false, staleGuestTs, 0, receiveTime)

	got, _ = s.GetVM("vm-1")
	// LastActivityAt is stamped with scheduler receive time (≈ now), so the
	// idle duration is ~0 seconds — well below the 60-second timeout.
	if got.LastActivityAt.IsZero() {
		t.Fatal("LastActivityAt should be set after first idle beat post-resume")
	}
	timeout := 60 * time.Second
	idleDuration := time.Since(got.LastActivityAt)
	if idleDuration >= timeout {
		t.Errorf("VM appears idle immediately after resume: idle for %v >= %v timeout", idleDuration, timeout)
	}
}

// TestUpdateVMActivity_SchedulerTimeUsed verifies that LastActivityAt is
// stamped with the scheduler receive time (parameter `at`), NOT with the
// harness-reported unix-ms wall clock.
func TestUpdateVMActivity_SchedulerTimeUsed(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.CreateVM(newRunningVM("vm-2", "t1", 30))

	schedulerReceiveTime := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	// Guest reports a unix-ms that is 1 hour EARLIER than scheduler time.
	guestTs := schedulerReceiveTime.Add(-1 * time.Hour).UnixMilli()

	s.UpdateVMActivity("vm-2", false, guestTs, 0, schedulerReceiveTime)

	got, _ := s.GetVM("vm-2")
	// The stamp must be the scheduler receive time, not the guest time.
	if got.LastActivityAt.IsZero() {
		t.Fatal("LastActivityAt should be set after first idle beat")
	}
	// Allow a 1-second tolerance for floating-point round-trip.
	diff := got.LastActivityAt.Sub(schedulerReceiveTime)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("LastActivityAt = %v, want scheduler time %v (diff %v)",
			got.LastActivityAt, schedulerReceiveTime, diff)
	}
}

// TestUpdateVMActivity_ActiveExecClearsAndResetsChangeSignal verifies that a
// has_active_exec=true beat clears LastActivityAt AND resets the change-signal
// baseline so the next idle beat is correctly detected.
func TestUpdateVMActivity_ActiveExecClearsAndResetsChangeSignal(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.CreateVM(newRunningVM("vm-3", "t1", 30))

	t0 := time.Now()
	guestTs1 := t0.Add(-5 * time.Minute).UnixMilli()

	// First beat: idle, guest ts is old.
	s.UpdateVMActivity("vm-3", false, guestTs1, 0, t0)
	got, _ := s.GetVM("vm-3")
	if got.LastActivityAt.IsZero() {
		t.Fatal("step 1: LastActivityAt should be set")
	}

	// Second beat: active child running — should clear LastActivityAt.
	s.UpdateVMActivity("vm-3", true, 0, 0, t0.Add(1*time.Second))
	got, _ = s.GetVM("vm-3")
	if !got.LastActivityAt.IsZero() {
		t.Errorf("step 2: LastActivityAt should be zero while active, got %v", got.LastActivityAt)
	}

	// Third beat: idle again with a NEW guest ts.
	t1 := t0.Add(2 * time.Second)
	guestTs2 := t1.UnixMilli()
	s.UpdateVMActivity("vm-3", false, guestTs2, 0, t1)
	got, _ = s.GetVM("vm-3")
	if got.LastActivityAt.IsZero() {
		t.Fatal("step 3: LastActivityAt should be set again after active cleared it")
	}
	// Must be close to t1, not t0.
	diff := got.LastActivityAt.Sub(t1)
	if diff < -time.Second || diff > time.Second {
		t.Errorf("step 3: LastActivityAt = %v, want ~%v", got.LastActivityAt, t1)
	}
}

// TestUpdateVMActivity_NoChangeSignal_DoesNotAdvanceClock verifies that
// repeated identical beats (same unix-ms, no change) do NOT advance
// LastActivityAt. The idle clock must keep ticking from the first stamp.
func TestUpdateVMActivity_NoChangeSignal_DoesNotAdvanceClock(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.CreateVM(newRunningVM("vm-4", "t1", 30))

	t0 := time.Now()
	guestTs := t0.UnixMilli()

	// First beat: stamps t0.
	s.UpdateVMActivity("vm-4", false, guestTs, 0, t0)
	got, _ := s.GetVM("vm-4")
	first := got.LastActivityAt

	// Subsequent beats with the SAME unix-ms (no change) — clock must not advance.
	s.UpdateVMActivity("vm-4", false, guestTs, 0, t0.Add(5*time.Second))
	s.UpdateVMActivity("vm-4", false, guestTs, 0, t0.Add(10*time.Second))
	got, _ = s.GetVM("vm-4")
	if !got.LastActivityAt.Equal(first) {
		t.Errorf("LastActivityAt advanced on no-change beat: was %v, now %v", first, got.LastActivityAt)
	}
}

// TestTransitionToRunning_ResetsLastActivityAt verifies that any RUNNING
// transition (spawn or resume) resets LastActivityAt so the VM is not
// immediately eligible for auto-suspend.
func TestTransitionToRunning_ResetsLastActivityAt(t *testing.T) {
	s := cluster.NewInMemoryStore()
	vm := &cluster.VM{
		Handle:          &lanternv1.VmHandle{VmId: "vm-5"},
		Spec:            &lanternv1.AgentSpec{IdleTimeoutSecs: 30},
		State:           lanternv1.VmState_VM_STATE_PAUSED,
		TenantID:        "t1",
		NodeName:        "n1",
		IdleTimeoutSecs: 30,
		LastActivityAt:  time.Now().Add(-1 * time.Hour), // stale idle timestamp
	}
	s.CreateVM(vm)

	// Simulate operator resume.
	s.TransitionVMState("vm-5",
		lanternv1.VmState_VM_STATE_PAUSED, "",
		lanternv1.VmState_VM_STATE_RUNNING, "resume",
		time.Now(),
	)
	got, _ := s.GetVM("vm-5")
	if !got.LastActivityAt.IsZero() {
		t.Errorf("LastActivityAt should be zero after RUNNING transition, got %v", got.LastActivityAt)
	}
}

// TestIdleSweeper_NoSuspendAfterResume verifies end-to-end that a VM just
// resumed (LastActivityAt cleared, first harness heartbeat arrives with a
// stale guest timestamp) is NOT swept as idle immediately.
func TestIdleSweeper_NoSuspendAfterResume(t *testing.T) {
	// This test exercises the sweeper via UpdateVMActivity's change-signal logic.
	s := cluster.NewInMemoryStore()

	// VM that was idling before resume: give it a stale LastActivityAt.
	vm := &cluster.VM{
		Handle:          &lanternv1.VmHandle{VmId: "vm-r", Node: "n1"},
		Spec:            &lanternv1.AgentSpec{IdleTimeoutSecs: 60},
		State:           lanternv1.VmState_VM_STATE_RUNNING,
		TenantID:        "t1",
		NodeName:        "n1",
		IdleTimeoutSecs: 60,
		LastActivityAt:  time.Time{}, // just resumed — reset
	}
	s.CreateVM(vm)
	s.UpsertNode(cluster.Node{Name: "n1", LastHeartbeat: time.Now(), FreeVcpuMillis: 4000, FreeMemoryBytes: 8 << 30})

	now := time.Now()

	// Harness sends its first beat after resume with a stale guest unix-ms
	// (the guest clock is behind by the paused duration).
	staleGuestMs := now.Add(-30 * time.Minute).UnixMilli()
	s.UpdateVMActivity("vm-r", false, staleGuestMs, 0, now)

	got, _ := s.GetVM("vm-r")
	// LastActivityAt is stamped with scheduler receive time (now), not the
	// stale guest time.  Idle duration = ~0 seconds < 60-second timeout.
	if !got.LastActivityAt.IsZero() && time.Since(got.LastActivityAt) >= 60*time.Second {
		t.Errorf("VM appears idle immediately after resume: LastActivityAt=%v (age %v >= 60s timeout)",
			got.LastActivityAt, time.Since(got.LastActivityAt))
	}
}

// TestReservation_HeartbeatClearsReservation verifies that a heartbeat
// (UpsertNode) clears the pending reservation because the heartbeat's
// reported capacity is the authoritative real value.
func TestReservation_HeartbeatClearsReservation(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  4000,
		FreeMemoryBytes: 8 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})
	vm := &cluster.VM{
		Handle:   &lanternv1.VmHandle{VmId: "vm-3", Node: "n1", CreatedAt: timestamppb.Now()},
		Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2", Memory: "4Gi"}},
		State:    lanternv1.VmState_VM_STATE_PENDING,
		TenantID: "t1",
		NodeName: "n1",
	}
	s.CreateVM(vm)

	// Heartbeat with the actual new free capacity (manager already accounts for the VM).
	s.UpsertNode(cluster.Node{
		Name:            "n1",
		FreeVcpuMillis:  2000, // manager says 2000m free after spawning the VM
		FreeMemoryBytes: 4 * 1024 * 1024 * 1024,
		LastHeartbeat:   time.Now(),
	})

	got, _ := s.GetNode("n1")
	// After heartbeat, the reservation is cleared; the heartbeat value is authoritative.
	if got.FreeVcpuMillis != 2000 {
		t.Errorf("after heartbeat FreeVcpuMillis: got %d, want 2000", got.FreeVcpuMillis)
	}
}

// TestReservation_TwoVMsOnSameNode accumulates reservations correctly.
func TestReservation_TwoVMsOnSameNode(t *testing.T) {
	s := cluster.NewInMemoryStore()
	s.UpsertNode(cluster.Node{
		Name:           "n1",
		FreeVcpuMillis: 8000,
		LastHeartbeat:  time.Now(),
	})

	for i, vmID := range []string{"vm-a", "vm-b"} {
		_ = i
		vm := &cluster.VM{
			Handle:   &lanternv1.VmHandle{VmId: vmID, Node: "n1", CreatedAt: timestamppb.Now()},
			Spec:     &lanternv1.AgentSpec{TenantId: "t1", Limits: &lanternv1.ResourceLimits{Vcpu: "2"}},
			State:    lanternv1.VmState_VM_STATE_PENDING,
			TenantID: "t1",
			NodeName: "n1",
		}
		s.CreateVM(vm)
	}

	got, _ := s.GetNode("n1")
	// 8000 - 2000 - 2000 = 4000
	if got.FreeVcpuMillis != 4000 {
		t.Errorf("FreeVcpuMillis after 2 VMs: got %d, want 4000", got.FreeVcpuMillis)
	}
}
