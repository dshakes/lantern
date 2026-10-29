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
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
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
	"golang.org/x/sync/singleflight"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/jackc/pgx/v5"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/agentidentity"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- Scheduler client (stubbed, interface-shaped) ----------

// VMStateInfo is the scheduler's view of one VM: its state plus WHY it is in
// that state. The reason matters for terminal states — a spawn refused
// because the node cannot satisfy the requested isolation class used to
// surface as a bare `failed` with no explanation anywhere.
type VMStateInfo struct {
	State  string
	Reason string
}

// SchedulerClient is the thin abstraction the runtime handler talks to.
// The real implementation will dial the RuntimeScheduler gRPC at :50055;
// for now stubSchedulerClient stamps runtime_vms and logs intent so the
// REST surface is exercisable end-to-end.
type SchedulerClient interface {
	Schedule(ctx context.Context, spec map[string]any) (vmID, node, az string, err error)
	Terminate(ctx context.Context, vmID, reason string) error
	// Exec runs a command in a VM. `node` is the VM's scheduled placement
	// (from runtime_vms.node) and selects WHICH runtime-manager to dial —
	// passing "" falls back to the default manager, which is only correct
	// on a single-node deployment.
	Exec(ctx context.Context, node, vmID, command string, argv []string) (stdout, stderr string, exitCode int32, err error)
	Cluster(ctx context.Context) (map[string]any, error)
	// ListStates returns the scheduler's current view of live VM states,
	// keyed by vm_id. Used by the reconciler to write authoritative state
	// back to runtime_vms. Returns an empty map (not an error) when the
	// scheduler has no live VMs.
	ListStates(ctx context.Context, tenantID string) (map[string]VMStateInfo, error)
	// Sandbox lifecycle (runtime_lifecycle.go). Errors carry gRPC status
	// codes: NotFound, FailedPrecondition (wrong state), ResourceExhausted.
	Pause(ctx context.Context, tenantID, vmID string) (snapshotID string, err error)
	Resume(ctx context.Context, tenantID, vmID string) (snapshotID string, err error)
	// Fork spawns len(identities) children, child i carrying identities[i].
	Fork(ctx context.Context, tenantID, vmID string, identities []ForkIdentity) (ForkResult, error)
}

type stubSchedulerClient struct {
	logger *zap.Logger
	// paused tracks stub VMs that are paused (vm_id -> snapshot id) so the
	// stub honours the real state rules: idempotent pause, resume only when
	// paused.
	paused sync.Map
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

func (s *stubSchedulerClient) Exec(_ context.Context, node, vmID, command string, _ []string) (string, string, int32, error) {
	// The stub spawns nothing, so there is nothing to exec into; the real
	// implementation is grpcSchedulerClient.Exec.
	s.logger.Info("stub scheduler: exec",
		zap.String("node", node),
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

func (s *stubSchedulerClient) ListStates(_ context.Context, _ string) (map[string]VMStateInfo, error) {
	// Stub: no scheduler to ask, so the reconciler has nothing to do.
	return map[string]VMStateInfo{}, nil
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
	logger       *zap.Logger
	serviceToken string                           // sent to managers as x-lantern-service-token
	mgrCreds     credentials.TransportCredentials // TLS when LANTERN_RUNTIME_MANAGER_TLS_CA is set
	conn         *grpc.ClientConn
	client       lanternv1.RuntimeSchedulerClient
	defaultMgr   string                      // LANTERN_DEFAULT_MANAGER_ADDR
	mgrMu        sync.Mutex                  // guards mgrConns
	mgrConns     map[string]*grpc.ClientConn // nodeName -> conn
	mgrClients   map[string]lanternv1.RuntimeManagerClient
}

// schedulerTokenCreds attaches the shared service token to every outbound gRPC
// call as x-lantern-service-token metadata, matching the runtime-scheduler's
// UnaryServiceAuthInterceptor expectation. When the token is empty nothing is
// attached (dev pass-through — the startup guard on the scheduler side aborts
// in prod when the token is unset).
type schedulerTokenCreds struct{ token string }

func (c schedulerTokenCreds) GetRequestMetadata(_ context.Context, _ ...string) (map[string]string, error) {
	if c.token == "" {
		return nil, nil
	}
	return map[string]string{"x-lantern-service-token": c.token}, nil
}

// RequireTransportSecurity returns false: the scheduler link is an in-cluster
// hop where TLS terminates at the gateway/service-mesh sidecar.
func (c schedulerTokenCreds) RequireTransportSecurity() bool { return false }

// NewGRPCSchedulerClient dials the scheduler service. serviceToken, when
// non-empty, is attached as x-lantern-service-token on every RPC so the
// scheduler's service-auth interceptor accepts the call. Read it from
// LANTERN_GRPC_SERVICE_TOKEN at the call site.
func NewGRPCSchedulerClient(addr, serviceToken string, logger *zap.Logger) (*grpcSchedulerClient, error) {
	mgrCreds, err := ManagerTransportCreds(IsProd())
	if err != nil {
		return nil, err
	}
	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	}
	if serviceToken != "" {
		opts = append(opts, grpc.WithPerRPCCredentials(schedulerTokenCreds{token: serviceToken}))
	}
	conn, err := grpc.NewClient(addr, opts...)
	if err != nil {
		return nil, fmt.Errorf("dial scheduler %s: %w", addr, err)
	}
	return &grpcSchedulerClient{
		logger:       logger,
		serviceToken: serviceToken,
		mgrCreds:     mgrCreds,
		conn:         conn,
		client:       lanternv1.NewRuntimeSchedulerClient(conn),
		defaultMgr:   os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR"),
		mgrConns:     make(map[string]*grpc.ClientConn),
		mgrClients:   make(map[string]lanternv1.RuntimeManagerClient),
	}, nil
}

// ManagerTransportCreds resolves the transport credentials for dialing a
// runtime-manager. The manager forces mTLS in prod (it verifies client certs
// against its CA), so:
//
//   - LANTERN_RUNTIME_MANAGER_TLS_CA set → TLS, verifying the manager against
//     that CA; LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY (both or neither) add the
//     client certificate.
//   - unset in dev → insecure (plaintext), so `make dev` works.
//   - unset in prod, client cert missing in prod, half-set cert/key, or an
//     unreadable file → error; runStartupGuards treats it as fatal.
func ManagerTransportCreds(isProd bool) (credentials.TransportCredentials, error) {
	caPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_CA"))
	certPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_CERT"))
	keyPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_KEY"))
	if (certPath == "") != (keyPath == "") {
		return nil, fmt.Errorf("runtime-manager client TLS is half-configured: set BOTH LANTERN_RUNTIME_MANAGER_TLS_CERT and LANTERN_RUNTIME_MANAGER_TLS_KEY (or neither)")
	}
	if caPath == "" {
		if isProd {
			return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CA is unset — the runtime-manager requires mTLS in production; set LANTERN_RUNTIME_MANAGER_TLS_CA plus LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY (client cert signed by the manager CA)")
		}
		return insecure.NewCredentials(), nil
	}
	if isProd && certPath == "" {
		return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY are unset — the runtime-manager verifies client certificates in production; set both")
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("read LANTERN_RUNTIME_MANAGER_TLS_CA %s: %w", caPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CA %s contains no PEM certificates", caPath)
	}
	cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if certPath != "" {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load runtime-manager client cert/key (%s, %s): %w", certPath, keyPath, err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return credentials.NewTLS(cfg), nil
}

// ManagerDialOptions returns the dial options every runtime-manager client in
// the control-plane must use: ManagerTransportCreds + the shared service token
// (LANTERN_GRPC_SERVICE_TOKEN), which the manager requires when it is set.
func ManagerDialOptions(serviceToken string) ([]grpc.DialOption, error) {
	creds, err := ManagerTransportCreds(IsProd())
	if err != nil {
		return nil, err
	}
	return []grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		grpc.WithPerRPCCredentials(schedulerTokenCreds{token: serviceToken}),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
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
	creds := c.mgrCreds
	if creds == nil {
		creds = insecure.NewCredentials()
	}
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(creds),
		grpc.WithPerRPCCredentials(schedulerTokenCreds{token: c.serviceToken}),
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
	idemKey, _ := spec["idempotency_key"].(string)
	req := &lanternv1.ScheduleRequest{Spec: agent, IdempotencyKey: idemKey}

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

func (c *grpcSchedulerClient) Exec(ctx context.Context, node, vmID, command string, argv []string) (string, string, int32, error) {
	var stdout, stderr []byte
	exit, truncated, err := c.ExecStream(ctx, node, vmID, command, argv, func(stream string, data []byte) error {
		if stream == "stdout" {
			stdout = append(stdout, data...)
		} else {
			stderr = append(stderr, data...)
		}
		return nil
	})
	if err != nil {
		// Return what we collected alongside the error so a partial
		// failure is still diagnosable.
		return string(stdout), string(stderr), exit, err
	}
	if truncated {
		stderr = append(stderr, execTruncatedNotice...)
	}
	return string(stdout), string(stderr), exit, nil
}

const execTruncatedNotice = "\n[lantern: output truncated at 1 MiB by control-plane cap]\n"

// execStreamer is implemented by schedulers that can deliver exec output
// incrementally (invariant #4). ExecVM uses it for Accept: text/event-stream.
type execStreamer interface {
	// ExecStream calls emit("stdout"|"stderr", chunk) as frames arrive, capping
	// each stream at execMaxOutputBytes in total (excess dropped, truncated=true).
	ExecStream(ctx context.Context, node, vmID, command string, argv []string, emit func(stream string, data []byte) error) (exitCode int32, truncated bool, err error)
}

func (c *grpcSchedulerClient) ExecStream(ctx context.Context, node, vmID, command string, argv []string, emit func(stream string, data []byte) error) (int32, bool, error) {
	// Exec dispatches DIRECTLY to the runtime-manager, mirroring the Logs SSE
	// proxy: the scheduler places workloads, but the manager owns the exec
	// channel into them.
	//
	// Dial the manager on the VM's OWN node — a workload placed on node-B is
	// unreachable from node-A's manager, so a hardcoded default would misroute
	// every exec in a multi-node deployment. resolveManagerAddr falls back to
	// LANTERN_DEFAULT_MANAGER_ADDR when node is "" or has no explicit override,
	// which keeps single-node dev working.
	mgr, err := c.managerClient(node)
	if err != nil {
		return 0, false, err
	}
	stream, err := mgr.Exec(ctx)
	if err != nil {
		return 0, false, fmt.Errorf("open exec stream: %w", err)
	}
	return pumpExec(stream, vmID, command, argv, emit)
}

// execClientStream is the slice of the manager's bidi stream pumpExec needs.
type execClientStream interface {
	Send(*lanternv1.ExecRequest) error
	CloseSend() error
	Recv() (*lanternv1.ExecResponse, error)
}

func pumpExec(stream execClientStream, vmID, command string, argv []string, emit func(string, []byte) error) (int32, bool, error) {
	// The first frame MUST carry vm_id + command. We pipe no stdin, so
	// half-close immediately and just drain the response side.
	if err := stream.Send(&lanternv1.ExecRequest{VmId: vmID, Command: command, Argv: argv}); err != nil {
		return 0, false, fmt.Errorf("send exec request: %w", err)
	}
	if err := stream.CloseSend(); err != nil {
		return 0, false, fmt.Errorf("close exec send: %w", err)
	}

	var sentOut, sentErr int
	truncated := false
	// capped trims chunk to the remaining per-stream budget.
	capped := func(sent *int, chunk []byte) []byte {
		room := execMaxOutputBytes - *sent
		if room < len(chunk) {
			truncated = true
			if room < 0 {
				room = 0
			}
			chunk = chunk[:room]
		}
		*sent += len(chunk)
		return chunk
	}

	var exitCode int32
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return exitCode, truncated, fmt.Errorf("exec stream: %w", err)
		}
		if c := capped(&sentOut, resp.Stdout); len(c) > 0 {
			if err := emit("stdout", c); err != nil {
				return exitCode, truncated, err
			}
		}
		if c := capped(&sentErr, resp.Stderr); len(c) > 0 {
			if err := emit("stderr", c); err != nil {
				return exitCode, truncated, err
			}
		}
		// The manager marks the terminal frame with done=true and the real
		// exit code; frames before it carry only output.
		if resp.Done {
			exitCode = resp.ExitCode
			break
		}
	}
	return exitCode, truncated, nil
}

// execMaxOutputBytes caps how much stdout/stderr a single exec accumulates in
// control-plane memory. Output originates in an untrusted workload (invariant
// #5), so a runaway command must not be able to OOM the control plane; past
// the cap we stop appending and say so in stderr rather than truncating
// silently.
const execMaxOutputBytes = 1 << 20 // 1 MiB per stream

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

func (c *grpcSchedulerClient) ListStates(ctx context.Context, tenantID string) (map[string]VMStateInfo, error) {
	ctx = withTenant(ctx, tenantID)
	resp, err := c.client.List(ctx, &lanternv1.ListRequest{TenantId: tenantID})
	if err != nil {
		return nil, err
	}
	out := make(map[string]VMStateInfo)
	if resp == nil {
		return out, nil
	}
	for _, item := range resp.GetItems() {
		h := item.GetHandle()
		if h == nil || h.GetVmId() == "" {
			continue
		}
		out[h.GetVmId()] = VMStateInfo{
			State:  vmStateString(item.GetState()),
			Reason: item.GetReason(),
		}
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
	case lanternv1.VmState_VM_STATE_PAUSED:
		return "paused"
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
	if b, ok := spec["confidential"].(bool); ok {
		a.Confidential = b
	}
	if v := int64Of(firstOf(spec, "idle_timeout_secs", "idleTimeoutSecs")); v != 0 {
		a.IdleTimeoutSecs = int32(v)
	}
	if lims, ok := spec["limits"].(map[string]any); ok && len(lims) > 0 {
		a.Limits = limitsFromMap(lims)
	}
	for _, r := range mapSlice(spec["egress_rules"]) {
		er := &lanternv1.EgressRule{}
		er.Pattern, _ = r["pattern"].(string)
		for _, m := range anySlice(firstOf(r, "http_methods", "httpMethods")) {
			if s, ok := m.(string); ok {
				er.HttpMethods = append(er.HttpMethods, s)
			}
		}
		er.RateBps = int64Of(firstOf(r, "rate_bps", "rateBps"))
		er.Inject = egressInjectFromMap(r)
		a.EgressRules = append(a.EgressRules, er)
	}
	for _, r := range mapSlice(spec["secrets"]) {
		sr := &lanternv1.SecretRef{}
		sr.EnvName, _ = firstOf(r, "env_name", "envName").(string)
		sr.SecretUri, _ = firstOf(r, "secret_uri", "secretUri").(string)
		a.Secrets = append(a.Secrets, sr)
	}
	// DLP policy — loaded from DB by scheduleAgentSpec and injected as structured
	// keys so the map-based plumbing doesn't need typed structs on this path.
	if rules := mapSlice(spec["dlp_rules"]); len(rules) > 0 {
		p := &lanternv1.DlpPolicy{}
		p.MaxInspectBytes = int64Of(firstOf(spec, "dlp_max_inspect_bytes", "dlpMaxInspectBytes"))
		for _, r := range rules {
			dr := &lanternv1.DlpRule{}
			dr.RuleId, _ = r["rule_id"].(string)
			dr.Detector, _ = r["detector"].(string)
			dr.Pattern, _ = r["pattern"].(string)
			dr.Mode, _ = r["mode"].(string)
			dr.Threshold = int32(int64Of(r["threshold"]))
			p.Rules = append(p.Rules, dr)
		}
		a.DlpPolicy = p
	}
	return a
}

// egressInjectFromMap parses an egress rule's `inject` entries (ADR 0026):
// `{header, secretRef, valuePrefix}` (snake_case and `secret_uri` accepted).
// The runtime-manager's host-side broker resolves the ref and sets the header
// on the way out; the secret never enters the VM.
func egressInjectFromMap(r map[string]any) []*lanternv1.CredentialInjection {
	var out []*lanternv1.CredentialInjection
	for _, m := range mapSlice(r["inject"]) {
		ci := &lanternv1.CredentialInjection{}
		ci.Header, _ = m["header"].(string)
		ci.SecretUri, _ = firstOf(m, "secretRef", "secret_ref", "secretUri", "secret_uri").(string)
		ci.ValuePrefix, _ = firstOf(m, "valuePrefix", "value_prefix").(string)
		out = append(out, ci)
	}
	return out
}

// validateEgressInject rejects malformed credential-injection specs before
// anything is scheduled: the header must be an RFC 7230 token, the ref a
// parseable `lantern.secret/...` ref, the prefix free of CR/LF, the rule an
// EXACT hostname (no wildcard, IP or CIDR), and the ref must not also be
// declared in `secrets` (that would hand the very value injection keeps out
// of the VM to the workload). Errors name indexes only — never the ref.
func validateEgressInject(rules []map[string]any, secrets []map[string]any) error {
	declared := map[string]bool{}
	for _, sr := range secrets {
		if u, _ := firstOf(sr, "secret_uri", "secretUri").(string); u != "" {
			declared[u] = true
		}
	}
	for i, r := range rules {
		for j, ci := range egressInjectFromMap(r) {
			if !isHTTPToken(ci.Header) {
				return fmt.Errorf("egress rule %d inject %d: header must be a valid HTTP header name", i, j)
			}
			if parseRef(ci.SecretUri).scope == "" {
				return fmt.Errorf("egress rule %d inject %d: secretRef must be a lantern.secret/... ref", i, j)
			}
			if strings.ContainsAny(ci.ValuePrefix, "\r\n") {
				return fmt.Errorf("egress rule %d inject %d: valuePrefix must not contain CR/LF", i, j)
			}
			if pattern, _ := r["pattern"].(string); pattern == "" || strings.Contains(pattern, "*") || net.ParseIP(pattern) != nil || strings.Contains(pattern, "/") {
				return fmt.Errorf("egress rule %d: credential injection requires an exact hostname pattern", i)
			}
			if declared[ci.SecretUri] {
				return fmt.Errorf("egress rule %d inject %d: secretRef is also listed in secrets — an injected credential must not be vended into the VM", i, j)
			}
		}
	}
	return nil
}

// isHTTPToken reports whether s is a non-empty RFC 7230 token.
func isHTTPToken(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
			strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
		if !ok {
			return false
		}
	}
	return true
}

// applySpecMap fills the fields of spec that the typed decode left empty from a
// raw spec map — a REST body or an agent manifest — accepting both the
// camelCase REST spelling and the snake_case agent.yaml/manifest spelling.
// Entry-level keys inside limits/egress_rules/secrets are normalized later by
// agentSpecFromMap, which reads both casings. Both schedule paths (HTTP and
// run-executor) go through here so neither silently drops sandbox policy.
func applySpecMap(spec *agentSpecDTO, m map[string]any) {
	if spec.ImageDigest == "" {
		spec.ImageDigest, _ = firstOf(m, "imageDigest", "image_digest").(string)
	}
	if spec.Isolation == "" {
		spec.Isolation, _ = firstOf(m, "isolation", "isolation_class", "isolationClass").(string)
	}
	if spec.RestoreSnapshotID == "" {
		spec.RestoreSnapshotID, _ = firstOf(m, "restoreSnapshotId", "restore_snapshot_id").(string)
	}
	if !spec.Confidential {
		spec.Confidential, _ = m["confidential"].(bool)
	}
	if spec.IdleTimeoutSecs == 0 {
		if v := int64Of(firstOf(m, "idleTimeoutSecs", "idle_timeout_secs")); v != 0 {
			spec.IdleTimeoutSecs = int32(v)
		}
	}
	if spec.Limits == nil {
		spec.Limits, _ = m["limits"].(map[string]any)
	}
	if spec.EgressRules == nil {
		spec.EgressRules = mapSlice(firstOf(m, "egressRules", "egress_rules"))
	}
	if spec.Secrets == nil {
		spec.Secrets = mapSlice(m["secrets"])
	}
	if env, ok := m["env"].(map[string]any); ok && spec.Env == nil {
		spec.Env = make(map[string]string, len(env))
		for k, v := range env {
			if sv, ok := v.(string); ok {
				spec.Env[k] = sv
			}
		}
	}
}

func firstOf(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			return v
		}
	}
	return nil
}

func anySlice(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out
	}
	return nil
}

// mapSlice normalizes []map[string]any / []any-of-maps (JSON round-trip form).
func mapSlice(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		return t
	case []any:
		var out []map[string]any
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func int64Of(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	}
	return 0
}

func float64Of(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	}
	return 0
}

// limitsFromMap decodes the opaque limits map (camelCase REST or snake_case
// manifest keys). timeout accepts a Go duration string ("5m") or seconds.
func limitsFromMap(m map[string]any) *lanternv1.ResourceLimits {
	l := &lanternv1.ResourceLimits{}
	l.Vcpu, _ = m["vcpu"].(string)
	l.Memory, _ = m["memory"].(string)
	l.Gpu, _ = m["gpu"].(string)
	l.ScratchSize, _ = firstOf(m, "scratch_size", "scratchSize").(string)
	l.MaxSteps = int64Of(firstOf(m, "max_steps", "maxSteps"))
	l.MaxTokens = int64Of(firstOf(m, "max_tokens", "maxTokens"))
	l.MaxCostUsd = float64Of(firstOf(m, "max_cost_usd", "maxCostUsd"))
	switch t := m["timeout"].(type) {
	case string:
		if d, err := time.ParseDuration(t); err == nil {
			l.Timeout = durationpb.New(d)
		}
	case float64, int, int64:
		l.Timeout = durationpb.New(time.Duration(float64Of(t) * float64(time.Second)))
	}
	return l
}

func parseIsolation(s string) lanternv1.IsolationClass {
	switch strings.ToLower(s) {
	case "trusted":
		return lanternv1.IsolationClass_ISOLATION_TRUSTED
	case "standard", "microvm", "firecracker":
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

// ---------- MicroVMDispatcher (two-tier run routing, ADR 0022) ----------

// MicroVMDispatcher is the narrow interface RESTHandler uses to dispatch
// microVM-tier runs. RuntimeHandler implements it via ScheduleRunInMicroVM.
// The interface is intentionally minimal: all scheduling policy (quota,
// identity, placement) lives in the RuntimeHandler, not the caller.
type MicroVMDispatcher interface {
	// ScheduleRunInMicroVM dispatches a new microVM workload for the given run.
	// Returns the vmID on success. On any error the caller must mark the run
	// failed with code "microvm_unavailable" — this method never touches the run row.
	ScheduleRunInMicroVM(ctx context.Context, tenantID, agentVersionID, runID, imageDigest string, manifest map[string]any) (vmID string, err error)
}

// scheduleAgentSpec is the shared scheduling core called by both RuntimeHandler.Schedule
// and RuntimeHandler.ScheduleRunInMicroVM. It mints a per-VM agent identity, calls the
// runtime scheduler, inserts the runtime_vms shadow row, and writes the schedule audit event.
//
// ctx must carry the tenant_id (injected via middleware.InjectTenantID) so the
// runtime_vms insert is RLS-scoped. principalID is the JWT subject for HTTP-originated
// schedules; for internal dispatches (two-tier run routing) pass the runID.
//
// Quota enforcement is the caller's responsibility: call checkRuntimeQuota before
// scheduleAgentSpec and abort appropriately if denied.
func (h *RuntimeHandler) scheduleAgentSpec(ctx context.Context, tenantID, principalID string, spec agentSpecDTO) (vmID, node, az, instanceID string, created time.Time, err error) {
	idemKey := spec.IdempotencyKey
	if idemKey == "" {
		idemKey = uuid.NewString()
	}

	// Load DLP policy (ADR 0030) BEFORE minting identity. Fail closed: a tenant
	// in block mode expects enforcement, so a policy we cannot read must not
	// become a VM with no DLP — and loading first leaves no orphan identity.
	dlpRules, dlpMaxBytes, err := h.loadDLPRules(ctx, tenantID)
	if err != nil {
		return "", "", "", "", time.Time{}, fmt.Errorf("load DLP policy: %w", err)
	}

	// Mint per-VM identity. Fail closed: an agent that cannot be identified must not be scheduled.
	// The instance id is derived from the idempotency key: when a retry is
	// deduped by the scheduler it returns the VM that booted with the FIRST
	// attempt's token, so the row we insert must name that same instance id.
	var instanceToken string
	instanceID, instanceToken, err = h.identity.IssueForID(ctx,
		agentidentity.InstanceIDForKey(tenantID, idemKey), tenantID, spec.RunID, spec.AgentVersionID)
	if err != nil {
		return "", "", "", "", time.Time{}, fmt.Errorf("mint agent identity: %w", err)
	}

	// Build the spec map. tenant_id always comes from context; never from the caller.
	specMap := map[string]any{
		"idempotency_key":     idemKey,
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
		"confidential":        spec.Confidential,
		"idle_timeout_secs":   spec.IdleTimeoutSecs,
		"tenant_id":           tenantID,
	}
	// Container exec controls — convert []string to []any so agentSpecFromMap's
	// type-asserted decoder handles them uniformly.
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
	// Build spawn env: merge caller-supplied values, then stamp identity (takes precedence).
	env := make(map[string]any, len(spec.Env)+2)
	for k, v := range spec.Env {
		env[k] = v
	}
	stampAgentIdentity(env, instanceID, instanceToken)
	specMap["env"] = env

	// Attach DLP policy (ADR 0030), loaded above.
	if len(dlpRules) > 0 {
		specMap["dlp_rules"] = dlpRules
		if dlpMaxBytes > 0 {
			specMap["dlp_max_inspect_bytes"] = dlpMaxBytes
		}
	}

	vmID, node, az, err = h.scheduler.Schedule(ctx, specMap)
	if err != nil {
		return "", "", "", "", time.Time{}, fmt.Errorf("scheduler.Schedule: %w", err)
	}

	// Invariant #10: the spec we PERSIST must not carry secret material.
	// LANTERN_AGENT_INSTANCE_TOKEN is a live bearer credential — it has to
	// ride the spawn request so the harness can authenticate VendSecret, but
	// storing it means it survives in runtime_vms.spec and is served verbatim
	// by GET /v1/runtime/vms for the whole of its TTL. Strip it from the
	// persisted copy only; `specMap` above already went to the scheduler with
	// the token intact.
	specJSON, _ := json.Marshal(redactSpecSecrets(specMap))
	if len(specJSON) == 0 {
		specJSON = []byte("{}")
	}

	// Insert shadow row. agent_version_id / run_id are UUID-typed and optional.
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

	created = time.Now().UTC()
	if wErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO runtime_vms
			  (vm_id, tenant_id, agent_version_id, run_id, node, az, isolation_class, state, spec, agent_instance_id, confidential, idle_timeout_secs, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::jsonb, $9, $10, $11, $12)
			ON CONFLICT (vm_id) DO NOTHING
		`, vmID, tenantID, agentVerArg, runIDArg, node, az, spec.Isolation, specJSON, instanceID, spec.Confidential, spec.IdleTimeoutSecs, created)
		return e
	}); wErr != nil {
		h.logger().Error("scheduleAgentSpec: insert runtime_vms failed", zap.Error(wErr))
		return "", "", "", "", time.Time{}, fmt.Errorf("insert runtime_vms: %w", wErr)
	}

	h.auditRuntime(ctx, tenantID, vmID, "schedule", map[string]any{
		"image_digest":      spec.ImageDigest,
		"isolation":         spec.Isolation,
		"confidential":      spec.Confidential,
		"node":              node,
		"az":                az,
		"agent_instance_id": instanceID,
	}, principalID, instanceID)

	return vmID, node, az, instanceID, created, nil
}

// ScheduleRunInMicroVM implements MicroVMDispatcher. It dispatches a microVM
// workload for the given run using the quota checker and scheduler wired into
// this RuntimeHandler. Returns the vmID on success. On any failure the caller
// must mark the run failed — this method never touches the run row.
//
// When the run is associated with a session (runs.session_id is set), the call
// is routed through scheduleSessionVM which reuses an existing live VM for that
// session rather than spawning a new one on every turn.
func (h *RuntimeHandler) ScheduleRunInMicroVM(ctx context.Context, tenantID, agentVersionID, runID, imageDigest string, manifest map[string]any) (string, error) {
	spec := agentSpecDTO{
		ImageDigest:    imageDigest,
		Isolation:      "microvm",
		AgentVersionID: agentVersionID,
		RunID:          runID,
		// Deterministic: a recovery re-drive of the same run dedups at the scheduler.
		IdempotencyKey: runScheduleKey(runID, manifest),
	}
	// limits / egress_rules / secrets / confidential (ADR 0023) / env +
	// restoreSnapshotId (crash-resume, ADR 0022) — either casing.
	applySpecMap(&spec, manifest)
	if err := validateEgressInject(spec.EgressRules, spec.Secrets); err != nil {
		return "", err
	}

	// Look up the run's session_id — when present, route through the session VM
	// affinity path so all turns of the same session reuse one VM.
	// rls-exempt: runs is tenant-scoped but we have tenantID and self-scope explicitly.
	var sessionID string
	if runID != "" {
		_ = h.srv.Pool.QueryRow(ctx,
			`SELECT COALESCE(session_id::text, '') FROM runs WHERE id = $1 AND tenant_id = $2`,
			runID, tenantID,
		).Scan(&sessionID)
	}

	// Quota: honest failure — any denial fails the run, never falls through to inline
	// (ADR 0022 §3: "never silent downgrade"). Skip quota check on session-VM reuse
	// (no new resource is consumed); the initial spawn already checked.
	if sessionID == "" {
		qres := h.checkRuntimeQuota(ctx, tenantID, spec)
		if !qres.Allowed {
			return "", fmt.Errorf("quota exceeded: %s", qres.Reason)
		}
		vmID, _, _, _, _, err := h.scheduleAgentSpec(ctx, tenantID, runID, spec)
		return vmID, err
	}

	// Session affinity: quota is checked inside scheduleSessionVM for the spawn
	// path; on reuse the check is skipped (same VM already counted).
	return h.scheduleSessionVM(ctx, tenantID, sessionID, spec)
}

// scheduleSessionVM reuses the live VM for (tenantID, sessionID) when one exists,
// or spawns a new one (after a quota check) and stamps the session_id on it.
//
// Singleflight deduplicates concurrent calls with the same key so two
// simultaneous turns in the same session never double-spawn. Sequential turns
// find the existing VM via the DB check.
func (h *RuntimeHandler) scheduleSessionVM(ctx context.Context, tenantID, sessionID string, spec agentSpecDTO) (string, error) {
	type result struct{ vmID string }
	sfKey := tenantID + ":" + sessionID

	v, err, _ := h.sessionVMsf.Do(sfKey, func() (any, error) {
		// 1. Check DB for a live VM already pinned to this session.
		var existingVMID string
		_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			e := tx.QueryRow(ctx, `
				SELECT vm_id FROM runtime_vms
				WHERE tenant_id = $1 AND session_id = $2
				  AND state IN ('pending','spawning','running')
				ORDER BY created_at DESC LIMIT 1
			`, tenantID, sessionID).Scan(&existingVMID)
			if e != nil {
				return nil // ErrNoRows or other — proceed to spawn
			}
			// Touch last_used_at so the idle sweep doesn't evict a busy VM.
			_, _ = tx.Exec(ctx, `UPDATE runtime_vms SET last_used_at = now() WHERE vm_id = $1`, existingVMID)
			return nil
		})
		if existingVMID != "" {
			h.logger().Debug("scheduleSessionVM: reusing live VM",
				zap.String("session_id", sessionID),
				zap.String("vm_id", existingVMID),
				zap.String("tenant_id", tenantID),
			)
			return result{vmID: existingVMID}, nil
		}

		// 2. No live VM — enforce quota before spawning.
		qres := h.checkRuntimeQuota(ctx, tenantID, spec)
		if !qres.Allowed {
			return nil, fmt.Errorf("quota exceeded: %s", qres.Reason)
		}

		// 3. Stamp the session affinity label so the scheduler can co-locate turns.
		labels := make(map[string]string, len(spec.Labels)+1)
		for k, v := range spec.Labels {
			labels[k] = v
		}
		labels["lantern.session_id"] = sessionID
		specWithSession := spec
		specWithSession.Labels = labels

		vmID, _, _, _, _, err := h.scheduleAgentSpec(ctx, tenantID, spec.RunID, specWithSession)
		if err != nil {
			return nil, err
		}

		// 4. Write session_id + last_used_at onto the freshly-inserted VM row.
		if wErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE runtime_vms SET session_id = $1, last_used_at = now() WHERE vm_id = $2
			`, sessionID, vmID)
			return e
		}); wErr != nil {
			h.logger().Warn("scheduleSessionVM: stamp session_id failed",
				zap.String("vm_id", vmID), zap.Error(wErr))
			// Non-fatal: the VM is running; session affinity lookup will miss on
			// the next turn (re-spawns) but the current turn is unaffected.
		}

		h.logger().Info("scheduleSessionVM: spawned new session VM",
			zap.String("session_id", sessionID),
			zap.String("vm_id", vmID),
			zap.String("tenant_id", tenantID),
		)
		return result{vmID: vmID}, nil
	})
	if err != nil {
		return "", err
	}
	return v.(result).vmID, nil
}

// TerminateSessionVM terminates the live VM pinned to (tenantID, sessionID),
// if one exists. Best-effort: errors are logged, not returned. Emits a
// session_vm_terminated audit event. Called by StopSession / DeleteSession.
func (h *RuntimeHandler) TerminateSessionVM(ctx context.Context, tenantID, sessionID string) error {
	var vmID string
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT vm_id FROM runtime_vms
			WHERE tenant_id = $1 AND session_id = $2
			  AND state IN ('pending','spawning','running')
			ORDER BY created_at DESC LIMIT 1
		`, tenantID, sessionID).Scan(&vmID)
	})
	if err != nil {
		// ErrNoRows is normal (no VM for this session). Other errors are unexpected.
		if err != pgx.ErrNoRows {
			h.logger().Warn("TerminateSessionVM: lookup failed",
				zap.String("session_id", sessionID), zap.Error(err))
		}
		return nil
	}

	if termErr := h.scheduler.Terminate(withTenant(ctx, tenantID), vmID, "session_ended"); termErr != nil {
		h.logger().Warn("TerminateSessionVM: scheduler.Terminate failed",
			zap.String("vm_id", vmID), zap.Error(termErr))
		// Fall through to mark terminated in DB so the row doesn't linger.
	}

	if wErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runtime_vms SET state = 'terminated', terminated_at = COALESCE(terminated_at, now())
			WHERE vm_id = $1 AND tenant_id = $2
		`, vmID, tenantID)
		return e
	}); wErr != nil {
		h.logger().Warn("TerminateSessionVM: state update failed",
			zap.String("vm_id", vmID), zap.Error(wErr))
	}

	h.auditRuntime(ctx, tenantID, vmID, "session_vm_terminated",
		map[string]any{"session_id": sessionID}, "", "")

	h.logger().Info("TerminateSessionVM: terminated",
		zap.String("session_id", sessionID),
		zap.String("vm_id", vmID),
		zap.String("tenant_id", tenantID),
	)
	return nil
}

// RunSessionVMIdleSweep terminates session VMs whose last_used_at is older
// than LANTERN_SESSION_VM_IDLE_TTL (default 30m). Runs until ctx is cancelled.
// Start it as a goroutine alongside the other background loops in main.go.
func RunSessionVMIdleSweep(ctx context.Context, h *RuntimeHandler, logger *zap.Logger) {
	ttl := 30 * time.Minute
	if v := os.Getenv("LANTERN_SESSION_VM_IDLE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			ttl = d
		}
	}
	// Sweep at 1/4 of TTL so a VM doesn't sit idle for 2× the TTL.
	interval := ttl / 4
	if interval < time.Minute {
		interval = time.Minute
	}
	logger.Info("session VM idle sweep started",
		zap.Duration("ttl", ttl), zap.Duration("interval", interval))

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepIdleSessionVMs(ctx, h, ttl, logger)
		}
	}
}

func sweepIdleSessionVMs(ctx context.Context, h *RuntimeHandler, ttl time.Duration, logger *zap.Logger) {
	sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Collect (tenant_id, vm_id, session_id) for stale session VMs.
	// rls-exempt: cross-tenant sweep — uses privileged pool, same pattern as reconcileLoop.
	type staleVM struct {
		tenantID  string
		vmID      string
		sessionID string
	}
	rows, err := h.srv.Pool.Query(sweepCtx, `
		SELECT tenant_id, vm_id, session_id
		FROM runtime_vms
		WHERE session_id IS NOT NULL
		  AND state IN ('pending','spawning','running')
		  AND last_used_at < now() - $1::interval
	`, ttl.String())
	if err != nil {
		logger.Warn("session VM idle sweep: query failed", zap.Error(err))
		return
	}
	var stale []staleVM
	for rows.Next() {
		var s staleVM
		if e := rows.Scan(&s.tenantID, &s.vmID, &s.sessionID); e == nil {
			stale = append(stale, s)
		}
	}
	rows.Close()

	for _, s := range stale {
		tctx := middleware.InjectTenantID(sweepCtx, s.tenantID)
		if termErr := h.scheduler.Terminate(withTenant(tctx, s.tenantID), s.vmID, "idle_timeout"); termErr != nil {
			logger.Warn("session VM idle sweep: terminate failed",
				zap.String("vm_id", s.vmID), zap.Error(termErr))
		}
		_ = h.srv.WithTenant(tctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(tctx, `
				UPDATE runtime_vms SET state = 'terminated', terminated_at = COALESCE(terminated_at, now())
				WHERE vm_id = $1 AND tenant_id = $2
			`, s.vmID, s.tenantID)
			return e
		})
		h.auditRuntime(tctx, s.tenantID, s.vmID, "session_vm_terminated",
			map[string]any{"session_id": s.sessionID, "reason": "idle_timeout"}, "", "")
		logger.Info("session VM idle sweep: terminated stale VM",
			zap.String("vm_id", s.vmID),
			zap.String("session_id", s.sessionID),
			zap.String("tenant_id", s.tenantID),
		)
	}
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
	// ponytail: singleflight deduplicates concurrent session-VM spawns within
	// a single process. Cross-replica deduplication is a future concern; the DB
	// check in scheduleSessionVM limits worst-case to a brief double-spawn.
	sessionVMsf singleflight.Group // key: "tenantID:sessionID"
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
		c, err := NewGRPCSchedulerClient(addr, os.Getenv("LANTERN_GRPC_SERVICE_TOKEN"), logger.Named("scheduler_grpc"))
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
		for vmID, info := range states {
			err := h.srv.WithTenant(tctx, func(tx pgx.Tx) error {
				// COALESCE keeps a previously-recorded reason when the
				// scheduler reports none, so an explanation is never
				// overwritten with blank on a later sweep.
				_, e := tx.Exec(tctx, `
					UPDATE runtime_vms
					SET state = $1,
					    state_reason = COALESCE(NULLIF($4, ''), state_reason)
					WHERE vm_id = $2 AND tenant_id = $3
					  AND (state <> $1 OR (state_reason IS DISTINCT FROM $4 AND $4 <> ''))
				`, info.State, vmID, tenantID, info.Reason)
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

// loadDLPRules returns the tenant's DLP rules from dlp_policies, and the
// configured max_inspect_bytes (0 → manager uses its own default of 64 KiB).
// An error is returned to the caller, which refuses to schedule (fail closed).
// RLS is enforced via WithTenant.
func (h *RuntimeHandler) loadDLPRules(ctx context.Context, tenantID string) ([]map[string]any, int64, error) {
	var rules []map[string]any
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT rule_id, detector, pattern, mode, threshold
			FROM dlp_policies
			WHERE tenant_id = $1 AND mode != 'off'
			ORDER BY created_at, rule_id
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var (
				ruleID, detector, pattern, mode string
				threshold                       int32
			)
			if sErr := rows.Scan(&ruleID, &detector, &pattern, &mode, &threshold); sErr != nil {
				return sErr
			}
			rules = append(rules, map[string]any{
				"rule_id":   ruleID,
				"detector":  detector,
				"pattern":   pattern,
				"mode":      mode,
				"threshold": int64(threshold),
			})
		}
		return rows.Err()
	}); err != nil {
		return nil, 0, err
	}
	return rules, 0, nil
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
	// Confidential compute (SEV-SNP/TDX under Kata-CC). Refused fail-closed if
	// no CC-capable node exists; never downgraded. See ADR 0023.
	Confidential bool `json:"confidential,omitempty"`
	// Limits / EgressRules / Secrets are passed through opaque so the
	// scheduler can interpret them without re-defining the structs here.
	Limits      map[string]any   `json:"limits,omitempty"`
	EgressRules []map[string]any `json:"egressRules,omitempty"`
	Secrets     []map[string]any `json:"secrets,omitempty"`
	// IdempotencyKey dedups a retried schedule at the scheduler. Run-executor
	// callers derive it from run_id; REST callers may supply it (field or
	// Idempotency-Key header); otherwise scheduleAgentSpec mints a fresh uuid.
	IdempotencyKey string `json:"idempotencyKey,omitempty"`
	// IdleTimeoutSecs auto-suspends the VM after this many seconds of
	// inactivity (no running workload child in the harness). 0 = never auto-suspend.
	IdleTimeoutSecs int32 `json:"idleTimeoutSecs,omitempty"`
}

type scheduleResponse struct {
	VmID      string    `json:"vmId"`
	Node      string    `json:"node"`
	Az        string    `json:"az"`
	CreatedAt time.Time `json:"createdAt"`
	// Stub is true when no real scheduler is wired
	// (LANTERN_SCHEDULER_GRPC_ADDR unset) and this vmId was SYNTHESIZED —
	// nothing was spawned and no scheduler ever saw it. Without this flag a
	// stubbed schedule is indistinguishable from a real one at the API and
	// CLI, which turns a misconfiguration into silent data loss. The prod
	// startup guard already refuses to boot in this state; this is the dev
	// signal. Omitted entirely on the real path.
	Stub bool `json:"stub,omitempty"`
	// Warning carries the human-readable explanation alongside Stub.
	Warning string `json:"warning,omitempty"`
}

type vmRow struct {
	VmID           string  `json:"vmId"`
	TenantID       string  `json:"tenantId"`
	AgentVersionID *string `json:"agentVersionId,omitempty"`
	RunID          *string `json:"runId,omitempty"`
	Node           *string `json:"node,omitempty"`
	Az             *string `json:"az,omitempty"`
	Region         *string `json:"region,omitempty"`
	IsolationClass *string `json:"isolationClass,omitempty"`
	State          string  `json:"state"`
	// StateReason explains a terminal state — e.g. "isolation class
	// 'untrusted' not satisfiable by the 'docker' backend". Absent when the
	// scheduler never supplied one.
	StateReason *string         `json:"stateReason,omitempty"`
	Spec        json.RawMessage `json:"spec"`
	// SnapshotID / ParentVMID are set by pause/fork (GET /v1/runtime/vms/{id}).
	SnapshotID      *string    `json:"snapshotId,omitempty"`
	ParentVMID      *string    `json:"parentVmId,omitempty"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	TerminatedAt    *time.Time `json:"terminatedAt,omitempty"`
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
	return h.checkRuntimeQuotaN(ctx, tenantID, 1)
}

// checkRuntimeQuotaN is checkRuntimeQuota for adding n VMs at once (fork).
func (h *RuntimeHandler) checkRuntimeQuotaN(ctx context.Context, tenantID string, n int) quotaCheckResult {
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
	if q.maxConcurrent > 0 && live+n > q.maxConcurrent {
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

	// Decode via a raw map so we accept both the camelCase REST convention
	// (imageDigest) AND the snake_case YAML convention that `lantern run`
	// forwards from agent.yaml (image_digest). Aliases are checked after the
	// primary JSON struct decode has a chance to populate the field.
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "read body")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	var spec agentSpecDTO
	if err := json.Unmarshal(rawBody, &spec); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "invalid body")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if h := r.Header.Get("Idempotency-Key"); h != "" {
		spec.IdempotencyKey = h
	}
	// Alias fallback: fill fields the camelCase struct decode missed from the
	// snake_case keys `lantern run` forwards from agent.yaml (image_digest,
	// isolation_class, egress_rules, secret_uri, ...).
	var raw map[string]any
	_ = json.Unmarshal(rawBody, &raw)
	applySpecMap(&spec, raw)
	if spec.ImageDigest == "" {
		span.SetStatus(codes.Error, "imageDigest required")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imageDigest is required"})
		return
	}
	if err := validateEgressInject(spec.EgressRules, spec.Secrets); err != nil {
		span.SetStatus(codes.Error, "invalid egress inject")
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
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

	vmID, node, az, instanceID, created, err := h.scheduleAgentSpec(ctx, tenantID, claims.Subject, spec)
	if err != nil {
		h.logger().Error("scheduleAgentSpec failed", zap.Error(err))
		span.RecordError(err)
		span.SetStatus(codes.Error, "scheduling failed")
		if strings.Contains(err.Error(), "mint agent identity") {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not mint agent identity"})
		} else {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scheduler unavailable"})
		}
		return
	}
	span.SetAttributes(
		attribute.String("lantern.vm_id", vmID),
		attribute.String("lantern.agent_instance_id", instanceID),
	)

	span.SetStatus(codes.Ok, "")
	resp := scheduleResponse{
		VmID:      vmID,
		Node:      node,
		Az:        az,
		CreatedAt: created,
	}
	if h.schedulerIsStub() {
		resp.Stub = true
		resp.Warning = stubScheduleWarning
		span.SetAttributes(attribute.Bool("lantern.scheduler_stub", true))
		h.logger().Warn("scheduled against the STUB scheduler — no workload was spawned",
			zap.String("vm_id", vmID), zap.String("tenant_id", tenantID))
	}
	writeJSON(w, http.StatusCreated, resp)
}

// redactedValue replaces secret material in persisted / returned specs.
const redactedValue = "[redacted]"

// secretSpecEnvKeys are env keys whose values are credentials, never config.
// Both names of the token (ADR 0032): a caller-supplied PAL_ twin is dropped
// at the stamp site, but rows written before that, or by another writer, must
// not serve it either.
var secretSpecEnvKeys = []string{
	"LANTERN_AGENT_INSTANCE_TOKEN",
	"PAL_AGENT_INSTANCE_TOKEN",
}

// stampAgentIdentity sets the VM's agent identity in a spawn env, replacing
// anything the caller supplied under EITHER name (ADR 0032). Only the
// LANTERN_ names are written until the writers flip (rename plan step 4); a
// caller-chosen PAL_ twin is deleted, never forwarded, because once the
// harness prefers PAL_ it would authenticate VendSecret with it.
func stampAgentIdentity(env map[string]any, instanceID, instanceToken string) {
	delete(env, "PAL_AGENT_INSTANCE_ID")
	delete(env, "PAL_AGENT_INSTANCE_TOKEN")
	env["LANTERN_AGENT_INSTANCE_ID"] = instanceID
	env["LANTERN_AGENT_INSTANCE_TOKEN"] = instanceToken
}

// redactSpecSecrets returns a copy of an AgentSpec map with credential-bearing
// env values replaced. The input map is NOT mutated — callers dispatch the
// original to the scheduler, which legitimately needs the real token.
//
// Applied on the write path (so nothing secret reaches Postgres) and again on
// the read path (so rows written before this fix are not served).
func redactSpecSecrets(spec map[string]any) map[string]any {
	if spec == nil {
		return nil
	}
	env, ok := spec["env"].(map[string]any)
	if !ok || len(env) == 0 {
		return spec
	}
	needsRedaction := false
	for _, k := range secretSpecEnvKeys {
		if v, present := env[k]; present && v != redactedValue {
			needsRedaction = true
			break
		}
	}
	if !needsRedaction {
		return spec
	}

	safeEnv := make(map[string]any, len(env))
	for k, v := range env {
		safeEnv[k] = v
	}
	for _, k := range secretSpecEnvKeys {
		if _, present := safeEnv[k]; present {
			safeEnv[k] = redactedValue
		}
	}
	out := make(map[string]any, len(spec))
	for k, v := range spec {
		out[k] = v
	}
	out["env"] = safeEnv
	return out
}

// redactSpecJSON redacts secret env values in a raw spec JSON blob read back
// from runtime_vms. Unparseable input is returned unchanged rather than
// dropped — a malformed spec is a display problem, not a reason to 500.
func redactSpecJSON(raw []byte) []byte {
	if len(raw) == 0 {
		return raw
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		return raw
	}
	redacted := redactSpecSecrets(spec)
	out, err := json.Marshal(redacted)
	if err != nil {
		return raw
	}
	return out
}

// stubScheduleWarning is returned verbatim to API clients so the CLI and
// dashboard can surface it without duplicating the wording.
const stubScheduleWarning = "no scheduler wired (LANTERN_SCHEDULER_GRPC_ADDR unset): " +
	"this vmId was synthesized and NO workload was spawned"

// schedulerIsStub reports whether the handler is running against the
// synthesizing stub rather than a real RuntimeScheduler.
func (h *RuntimeHandler) schedulerIsStub() bool {
	_, ok := h.scheduler.(*stubSchedulerClient)
	return ok
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
		       isolation_class, state, state_reason, spec, last_heartbeat_at, created_at, terminated_at,
		       snapshot_id, parent_vm_id
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
				&v.Node, &v.Az, &v.Region, &v.IsolationClass, &v.State, &v.StateReason, &specJSON,
				&v.LastHeartbeatAt, &v.CreatedAt, &v.TerminatedAt, &v.SnapshotID, &v.ParentVMID); err != nil {
				continue
			}
			if len(specJSON) == 0 {
				specJSON = []byte("{}")
			}
			v.Spec = redactSpecJSON(specJSON)
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
			       isolation_class, state, state_reason, spec, last_heartbeat_at, created_at, terminated_at,
			       snapshot_id, parent_vm_id
			FROM runtime_vms
			WHERE vm_id = $1 AND tenant_id = $2
		`, vmID, tenantID).Scan(&v.VmID, &v.TenantID, &v.AgentVersionID, &v.RunID,
			&v.Node, &v.Az, &v.Region, &v.IsolationClass, &v.State, &v.StateReason, &specJSON,
			&v.LastHeartbeatAt, &v.CreatedAt, &v.TerminatedAt, &v.SnapshotID, &v.ParentVMID); e != nil {
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
	v.Spec = redactSpecJSON(specJSON)

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

	// Confirm ownership (tenant-scoped; cross-tenant vm_id → no row → 404) and
	// capture the VM's node placement — exec must reach the manager on the node
	// the workload actually runs on, not a default (mirrors StreamLogs).
	var owner string
	var node *string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT tenant_id, node FROM runtime_vms WHERE vm_id = $1 AND tenant_id = $2`, vmID, tenantID).Scan(&owner, &node)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "vm not found"})
		return
	}
	if owner != tenantID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	// Auto-resume: if this VM was auto-suspended (paused + idle_timeout_secs > 0),
	// transparently resume it before exec.
	if !h.ensureVMRunning(w, ctx, tenantID, vmID) {
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

	nodeName := ""
	if node != nil {
		nodeName = *node
	}
	if st, ok := h.scheduler.(execStreamer); ok && strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		h.streamExec(w, r, st, withTenant(ctx, tenantID), tenantID, claims.Subject, nodeName, vmID, body.Command, body.Argv)
		return
	}
	stdout, stderr, exit, err := h.scheduler.Exec(withTenant(ctx, tenantID), nodeName, vmID, body.Command, body.Argv)
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

// streamExec relays exec output as SSE (event: stdout|stderr|exit) as chunks
// arrive from the manager, with no full-response buffering (invariant #4).
func (h *RuntimeHandler) streamExec(w http.ResponseWriter, r *http.Request, st execStreamer, ctx context.Context, tenantID, principalID, node, vmID, command string, argv []string) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	send := func(event string, payload any) error {
		b, _ := json.Marshal(payload)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
			return err
		}
		fl.Flush()
		return nil
	}
	exit, truncated, err := st.ExecStream(ctx, node, vmID, command, argv, func(stream string, data []byte) error {
		return send(stream, map[string]string{"data": string(data)})
	})
	if err != nil {
		h.logger().Error("scheduler.ExecStream failed", zap.Error(err))
		_ = send("error", map[string]string{"error": "scheduler error"})
		return
	}
	if truncated {
		_ = send("stderr", map[string]string{"data": execTruncatedNotice})
	}
	h.auditRuntime(ctx, tenantID, vmID, "exec",
		map[string]any{"command": command, "exit_code": exit}, principalID, "")
	_ = send("exit", map[string]int32{"exitCode": exit})
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

// runScheduleKey derives the scheduler idempotency key for a run's VM
// (invariant #8: run + attempt). A retry of the same attempt dedups to the
// same VM; a recovery re-drive (manifest["attempt"] > 1) gets a fresh one.
func runScheduleKey(runID string, manifest map[string]any) string {
	attempt := 1
	switch v := manifest["attempt"].(type) {
	case int:
		attempt = v
	case float64:
		attempt = int(v)
	}
	return fmt.Sprintf("run:%s:%d", runID, attempt)
}
