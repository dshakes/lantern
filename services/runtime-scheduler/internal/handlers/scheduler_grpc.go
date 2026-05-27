// Package handlers wires the RuntimeScheduler gRPC contract to the
// in-memory cluster store + placement engine. Six RPCs:
//
//	Schedule  — pick a node, dispatch spawn, return handle
//	Events    — stream StatusEvents for a tenant (or single VM)
//	List      — tenant-scoped view of live VMs
//	Terminate — drain + release a VM
//	Snapshot  — request a durable snapshot (stub-dispatched)
//	Cluster   — health / capacity overview for dashboards
package handlers

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/dialer"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/placement"
)

var tracer = otel.Tracer("lantern.runtime-scheduler")

// SchedulerService implements lanternv1.RuntimeSchedulerServer.
type SchedulerService struct {
	lanternv1.UnimplementedRuntimeSchedulerServer

	Store         cluster.ClusterStore
	Placement     *placement.Engine
	Dialer        dialer.ManagerDialer
	Logger        *zap.Logger
	TenantHardCap int // hard ceiling enforced before placement
}

// NewSchedulerService constructs the service. Caller must wire all deps.
func NewSchedulerService(
	store cluster.ClusterStore,
	pl *placement.Engine,
	d dialer.ManagerDialer,
	logger *zap.Logger,
	tenantHardCap int,
) *SchedulerService {
	return &SchedulerService{
		Store:         store,
		Placement:     pl,
		Dialer:        d,
		Logger:        logger.Named("scheduler_grpc"),
		TenantHardCap: tenantHardCap,
	}
}

// Schedule picks a node for the supplied spec, dispatches the spawn to
// that node's runtime-manager, and returns a VmHandle. The caller listens
// to /events for state changes.
func (s *SchedulerService) Schedule(ctx context.Context, req *lanternv1.ScheduleRequest) (*lanternv1.VmHandle, error) {
	ctx, span := tracer.Start(ctx, "RuntimeScheduler.Schedule")
	defer span.End()

	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}
	if req == nil || req.Spec == nil {
		return nil, status.Error(codes.InvalidArgument, "spec is required")
	}
	if req.Spec.ImageDigest == "" {
		return nil, status.Error(codes.InvalidArgument, "spec.image_digest is required (tags not allowed)")
	}

	// Tenant identity comes from the JWT, not the caller-supplied spec.
	req.Spec.TenantId = tenantID

	// Quota enforcement (hard cap). Soft cap is encoded in the score.
	live := s.Store.TenantLiveVMs(tenantID)
	if s.TenantHardCap > 0 && live >= s.TenantHardCap {
		return nil, status.Errorf(codes.ResourceExhausted,
			"tenant %s is at the concurrent-VM hard cap (%d)", tenantID, s.TenantHardCap)
	}

	decision, err := s.Placement.Pick(req.Spec, req.Hint, s.TenantHardCap)
	if err != nil {
		s.Logger.Warn("placement failed",
			zap.String("tenant_id", tenantID),
			zap.String("image", req.Spec.ImageDigest),
			zap.Error(err),
		)
		return nil, status.Errorf(codes.FailedPrecondition, "placement failed: %v", err)
	}

	handle := &lanternv1.VmHandle{
		VmId:      "vm-" + uuid.NewString(),
		Node:      decision.NodeName,
		CreatedAt: timestamppb.Now(),
	}
	if node, ok := s.Store.GetNode(decision.NodeName); ok {
		handle.AvailabilityZone = node.AvailabilityZone
	}

	span.SetAttributes(
		attribute.String("tenant_id", tenantID),
		attribute.String("vm_id", handle.VmId),
		attribute.String("node", handle.Node),
		attribute.Float64("placement.score", decision.Score),
	)

	vm := &cluster.VM{
		Handle:      handle,
		Spec:        req.Spec,
		State:       lanternv1.VmState_VM_STATE_PENDING,
		TenantID:    tenantID,
		NodeName:    decision.NodeName,
		LastEventAt: time.Now().UTC(),
	}
	s.Store.CreateVM(vm)
	s.Store.IncrTenantVMs(tenantID, 1)

	// Emit PENDING then dispatch the spawn.
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   handle.VmId,
		State:  lanternv1.VmState_VM_STATE_PENDING,
		At:     timestamppb.Now(),
		Reason: "scheduled",
	})

	if req.ReserveOnly {
		s.Logger.Info("reservation only — caller will spawn",
			zap.String("vm_id", handle.VmId),
			zap.String("node", handle.Node),
		)
		return handle, nil
	}

	// Dispatch spawn to the manager. Use a detached context so the spawn
	// proceeds even if the caller hangs up.
	go s.dispatchSpawn(decision.NodeAddr, req.Spec, handle, tenantID)

	return handle, nil
}

// Events streams StatusEvents for one or all of the caller's VMs.
func (s *SchedulerService) Events(req *lanternv1.EventsRequest, stream lanternv1.RuntimeScheduler_EventsServer) error {
	tenantID, err := middleware.MustTenantID(stream.Context())
	if err != nil {
		return err
	}
	ch, cancel := s.Store.Subscribe(req.VmId, tenantID)
	defer cancel()

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// List returns a tenant-scoped view of live VMs.
func (s *SchedulerService) List(ctx context.Context, req *lanternv1.ListRequest) (*lanternv1.ListResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}

	stateSet := make(map[lanternv1.VmState]struct{}, len(req.States))
	for _, st := range req.States {
		stateSet[st] = struct{}{}
	}
	labelSel := parseLabelSelector(req.LabelSelector)

	vms := s.Store.ListVMs(tenantID, func(v *cluster.VM) bool {
		if len(stateSet) > 0 {
			if _, ok := stateSet[v.State]; !ok {
				return false
			}
		}
		if len(labelSel) > 0 && v.Spec != nil {
			for k, want := range labelSel {
				if v.Spec.Labels[k] != want {
					return false
				}
			}
		}
		return true
	})

	resp := &lanternv1.ListResponse{Items: make([]*lanternv1.ListResponse_Item, 0, len(vms))}
	for _, v := range vms {
		item := &lanternv1.ListResponse_Item{
			Handle: v.Handle,
			Spec:   v.Spec,
			State:  v.State,
			Usage:  v.Usage,
		}
		if !v.LastHeartbeat.IsZero() {
			item.LastHeartbeat = timestamppb.New(v.LastHeartbeat)
		}
		resp.Items = append(resp.Items, item)
	}
	return resp, nil
}

// Terminate drains + terminates a VM. Caller-supplied grace is forwarded.
func (s *SchedulerService) Terminate(ctx context.Context, req *lanternv1.TerminateRequest) (*lanternv1.TerminateResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}
	if req.VmId == "" {
		return nil, status.Error(codes.InvalidArgument, "vm_id is required")
	}
	vm, ok := s.Store.GetVM(req.VmId)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "vm %q not found", req.VmId)
	}
	if vm.TenantID != tenantID {
		return nil, status.Errorf(codes.PermissionDenied, "vm %q does not belong to caller", req.VmId)
	}

	// Mark draining + emit event.
	s.Store.UpdateVMState(req.VmId, lanternv1.VmState_VM_STATE_DRAINING, req.Reason, nil, time.Now().UTC())
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   req.VmId,
		State:  lanternv1.VmState_VM_STATE_DRAINING,
		At:     timestamppb.Now(),
		Reason: req.Reason,
	})

	// Forward to manager (stub).
	node, _ := s.Store.GetNode(vm.NodeName)
	_, _ = s.Dialer.Stop(ctx, node.Address, &lanternv1.StopRequest{
		VmId:   req.VmId,
		Grace:  req.Grace,
		Reason: req.Reason,
	})

	// Optimistic transition to terminated. In production the manager would
	// confirm and the harness would close.
	s.Store.UpdateVMState(req.VmId, lanternv1.VmState_VM_STATE_TERMINATED, req.Reason, nil, time.Now().UTC())
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   req.VmId,
		State:  lanternv1.VmState_VM_STATE_TERMINATED,
		At:     timestamppb.Now(),
		Reason: req.Reason,
	})
	s.Store.DeleteVM(req.VmId)
	s.Store.IncrTenantVMs(tenantID, -1)

	return &lanternv1.TerminateResponse{Ok: true, Detail: "terminated"}, nil
}

// Snapshot requests a snapshot of a running VM. Stubbed for now —
// returns a synthetic snapshot ID. Real implementation forwards to the
// manager's Snapshot RPC once defined.
func (s *SchedulerService) Snapshot(ctx context.Context, req *lanternv1.SnapshotRequest) (*lanternv1.SnapshotResponse, error) {
	tenantID, err := middleware.MustTenantID(ctx)
	if err != nil {
		return nil, err
	}
	if req.VmId == "" {
		return nil, status.Error(codes.InvalidArgument, "vm_id is required")
	}
	vm, ok := s.Store.GetVM(req.VmId)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "vm %q not found", req.VmId)
	}
	if vm.TenantID != tenantID {
		return nil, status.Errorf(codes.PermissionDenied, "vm %q does not belong to caller", req.VmId)
	}
	snapID := req.IdHint
	if snapID == "" {
		snapID = "snap-" + uuid.NewString()
	}
	s.Logger.Info("snapshot intent (stub)",
		zap.String("vm_id", req.VmId),
		zap.String("snapshot_id", snapID),
		zap.Bool("keep_running", req.KeepRunning),
	)
	// TODO(W12): forward to manager and persist bytes/sha256.
	return &lanternv1.SnapshotResponse{
		SnapshotId: snapID,
		Bytes:      0,
		Sha256:     "",
	}, nil
}

// Cluster returns capacity / health for every registered node.
func (s *SchedulerService) Cluster(ctx context.Context, _ *lanternv1.ClusterRequest) (*lanternv1.ClusterResponse, error) {
	// Cluster RPC is privileged but tenant-scoped: any authenticated caller
	// can see the topology (the schedule decision uses it implicitly).
	if _, err := middleware.MustTenantID(ctx); err != nil {
		return nil, err
	}

	nodes := s.Store.ListNodes()
	resp := &lanternv1.ClusterResponse{
		Nodes: make([]*lanternv1.ClusterResponse_Node, 0, len(nodes)),
	}
	var running, pending int64
	for _, n := range nodes {
		resp.Nodes = append(resp.Nodes, &lanternv1.ClusterResponse_Node{
			Name:              n.Name,
			AvailabilityZone:  n.AvailabilityZone,
			Region:            n.Region,
			FreeVcpuMillis:    n.FreeVcpuMillis,
			FreeMemoryBytes:   n.FreeMemoryBytes,
			RunningVms:        n.RunningVms,
			Draining:          n.Draining,
			WarmPoolInventory: n.WarmPoolImageOnly,
		})
		running += n.RunningVms
	}

	// Pending = VMs whose state is still PENDING/SPAWNING.
	for _, v := range s.Store.ListVMs("", func(v *cluster.VM) bool {
		return v.State == lanternv1.VmState_VM_STATE_PENDING ||
			v.State == lanternv1.VmState_VM_STATE_SPAWNING
	}) {
		_ = v
		pending++
	}

	resp.TotalVmsRunning = running
	resp.TotalVmsPending = pending
	return resp, nil
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

func (s *SchedulerService) emit(tenantID string, ev *lanternv1.StatusEvent) {
	s.Store.Publish(ev, tenantID)
}

func (s *SchedulerService) dispatchSpawn(nodeAddr string, spec *lanternv1.AgentSpec, handle *lanternv1.VmHandle, tenantID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	s.Store.UpdateVMState(handle.VmId, lanternv1.VmState_VM_STATE_SPAWNING, "dispatched", nil, time.Now().UTC())
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   handle.VmId,
		State:  lanternv1.VmState_VM_STATE_SPAWNING,
		At:     timestamppb.Now(),
		Reason: "spawn dispatched to " + handle.Node,
	})

	_, err := s.Dialer.Spawn(ctx, nodeAddr, &lanternv1.SpawnRequest{
		Spec:   spec,
		Handle: handle,
	})
	if err != nil {
		s.Logger.Error("spawn dispatch failed",
			zap.String("vm_id", handle.VmId),
			zap.String("node", handle.Node),
			zap.Error(err),
		)
		s.Store.UpdateVMState(handle.VmId, lanternv1.VmState_VM_STATE_FAILED, err.Error(), nil, time.Now().UTC())
		s.emit(tenantID, &lanternv1.StatusEvent{
			VmId:   handle.VmId,
			State:  lanternv1.VmState_VM_STATE_FAILED,
			At:     timestamppb.Now(),
			Reason: err.Error(),
		})
		return
	}
	// With the stub dialer there's no harness reporting RUNNING — emit it
	// here so consumers see a complete lifecycle. Real wiring (manager
	// pushes RUNNING when the harness's first heartbeat lands) replaces
	// this in W12.
	s.Store.UpdateVMState(handle.VmId, lanternv1.VmState_VM_STATE_RUNNING, "spawn ok", nil, time.Now().UTC())
	s.emit(tenantID, &lanternv1.StatusEvent{
		VmId:   handle.VmId,
		State:  lanternv1.VmState_VM_STATE_RUNNING,
		At:     timestamppb.Now(),
		Reason: "spawn ok",
	})
}

// parseLabelSelector accepts "k=v,k=v" pairs and returns a map. Empty
// input -> empty map. Malformed entries are skipped.
func parseLabelSelector(s string) map[string]string {
	out := map[string]string{}
	if s == "" {
		return out
	}
	for _, pair := range strings.Split(s, ",") {
		kv := strings.SplitN(strings.TrimSpace(pair), "=", 2)
		if len(kv) != 2 {
			continue
		}
		out[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
	}
	return out
}
