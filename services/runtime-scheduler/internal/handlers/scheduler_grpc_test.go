package handlers_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/timestamppb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/dialer"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/handlers"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/middleware"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/placement"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
)

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

// errDialer always returns an error from Stop, simulating an unreachable manager.
type errDialer struct{}

func (errDialer) Spawn(_ context.Context, _ string, _ *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error) {
	return &lanternv1.SpawnResponse{}, nil
}
func (errDialer) Stop(_ context.Context, _ string, _ *lanternv1.StopRequest) (*lanternv1.StopResponse, error) {
	return nil, errors.New("connection refused")
}
func (errDialer) Snapshot(_ context.Context, _ string, _ *lanternv1.SnapshotRequest) (*lanternv1.SnapshotResponse, error) {
	return nil, errors.New("unimplemented")
}
func (errDialer) Close() {}

// okDialer succeeds for all calls.
type okDialer struct{}

func (okDialer) Spawn(_ context.Context, _ string, req *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error) {
	return &lanternv1.SpawnResponse{Handle: req.Handle}, nil
}
func (okDialer) Stop(_ context.Context, _ string, _ *lanternv1.StopRequest) (*lanternv1.StopResponse, error) {
	return &lanternv1.StopResponse{Ok: true}, nil
}
func (okDialer) Snapshot(_ context.Context, _ string, _ *lanternv1.SnapshotRequest) (*lanternv1.SnapshotResponse, error) {
	return nil, errors.New("unimplemented")
}
func (okDialer) Close() {}

// ctxWithTenant injects a tenant ID the way the middleware does.
func ctxWithTenant(tenantID string) context.Context {
	return middleware.InjectTenantID(context.Background(), tenantID)
}

func newService(store cluster.ClusterStore, d dialer.ManagerDialer) *handlers.SchedulerService {
	pl := &placement.Engine{Store: store, Weights: scoring.DefaultWeights()}
	return handlers.NewSchedulerService(store, pl, d, zap.NewNop(), 20)
}

func addNode(store cluster.ClusterStore, name string, vcpuMillis, memBytes int64) {
	store.UpsertNode(cluster.Node{
		Name:            name,
		Address:         name + ":50054",
		FreeVcpuMillis:  vcpuMillis,
		FreeMemoryBytes: memBytes,
		LastHeartbeat:   time.Now(),
	})
}

func scheduleReq(imageDigest, idempotencyKey string) *lanternv1.ScheduleRequest {
	return &lanternv1.ScheduleRequest{
		Spec: &lanternv1.AgentSpec{
			ImageDigest: imageDigest,
			Limits:      &lanternv1.ResourceLimits{Vcpu: "1", Memory: "1Gi"},
		},
		IdempotencyKey: idempotencyKey,
	}
}

// ---------------------------------------------------------------------------
// Defect 3: Terminate must not free quota when Stop fails
// ---------------------------------------------------------------------------

func TestTerminate_StopError_DoesNotFreeQuota(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	svc := newService(store, errDialer{})

	ctx := ctxWithTenant("t1")

	// Schedule a VM so there's something to terminate.
	handle, err := svc.Schedule(ctx, scheduleReq("sha256:abc", ""))
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	// Let the background dispatchSpawn goroutine settle before asserting.
	time.Sleep(50 * time.Millisecond)

	quotaBefore := store.TenantLiveVMs("t1")
	if quotaBefore != 1 {
		t.Fatalf("quota before terminate: got %d, want 1", quotaBefore)
	}

	// Terminate should fail because errDialer.Stop returns an error.
	_, err = svc.Terminate(ctx, &lanternv1.TerminateRequest{VmId: handle.VmId, Reason: "test"})
	if err == nil {
		t.Fatal("expected Terminate to return error when Stop fails, got nil")
	}

	// Quota must still be 1 — the VM is still running on the manager side.
	quotaAfter := store.TenantLiveVMs("t1")
	if quotaAfter != 1 {
		t.Errorf("quota after failed terminate: got %d, want 1 (quota must not be freed on Stop error)", quotaAfter)
	}

	// VM must still be in store (not deleted).
	if _, ok := store.GetVM(handle.VmId); !ok {
		t.Error("VM was removed from store despite Stop error — must remain for retry")
	}
}

func TestTerminate_StopSuccess_FreesQuota(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	svc := newService(store, okDialer{})

	ctx := ctxWithTenant("t1")

	handle, err := svc.Schedule(ctx, scheduleReq("sha256:abc", ""))
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}

	resp, err := svc.Terminate(ctx, &lanternv1.TerminateRequest{VmId: handle.VmId, Reason: "done"})
	if err != nil {
		t.Fatalf("Terminate: %v", err)
	}
	if !resp.Ok {
		t.Errorf("TerminateResponse.Ok: got false, want true")
	}
	if store.TenantLiveVMs("t1") != 0 {
		t.Errorf("quota after successful terminate: got %d, want 0", store.TenantLiveVMs("t1"))
	}
}

// ---------------------------------------------------------------------------
// Defect 5: Schedule idempotency key deduplicates retries
// ---------------------------------------------------------------------------

func TestSchedule_IdempotencyKey_ReturnsSameHandle(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	svc := newService(store, okDialer{})

	ctx := ctxWithTenant("t1")
	req := scheduleReq("sha256:abc", "idem-key-1")

	h1, err := svc.Schedule(ctx, req)
	if err != nil {
		t.Fatalf("first Schedule: %v", err)
	}

	// Repeat the same request (simulating a client retry).
	h2, err := svc.Schedule(ctx, req)
	if err != nil {
		t.Fatalf("second Schedule: %v", err)
	}

	if h1.VmId != h2.VmId {
		t.Errorf("idempotency broken: first=%q second=%q, expected same VmId", h1.VmId, h2.VmId)
	}
	// Only one VM should be in the store.
	vms := store.ListVMs("t1", nil)
	if len(vms) != 1 {
		t.Errorf("expected 1 VM after two idempotent Schedule calls, got %d", len(vms))
	}
}

func TestSchedule_NoIdempotencyKey_CreatesTwoVMs(t *testing.T) {
	store := cluster.NewInMemoryStore()
	addNode(store, "n1", 8000, 16<<30)
	svc := newService(store, okDialer{})

	ctx := ctxWithTenant("t1")

	if _, err := svc.Schedule(ctx, scheduleReq("sha256:abc", "")); err != nil {
		t.Fatalf("first Schedule: %v", err)
	}
	if _, err := svc.Schedule(ctx, scheduleReq("sha256:abc", "")); err != nil {
		t.Fatalf("second Schedule: %v", err)
	}

	vms := store.ListVMs("t1", nil)
	if len(vms) != 2 {
		t.Errorf("expected 2 VMs when no idempotency key, got %d", len(vms))
	}
}

// ---------------------------------------------------------------------------
// Helper: expose a VmHandle with a fixed CreatedAt for test assertions
// ---------------------------------------------------------------------------
var _ = timestamppb.Now // ensure import used
