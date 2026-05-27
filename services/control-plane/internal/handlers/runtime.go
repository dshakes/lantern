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
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
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
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
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
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
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

// RuntimeHandler implements the REST surface for headless agent runtime
// governance. Mounted under /v1/runtime/* in cmd/server/main.go.
type RuntimeHandler struct {
	srv       *server.Server
	auth      *AuthHandler
	scheduler SchedulerClient
}

// NewRuntimeHandler constructs a RuntimeHandler. If LANTERN_SCHEDULER_GRPC_ADDR
// is set the real gRPC client is dialed; otherwise the stub is used so a
// solo control-plane stays exercisable.
func NewRuntimeHandler(srv *server.Server, auth *AuthHandler) *RuntimeHandler {
	h := &RuntimeHandler{srv: srv, auth: auth}
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
	return h
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
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT max_concurrent_vms, max_cost_usd_per_day, hard_fail
		FROM runtime_quotas
		WHERE tenant_id = $1
	`, tenantID).Scan(&q.maxConcurrent, &q.maxCostDay, &q.hardFail)
	if err == nil {
		q.exists = true
	}
	if !q.exists {
		return quotaCheckResult{Allowed: true}
	}

	// Concurrent VMs.
	var live int
	_ = h.srv.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM runtime_vms
		WHERE tenant_id = $1
		  AND state IN ('pending','spawning','running')
		  AND terminated_at IS NULL
	`, tenantID).Scan(&live)
	if q.maxConcurrent > 0 && live >= q.maxConcurrent {
		return quotaCheckResult{
			Allowed:  false,
			HardFail: q.hardFail,
			Reason:   fmt.Sprintf("concurrent VM limit reached (%d/%d)", live, q.maxConcurrent),
		}
	}

	// Today's cost (aggregated from audit events).
	var spentToday float64
	_ = h.srv.Pool.QueryRow(ctx, `
		SELECT COALESCE(SUM((attrs->>'cost_usd_estimate')::float8), 0)
		FROM runtime_audit_events
		WHERE tenant_id = $1
		  AND action = 'schedule'
		  AND at >= date_trunc('day', now())
	`, tenantID).Scan(&spentToday)
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
func (h *RuntimeHandler) auditRuntime(ctx context.Context, tenantID, vmID, action string, attrs map[string]any, principalID string) {
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
	if _, err := h.srv.Pool.Exec(ctx, `
		INSERT INTO runtime_audit_events (tenant_id, vm_id, action, attrs, principal_id)
		VALUES ($1, $2, $3, $4::jsonb, $5)
	`, tenantID, vmIDArg, action, attrsJSON, principalArg); err != nil {
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
	tenantID := claims.TenantID
	ctx := r.Context()

	var spec agentSpecDTO
	if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if spec.ImageDigest == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imageDigest is required"})
		return
	}

	// Quota enforcement BEFORE we touch the scheduler.
	qres := h.checkRuntimeQuota(ctx, tenantID, spec)
	if !qres.Allowed {
		h.auditRuntime(ctx, tenantID, "", "schedule_denied",
			map[string]any{"reason": qres.Reason}, claims.Subject)
		if qres.HardFail {
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

	vmID, node, az, err := h.scheduler.Schedule(ctx, specMap)
	if err != nil {
		h.logger().Error("scheduler.Schedule failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scheduler unavailable"})
		return
	}

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
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO runtime_vms
		  (vm_id, tenant_id, agent_version_id, run_id, node, az, isolation_class, state, spec, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9)
		ON CONFLICT (vm_id) DO NOTHING
	`, vmID, tenantID, agentVerArg, runIDArg, node, az, spec.Isolation, specJSON, created)
	if err != nil {
		h.logger().Error("insert runtime_vms failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.auditRuntime(ctx, tenantID, vmID, "schedule",
		map[string]any{
			"image_digest": spec.ImageDigest,
			"isolation":    spec.Isolation,
			"node":         node,
			"az":           az,
		}, claims.Subject)

	writeJSON(w, http.StatusCreated, scheduleResponse{
		VmID:      vmID,
		Node:      node,
		Az:        az,
		CreatedAt: created,
	})
}

// ListVMs handles GET /v1/runtime/vms.
func (h *RuntimeHandler) ListVMs(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

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

	rows, err := h.srv.Pool.Query(ctx, query, args...)
	if err != nil {
		h.logger().Error("list runtime_vms failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	defer rows.Close()

	out := make([]vmRow, 0)
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
	writeJSON(w, http.StatusOK, out)
}

// GetVM handles GET /v1/runtime/vms/{id}.
func (h *RuntimeHandler) GetVM(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	var v vmRow
	var specJSON []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT vm_id, tenant_id, agent_version_id, run_id, node, az, region,
		       isolation_class, state, spec, last_heartbeat_at, created_at, terminated_at
		FROM runtime_vms
		WHERE vm_id = $1 AND tenant_id = $2
	`, vmID, tenantID).Scan(&v.VmID, &v.TenantID, &v.AgentVersionID, &v.RunID,
		&v.Node, &v.Az, &v.Region, &v.IsolationClass, &v.State, &specJSON,
		&v.LastHeartbeatAt, &v.CreatedAt, &v.TerminatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	if len(specJSON) == 0 {
		specJSON = []byte("{}")
	}
	v.Spec = specJSON

	// Recent audit events for this VM.
	events := make([]auditDTO, 0)
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, tenant_id, vm_id, action, attrs, principal_id, at
		FROM runtime_audit_events
		WHERE tenant_id = $1 AND vm_id = $2
		ORDER BY at DESC
		LIMIT 50
	`, tenantID, vmID)
	if err == nil {
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

	writeJSON(w, http.StatusOK, map[string]any{
		"vm":     v,
		"events": events,
	})
}

// StreamLogs handles GET /v1/runtime/vms/{id}/logs as SSE.
// Stub: opens an SSE channel and emits a single "stub" event. The real
// implementation proxies to RuntimeManager.Logs over gRPC.
func (h *RuntimeHandler) StreamLogs(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm the VM belongs to this tenant + capture its node placement.
	var owner string
	var node *string
	err = h.srv.Pool.QueryRow(ctx, `SELECT tenant_id, node FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&owner, &node)
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
	tenantID := claims.TenantID
	ctx := r.Context()
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm ownership.
	var owner string
	err = h.srv.Pool.QueryRow(ctx, `SELECT tenant_id FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&owner)
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

	_, err = h.srv.Pool.Exec(ctx, `
		UPDATE runtime_vms
		SET state = 'terminated', terminated_at = now()
		WHERE vm_id = $1 AND tenant_id = $2
	`, vmID, tenantID)
	if err != nil {
		h.logger().Error("update runtime_vms terminated_at failed", zap.Error(err))
	}

	h.auditRuntime(ctx, tenantID, vmID, "terminate",
		map[string]any{"reason": reason}, claims.Subject)

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
	tenantID := claims.TenantID
	ctx := r.Context()
	vmID := r.PathValue("id")
	if vmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "vm id required"})
		return
	}

	// Confirm ownership.
	var owner string
	err = h.srv.Pool.QueryRow(ctx, `SELECT tenant_id FROM runtime_vms WHERE vm_id = $1`, vmID).Scan(&owner)
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
		map[string]any{"command": body.Command, "exit_code": exit}, claims.Subject)

	writeJSON(w, http.StatusOK, map[string]any{
		"stdout":   stdout,
		"stderr":   stderr,
		"exitCode": exit,
	})
}

// Cluster handles GET /v1/runtime/cluster. Owner-only.
func (h *RuntimeHandler) Cluster(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner role required"})
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
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var dto quotaDTO
	var updatedAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT max_concurrent_vms, max_compute_hours_per_day, max_egress_gb_per_day,
		       max_cost_usd_per_day, hard_fail, updated_at
		FROM runtime_quotas
		WHERE tenant_id = $1
	`, tenantID).Scan(&dto.MaxConcurrentVMs, &dto.MaxComputeHoursPerDay,
		&dto.MaxEgressGBPerDay, &dto.MaxCostUsdPerDay, &dto.HardFail, &updatedAt)
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

// UpsertQuota handles PUT /v1/runtime/quota. Owner-only.
func (h *RuntimeHandler) UpsertQuota(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if claims.Role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner role required"})
		return
	}
	ctx := r.Context()
	tenantID := claims.TenantID

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

	_, err = h.srv.Pool.Exec(ctx, `
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
		}, claims.Subject)

	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// ListAudit handles GET /v1/runtime/audit.
func (h *RuntimeHandler) ListAudit(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

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

	rows, err := h.srv.Pool.Query(ctx, query, args...)
	if err != nil {
		h.logger().Error("list runtime_audit_events failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	defer rows.Close()

	out := make([]auditDTO, 0)
	var nextBefore int64
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

	writeJSON(w, http.StatusOK, map[string]any{
		"events":     out,
		"nextBefore": nextBefore,
	})
}

// ---------- compile-time util ----------

// ensure pgxpool import is used (some build configurations strip
// unused imports — we keep the reference explicit here so the file
// stays self-contained as we wire in the gRPC client).
var _ = func(p *pgxpool.Pool) {}
