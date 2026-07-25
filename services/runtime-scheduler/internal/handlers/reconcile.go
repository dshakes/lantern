package handlers

import (
	"time"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
)

// reconcileGrace is how long after creation a VM is exempt from
// inventory-based termination.
//
// A Schedule call creates the VM row and dispatches to the manager
// asynchronously, so there is a window where the scheduler knows about a VM
// the node has not registered yet. Terminating inside that window would kill
// VMs that are mid-spawn.
const reconcileGrace = 90 * time.Second

// ReconcileNodeInventory settles the scheduler's view of a node against what
// the node itself reports is live, and returns the vm_ids it terminated.
//
// # The bug this fixes
//
// The scheduler wrote VM_STATE_RUNNING on spawn-ok and VM_STATE_TERMINATED
// only from an explicit Terminate RPC. Nothing consumed workload exit, so any
// agent that ran to completion — the normal case for a headless batch runtime
// — stayed RUNNING forever. Observed live: 9 VMs reported RUNNING with zero
// running containers. That phantom count fed the per-tenant concurrency quota
// (spurious HTTP 402s), the placement engine's load scoring, and compute-hour
// billing.
//
// # Why full-state sync rather than exit events
//
// The node sends its complete live inventory on every heartbeat, not a delta.
// A dropped message, a manager restart, or a missed event all self-heal on the
// next beat, which a delta protocol cannot promise. The cost is up to one
// heartbeat interval of staleness on terminal state — acceptable, and far
// cheaper than a leak that never converges.
//
// # Safety
//
//   - `reportsInventory` false means the manager has no opinion (an older build
//     that does not send the field). Nothing is reconciled — otherwise a rolling
//     upgrade would mass-terminate every live VM on the node.
//   - VMs younger than reconcileGrace are skipped, so a VM still being dispatched
//     is never killed.
//   - Only VMs the scheduler believes are on THIS node are considered, and only
//     from non-terminal states.
func ReconcileNodeInventory(
	store cluster.ClusterStore,
	nodeName string,
	liveVMIDs []string,
	reportsInventory bool,
	now time.Time,
) []string {
	if store == nil || nodeName == "" || !reportsInventory {
		return nil
	}

	live := make(map[string]struct{}, len(liveVMIDs))
	for _, id := range liveVMIDs {
		live[id] = struct{}{}
	}

	// Record that the node vouched for these VMs. A VM confirmed even once no
	// longer needs the dispatch grace, so the NEXT inventory that omits it is
	// acted on immediately rather than after the full grace window.
	store.MarkVMsSeenOnNode(nodeName, liveVMIDs, now)

	// Every VM this scheduler thinks is non-terminal on this node.
	stale := store.ListVMs("", func(v *cluster.VM) bool {
		if v == nil || v.Handle == nil || v.NodeName != nodeName {
			return false
		}
		switch v.State {
		case lanternv1.VmState_VM_STATE_PENDING,
			lanternv1.VmState_VM_STATE_SPAWNING,
			lanternv1.VmState_VM_STATE_RUNNING,
			lanternv1.VmState_VM_STATE_DRAINING:
			return true
		default:
			return false
		}
	})

	terminated := make([]string, 0)
	for _, v := range stale {
		id := v.Handle.VmId
		if _, ok := live[id]; ok {
			continue // node still has it
		}
		// The dispatch grace protects VMs the node has NEVER confirmed — the
		// window between creating the row and the node registering the
		// workload. Once a node has reported a VM as live, its absence from a
		// later inventory is authoritative straight away; making a
		// short-lived agent wait out the grace just to record a terminal
		// state it already reached is pure latency.
		if v.InventorySeenAt.IsZero() && createdAt(v).Add(reconcileGrace).After(now) {
			continue // never confirmed, still inside the dispatch window
		}
		if store.UpdateVMState(id, lanternv1.VmState_VM_STATE_TERMINATED,
			"reconciled: node no longer reports this VM as live", nil, now) {
			store.IncrTenantVMs(v.TenantID, -1)
			terminated = append(terminated, id)
		}
	}
	return terminated
}

// createdAt reads the VM's creation time, falling back to the last event so a
// record with no timestamp is treated as old rather than perpetually exempt.
func createdAt(v *cluster.VM) time.Time {
	if v.Handle != nil && v.Handle.CreatedAt != nil {
		return v.Handle.CreatedAt.AsTime()
	}
	return v.LastEventAt
}
