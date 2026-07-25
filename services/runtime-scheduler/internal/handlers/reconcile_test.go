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

// Once a node has confirmed a VM in an inventory, the dispatch grace no
// longer applies — a later inventory omitting it is authoritative at once.
// Without this a short-lived agent (exits in ~1s) sat in RUNNING for the full
// 90s grace before its terminal state was recorded.
func TestReconcile_ConfirmedVMSkipsGraceOnNextBeat(t *testing.T) {
	store := cluster.NewInMemoryStore()
	// 5s old — well inside the dispatch grace.
	seedVM(store, "vm-fast", "node-a", "t1", lanternv1.VmState_VM_STATE_RUNNING, 5)

	// Beat 1: node reports it live. Nothing to terminate, but it is confirmed.
	if got := ReconcileNodeInventory(store, "node-a", []string{"vm-fast"}, true, time.Now().UTC()); len(got) != 0 {
		t.Fatalf("a VM the node reports live must not be terminated, got %v", got)
	}

	// Beat 2: it exited. Still inside the grace by age, but confirmed once.
	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 1 || got[0] != "vm-fast" {
		t.Fatalf("a previously-confirmed VM must reconcile immediately, got %v", got)
	}
	if s := stateOf(t, store, "vm-fast"); s != lanternv1.VmState_VM_STATE_TERMINATED {
		t.Fatalf("want TERMINATED, got %v", s)
	}
}

// The grace must still protect VMs the node has never confirmed — that is the
// create-row-then-dispatch window it exists for.
func TestReconcile_UnconfirmedVMStillGetsGrace(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-dispatching", "node-a", "t1", lanternv1.VmState_VM_STATE_PENDING, 5)

	// Node has never reported it, and it is young.
	got := ReconcileNodeInventory(store, "node-a", []string{}, true, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("an unconfirmed, in-grace VM must be left alone, got %v", got)
	}
}

// One node's inventory must not vouch for another node's VM.
func TestReconcile_ConfirmationIsNodeScoped(t *testing.T) {
	store := cluster.NewInMemoryStore()
	seedVM(store, "vm-b", "node-b", "t1", lanternv1.VmState_VM_STATE_RUNNING, 5)

	// node-a wrongly claims vm-b. It must not become "confirmed" on node-b.
	ReconcileNodeInventory(store, "node-a", []string{"vm-b"}, true, time.Now().UTC())

	// node-b now omits it; still young and never legitimately confirmed.
	got := ReconcileNodeInventory(store, "node-b", []string{}, true, time.Now().UTC())

	if len(got) != 0 {
		t.Fatalf("cross-node confirmation must not bypass the grace, got %v", got)
	}
}
