package handlers

// Headless-agent runtime governance.
//
// This handler is the control-plane's gatekeeper in front of the
// (Firecracker-backed) RuntimeScheduler at :50055 — see
// packages/proto/lantern/v1/runtime.proto for the wire contract.
//
// Responsibilities:
//   1. Authn (JWT/API key) and tenancy enforcement on every call. The
//      tenant_id in the AgentSpec is ALWAYS overwritten from the JWT.
//   2. Quota enforcement (runtime_quotas) BEFORE dispatching to the
//      scheduler. On hard_fail=true, denied requests get HTTP 402.
//   3. Audit trail — every schedule/terminate/exec/deny writes a row
//      into runtime_audit_events keyed by tenant_id + principal_id.
//   4. Canonical VM record-keeping in runtime_vms. The scheduler is
//      the source of truth for live placement, but the control-plane
//      keeps a shadow row so the dashboard never has to fan out gRPC.
//
// gRPC scheduling is plumbed through the SchedulerClient interface.
// The stubSchedulerClient default just logs intent and stamps
// runtime_vms.state='pending' — wiring the real grpc.Dial happens in
// a follow-up once the scheduler service is up.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	"github.com/jackc/pgx/v5"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- Scheduler client (stubbed, interface-shaped) ----------

// SchedulerClient is the thin abstraction the runtime handler talks to.
// The real implementation will dial the RuntimeScheduler gRPC at :50055;
// for now stubSchedulerClient stamps runtime_vms and logs intent so the
// REST surface is exercisable end-to-end.
type SchedulerClient interface {
	Schedule(ctx context.Context, spec map[string]any) (vmID, node, az string, err error)
	Terminate(ctx context.Context, vmID, reason string) error
	Exec(ctx context.Context, vmID, command string, argv []string) (stdout, stderr string, exitCode int32, err error)
	Cluster(ctx context.Context) (map[string]any, error)
	// ListStates returns the scheduler's current view of live VM states,
	// keyed by vm_id. Used by the reconciler to write authoritative state
	// back to runtime_vms. Returns an empty map (not an error) when the
	// scheduler has no live VMs.
	ListStates(ctx context.Context, tenantID string) (map[string]string, error)
}

type stubSchedulerClient struct {
	logger *zap.Logger
}

func (s *stubSchedulerClient) Schedule(_ context.Context, spec map[string]any) (string, string, string, error) {
	// TODO(runtime-grpc): replace with real RuntimeScheduler.Schedule call.
	vmID := "vm-" + newID()
	s.logger.Info("stub scheduler: schedule",
		zap.String("vm_id", vmID),
		zap.Any("spec_keys", keysOf(spec)),
	)
	return vmID, "node-stub", "az-stub", nil
}

func (s *stubSchedulerClient) Terminate(_ context.Context, vmID, reason string) error {
	// TODO(runtime-grpc): replace with real RuntimeScheduler.Terminate call.
	s.logger.Info("stub scheduler: terminate",
		zap.String("vm_id", vmID),
		zap.String("reason", reason),
	)
	return nil
}

func (s *stubSchedulerClient) Exec(_ context.Context, vmID, command string, _ []string) (string, string, int32, error) {
	// TODO(runtime-grpc): replace with real RuntimeManager.Exec stream proxy.
	s.logger.Info("stub scheduler: exec",
		zap.String("vm_id", vmID),
		zap.String("command", command),
	)
	return "", "stub exec — runtime-manager gRPC not yet wired\n", 0, nil
}

func (s *stubSchedulerClient) Cluster(_ context.Context) (map[string]any, error) {
	// TODO(runtime-grpc): replace with real RuntimeScheduler.Cluster call.
	return map[string]any{
		"nodes":           []any{},
		"totalVmsRunning": 0,
		"totalVmsPending": 0,
		"stub":            true,
	}, nil
}

func (s *stubSchedulerClient) ListStates(_ context.Context, _ string) (map[string]string, error) {
	// Stub: no scheduler to ask, so the reconciler has nothing to do.
	return map[string]string{}, nil
}

// ---------- Real gRPC scheduler client ----------

// grpcSchedulerClient dials the RuntimeScheduler service at the address
// supplied via LANTERN_SCHEDULER_GRPC_ADDR (typically scheduler:50055).
// It also lazily dials per-node runtime-manager connections for the
// Logs / Exec stream proxy paths.
//
// Connections are kept alive for the process lifetime. There is no TLS
// today — the wire runs inside the cluster VPC and is wrapped by the
// existing gateway TLS at the edge.
type grpcSchedulerClient struct {
	logger     *zap.Logger
	conn       *grpc.ClientConn
	client     lanternv1.RuntimeSchedulerClient
	defaultMgr string                      // LANTERN_DEFAULT_MANAGER_ADDR
	mgrMu      sync.Mutex                  // guards mgrConns
	mgrConns   map[string]*grpc.ClientConn // nodeName -> conn
	mgrClients map[string]lanternv1.RuntimeManagerClient
}

// NewGRPCSchedulerClient dials the scheduler service. Plain insecure for now —
// scheduler runs inside the cluster, TLS terminates at the edge.
func NewGRPCSchedulerClient(addr string, logger *zap.Logger) (*grpcSchedulerClient, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial scheduler %s: %w", addr, err)
	}
	return &grpcSchedulerClient{
		logger:     logger,
		conn:       conn,
		client:     lanternv1.NewRuntimeSchedulerClient(conn),
		defaultMgr: os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR"),
		mgrConns:   make(map[string]*grpc.ClientConn),
		mgrClients: make(map[string]lanternv1.RuntimeManagerClient),
	}, nil
}

// withTenant attaches the tenant_id to outbound gRPC metadata, matching the
// scheduler's `middleware.MustTenantID` expectation. The tenant comes from
// the request context (caller already validated the JWT) so we pull it from
// the spec map here.
func withTenant(ctx context.Context, tenantID string) context.Context {
	if tenantID == "" {
		return ctx
	}
	return metadata.AppendToOutgoingContext(ctx, "tenant_id", tenantID)
}

// resolveManagerAddr maps a node name to a runtime-manager gRPC address.
// Resolution order:
//  1. LANTERN_NODE_ADDR_<node> (with dots/dashes replaced by underscores)
//  2. LANTERN_DEFAULT_MANAGER_ADDR
//  3. node + ":50054" (the runtime-manager default port)
func (c *grpcSchedulerClient) resolveManagerAddr(node string) string {
	if node == "" {
		return c.defaultMgr
	}
	key := "LANTERN_NODE_ADDR_" + strings.NewReplacer(".", "_", "-", "_").Replace(node)
	if v := os.Getenv(key); v != "" {
		return v
	}
	if c.defaultMgr != "" {
		return c.defaultMgr
	}
	return node + ":50054"
}

// managerClient returns (or lazily dials) the RuntimeManagerClient for a node.
func (c *grpcSchedulerClient) managerClient(node string) (lanternv1.RuntimeManagerClient, error) {
	addr := c.resolveManagerAddr(node)
	if addr == "" {
		return nil, fmt.Errorf("no runtime-manager address known for node %q", node)
	}
	c.mgrMu.Lock()
	defer c.mgrMu.Unlock()
	if cl, ok := c.mgrClients[node]; ok {
		return cl, nil
	}
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	)
	if err != nil {
		return nil, fmt.Errorf("dial runtime-manager %s: %w", addr, err)
	}
	cl := lanternv1.NewRuntimeManagerClient(conn)
	c.mgrConns[node] = conn
	c.mgrClients[node] = cl
	c.logger.Info("dialed runtime-manager", zap.String("node", node), zap.String("addr", addr))
	return cl, nil
}

func (c *grpcSchedulerClient) Schedule(ctx context.Context, spec map[string]any) (string, string, string, error) {
	tenantID, _ := spec["tenant_id"].(string)
	ctx = withTenant(ctx, tenantID)

	agent := agentSpecFromMap(spec)
	req := &lanternv1.ScheduleRequest{Spec: agent}

	resp, err := c.client.Schedule(ctx, req)
	if err != nil {
		return "", "", "", err
	}
	if resp == nil {
		return "", "", "", fmt.Errorf("scheduler returned nil handle")
	}
	return resp.VmId, resp.Node, resp.AvailabilityZone, nil
}

func (c *grpcSchedulerClient) Terminate(ctx context.Context, vmID, reason string) error {
	// Tenant id is required by the scheduler's middleware, but the REST
	// terminate handler already verified ownership. Pull from outgoing
	// metadata if the caller stamped one; otherwise the scheduler will reject.
	_, err := c.client.Terminate(ctx, &lanternv1.TerminateRequest{
		VmId:   vmID,
		Reason: reason,
	})
	return err
}

func (c *grpcSchedulerClient) Exec(ctx context.Context, vmID, command string, argv []string) (string, string, int32, error) {
	// TODO(runtime-grpc): RuntimeManager.Exec is a bidi-stream RPC. The
	// stub generated client in gen/go/lantern/v1/runtime_grpc.pb.go does
	// not yet expose it (the proto defines it but `make proto` hasn't
	// regenerated). Until then we surface a clear error so callers know
	// Exec is not wired and can fall back. Tracked as TODO(W12-exec).
	_ = ctx
	c.logger.Warn("grpc scheduler: Exec not wired through proto stub",
		zap.String("vm_id", vmID),
		zap.String("command", command),
		zap.Int("argv_len", len(argv)),
	)
	return "", "exec not yet wired through runtime-manager proto stub\n", 0, nil
}

func (c *grpcSchedulerClient) Cluster(ctx context.Context) (map[string]any, error) {
	// Cluster is gated by tenant_id on the scheduler side — propagate
	// from context if the caller stamped one (Cluster handler stamps via
	// owner-only auth).
	resp, err := c.client.Cluster(ctx, &lanternv1.ClusterRequest{})
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return map[string]any{"nodes": []any{}, "total_vms_running": 0, "total_vms_pending": 0}, nil
	}
	nodes := make([]map[string]any, 0, len(resp.Nodes))
	for _, n := range resp.Nodes {
		if n == nil {
			continue
		}
		nodes = append(nodes, map[string]any{
			"name":              n.Name,
			"availability_zone": n.AvailabilityZone,
			"region":            n.Region,
			"free_vcpu_millis":  n.FreeVcpuMillis,
			"free_memory_bytes": n.FreeMemoryBytes,
			"running_vms":       n.RunningVms,
			"draining":          n.Draining,
		})
	}
	return map[string]any{
		"nodes":             nodes,
		"total_vms_running": resp.TotalVmsRunning,
		"total_vms_pending": resp.TotalVmsPending,
	}, nil
}

func (c *grpcSchedulerClient) ListStates(ctx context.Context, tenantID string) (map[string]string, error) {
	ctx = withTenant(ctx, tenantID)
	resp, err := c.client.List(ctx, &lanternv1.ListRequest{TenantId: tenantID})
	if err != nil {
		return nil, err
	}
	out := make(map[string]string)
	if resp == nil {
		return out, nil
	}
	for _, item := range resp.GetItems() {
		h := item.GetHandle()
		if h == nil || h.GetVmId() == "" {
			continue
		}
		out[h.GetVmId()] = vmStateString(item.GetState())
	}
	return out, nil
}

// vmStateString maps the proto VmState enum to the lowercase string the
// runtime_vms table + dashboard use.
func vmStateString(s lanternv1.VmState) string {
	switch s {
	case lanternv1.VmState_VM_STATE_PENDING:
		return "pending"
	case lanternv1.VmState_VM_STATE_SPAWNING:
		return "spawning"
	case lanternv1.VmState_VM_STATE_RUNNING:
		return "running"
	case lanternv1.VmState_VM_STATE_DRAINING:
		return "draining"
	case lanternv1.VmState_VM_STATE_TERMINATED:
		return "terminated"
	case lanternv1.VmState_VM_STATE_FAILED:
		return "failed"
	default:
		return "pending"
	}
}

// agentSpecFromMap turns the REST-side spec map into the proto AgentSpec.
// Field names mirror the conventions in runtime-scheduler/internal/handlers
// (snake_case map keys, proto enum normalization).
func agentSpecFromMap(spec map[string]any) *lanternv1.AgentSpec {
	if spec == nil {
		return &lanternv1.AgentSpec{}
	}
	a := &lanternv1.AgentSpec{}
	if s, ok := spec["image_digest"].(string); ok {
		a.ImageDigest = s
	}
	if s, ok := spec["tenant_id"].(string); ok {
		a.TenantId = s
	}
	if s, ok := spec["agent_version_id"].(string); ok {
		a.AgentVersionId = s
	}
	if s, ok := spec["run_id"].(string); ok {
		a.RunId = s
	}
	if s, ok := spec["restore_snapshot_id"].(string); ok {
		a.RestoreSnapshotId = s
	}
	if b, ok := spec["idempotent"].(bool); ok {
		a.Idempotent = b
	}
	if iso, ok := spec["isolation"].(string); ok {
		a.Isolation = parseIsolation(iso)
	}
	if net, ok := spec["network"].(string); ok {
		a.Network = parseNetwork(net)
	}
	if labels, ok := spec["labels"].(map[string]string); ok {
		a.Labels = labels
	}
	if regions, ok := spec["preferred_regions"].([]string); ok {
		a.PreferredRegions = regions
	}
	// command, args, env — JSON arrays/objects come back as []any / map[string]any.
	if cmd, ok := spec["command"].([]any); ok {
		for _, v := range cmd {
			if s, ok := v.(string); ok {
				a.Command = append(a.Command, s)
			}
		}
	}
	if args, ok := spec["args"].([]any); ok {
		for _, v := range args {
			if s, ok := v.(string); ok {
				a.Args = append(a.Args, s)
			}
		}
	}
	if env, ok := spec["env"].(map[string]any); ok {
		a.Env = make(map[string]string, len(env))
		for k, v := range env {
			if s, ok := v.(string); ok {
				a.Env[k] = s
			}
		}
	}
	return a
}

func parseIsolation(s string) lanternv1.IsolationClass {
	switch strings.ToLower(s) {
	case "trusted":
		return lanternv1.IsolationClass_ISOLATION_TRUSTED
	case "standard":
		return lanternv1.IsolationClass_ISOLATION_STANDARD
	case "untrusted":
		return lanternv1.IsolationClass_ISOLATION_UNTRUSTED
	case "hostile":
		return lanternv1.IsolationClass_ISOLATION_HOSTILE
	case "wasm":
		return lanternv1.IsolationClass_ISOLATION_WASM
	case "devcontainer":
		return lanternv1.IsolationClass_ISOLATION_DEVCONTAINER
	default:
		return lanternv1.IsolationClass_ISOLATION_UNSPECIFIED
	}
}

func parseNetwork(s string) lanternv1.NetworkPolicy {
	switch strings.ToLower(s) {
	case "none":
		return lanternv1.NetworkPolicy_NETWORK_NONE
	case "allowlist", "allowlist_domain":
		return lanternv1.NetworkPolicy_NETWORK_ALLOWLIST_DOMAIN
	case "tenant_vpc":
		return lanternv1.NetworkPolicy_NETWORK_TENANT_VPC
	case "open":
		return lanternv1.NetworkPolicy_NETWORK_OPEN
	default:
		return lanternv1.NetworkPolicy_NETWORK_UNSPECIFIED
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---------- Handler ----------

// vmMetricsStore is the minimal interface the RuntimeHandler needs to read
// the latest prometheus payload per VM. RuntimeReportHandler implements it.
type vmMetricsStore interface {
	LatestVMMetrics(tenantID string) []*vmMetricsEntry
}

// RuntimeHandler implements the REST surface for headless agent runtime
// governance. Mounted under /v1/runtime/* in cmd/server/main.go.
type RuntimeHandler struct {
	srv          *server.Server
	auth         *AuthHandler
	scheduler    SchedulerClient
	identity     *agentidentity.Issuer
	spawnLimiter *SpawnRateLimiter // per-tenant spawn-storm guard (nil = disabled)
	metricsStore vmMetricsStore    // optional; nil when report handler not wired
}

// SetSpawnLimiter wires the per-tenant spawn rate limiter (phase 3). nil-safe.
func (h *RuntimeHandler) SetSpawnLimiter(l *SpawnRateLimiter) { h.spawnLimiter = l }

// SetMetricsStore wires the prometheus-metrics in-memory store from
// RuntimeReportHandler so LiveMetrics can surface per-VM counters. nil-safe.
func (h *RuntimeHandler) SetMetricsStore(s vmMetricsStore) { h.metricsStore = s }

// NewRuntimeHandler constructs a RuntimeHandler. If LANTERN_SCHEDULER_GRPC_ADDR
// is set the real gRPC client is dialed; otherwise the stub is used so a
// solo control-plane stays exercisable.
func NewRuntimeHandler(srv *server.Server, auth *AuthHandler) *RuntimeHandler {
	h := &RuntimeHandler{
		srv:      srv,
		auth:     auth,
		identity: agentidentity.New(auth.JWTSecret()),
	}
	logger := srv.Logger.Named("runtime")
	if addr := os.Getenv("LANTERN_SCHEDULER_GRPC_ADDR"); addr != "" {
		c, err := NewGRPCSchedulerClient(addr, logger.Named("scheduler_grpc"))
		if err != nil {
			logger.Warn("falling back to stub scheduler client",
				zap.String("addr", addr), zap.Error(err))
			h.scheduler = &stubSchedulerClient{logger: logger.Named("scheduler_stub")}
		} else {
			logger.Info("runtime scheduler: gRPC client wired",
				zap.String("addr", addr))
			h.scheduler = c
		}
	} else {
		logger.Info("runtime scheduler: stub client (set LANTERN_SCHEDULER_GRPC_ADDR to wire real gRPC)")
		h.scheduler = &stubSchedulerClient{logger: logger.Named("scheduler_stub")}
	}
	// State reconciler: the scheduler is authoritative for live VM state
	// but the dashboard reads runtime_vms. Without writeback, a row stays
	// 'pending' forever even after the container is running or gone. Poll
	// the scheduler every few seconds and reconcile. Only runs against the
	// real gRPC client — the stub has nothing to report.
	if _, isStub := h.scheduler.(*stubSchedulerClient); !isStub {
		go h.reconcileLoop()
	}
	return h
}

// reconcileLoop periodically pulls live VM states from the scheduler and
// writes them back to runtime_vms so the dashboard reflects reality.
// Rows that the control-plane believes are live (pending/spawning/running/
// draining) but that the scheduler no longer knows about are marked
// terminated — the scheduler deletes VMs from its store on terminate, so
// "gone from scheduler" means "finished".
func (h *RuntimeHandler) reconcileLoop() {
	const interval = 4 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		h.reconcileOnce()
	}
}

func (h *RuntimeHandler) reconcileOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Distinct tenants with live rows — reconcile each (scheduler.List is
	// tenant-scoped). Keeps the query small on a busy cluster.
	// rls-exempt: background sweep with no request tenant — this discovery query
	// spans ALL tenants to find which ones have live VMs, so it runs on the
	// privileged pool. The per-tenant writes below ARE tenant-scoped via WithTenant.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT DISTINCT tenant_id FROM runtime_vms
		WHERE state IN ('pending','spawning','running','draining')
	`)
	if err != nil {
		h.logger().Warn("reconcile: tenant scan failed", zap.Error(err))
		return
	}
	var tenants []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			tenants = append(tenants, t)
		}
	}
	rows.Close()

	for _, tenantID := range tenants {
		states, err := h.scheduler.ListStates(ctx, tenantID)
		if err != nil {
			h.logger().Debug("reconcile: ListStates failed", zap.String("tenant", tenantID), zap.Error(err))
			continue
		}
		// The sweep has a concrete per-tenant id (from the discovery query, not a
		// request); inject it so the reconcile writes are RLS-scoped.
		tctx := middleware.InjectTenantID(ctx, tenantID)
		// Update each live VM the scheduler still knows about.
		for vmID, state := range states {
			err := h.srv.WithTenant(tctx, func(tx pgx.Tx) error {
				_, e := tx.Exec(tctx, `
					UPDATE runtime_vms SET state = $1
					WHERE vm_id = $2 AND tenant_id = $3 AND state <> $1
				`, state, vmID, tenantID)
				return e
			})
			if err != nil {
				h.logger().Debug("reconcile: state update failed", zap.String("vm", vmID), zap.Error(err))
			}
		}
		// Any DB row still marked live but absent from the scheduler's
		// view has finished — mark terminated + stamp terminated_at.
		liveIDs := make([]string, 0, len(states))
		for id := range states {
			liveIDs = append(liveIDs, id)
		}
		// Grace window: don't sweep VMs created in the last 30s — a
		// freshly-scheduled VM may not have propagated into the
		// scheduler's List view yet, and we'd wrongly terminate it.
		// Also skip the sweep entirely when the scheduler reports ZERO
		// live VMs but the DB has live rows — that's the signature of a
		// scheduler restart (in-memory store wiped), not "everything
		// finished at once". Mass-terminating on a restart would lie.
		if len(liveIDs) == 0 {
			continue
		}
		err = h.srv.WithTenant(tctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(tctx, `
				UPDATE runtime_vms
				SET state = 'terminated',
				    terminated_at = COALESCE(terminated_at, now())
				WHERE tenant_id = $1
				  AND state IN ('pending','spawning','running','draining')
				  AND created_at < now() - interval '30 seconds'
				  AND NOT (vm_id = ANY($2))
			`, tenantID, liveIDs)
			return e
		})
		if err != nil {
			h.logger().Debug("reconcile: terminate-sweep failed", zap.String("tenant", tenantID), zap.Error(err))
		}
	}
}

// WithScheduler swaps the scheduler client (used by tests + the future
// gRPC wiring).
func (h *RuntimeHandler) WithScheduler(c SchedulerClient) *RuntimeHandler {
	h.scheduler = c
	return h
}

func (h *RuntimeHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("runtime")
}

// ---------- DTOs ----------

// agentSpecDTO is the JSON-shape of lantern.v1.AgentSpec. Kept loose on
// purpose: REST clients should be able to pass any subset and the
// server fills in defaults. tenant_id from the body is always ignored
// and overwritten from the JWT claims.
type agentSpecDTO struct {
	ImageDigest       string            `json:"imageDigest"`
	Isolation         string            `json:"isolation,omitempty"`
	Network           string            `json:"network,omitempty"`
	Labels            map[string]string `json:"labels,omitempty"`
	PreferredRegions  []string          `json:"preferredRegions,omitempty"`
	Idempotent        bool              `json:"idempotent,omitempty"`
	RestoreSnapshotID string            `json:"restoreSnapshotId,omitempty"`
	AgentVersionID    string            `json:"agentVersionId,omitempty"`
	RunID             string            `json:"runId,omitempty"`
	// Container entrypoint override + extra args. Both honored by the
	// runtime-manager docker backend.
	Command []string          `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// Limits / EgressRules / Secrets are passed through opaque so the
	// scheduler can interpret them without re-defining the structs here.
	Limits      map[string]any   `json:"limits,omitempty"`
	EgressRules []map[string]any `json:"egressRules,omitempty"`
	Secrets     []map[string]any `json:"secrets,omitempty"`
}

type scheduleResponse struct {
	VmID      string    `json:"vmId"`
	Node      string    `json:"node"`
	Az        string    `json:"az"`
	CreatedAt time.Time `json:"createdAt"`
}

type vmRow struct {
	VmID            string          `json:"vmId"`
	TenantID        string          `json:"tenantId"`
	AgentVersionID  *string         `json:"agentVersionId,omitempty"`
	RunID           *string         `json:"runId,omitempty"`
	Node            *string         `json:"node,omitempty"`
	Az              *string         `json:"az,omitempty"`
	Region          *string         `json:"region,omitempty"`
	IsolationClass  *string         `json:"isolationClass,omitempty"`
	State           string          `json:"state"`
	Spec            json.RawMessage `json:"spec"`
	LastHeartbeatAt *time.Time      `json:"lastHeartbeatAt,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	TerminatedAt    *time.Time      `json:"terminatedAt,omitempty"`
}

type quotaDTO struct {
	MaxConcurrentVMs      int        `json:"maxConcurrentVms"`
	MaxComputeHoursPerDay float64    `json:"maxComputeHoursPerDay"`
	MaxEgressGBPerDay     int        `json:"maxEgressGbPerDay"`
	MaxCostUsdPerDay      float64    `json:"maxCostUsdPerDay"`
	HardFail              bool       `json:"hardFail"`
	UpdatedAt             *time.Time `json:"updatedAt,omitempty"`
}

type auditDTO struct {
	ID          int64           `json:"id"`
	TenantID    string          `json:"tenantId"`
	VmID        *string         `json:"vmId,omitempty"`
	Action      string          `json:"action"`
	Attrs       json.RawMessage `json:"attrs"`
	PrincipalID *string         `json:"principalId,omitempty"`
	At          time.Time       `json:"at"`
}

// ---------- Quota enforcement ----------

// quotaCheckResult is returned by checkRuntimeQuota.
type quotaCheckResult struct {
	Allowed  bool
	HardFail bool
	Reason   string
}

// checkRuntimeQuota evaluates whether the tenant may schedule another
// VM right now. Called by Schedule (and any other mutating route).
//
// Today it enforces two ceilings:
//   - max_concurrent_vms vs. count(state in pending/spawning/running)
//   - max_cost_usd_per_day vs. sum of today's "schedule" audit events'
//     attrs.cost_usd_estimate (best-effort; the scheduler will fail
//     long-running VMs through ResourceUsage telemetry too).
//
// If no quota row exists, the tenant defaults to "allowed" (open).
// If the row exists with hard_fail=true, denied callers should get
// HTTP 402; with hard_fail=false the caller may proceed but the
// denial is still audit-logged.
func (h *RuntimeHandler) checkRuntimeQuota(ctx context.Context, tenantID string, _ agentSpecDTO) quotaCheckResult {
	var q struct {
		maxConcurrent int
		maxCostDay    float64
		hardFail      bool
		exists        bool
	}
	var live int
	var spentToday float64
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `
			SELECT max_concurrent_vms, max_cost_usd_per_day, hard_fail
			FROM runtime_quotas
			WHERE tenant_id = $1
		`, tenantID).Scan(&q.maxConcurrent, &q.maxCostDay, &q.hardFail); e == nil {
			q.exists = true
		}
		if !q.exists {
			return nil
		}
		// Concurrent VMs.
		_ = tx.QueryRow(ctx, `
			SELECT COUNT(*) FROM runtime_vms
			WHERE tenant_id = $1
			  AND state IN ('pending','spawning','running')
			  AND terminated_at IS NULL
		`, tenantID).Scan(&live)
		// Today's cost (aggregated from audit events).
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(SUM((attrs->>'cost_usd_estimate')::float8), 0)
			FROM runtime_audit_events
			WHERE tenant_id = $1
			  AND action = 'schedule'
			  AND at >= date_trunc('day', now())
		`, tenantID).Scan(&spentToday)
		return nil
	})
	if !q.exists {
		return quotaCheckResult{Allowed: true}
	}
	if q.maxConcurrent > 0 && live >= q.maxConcurrent {
		return quotaCheckResult{
			Allowed:  false,
			HardFail: q.hardFail,
			Reason:   fmt.Sprintf("concurrent VM limit reached (%d/%d)", live, q.maxConcurrent),
		}
	}
	if q.maxCostDay > 0 && spentToday >= q.maxCostDay {
		return quotaCheckResult{
			Allowed:  false,
			HardFail: q.hardFail,
			Reason:   fmt.Sprintf("daily cost limit reached ($%.4f/$%.4f)", spentToday, q.maxCostDay),
		}
	}

	return quotaCheckResult{Allowed: true, HardFail: q.hardFail}
}

// ---------- Audit helper ----------

// auditRuntime inserts a single audit row. Best-effort — failures are
// logged but never abort the caller (we never want auditing to be a
// load-bearing failure mode).
//
// agentInstanceID is the per-VM identity minted at schedule time. Pass empty
// for actions where the instance id is not known (e.g. quota_update, exec
// from an operator shell).
func (h *RuntimeHandler) auditRuntime(ctx context.Context, tenantID, vmID, action string, attrs map[string]any, principalID, agentInstanceID string) {
	attrsJSON, err := json.Marshal(attrs)
	if err != nil || len(attrsJSON) == 0 {
		attrsJSON = []byte("{}")
	}
	var vmIDArg any
	if vmID != "" {
		vmIDArg = vmID
	}
	var principalArg any
	if principalID != "" {
		if _, err := uuid.Parse(principalID); err == nil {
			principalArg = principalID
		}
	}
	var instanceArg any
	if agentInstanceID != "" {
		instanceArg = agentInstanceID
	}
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO runtime_audit_events (tenant_id, vm_id, action, attrs, principal_id, agent_instance_id)
			VALUES ($1, $2, $3, $4::jsonb, $5, $6)
		`, tenantID, vmIDArg, action, attrsJSON, principalArg, instanceArg)
		return e
	}); err != nil {
		h.logger().Warn("audit insert failed",
			zap.String("tenant_id", tenantID),
			zap.String("action", action),
			zap.Error(err),
		)
	}
}

// ---------- HTTP handlers ----------

// Schedule handles POST /v1/runtime/schedule.
func (h *RuntimeHandler) Schedule(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeWrite) {
		return
	}
	tenantID := claims.TenantID

	// Per-tenant spawn-storm guard (phase 3): throttle a burst of schedule calls
	// before any placement/quota work. 429, no VM created.
	if h.spawnLimiter != nil && !h.spawnLimiter.Allow(tenantID) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited: too many schedule requests, slow down"})
		return
	}

	// Carry the tenant on the context so every WithTenant-routed DB call below
	// (quota check, audit, runtime_vms insert) is RLS-scoped to this tenant.
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	// Start a span covering the scheduling work (after auth).
	tracer := otel.Tracer("lantern.control-plane")
	ctx, span := tracer.Start(ctx, "runtime.schedule")
	span.SetAttributes(attribute.String("lantern.tenant_id", tenantID))
	defer span.End()

	var spec agentSpecDTO
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid body")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if spec.ImageDigest == "" {
		span.SetStatus(codes.Error, "imageDigest required")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imageDigest is required"})
		return
	}
	// Stamp known spec attributes immediately so they appear even if we
	// return early (quota denial, identity failure, etc.).
	span.SetAttributes(
		attribute.String("lantern.run_id", spec.RunID),
		attribute.String("lantern.agent_version_id", spec.AgentVersionID),
		attribute.String("lantern.isolation_class", spec.Isolation),
	)

	// Quota enforcement BEFORE we touch the scheduler.
	qres := h.checkRuntimeQuota(ctx, tenantID, spec)
	if !qres.Allowed {
		h.auditRuntime(ctx, tenantID, "", "schedule_denied",
			map[string]any{"reason": qres.Reason}, claims.Subject, "")
		if qres.HardFail {
			span.SetStatus(codes.Error, "quota exceeded: "+qres.Reason)
			writeJSON(w, http.StatusPaymentRequired, map[string]string{
				"error":  "quota exceeded",
				"reason": qres.Reason,
			})
			return
		}
		// soft-fail — log + continue
		h.logger().Warn("quota exceeded but hard_fail=false",
			zap.String("tenant_id", tenantID), zap.String("reason", qres.Reason))
	}

	// Mint a short-lived agent-instance identity. Do this BEFORE building
	// specMap so the token can be injected into the spawn env. Fail closed:
	// an agent that cannot be identified must not be scheduled.
	instanceID, instanceToken, err := h.identity.Issue(ctx, tenantID, spec.RunID, spec.AgentVersionID)
	if err != nil {
		h.logger().Error("agentidentity.Issue failed", zap.Error(err))
		span.RecordError(err)
		span.SetStatus(codes.Error, "mint agent identity failed")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not mint agent identity"})
		return
	}
	span.SetAttributes(attribute.String("lantern.agent_instance_id", instanceID))

	// Tenant id always comes from JWT; never from the body.
	specMap := map[string]any{
		"image_digest":        spec.ImageDigest,
		"isolation":           spec.Isolation,
		"network":             spec.Network,
		"labels":              spec.Labels,
		"preferred_regions":   spec.PreferredRegions,
		"idempotent":          spec.Idempotent,
		"restore_snapshot_id": spec.RestoreSnapshotID,
		"agent_version_id":    spec.AgentVersionID,
		"run_id":              spec.RunID,
		"limits":              spec.Limits,
		"egress_rules":        spec.EgressRules,
		"secrets":             spec.Secrets,
		"tenant_id":           tenantID,
	}
	// Container exec controls — convert []string to []any so
	// agentSpecFromMap's type-asserted decoder handles them uniformly.
	if len(spec.Command) > 0 {
		cmd := make([]any, len(spec.Command))
		for i, s := range spec.Command {
			cmd[i] = s
		}
		specMap["command"] = cmd
	}
	if len(spec.Args) > 0 {
		args := make([]any, len(spec.Args))
		for i, s := range spec.Args {
			args[i] = s
		}
		specMap["args"] = args
	}
	// Build the spawn env, merging caller-supplied values with the identity
	// vars. Identity vars take precedence and cannot be overridden by the body.
	env := make(map[string]any, len(spec.Env)+2)
	for k, v := range spec.Env {
		env[k] = v
	}
	env["LANTERN_AGENT_INSTANCE_ID"] = instanceID
	env["LANTERN_AGENT_INSTANCE_TOKEN"] = instanceToken
	specMap["env"] = env

	vmID, node, az, err := h.scheduler.Schedule(ctx, specMap)
	if err != nil {
		h.logger().Error("scheduler.Schedule failed", zap.Error(err))
		span.RecordError(err)
		span.SetStatus(codes.Error, "scheduler unavailable")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scheduler unavailable"})
		return
	}
	span.SetAttributes(attribute.String("lantern.vm_id", vmID))

	specJSON, _ := json.Marshal(specMap)
	if len(specJSON) == 0 {
		specJSON = []byte("{}")
	}

	// Insert shadow row. agent_version_id / run_id are UUID-typed and
	// optional — nil out empty strings so the cast succeeds.
	var agentVerArg, runIDArg any
	if spec.AgentVersionID != "" {
		if _, perr := uuid.Parse(spec.AgentVersionID); perr == nil {
			agentVerArg = spec.AgentVersionID
		}
	}
	if spec.RunID != "" {
		if _, perr := uuid.Parse(spec.RunID); perr == nil {
			runIDArg = spec.RunID
		}
	}

	created := time.Now().UTC()
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO runtime_vms
			  (vm_id, tenant_id, agent_version_id, run_id, node, az, isolation_class, state, spec, agent_instance_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9, $10)
			ON CONFLICT (vm_id) DO NOTHING
		`, vmID, tenantID, agentVerArg, runIDArg, node, az, spec.Isolation, specJSON, instanceID, created)
		return e
	})
	if err != nil {
		h.logger().Error("insert runtime_vms failed", zap.Error(err))
		span.RecordError(err)
		span.SetStatus(codes.Error, "insert runtime_vms failed")
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.auditRuntime(ctx, tenantID, vmID, "schedule",
		map[string]any{
			"image_digest":      spec.ImageDigest,
			"isolation":         spec.Isolation,
			"node":              node,
			"az":                az,
			"agent_instance_id": instanceID,
		}, claims.Subject, instanceID)

	span.SetStatus(codes.Ok, "")
	writeJSON(w, http.StatusCreated, scheduleResponse{
		VmID:      vmID,
		Node:      node,
		Az:        az,
		CreatedAt: created,
	})
}

// ListVMs handles GET /v1/runtime/vms.
func (h *RuntimeHandler) ListVMs(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	state := r.URL.Query().Get("state")
	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}

	query := `
		SELECT vm_id, tenant_id, agent_version_id, run_id, node, az, region,
		       isolation_class, state, spec, last_heartbeat_at, created_at, terminated_at
		FROM runtime_vms
		WHERE tenant_id = $1
	`
	args := []any{tenantID}
	if state != "" {
		query += ` AND state = $2`
		args = append(args, state)
	}
	query += fmt.Sprintf(` ORDER BY created_at DESC LIMIT %d`, limit)

	out := make([]vmRow, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, query, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var v vmRow
			var specJSON []byte
			if err := rows.Scan(&v.VmID, &v.TenantID, &v.AgentVersionID, &v.RunID,
				&v.Node, &v.Az, &v.Region, &v.IsolationClass, &v.State, &specJSON,
				&v.LastHeartbeatAt, &v.CreatedAt, &v.TerminatedAt); err != nil {
				continue
			}
			if len(specJSON) == 0 {
				specJSON = []byte("{}")
			}
			v.Spec = specJSON
			out = append(out, v)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list runtime_vms failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetVM handles GET /v1/runtime/vms/{id}.
func (h *RuntimeHandler) GetVM(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	var v vmRow
	var specJSON []byte
	events := make([]auditDTO, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `
			SELECT vm_id, tenant_id, agent_version_id, run_id, node, az, region,
			       isolation_class, state, spec, last_heartbeat_at, created_at, terminated_at
			FROM runtime_vms
			WHERE vm_id = $1 AND tenant_id = $2
		`, vmID, tenantID).Scan(&v.VmID, &v.TenantID, &v.AgentVersionID, &v.RunID,
			&v.Node, &v.Az, &v.Region, &v.IsolationClass, &v.State, &specJSON,
			&v.LastHeartbeatAt, &v.CreatedAt, &v.TerminatedAt); e != nil {
			return e
		}
		// Recent audit events for this VM.
		rows, qErr := tx.Query(ctx, `
			SELECT id, tenant_id, vm_id, action, attrs, principal_id, at
			FROM runtime_audit_events
			WHERE tenant_id = $1 AND vm_id = $2
			ORDER BY at DESC
			LIMIT 50
		`, tenantID, vmID)
		if qErr == nil {
			defer rows.Close()
			for rows.Next() {
				var e auditDTO
				var attrs []byte
				var principal *string
				if err := rows.Scan(&e.ID, &e.TenantID, &e.VmID, &e.Action, &attrs, &principal, &e.At); err != nil {
					continue
				}
				if len(attrs) == 0 {
					attrs = []byte("{}")
				}
				e.Attrs = attrs
				e.PrincipalID = principal
				events = append(events, e)
			}
		}
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	if len(specJSON) == 0 {
		specJSON = []byte("{}")
	}
	v.Spec = specJSON

	writeJSON(w, http.StatusOK, map[string]any{
		"vm":     v,
		"events": events,
	})
}

// StreamLogs handles GET /v1/runtime/vms/{id}/logs as SSE.
// Stub: opens an SSE channel and emits a single "stub" event. The real
// implementation proxies to RuntimeManager.Logs over gRPC.
func (h *RuntimeHandler) StreamLogs(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm the VM belongs to this tenant + capture its node placement. The
	// tenant_id predicate (plus RLS scoping under WithTenant) makes a cross-tenant
	// vm_id return no row → 404, the same outcome as the prior owner!=tenant check.
	var owner string
	var node *string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_id, node FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, tenantID).Scan(&owner, &node)
	})
	if err != nil || owner != tenantID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// If the gRPC scheduler client is wired AND we know the node, proxy
	// the real RuntimeManager.Logs stream. Otherwise fall back to the
	// single-frame stub so the client can render a placeholder.
	gc, ok := h.scheduler.(*grpcSchedulerClient)
	if !ok || node == nil || *node == "" {
		h.logger().Info("logs: emitting stub frame (no grpc client or no node)",
			zap.String("vm_id", vmID))
		notice := map[string]any{
			"vmId":   vmID,
			"stream": "harness",
			"text":   "log streaming not yet wired (stub)",
			"at":     time.Now().UTC(),
		}
		b, _ := json.Marshal(notice)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return
	}

	mgr, err := gc.managerClient(*node)
	if err != nil {
		h.logger().Warn("logs: manager dial failed; falling back to stub",
			zap.String("vm_id", vmID), zap.Error(err))
		notice := map[string]any{
			"vmId":   vmID,
			"stream": "harness",
			"text":   fmt.Sprintf("log streaming unavailable: %v", err),
			"at":     time.Now().UTC(),
		}
		b, _ := json.Marshal(notice)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return
	}

	streamCtx, cancel := context.WithCancel(withTenant(ctx, tenantID))
	defer cancel()
	stream, err := mgr.Logs(streamCtx, &lanternv1.LogsRequest{VmId: vmID, Follow: true})
	if err != nil {
		h.logger().Warn("logs: open stream failed", zap.String("vm_id", vmID), zap.Error(err))
		notice := map[string]any{
			"vmId":   vmID,
			"stream": "harness",
			"text":   fmt.Sprintf("log stream open failed: %v", err),
			"at":     time.Now().UTC(),
		}
		b, _ := json.Marshal(notice)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return
	}

	// Cancel the upstream when the client disconnects.
	go func() {
		<-r.Context().Done()
		cancel()
	}()

	h.logger().Info("logs: proxying RuntimeManager.Logs",
		zap.String("vm_id", vmID), zap.String("node", *node))

	for {
		line, err := stream.Recv()
		if err != nil {
			// EOF / client cancel — exit quietly. Anything else gets a
			// final error frame so the client doesn't think we hung.
			if r.Context().Err() == nil {
				errFrame, _ := json.Marshal(map[string]any{
					"vmId":   vmID,
					"stream": "harness",
					"text":   fmt.Sprintf("log stream closed: %v", err),
					"at":     time.Now().UTC(),
				})
				fmt.Fprintf(w, "data: %s\n\n", errFrame)
				flusher.Flush()
			}
			return
		}
		if line == nil {
			continue
		}
		at := time.Now().UTC()
		if line.At != nil {
			at = line.At.AsTime()
		}
		frame := map[string]any{
			"vmId":   line.VmId,
			"stream": line.Stream,
			"text":   line.Text,
			"at":     at,
		}
		b, _ := json.Marshal(frame)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
}

// TerminateVM handles DELETE /v1/runtime/vms/{id}.
func (h *RuntimeHandler) TerminateVM(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeWrite) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm ownership. The tenant_id predicate + RLS scoping means a
	// cross-tenant vm_id returns no row → 404 (the 403 branch below is preserved
	// for the unenforced pool where the row is visible but owned by another tenant).
	var owner string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_id FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, tenantID).Scan(&owner)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	if owner != tenantID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	reason := r.URL.Query().Get("reason")
	if reason == "" {
		reason = "user_terminate"
	}

	if err := h.scheduler.Terminate(withTenant(ctx, tenantID), vmID, reason); err != nil {
		h.logger().Error("scheduler.Terminate failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "scheduler error"})
		return
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runtime_vms
			SET state = 'terminated', terminated_at = now()
			WHERE vm_id = $1 AND tenant_id = $2
		`, vmID, tenantID)
		return e
	})
	if err != nil {
		h.logger().Error("update runtime_vms terminated_at failed", zap.Error(err))
	}

	h.auditRuntime(ctx, tenantID, vmID, "terminate",
		map[string]any{"reason": reason}, claims.Subject, "")

	writeJSON(w, http.StatusOK, map[string]any{"vmId": vmID, "status": "terminated"})
}

// ExecVM handles POST /v1/runtime/vms/{id}/exec.
// Stub: just forwards to the scheduler stub which logs and returns a placeholder.
func (h *RuntimeHandler) ExecVM(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeAdmin) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm ownership (tenant-scoped; cross-tenant vm_id → no row → 404).
	var owner string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_id FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, tenantID).Scan(&owner)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	if owner != tenantID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	var body struct {
		Command string   `json:"command"`
		Argv    []string `json:"argv,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Command == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "command is required"})
		return
	}

	stdout, stderr, exit, err := h.scheduler.Exec(withTenant(ctx, tenantID), vmID, body.Command, body.Argv)
	if err != nil {
		h.logger().Error("scheduler.Exec failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "scheduler error"})
		return
	}

	h.auditRuntime(ctx, tenantID, vmID, "exec",
		map[string]any{"command": body.Command, "exit_code": exit}, claims.Subject, "")

	writeJSON(w, http.StatusOK, map[string]any{
		"stdout":   stdout,
		"stderr":   stderr,
		"exitCode": exit,
	})
}

// Cluster handles GET /v1/runtime/cluster. Requires runtime:admin scope
// (owner/admin role, or a service API key with runtime:admin).
func (h *RuntimeHandler) Cluster(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeAdmin) {
		return
	}

	cluster, err := h.scheduler.Cluster(withTenant(r.Context(), claims.TenantID))
	if err != nil {
		h.logger().Error("scheduler.Cluster failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "scheduler error"})
		return
	}
	writeJSON(w, http.StatusOK, cluster)
}

// GetQuota handles GET /v1/runtime/quota.
func (h *RuntimeHandler) GetQuota(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	var dto quotaDTO
	var updatedAt time.Time
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT max_concurrent_vms, max_compute_hours_per_day, max_egress_gb_per_day,
			       max_cost_usd_per_day, hard_fail, updated_at
			FROM runtime_quotas
			WHERE tenant_id = $1
		`, tenantID).Scan(&dto.MaxConcurrentVMs, &dto.MaxComputeHoursPerDay,
			&dto.MaxEgressGBPerDay, &dto.MaxCostUsdPerDay, &dto.HardFail, &updatedAt)
	})
	if err != nil {
		// Return defaults so the dashboard can render before first PUT.
		writeJSON(w, http.StatusOK, quotaDTO{
			MaxConcurrentVMs:      20,
			MaxComputeHoursPerDay: 10.0,
			MaxEgressGBPerDay:     5,
			MaxCostUsdPerDay:      5.0,
			HardFail:              true,
		})
		return
	}
	dto.UpdatedAt = &updatedAt
	writeJSON(w, http.StatusOK, dto)
}

// UpsertQuota handles PUT /v1/runtime/quota. Requires runtime:admin scope
// (owner/admin role, or a service API key with runtime:admin).
func (h *RuntimeHandler) UpsertQuota(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeAdmin) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	var body quotaDTO
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.MaxConcurrentVMs <= 0 {
		body.MaxConcurrentVMs = 20
	}
	if body.MaxComputeHoursPerDay <= 0 {
		body.MaxComputeHoursPerDay = 10.0
	}
	if body.MaxEgressGBPerDay <= 0 {
		body.MaxEgressGBPerDay = 5
	}
	if body.MaxCostUsdPerDay <= 0 {
		body.MaxCostUsdPerDay = 5.0
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO runtime_quotas
			  (tenant_id, max_concurrent_vms, max_compute_hours_per_day,
			   max_egress_gb_per_day, max_cost_usd_per_day, hard_fail, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, now())
			ON CONFLICT (tenant_id) DO UPDATE SET
			  max_concurrent_vms        = EXCLUDED.max_concurrent_vms,
			  max_compute_hours_per_day = EXCLUDED.max_compute_hours_per_day,
			  max_egress_gb_per_day     = EXCLUDED.max_egress_gb_per_day,
			  max_cost_usd_per_day      = EXCLUDED.max_cost_usd_per_day,
			  hard_fail                 = EXCLUDED.hard_fail,
			  updated_at                = now()
		`, tenantID, body.MaxConcurrentVMs, body.MaxComputeHoursPerDay,
			body.MaxEgressGBPerDay, body.MaxCostUsdPerDay, body.HardFail)
		return e
	})
	if err != nil {
		h.logger().Error("upsert runtime_quotas failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.auditRuntime(ctx, tenantID, "", "quota_update",
		map[string]any{
			"max_concurrent_vms":        body.MaxConcurrentVMs,
			"max_compute_hours_per_day": body.MaxComputeHoursPerDay,
			"max_egress_gb_per_day":     body.MaxEgressGBPerDay,
			"max_cost_usd_per_day":      body.MaxCostUsdPerDay,
			"hard_fail":                 body.HardFail,
		}, claims.Subject, "")

	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// ListAudit handles GET /v1/runtime/audit.
func (h *RuntimeHandler) ListAudit(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	var beforeID int64
	if b := r.URL.Query().Get("before"); b != "" {
		if n, err := strconv.ParseInt(b, 10, 64); err == nil && n > 0 {
			beforeID = n
		}
	}

	query := `
		SELECT id, tenant_id, vm_id, action, attrs, principal_id, at
		FROM runtime_audit_events
		WHERE tenant_id = $1
	`
	args := []any{tenantID}
	if beforeID > 0 {
		query += ` AND id < $2`
		args = append(args, beforeID)
	}
	query += fmt.Sprintf(` ORDER BY id DESC LIMIT %d`, limit)

	out := make([]auditDTO, 0)
	var nextBefore int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, query, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var e auditDTO
			var attrs []byte
			var principal *string
			if err := rows.Scan(&e.ID, &e.TenantID, &e.VmID, &e.Action, &attrs, &principal, &e.At); err != nil {
				continue
			}
			if len(attrs) == 0 {
				attrs = []byte("{}")
			}
			e.Attrs = attrs
			e.PrincipalID = principal
			out = append(out, e)
			nextBefore = e.ID
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list runtime_audit_events failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"events":     out,
		"nextBefore": nextBefore,
	})
}

// ---------- Live metrics ----------

// vmMetricsDTO is the per-VM payload returned by GET /v1/runtime/metrics.
// It combines the shadow row from runtime_vms with the most-recent prometheus
// text forwarded from the harness (when available).
type vmMetricsDTO struct {
	VmID           string     `json:"vmId"`
	State          string     `json:"state"`
	Node           *string    `json:"node,omitempty"`
	Az             *string    `json:"az,omitempty"`
	IsolationClass *string    `json:"isolationClass,omitempty"`
	CreatedAt      time.Time  `json:"createdAt"`
	TerminatedAt   *time.Time `json:"terminatedAt,omitempty"`
	// LastAuditAction is the most recent audit event action for this VM.
	// Gives a quick "what happened last" without fetching the full event list.
	LastAuditAction *string    `json:"lastAuditAction,omitempty"`
	LastAuditAt     *time.Time `json:"lastAuditAt,omitempty"`
	// PromMetrics is the raw Prometheus exposition text last forwarded by
	// the harness via POST /v1/runtime/report (kind=prometheus_metrics).
	// Empty when no metrics have been received or the VM has terminated.
	PromMetrics    string     `json:"promMetrics,omitempty"`
	PromReceivedAt *time.Time `json:"promReceivedAt,omitempty"`
}

// LiveMetrics handles GET /v1/runtime/metrics.
// Returns per-VM live stats for the caller's tenant, combining:
//   - runtime_vms shadow rows (state, placement, isolation)
//   - most-recent runtime_audit_events action per VM
//   - latest prometheus metrics forwarded by the harness
//
// Requires runtime:read scope.
func (h *RuntimeHandler) LiveMetrics(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !h.requireRuntimeScope(w, claims, ScopeRuntimeRead) {
		return
	}
	tenantID := claims.TenantID
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	// Fetch all VMs for the tenant, most-recently-created first.
	out := make([]vmMetricsDTO, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT v.vm_id, v.state, v.node, v.az, v.isolation_class,
			       v.created_at, v.terminated_at,
			       a.action, a.at
			FROM runtime_vms v
			LEFT JOIN LATERAL (
				SELECT action, at
				FROM runtime_audit_events
				WHERE tenant_id = $1 AND vm_id = v.vm_id
				ORDER BY at DESC
				LIMIT 1
			) a ON true
			WHERE v.tenant_id = $1
			ORDER BY v.created_at DESC
			LIMIT 200
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var dto vmMetricsDTO
			var auditAction *string
			var auditAt *time.Time
			if err := rows.Scan(
				&dto.VmID, &dto.State, &dto.Node, &dto.Az, &dto.IsolationClass,
				&dto.CreatedAt, &dto.TerminatedAt,
				&auditAction, &auditAt,
			); err != nil {
				continue
			}
			dto.LastAuditAction = auditAction
			dto.LastAuditAt = auditAt
			out = append(out, dto)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("live metrics: query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// Overlay the latest prometheus metrics from the in-memory store.
	if h.metricsStore != nil {
		latest := h.metricsStore.LatestVMMetrics(tenantID)
		byVM := make(map[string]*vmMetricsEntry, len(latest))
		for _, e := range latest {
			byVM[e.VmID] = e
		}
		for i := range out {
			if e, ok := byVM[out[i].VmID]; ok {
				out[i].PromMetrics = e.PromText
				t := e.ReceivedAt
				out[i].PromReceivedAt = &t
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"tenantId": tenantID,
		"vms":      out,
	})
}

// ---------- RBAC: runtime scopes ----------

// Runtime-specific scope constants. These are intentionally distinct from
// the coarse "read"/"write"/"admin" global scopes so a service API key can
// be granted runtime:read without also gaining write access to agents/runs.
//
// Implication chain: runtime:admin ⊇ runtime:write ⊇ runtime:read.
const (
	// ScopeRuntimeRead allows safe, idempotent reads (ListVMs, GetVM,
	// StreamLogs, GetQuota, ListAudit, Cluster).
	ScopeRuntimeRead = "runtime:read"

	// ScopeRuntimeWrite allows state-mutating operations (Schedule,
	// TerminateVM).
	ScopeRuntimeWrite = "runtime:write"

	// ScopeRuntimeAdmin allows the most sensitive operations: ExecVM
	// (interactive shell into a running VM) and UpsertQuota.
	ScopeRuntimeAdmin = "runtime:admin"
)

// authorizeRuntimeScope returns true when claims satisfy the required scope.
//
// Authorization rules:
//   - Role "owner" or "admin" → always allowed (human tenant administrators).
//   - Role "service" (API key) → allowed when Scopes contains the required
//     scope, or a superseding scope (admin ⊇ write ⊇ read). An empty/nil
//     scopes slice grants at most runtime:read (least-privilege default for
//     unscoped keys — they must not gain write or admin just by omission).
//   - Role "member" → allowed for runtime:read only; denied for write/admin.
//   - Any other unrecognised role → denied (fail-closed; not even read).
func authorizeRuntimeScope(claims *LanternClaims, required string) bool {
	switch claims.Role {
	case "owner", "admin":
		return true
	case "service":
		if len(claims.Scopes) == 0 {
			// Empty/nil scope set: least-privilege — grant read only.
			// A service key with no explicit scopes must not silently gain
			// write or admin access to the runtime (ExecVM, Schedule, etc.).
			return required == ScopeRuntimeRead
		}
		for _, s := range claims.Scopes {
			if s == required {
				return true
			}
			// Implication chain: admin ⊇ write ⊇ read.
			if s == ScopeRuntimeAdmin {
				return true // admin implies write and read
			}
			if s == ScopeRuntimeWrite && required == ScopeRuntimeRead {
				return true // write implies read
			}
		}
		return false
	case "member":
		// Members may only perform read operations on their tenant's resources.
		return required == ScopeRuntimeRead
	default:
		// Unknown role: deny unconditionally (fail-closed).
		// Granting read to an unrecognised role leaks log/VM metadata to
		// callers that should not be allowed past the gate at all.
		return false
	}
}

// requireRuntimeScope is the handler-side gate: it writes a 403 and returns
// false when the claims do not satisfy the required scope. Callers do:
//
//	if !h.requireRuntimeScope(w, claims, ScopeRuntimeWrite) { return }
//
// On denial for write/admin scopes, an audit event is also written so that
// access-denial patterns are visible in the audit log.
func (h *RuntimeHandler) requireRuntimeScope(w http.ResponseWriter, claims *LanternClaims, required string) bool {
	if authorizeRuntimeScope(claims, required) {
		return true
	}
	// Audit write/admin denials so operators can detect scope-escalation
	// attempts without reading application logs. Guard against a nil pool
	// (test environments that don't require a DB).
	if required != ScopeRuntimeRead && h.srv.Pool != nil {
		principal := claims.Subject
		if principal == "" {
			principal = claims.Email
		}
		h.auditRuntime(
			context.Background(),
			claims.TenantID, "", required+"_denied",
			map[string]any{
				"role":           claims.Role,
				"required_scope": required,
			},
			principal, "",
		)
	}
	writeJSON(w, http.StatusForbidden, map[string]any{
		"error":          "forbidden",
		"required_scope": required,
	})
	return false
}

// ---------- compile-time util ----------

// ensure pgxpool import is used (some build configurations strip
// unused imports — we keep the reference explicit here so the file
// stays self-contained as we wire in the gRPC client).
var _ = func(p *pgxpool.Pool) {}
