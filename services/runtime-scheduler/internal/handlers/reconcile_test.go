package handlers

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// seedVM puts a VM into the store in the given state, created ageSecs ago.
func seedVM(store cluster.ClusterStore, vmID, node, tenant string, state lanternv1.VmState, ageSecs int) {
	store.CreateVM(&cluster.VM{
		Handle: &lanternv1.VmHandle{
			VmId:      vmID,
			Node:      node,
			CreatedAt: timestamppb.New(time.Now().UTC().Add(-time.Duration(ageSecs) * time.Second)),
		},
		State:    state,
		TenantID: tenant,
		NodeName: node,
	})
	store.IncrTenantVMs(tenant, 1)
}

func stateOf(t *testing.T, store cluster.ClusterStore, vmID string) lanternv1.VmState {
	t.Helper()
	v, ok := store.GetVM(vmID)
	if !ok {
		t.Fatalf("vm %s missing from store", vmID)
	}
	return v.State
}

// The headline bug: a workload that exits on its own stays RUNNING forever
// because nothing consumes exit. Observed live as 9 RUNNING VMs with zero
// running containers.
func TestReconcile_TerminatesVMsTheNodeNoLongerReports(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-gone", "node-a", "t1", lanternv1.VmState_VM_STATE_RUNNING, 300)
	seedVM(store, "vm-live", "node-a", "t1", lanternv1.VmState_VM_STATE_RUNNING, 300)

	got := ReconcileNodeInventory(store, "node-a", []string{"vm-live"}, true, time.Now().UTC())

	if len(got) != 1 || got[0] != "vm-gone" {
		t.Fatalf("want [vm-gone] terminated, got %v", got)
	}
	if s := stateOf(t, store, "vm-gone"); s != lanternv1.VmState_VM_STATE_TERMINATED {
		t.Fatalf("vm-gone should be TERMINATED, got %v", s)
	}
	if s := stateOf(t, store, "vm-live"); s != lanternv1.VmState_VM_STATE_RUNNING {
		t.Fatalf("vm-live must stay RUNNING, got %v", s)
	}
	// The phantom count is what drives spurious HTTP 402s.
	if n := store.TenantLiveVMs("t1"); n != 1 {
		t.Fatalf("tenant live count should drop to 1, got %d", n)
	}
}

// A manager build that does not report inventory must not have its VMs wiped
// during a rolling upgrade.
func TestReconcile_NoInventoryFlagIsANoOp(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-1", "node-a", "t1", lanternv1.VmState_VM_STATE_RUNNING, 300)

	got := ReconcileNodeInventory(store, "node-a", nil, false, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("must not reconcile without the inventory flag, terminated %v", got)
	}
	if s := stateOf(t, store, "vm-1"); s != lanternv1.VmState_VM_STATE_RUNNING {
		t.Fatalf("vm-1 must be untouched, got %v", s)
	}
}

// An empty inventory WITH the flag is a real claim: the node has nothing live.
func TestReconcile_EmptyInventoryWithFlagTerminates(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-1", "node-a", "t1", lanternv1.VmState_VM_STATE_RUNNING, 300)

	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 1 {
		t.Fatalf("empty inventory with flag should terminate the phantom, got %v", got)
	}
}

// Schedule creates the row before the node registers the VM. Killing inside
// that window would terminate VMs that are mid-dispatch.
func TestReconcile_RespectsDispatchGrace(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-new", "node-a", "t1", lanternv1.VmState_VM_STATE_PENDING, 5)

	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("VMs inside the dispatch grace must be left alone, got %v", got)
	}
}

// One node's inventory says nothing about another node's VMs.
func TestReconcile_ScopedToTheReportingNode(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-other", "node-b", "t1", lanternv1.VmState_VM_STATE_RUNNING, 300)

	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("node-a's inventory must not touch node-b's VMs, got %v", got)
	}
	if s := stateOf(t, store, "vm-other"); s != lanternv1.VmState_VM_STATE_RUNNING {
		t.Fatalf("vm-other must stay RUNNING, got %v", s)
	}
}

// Already-terminal VMs must not be re-terminated (would double-decrement the
// tenant live count).
func TestReconcile_IgnoresTerminalStates(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-done", "node-a", "t1", lanternv1.VmState_VM_STATE_TERMINATED, 300)
	seedVM(store, "vm-failed", "node-a", "t1", lanternv1.VmState_VM_STATE_FAILED, 300)

	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("terminal VMs must be skipped, got %v", got)
	}
}
