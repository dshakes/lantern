package handlers

// Sandbox lifecycle: Pause / Resume / Fork, built entirely on the manager's
// existing Snapshot, Spawn(restore_snapshot_id) and Stop RPCs.
//
// Contract with the manager: Spawn(handle.vm_id=X, spec.restore_snapshot_id=S)
// yields a VM identified as X restored from S. Resume reuses the paused VM's
// own vm_id; Fork mints new ones.
//
// Quota: a PAUSED VM holds no concurrent-VM slot. Pause releases exactly one
// (only on the pausing→PAUSED edge, CAS-guarded against reconcile); Resume and Fork
// take slots with TryReserveTenantVMs (atomic, all-or-nothing) and give back
// every slot whose spawn failed.

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/middleware"
)

// defaultMaxForkCount is the default upper bound for a single Fork call.
// Override with LANTERN_MAX_FORK_COUNT (ceiling: maxForkCountCeiling).
const (
	defaultMaxForkCount    = 100
	maxForkCountCeiling    = 1000
	defaultForkConcurrency = 16
)

// maxForkCount returns the configured per-call fork limit.
// LANTERN_MAX_FORK_COUNT (default 100, ceiling 1000).
func maxForkCount() int {
	if v := envInt("LANTERN_MAX_FORK_COUNT", defaultMaxForkCount); v > 0 {
		if v > maxForkCountCeiling {
			return maxForkCountCeiling
		}
		return v
	}
	return defaultMaxForkCount
}

// forkConcurrency returns the maximum number of fork spawns to issue in
// parallel within a single Fork call.
// LANTERN_FORK_CONCURRENCY (default 16).
func forkConcurrency() int {
	if v := envInt("LANTERN_FORK_CONCURRENCY", defaultForkConcurrency); v > 0 {
		return v
	}
	return defaultForkConcurrency
}

// envInt reads an integer environment variable, returning def on missing/invalid.
func envInt(key string, def int) int {
	s, ok := os.LookupEnv(key)
	if !ok || s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// Crash-safe transitions. A VM mid-Pause is persisted as DRAINING+ReasonPausing
// and mid-Resume as SPAWNING+ReasonResuming — both states loadVMs counts as
// live, so a scheduler crash inside the manager call can over-count a slot for
// a while but never reloads a running VM as PAUSED (outside quota and
// reconciliation). ReconcileNodeInventory resolves either marker to PAUSED once
// the node shows the VM is not running; the RPC and reconciliation settle the
// marker with TransitionVMState so exactly one of them releases the slot.
const (
	ReasonPausing     = "scheduler:pausing"
	ReasonResuming    = "scheduler:resuming"
	ReasonIdlePausing = "scheduler:idle-pausing"
)

// lockVM serializes lifecycle mutations (Pause/Resume/Fork/Terminate) on one
// VM so two concurrent calls cannot both snapshot/stop it or double-release
// its quota slot. Returns the unlock func.
//
// ponytail: one mutex per vm_id, never evicted — a few bytes per VM ever
// lifecycled; evict on DeleteVM if scheduler uptime × VM churn ever matters.
func (s *SchedulerService) lockVM(vmID string) func() {
	m, _ := s.vmLocks.LoadOrStore(vmID, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// ownedVM runs the shared preamble for a mutating lifecycle RPC: leader check,
// tenant from the verified metadata, vm_id present, and ownership. A VM owned
// by another tenant is NotFound — never a hint that it exists.
func (s *SchedulerService) ownedVM(ctx context.Context, vmID string) (string, error) {
	if !s.Elector.IsLeader() {
		return "", status.Error(codes.Unavailable, "not the leader — retry on another replica")
	}
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return "", err
	}
	if vmID == "" {
		return "", status.Error(codes.InvalidArgument, "vm_id is required")
	}
	if vm, ok := s.Store.GetVM(vmID); !ok || vm.TenantID != tenantID {
		return "", status.Errorf(codes.NotFound, "vm %q not found", vmID)
	}
	return tenantID, nil
}

// Pause snapshots a RUNNING VM, stops it, marks it PAUSED and releases its
// quota slot. Pausing an already-PAUSED VM returns the existing snapshot.
func (s *SchedulerService) Pause(ctx context.Context, req *lanternv1.PauseRequest) (*lanternv1.PauseResponse, error) {
	ctx, span := tracer.Start(ctx, "RuntimeScheduler.Pause")
	defer span.End()

	tenantID, err := s.ownedVM(ctx, req.GetVmId())
	if err != nil {
		return nil, err
	}
	vmID := req.GetVmId()
	defer s.lockVM(vmID)()
	span.SetAttributes(attribute.String("tenant_id", tenantID), attribute.String("vm_id", vmID))

	vm, ok := s.Store.GetVM(vmID) // re-read under the lock
	if !ok {
		return nil, status.Errorf(codes.NotFound, "vm %q not found", vmID)
	}
	switch vm.State {
	case lanternv1.VmState_VM_STATE_PAUSED:
		return &lanternv1.PauseResponse{VmId: vmID, SnapshotId: vm.SnapshotID, State: vm.State}, nil
	case lanternv1.VmState_VM_STATE_RUNNING:
	default:
		return nil, status.Errorf(codes.FailedPrecondition, "vm %q is %s; only a RUNNING vm can be paused", vmID, vm.State)
	}

	node, ok := s.Store.GetNode(vm.NodeName)
	if !ok {
		return nil, status.Errorf(codes.Unavailable, "pause %s: node %q is not registered", vmID, vm.NodeName)
	}
	snap, err := s.Dialer.Snapshot(ctx, node.Address, &lanternv1.SnapshotRequest{VmId: vmID})
	if err != nil {
		// No synthetic id here (unlike Snapshot): pausing onto a snapshot that
		// does not exist would destroy the sandbox's state on Stop.
		return nil, status.Errorf(codes.Unavailable, "pause %s: manager snapshot failed: %v", vmID, err)
	}
	if snap.GetSnapshotId() == "" {
		return nil, status.Errorf(codes.Internal, "pause %s: manager returned an empty snapshot id", vmID)
	}
	if s.SnapshotPersister != nil {
		s.SnapshotPersister.PersistSnapshot(ctx, snap.SnapshotId, vmID, tenantID, vm.NodeName, false, snap)
	}

	// Persist the snapshot, then the pausing marker, BEFORE Stop. Reconcile
	// resolves a pausing VM that leaves the node's inventory to PAUSED (not
	// TERMINATED), and a crash here reloads it still holding its slot.
	s.Store.SetVMSnapshot(vmID, snap.SnapshotId)
	s.Store.UpdateVMState(vmID, lanternv1.VmState_VM_STATE_DRAINING, ReasonPausing, nil, time.Now().UTC())

	if _, err := s.Dialer.Stop(ctx, node.Address, &lanternv1.StopRequest{VmId: vmID, Reason: "paused"}); err != nil {
		// Still running on the node: restore RUNNING, keep the slot.
		s.Store.TransitionVMState(vmID, lanternv1.VmState_VM_STATE_DRAINING, ReasonPausing,
			lanternv1.VmState_VM_STATE_RUNNING, "pause failed: "+err.Error(), time.Now().UTC())
		return nil, status.Errorf(codes.Unavailable, "pause %s: manager stop failed: %v", vmID, err)
	}

	// Reconcile may already have settled it (node heartbeat after Stop) and
	// released the slot; only the winner releases.
	if s.Store.TransitionVMState(vmID, lanternv1.VmState_VM_STATE_DRAINING, ReasonPausing,
		lanternv1.VmState_VM_STATE_PAUSED, "paused", time.Now().UTC()) {
		s.Store.IncrTenantVMs(tenantID, -1)
		if s.Metrics != nil {
			s.Metrics.ActiveVMs.Dec()
		}
	}
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId: vmID, State: lanternv1.VmState_VM_STATE_PAUSED, At: timestamppb.Now(), Reason: "paused",
	})
	s.Logger.Info("vm paused", zap.String("vm_id", vmID), zap.String("snapshot_id", snap.SnapshotId))
	return &lanternv1.PauseResponse{VmId: vmID, SnapshotId: snap.SnapshotId, State: lanternv1.VmState_VM_STATE_PAUSED}, nil
}

// Resume re-spawns a PAUSED VM under its SAME vm_id from its snapshot, on the
// node that holds the snapshot. On spawn failure the slot is released and the
// VM stays PAUSED (resumable again).
func (s *SchedulerService) Resume(ctx context.Context, req *lanternv1.ResumeRequest) (*lanternv1.ResumeResponse, error) {
	ctx, span := tracer.Start(ctx, "RuntimeScheduler.Resume")
	defer span.End()

	tenantID, err := s.ownedVM(ctx, req.GetVmId())
	if err != nil {
		return nil, err
	}
	vmID := req.GetVmId()
	defer s.lockVM(vmID)()
	span.SetAttributes(attribute.String("tenant_id", tenantID), attribute.String("vm_id", vmID))

	vm, ok := s.Store.GetVM(vmID)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "vm %q not found", vmID)
	}
	if vm.State != lanternv1.VmState_VM_STATE_PAUSED {
		return nil, status.Errorf(codes.FailedPrecondition, "vm %q is %s; only a PAUSED vm can be resumed", vmID, vm.State)
	}
	node, ok := s.Store.GetNode(vm.NodeName)
	if !ok {
		return nil, status.Errorf(codes.Unavailable, "resume %s: node %q holding its snapshot is not registered", vmID, vm.NodeName)
	}
	if !s.Store.TryReserveTenantVMs(tenantID, 1, s.TenantHardCap) {
		return nil, status.Errorf(codes.ResourceExhausted,
			"tenant %s is at the concurrent-VM hard cap (%d)", tenantID, s.TenantHardCap)
	}

	// Persist the resuming marker BEFORE Spawn so a crash mid-spawn reloads
	// the VM holding the slot just reserved, not as PAUSED.
	s.Store.UpdateVMState(vmID, lanternv1.VmState_VM_STATE_SPAWNING, ReasonResuming, nil, time.Now().UTC())

	if err := s.spawnFromSnapshot(ctx, node.Address, vm, vm.Handle, vm.SnapshotID); err != nil {
		if s.Store.TransitionVMState(vmID, lanternv1.VmState_VM_STATE_SPAWNING, ReasonResuming,
			lanternv1.VmState_VM_STATE_PAUSED, "resume failed: "+err.Error(), time.Now().UTC()) {
			s.Store.IncrTenantVMs(tenantID, -1)
		}
		return nil, status.Errorf(codes.Unavailable, "resume %s: manager spawn failed (vm stays paused): %v", vmID, err)
	}

	if !s.Store.TransitionVMState(vmID, lanternv1.VmState_VM_STATE_SPAWNING, ReasonResuming,
		lanternv1.VmState_VM_STATE_RUNNING, "resumed", time.Now().UTC()) {
		// Reconcile gave up on this resume (spawn outlived its grace), recorded
		// it PAUSED and released the slot. Stop what we just booted rather than
		// leave it running uncounted.
		if _, err := s.Dialer.Stop(ctx, node.Address, &lanternv1.StopRequest{VmId: vmID, Reason: "resume superseded"}); err != nil {
			s.Logger.Error("resume: superseded respawn could not be stopped — running outside quota until reconciled",
				zap.String("vm_id", vmID), zap.String("node", vm.NodeName), zap.Error(err))
		}
		return nil, status.Errorf(codes.Unavailable, "resume %s: superseded by reconciliation (vm stays paused); retry", vmID)
	}
	if s.Metrics != nil {
		s.Metrics.ActiveVMs.Inc()
	}
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId: vmID, State: lanternv1.VmState_VM_STATE_RUNNING, At: timestamppb.Now(), Reason: "resumed",
	})
	return &lanternv1.ResumeResponse{
		VmId: vmID, SnapshotId: vm.SnapshotID, State: lanternv1.VmState_VM_STATE_RUNNING, Node: vm.NodeName,
	}, nil
}

// Fork spawns `count` new VMs restored from a snapshot of the source. A
// RUNNING source gets a fresh snapshot and keeps running; a PAUSED source
// forks from its pause snapshot. Quota for all `count` is taken up front
// (all-or-nothing); each child that fails to spawn is reported and its slot
// released.
func (s *SchedulerService) Fork(ctx context.Context, req *lanternv1.ForkRequest) (*lanternv1.ForkResponse, error) {
	ctx, span := tracer.Start(ctx, "RuntimeScheduler.Fork")
	defer span.End()

	tenantID, err := s.ownedVM(ctx, req.GetVmId())
	if err != nil {
		return nil, err
	}
	count := int(req.GetCount())
	max := maxForkCount()
	if count < 1 || count > max {
		return nil, status.Errorf(codes.InvalidArgument, "count must be 1..%d, got %d", max, count)
	}
	// Each child gets its OWN identity; inheriting the source's would let N
	// sandboxes act as one agent instance. Fail closed without them.
	if len(req.GetIdentities()) != count {
		return nil, status.Errorf(codes.InvalidArgument, "fork needs one fresh agent identity per child: got %d for count %d", len(req.GetIdentities()), count)
	}
	for _, id := range req.GetIdentities() {
		if id.GetAgentInstanceId() == "" || id.GetAgentInstanceToken() == "" {
			return nil, status.Error(codes.InvalidArgument, "fork identity is missing agent_instance_id or agent_instance_token")
		}
	}
	srcID := req.GetVmId()
	defer s.lockVM(srcID)()
	span.SetAttributes(attribute.String("tenant_id", tenantID), attribute.String("vm_id", srcID), attribute.Int("fork.count", count))

	src, ok := s.Store.GetVM(srcID)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "vm %q not found", srcID)
	}
	switch src.State {
	case lanternv1.VmState_VM_STATE_PAUSED:
		if src.SnapshotID == "" {
			return nil, status.Errorf(codes.FailedPrecondition, "vm %q is paused without a snapshot", srcID)
		}
	case lanternv1.VmState_VM_STATE_RUNNING:
	default:
		return nil, status.Errorf(codes.FailedPrecondition, "vm %q is %s; only a RUNNING or PAUSED vm can be forked", srcID, src.State)
	}
	node, ok := s.Store.GetNode(src.NodeName)
	if !ok {
		return nil, status.Errorf(codes.Unavailable, "fork %s: node %q holding the snapshot is not registered", srcID, src.NodeName)
	}
	// Reserve quota BEFORE snapshotting: a denied fork must cost no snapshot
	// I/O or storage. Every early return below gives the slots back.
	if !s.Store.TryReserveTenantVMs(tenantID, count, s.TenantHardCap) {
		return nil, status.Errorf(codes.ResourceExhausted,
			"tenant %s cannot fit %d more VMs under the concurrent-VM hard cap (%d)", tenantID, count, s.TenantHardCap)
	}
	snapID := src.SnapshotID
	if src.State == lanternv1.VmState_VM_STATE_RUNNING {
		snap, err := s.Dialer.Snapshot(ctx, node.Address, &lanternv1.SnapshotRequest{VmId: srcID, KeepRunning: true})
		if err != nil {
			s.Store.IncrTenantVMs(tenantID, -count)
			return nil, status.Errorf(codes.Unavailable, "fork %s: manager snapshot failed: %v", srcID, err)
		}
		if snap.GetSnapshotId() == "" {
			s.Store.IncrTenantVMs(tenantID, -count)
			return nil, status.Errorf(codes.Internal, "fork %s: manager returned an empty snapshot id", srcID)
		}
		snapID = snap.SnapshotId
		if s.SnapshotPersister != nil {
			s.SnapshotPersister.PersistSnapshot(ctx, snapID, srcID, tenantID, src.NodeName, true, snap)
		}
	}

	// Pre-allocate handles and VM records sequentially so each child has a
	// stable index before any goroutine runs.  The handles array is indexed by
	// child slot so goroutines can write results[i] without a mutex.
	handles := make([]*lanternv1.VmHandle, count)
	children := make([]*cluster.VM, count)
	results := make([]*lanternv1.ForkChild, count)
	for i := 0; i < count; i++ {
		handles[i] = &lanternv1.VmHandle{
			VmId:             "vm-" + uuid.NewString(),
			Node:             src.NodeName,
			AvailabilityZone: node.AvailabilityZone,
			CreatedAt:        timestamppb.Now(),
		}
		ident := req.GetIdentities()[i]
		children[i] = &cluster.VM{
			Handle:      handles[i],
			Spec:        withIdentity(src.Spec, ident),
			State:       lanternv1.VmState_VM_STATE_SPAWNING,
			TenantID:    tenantID,
			NodeName:    src.NodeName,
			LastEventAt: time.Now().UTC(),
			SnapshotID:  snapID,
			ParentVMID:  srcID,
		}
		s.Store.CreateVM(children[i])
		results[i] = &lanternv1.ForkChild{
			VmId:            handles[i].VmId,
			Node:            src.NodeName,
			AgentInstanceId: req.GetIdentities()[i].GetAgentInstanceId(),
		}
	}

	// Fan out spawns with bounded concurrency.
	// Each goroutine writes to results[i] (its own slot) — no mutex needed on
	// the slice itself.  Store/Metrics/emit calls are all goroutine-safe.
	concurrency := forkConcurrency()
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		i := i // capture for goroutine
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-sem; wg.Done() }()
			vmID := handles[i].VmId
			if err := s.spawnFromSnapshot(ctx, node.Address, children[i], handles[i], snapID); err != nil {
				s.Store.UpdateVMState(vmID, lanternv1.VmState_VM_STATE_FAILED, err.Error(), nil, time.Now().UTC())
				s.Store.IncrTenantVMs(tenantID, -1)
				results[i].State = lanternv1.VmState_VM_STATE_FAILED
				results[i].Error = err.Error()
				s.emit(tenantID, &lanternv1.StatusEvent{
					VmId: vmID, State: lanternv1.VmState_VM_STATE_FAILED, At: timestamppb.Now(), Reason: err.Error(),
				})
			} else {
				s.Store.UpdateVMState(vmID, lanternv1.VmState_VM_STATE_RUNNING, "forked from "+srcID, nil, time.Now().UTC())
				if s.Metrics != nil {
					s.Metrics.ActiveVMs.Inc()
				}
				results[i].State = lanternv1.VmState_VM_STATE_RUNNING
				s.emit(tenantID, &lanternv1.StatusEvent{
					VmId: vmID, State: lanternv1.VmState_VM_STATE_RUNNING, At: timestamppb.Now(), Reason: "forked from " + srcID,
				})
			}
		}()
	}
	wg.Wait()

	resp := &lanternv1.ForkResponse{SourceVmId: srcID, SnapshotId: snapID, Forks: results}
	s.Logger.Info("vm forked", zap.String("vm_id", srcID), zap.String("snapshot_id", snapID), zap.Int("count", count))
	return resp, nil
}

// Spawn-contract env keys carrying a VM's agent identity.
const (
	envAgentInstanceID    = "LANTERN_AGENT_INSTANCE_ID"
	envAgentInstanceToken = "LANTERN_AGENT_INSTANCE_TOKEN"
)

// withIdentity returns a copy of spec whose env carries `ident` instead of
// whatever identity the source had. The source spec is never mutated.
func withIdentity(spec *lanternv1.AgentSpec, ident *lanternv1.ForkIdentity) *lanternv1.AgentSpec {
	out := &lanternv1.AgentSpec{}
	if spec != nil {
		out = proto.Clone(spec).(*lanternv1.AgentSpec)
	}
	if out.Env == nil {
		out.Env = map[string]string{}
	}
	delete(out.Env, envAgentInstanceID)
	delete(out.Env, envAgentInstanceToken)
	out.Env[envAgentInstanceID] = ident.GetAgentInstanceId()
	out.Env[envAgentInstanceToken] = ident.GetAgentInstanceToken()
	return out
}

// spawnFromSnapshot asks the manager to boot `handle` restored from snapID,
// using a copy of vm's spec (the stored spec is never mutated).
func (s *SchedulerService) spawnFromSnapshot(ctx context.Context, nodeAddr string, vm *cluster.VM, handle *lanternv1.VmHandle, snapID string) error {
	spec := &lanternv1.AgentSpec{}
	if vm.Spec != nil {
		spec = proto.Clone(vm.Spec).(*lanternv1.AgentSpec)
	}
	spec.RestoreSnapshotId = snapID
	spec.TenantId = vm.TenantID
	resp, err := s.Dialer.Spawn(ctx, nodeAddr, &lanternv1.SpawnRequest{Spec: spec, Handle: handle})
	if err != nil {
		return fmt.Errorf("spawn %s from snapshot %s: %w", handle.GetVmId(), snapID, err)
	}
	s.recordMeasurement(handle.GetVmId(), resp)
	return nil
}
