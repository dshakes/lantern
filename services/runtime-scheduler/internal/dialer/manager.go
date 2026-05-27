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
	"fmt"
	"os"
	"strings"
	"sync"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// defaultManagerPort is the runtime-manager's default gRPC listen port.
// See services/runtime-manager/src/config.rs.
const defaultManagerPort = "50054"

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

// ---------------------------------------------------------------------------
// GRPCDialer — real gRPC client to per-node runtime-manager instances.
// ---------------------------------------------------------------------------

// GRPCDialer dials runtime-manager gRPC endpoints on demand and caches
// the resulting ClientConn per resolved target. Connections are dialed
// lazily (first call per node) and reused for all subsequent RPCs.
//
// Per-node address resolution rules, in order:
//  1. If env LANTERN_NODE_ADDR_<NODE-UPPERCASED> is set, use that.
//  2. If nodeAddr is "node-local", "node-stub", or empty, fall back to
//     env LANTERN_DEFAULT_MANAGER_ADDR.
//  3. If nodeAddr already contains a ':' (has a port), use as-is.
//  4. Otherwise append the default runtime-manager port (:50054).
//
// Transport is insecure (cleartext). TLS is out of scope for this wedge —
// the scheduler<->manager link is expected to be on a private network or
// service mesh that terminates TLS at the sidecar.
type GRPCDialer struct {
	logger *zap.Logger

	mu    sync.RWMutex
	conns map[string]*grpc.ClientConn // keyed by both raw nodeAddr and resolved target
}

// NewGRPCDialer returns a dialer with no eager connections; conns are
// established on the first Spawn/Stop call per node.
func NewGRPCDialer(logger *zap.Logger) *GRPCDialer {
	return &GRPCDialer{
		logger: logger.Named("manager_dialer"),
		conns:  make(map[string]*grpc.ClientConn),
	}
}

// resolveTarget maps a node address (as the scheduler knows it) to a
// concrete gRPC dial target.
func resolveTarget(nodeAddr string) string {
	// 1. Explicit per-node override.
	if nodeAddr != "" {
		envKey := "LANTERN_NODE_ADDR_" + sanitizeEnvKey(nodeAddr)
		if v := os.Getenv(envKey); v != "" {
			return v
		}
	}

	// 2. Synthetic / unset → default.
	if nodeAddr == "" || nodeAddr == "node-local" || nodeAddr == "node-stub" {
		if v := os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR"); v != "" {
			return v
		}
		// No override available; fall through to the raw value so the
		// dial fails loudly rather than silently dialing localhost.
	}

	// 3 + 4. Use as-is if it has a port; otherwise append the default.
	if strings.Contains(nodeAddr, ":") {
		return nodeAddr
	}
	return nodeAddr + ":" + defaultManagerPort
}

// sanitizeEnvKey makes a node name safe for use as an env var suffix
// (uppercase, '-' and '.' → '_').
func sanitizeEnvKey(s string) string {
	r := strings.NewReplacer("-", "_", ".", "_", "/", "_", ":", "_")
	return strings.ToUpper(r.Replace(s))
}

// clientFor returns a RuntimeManagerClient for the given node address,
// dialing (and caching) on first use.
func (d *GRPCDialer) clientFor(nodeAddr string) (lanternv1.RuntimeManagerClient, error) {
	target := resolveTarget(nodeAddr)
	if target == "" {
		return nil, fmt.Errorf("dialer: empty target for node %q", nodeAddr)
	}

	// Fast path: already cached under raw or resolved key.
	d.mu.RLock()
	if c, ok := d.conns[nodeAddr]; ok && c != nil {
		d.mu.RUnlock()
		return lanternv1.NewRuntimeManagerClient(c), nil
	}
	if c, ok := d.conns[target]; ok && c != nil {
		d.mu.RUnlock()
		return lanternv1.NewRuntimeManagerClient(c), nil
	}
	d.mu.RUnlock()

	// Slow path: dial under write lock, re-checking after acquisition.
	d.mu.Lock()
	defer d.mu.Unlock()
	if c, ok := d.conns[target]; ok && c != nil {
		if nodeAddr != "" {
			d.conns[nodeAddr] = c
		}
		return lanternv1.NewRuntimeManagerClient(c), nil
	}

	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("dialer: dial %s (node %q): %w", target, nodeAddr, err)
	}
	d.conns[target] = conn
	if nodeAddr != "" && nodeAddr != target {
		d.conns[nodeAddr] = conn
	}
	d.logger.Info("dialed runtime-manager",
		zap.String("node_addr", nodeAddr),
		zap.String("target", target),
	)
	return lanternv1.NewRuntimeManagerClient(conn), nil
}

// Spawn forwards to the runtime-manager at nodeAddr.
func (d *GRPCDialer) Spawn(ctx context.Context, nodeAddr string, req *lanternv1.SpawnRequest) (*lanternv1.SpawnResponse, error) {
	client, err := d.clientFor(nodeAddr)
	if err != nil {
		return nil, err
	}
	d.logger.Debug("spawn forward",
		zap.String("node_addr", nodeAddr),
		zap.String("vm_id", vmHandleID(req.Handle)),
		zap.String("tenant_id", specTenant(req.Spec)),
		zap.String("run_id", specRunID(req.Spec)),
	)
	return client.Spawn(ctx, req)
}

// Stop forwards to the runtime-manager at nodeAddr.
func (d *GRPCDialer) Stop(ctx context.Context, nodeAddr string, req *lanternv1.StopRequest) (*lanternv1.StopResponse, error) {
	client, err := d.clientFor(nodeAddr)
	if err != nil {
		return nil, err
	}
	d.logger.Debug("stop forward",
		zap.String("node_addr", nodeAddr),
		zap.String("vm_id", req.VmId),
		zap.String("reason", req.Reason),
	)
	return client.Stop(ctx, req)
}

// Close tears down every cached gRPC connection. Safe to call multiple
// times; the underlying ClientConn.Close is idempotent.
func (d *GRPCDialer) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	closed := make(map[*grpc.ClientConn]struct{}, len(d.conns))
	for key, conn := range d.conns {
		if conn == nil {
			continue
		}
		if _, ok := closed[conn]; ok {
			continue
		}
		if err := conn.Close(); err != nil {
			d.logger.Warn("grpc conn close failed",
				zap.String("key", key),
				zap.Error(err),
			)
		}
		closed[conn] = struct{}{}
	}
	d.conns = make(map[string]*grpc.ClientConn)
}

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
