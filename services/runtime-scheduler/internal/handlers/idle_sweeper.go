package handlers

// Idle sweeper — auto-pauses RUNNING VMs that have been idle longer than their
// AgentSpec.idle_timeout_secs.
//
// Design:
//   - Eligibility: VM is RUNNING, IdleTimeoutSecs > 0, LastActivityAt is non-zero
//     (harness has reported at least one idle signal), and the idle duration
//     exceeds IdleTimeoutSecs.
//   - Idle = harness reported has_active_exec=false. UpdateVMActivity clears
//     LastActivityAt while a child is running and stamps it when the child exits.
//   - When idle past the timeout the sweeper drives a Snapshot+Stop+PAUSED
//     transition, reusing the same crash-safe CAS machinery as operator Pause().
//   - Per-VM lock (lockVM) is held across the state check + DRAINING transition
//     so a concurrent Pause/Resume/Terminate/Terminate cannot race.
//   - Leader-only: a nil isLeader means always-sweep (single-node/dev).
//
// Emitted events: StatusEvent DRAINING+idle-pausing on initiation,
// StatusEvent PAUSED after snapshot+stop succeeds.

import (
	"context"
	"time"

	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

const (
	// DefaultIdleSweepInterval is the default tick for the idle sweeper.
	// 10 s gives ≤10 s of extra idle time beyond the configured timeout.
	DefaultIdleSweepInterval = 10 * time.Second
)

// StartIdleSweeper runs the idle-suspend sweep loop until ctx is cancelled.
// isLeader gates mutation: when it returns false (standby replica) the tick
// body is skipped entirely. A nil isLeader means always-sweep (single-node/dev).
func StartIdleSweeper(ctx context.Context, svc *SchedulerService, tick time.Duration, isLeader func() bool) {
	if tick <= 0 {
		tick = DefaultIdleSweepInterval
	}
	go func() {
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				if isLeader != nil && !isLeader() {
					continue // standby replica — do not mutate
				}
				sweepIdleVMs(ctx, svc, now)
			}
		}
	}()
}

// sweepIdleVMs finds all RUNNING VMs past their idle timeout and drives the
// Pause path for each. Called on every sweeper tick.
func sweepIdleVMs(ctx context.Context, svc *SchedulerService, now time.Time) {
	// Snapshot the full VM list. Each candidate is re-validated under its per-VM
	// lock below to handle races between the list and the lock acquisition.
	vms := svc.Store.ListVMs("", nil)

	for _, vm := range vms {
		if vm.IdleTimeoutSecs <= 0 {
			continue
		}
		if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
			continue
		}
		if vm.LastActivityAt.IsZero() {
			// No harness heartbeat with idle signal yet — treat as active.
			continue
		}
		timeout := time.Duration(vm.IdleTimeoutSecs) * time.Second
		if now.Sub(vm.LastActivityAt) < timeout {
			continue
		}

		// This VM looks idle and overdue. Drive it through the pause path.
		// tryIdlePause holds the vm lock and performs the CAS-based DRAINING
		// transition inline; the snapshot+stop happen in a separate goroutine
		// to avoid blocking the sweeper tick on manager latency.
		tryIdlePause(ctx, svc, vm.Handle.GetVmId(), vm.TenantID, now, timeout)
	}
}

// tryIdlePause acquires the per-VM lock, re-validates idle conditions, CAS-
// transitions to DRAINING+ReasonIdlePausing, then spawns a goroutine to
// complete the snapshot+stop. All path failures are logged; none surface
// to the caller — the sweeper is best-effort fire-and-forget.
func tryIdlePause(ctx context.Context, svc *SchedulerService, vmID, tenantID string, now time.Time, timeout time.Duration) {
	unlock := svc.lockVM(vmID)

	// Re-read under the lock: state may have changed since we listed.
	vm, ok := svc.Store.GetVM(vmID)
	if !ok {
		unlock()
		return
	}
	if vm.State != lanternv1.VmState_VM_STATE_RUNNING {
		unlock()
		return
	}
	if vm.IdleTimeoutSecs <= 0 {
		unlock()
		return
	}
	if vm.LastActivityAt.IsZero() || now.Sub(vm.LastActivityAt) < timeout {
		unlock()
		return
	}

	// CAS to DRAINING+ReasonIdlePausing. A concurrent Pause/Resume/Terminate
	// may have won the race since the GetVM above; TransitionVMState is the
	// tiebreaker.
	if !svc.Store.TransitionVMState(
		vmID,
		lanternv1.VmState_VM_STATE_RUNNING, "",
		lanternv1.VmState_VM_STATE_DRAINING, ReasonIdlePausing,
		now,
	) {
		unlock()
		return
	}

	idleFor := now.Sub(vm.LastActivityAt)
	svc.Logger.Info("idle-sweeper: initiating auto-suspend",
		zap.String("vm_id", vmID),
		zap.String("tenant_id", tenantID),
		zap.Duration("idle_for", idleFor),
		zap.Int32("idle_timeout_secs", vm.IdleTimeoutSecs),
	)

	svc.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   vmID,
		State:  lanternv1.VmState_VM_STATE_DRAINING,
		At:     timestamppb.New(now),
		Reason: ReasonIdlePausing,
	})

	nodeName := vm.NodeName
	unlock() // release before async work; the goroutine re-acquires

	go func() {
		defer svc.lockVM(vmID)()

		// Re-read: only proceed if still DRAINING+ReasonIdlePausing (a
		// concurrent Resume or Terminate may have settled it already).
		vm, ok := svc.Store.GetVM(vmID)
		if !ok {
			return
		}
		if vm.State != lanternv1.VmState_VM_STATE_DRAINING || vm.Reason != ReasonIdlePausing {
			return
		}

		node, nodeOK := svc.Store.GetNode(nodeName)
		if !nodeOK {
			// Node is gone; reconcile will settle via ReconcileNodeInventory.
			svc.Logger.Warn("idle-sweeper: node gone during auto-suspend; leaving DRAINING for reconcile",
				zap.String("vm_id", vmID),
				zap.String("node", nodeName),
			)
			return
		}

		// Snapshot first, then stop — same order as operator Pause().
		snap, err := svc.Dialer.Snapshot(ctx, node.Address, &lanternv1.SnapshotRequest{VmId: vmID})
		if err != nil {
			// Snapshot failed: restore RUNNING so the operator can retry.
			if svc.Store.TransitionVMState(vmID,
				lanternv1.VmState_VM_STATE_DRAINING, ReasonIdlePausing,
				lanternv1.VmState_VM_STATE_RUNNING, "auto-suspend snapshot failed: "+err.Error(),
				time.Now().UTC(),
			) {
				svc.Logger.Error("idle-sweeper: snapshot failed; restored to RUNNING",
					zap.String("vm_id", vmID), zap.Error(err))
			}
			return
		}
		snapID := snap.GetSnapshotId()
		if snapID == "" {
			// Manager returned an empty snapshot — treat same as failure.
			if svc.Store.TransitionVMState(vmID,
				lanternv1.VmState_VM_STATE_DRAINING, ReasonIdlePausing,
				lanternv1.VmState_VM_STATE_RUNNING, "auto-suspend: empty snapshot id",
				time.Now().UTC(),
			) {
				svc.Logger.Error("idle-sweeper: manager returned empty snapshot id; restored to RUNNING",
					zap.String("vm_id", vmID))
			}
			return
		}

		if svc.SnapshotPersister != nil {
			svc.SnapshotPersister.PersistSnapshot(ctx, snapID, vmID, tenantID, nodeName, false, snap)
		}

		// Record the snapshot before Stop so crash-recovery (reconcile) can
		// settle this VM to PAUSED with the right snapshot id.
		svc.Store.SetVMSnapshot(vmID, snapID)

		if _, err := svc.Dialer.Stop(ctx, node.Address, &lanternv1.StopRequest{
			VmId:   vmID,
			Reason: "auto-suspend (idle timeout)",
		}); err != nil {
			// Stop failed: restore RUNNING so the operator can retry.
			if svc.Store.TransitionVMState(vmID,
				lanternv1.VmState_VM_STATE_DRAINING, ReasonIdlePausing,
				lanternv1.VmState_VM_STATE_RUNNING, "auto-suspend stop failed: "+err.Error(),
				time.Now().UTC(),
			) {
				svc.Logger.Error("idle-sweeper: stop failed; restored to RUNNING",
					zap.String("vm_id", vmID), zap.Error(err))
			}
			return
		}

		// Reconcile may have already settled PAUSED (node heartbeat after
		// Stop). TransitionVMState is the tiebreaker — only one of us releases.
		if svc.Store.TransitionVMState(vmID,
			lanternv1.VmState_VM_STATE_DRAINING, ReasonIdlePausing,
			lanternv1.VmState_VM_STATE_PAUSED, "auto-suspended (idle timeout)",
			time.Now().UTC(),
		) {
			svc.Store.IncrTenantVMs(tenantID, -1)
			if svc.Metrics != nil {
				svc.Metrics.ActiveVMs.Dec()
			}
			svc.emit(tenantID, &lanternv1.StatusEvent{
				VmId:   vmID,
				State:  lanternv1.VmState_VM_STATE_PAUSED,
				At:     timestamppb.Now(),
				Reason: "auto-suspended (idle timeout)",
			})
			svc.Logger.Info("idle-sweeper: VM auto-suspended",
				zap.String("vm_id", vmID),
				zap.String("snapshot_id", snapID),
				zap.String("tenant_id", tenantID),
			)
		}
	}()
}
