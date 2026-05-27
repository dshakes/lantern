// Package dialer wraps the per-node runtime-manager gRPC clients. The
// scheduler holds one of these and asks "give me a client for node N";
// the dialer caches the connection.
//
// For now (W12 pre-VM phase), the default ManagerDialer implementation
// is a stub that just logs the intent. The placement decision is real
// — the actual Spawn call lands once runtime-manager exposes its gRPC
// surface at the node's address.
package dialer

import (
	"context"
	"sync"

	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// ManagerDialer is the interface the scheduler uses to talk to a node.
type ManagerDialer interface {
	Spawn(ctx context.Context, nodeAddr string, req *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error)
	Stop(ctx context.Context, nodeAddr string, req *lanternv1.StopRequest) (*lanternv1.StopResponse, error)
	Close()
}

// LogOnlyDialer is the no-op implementation used until real runtime-manager
// instances are reachable on each node. It logs the request and returns a
// synthetic OK response so the rest of the scheduler can exercise its
// happy path end-to-end.
//
// TODO(W12): replace with a real grpc.ClientConn-backed dialer once
// runtime-manager exposes the RuntimeManager service on each node. The
// scheduler should pool connections keyed by node address.
type LogOnlyDialer struct {
	logger *zap.Logger
	mu     sync.Mutex
}

// NewLogOnlyDialer returns a stub dialer that logs every call.
func NewLogOnlyDialer(logger *zap.Logger) *LogOnlyDialer {
	return &LogOnlyDialer{logger: logger.Named("manager_dialer")}
}

func (d *LogOnlyDialer) Spawn(_ context.Context, nodeAddr string, req *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.logger.Info("spawn intent (stub)",
		zap.String("node_addr", nodeAddr),
		zap.String("vm_id", vmHandleID(req.Handle)),
		zap.String("image", specImage(req.Spec)),
		zap.String("tenant_id", specTenant(req.Spec)),
		zap.String("run_id", specRunID(req.Spec)),
	)
	return &lanternv1.SpawnResponse{Handle: req.Handle}, nil
}

func (d *LogOnlyDialer) Stop(_ context.Context, nodeAddr string, req *lanternv1.StopRequest) (*lanternv1.StopResponse, error) {
	d.logger.Info("stop intent (stub)",
		zap.String("node_addr", nodeAddr),
		zap.String("vm_id", req.VmId),
		zap.String("reason", req.Reason),
	)
	return &lanternv1.StopResponse{Ok: true, Detail: "stub dialer"}, nil
}

func (d *LogOnlyDialer) Close() {}

// Nil-safe accessors used while the generated stubs don't include the
// usual `func (x *T) GetField() ...` helpers from protoc-gen-go. Once
// `make proto` lands, these can collapse to spec.GetX() etc.
func vmHandleID(h *lanternv1.VmHandle) string {
	if h == nil {
		return ""
	}
	return h.VmId
}

func specImage(s *lanternv1.AgentSpec) string {
	if s == nil {
		return ""
	}
	return s.ImageDigest
}

func specTenant(s *lanternv1.AgentSpec) string {
	if s == nil {
		return ""
	}
	return s.TenantId
}

func specRunID(s *lanternv1.AgentSpec) string {
	if s == nil {
		return ""
	}
	return s.RunId
}
