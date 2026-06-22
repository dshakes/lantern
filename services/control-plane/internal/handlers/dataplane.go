// Package handlers — DataPlane gRPC service.
//
// DataPlaneService is the server-side implementation of the control-plane ↔
// data-plane tunnel. The data-plane agent dials OUT to this service (no inbound
// ports on the agent side). The service is registered on the existing :50051
// gRPC listener alongside AgentService and RunService.
//
// # Auth design
//
//   - Bootstrap: POST /v1/data-planes generates a 32-byte random token, stores
//     SHA-256(token) in data_planes.reg_token_hash, and returns the plaintext
//     ONCE. Register validates the incoming agent_token against the stored hash
//     (constant-time SHA-256 compare) and on success mints a short-lived
//     session JWT (typ=dataplane-session, exp=1h).
//
//   - Per-RPC: Heartbeat / ReportMetrics / RefreshToken / RunStream all carry
//     plane_id + session_token. The session token is verified (sig, exp,
//     typ==dataplane-session) and its plane_id claim must match the request.
//     Expired or forged tokens are rejected Unauthenticated.
//
//   - Tenant isolation: the session token binds tenant_id; every DB write is
//     scoped to that tenant. A plane can never affect another tenant's rows.
//
// # Per-plane connection registry
//
// RunStream registers a per-plane send channel in planeRegistry. The dispatch
// path (RESTHandler.CreateRun → DataPlaneService.RouteRun) pushes a
// DpRunAssignment by calling PlaneRegistry.Send — the channel is consumed by the
// RunStream goroutine that sends it down the server stream. When a tenant has a
// connected plane the run executes there (customer-VPC model); otherwise it
// falls back to inline execution in the control plane (managed-cloud model).
package handlers

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// maxRunStreamsPerTenant is the maximum number of concurrent RunStream
// connections allowed per tenant. Configurable via LANTERN_DP_MAX_STREAMS_PER_TENANT.
// Default is 10.
const defaultMaxRunStreamsPerTenant = 10

func maxRunStreamsPerTenant() int {
	if v := os.Getenv("LANTERN_DP_MAX_STREAMS_PER_TENANT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultMaxRunStreamsPerTenant
}

// ---------- JWT claims for dataplane sessions ----------

const (
	dpSessionTyp    = "dataplane-session"
	dpSessionIssuer = "lantern-cp"
	dpSessionTTL    = time.Hour
)

// dpClaims is the JWT payload for a data-plane session token.
type dpClaims struct {
	jwt.RegisteredClaims
	Typ      string `json:"typ"`
	PlaneID  string `json:"plane_id"`
	TenantID string `json:"tenant_id"`
}

// ---------- Per-plane connection registry ----------

// planeConn holds the live RunStream send channel for a single connected plane.
type planeConn struct {
	tenantID string
	planeID  string
	// assignCh receives DpRunAssignment frames from the scheduler and
	// forwards them down the RunStream server-to-client direction.
	assignCh chan *lanternv1.DpRunAssignment
}

// PlaneRegistry tracks live RunStream connections keyed by (tenantID, planeID).
// The dispatch path calls RouteRun (which selects a plane via PlaneForTenant and
// pushes through Send) to place a run on a specific plane.
type PlaneRegistry struct {
	mu                sync.Mutex
	conns             map[string]*planeConn // key: tenantID+"/"+planeID
	tenantStreamCount map[string]int        // key: tenantID
}

func newPlaneRegistry() *PlaneRegistry {
	return &PlaneRegistry{
		conns:             make(map[string]*planeConn),
		tenantStreamCount: make(map[string]int),
	}
}

func registryKey(tenantID, planeID string) string {
	return tenantID + "/" + planeID
}

// tryRegister attempts to add a plane's send channel to the registry.
// Returns (deregister, true) on success or (nil, false) if the per-tenant cap
// would be exceeded (caller should return ResourceExhausted).
func (r *PlaneRegistry) tryRegister(tenantID, planeID string, ch chan *lanternv1.DpRunAssignment, cap int) (func(), bool) {
	key := registryKey(tenantID, planeID)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tenantStreamCount[tenantID] >= cap {
		return nil, false
	}
	r.conns[key] = &planeConn{tenantID: tenantID, planeID: planeID, assignCh: ch}
	r.tenantStreamCount[tenantID]++
	return func() {
		r.mu.Lock()
		delete(r.conns, key)
		if r.tenantStreamCount[tenantID] > 0 {
			r.tenantStreamCount[tenantID]--
		}
		r.mu.Unlock()
	}, true
}

// register adds a plane's send channel to the registry without enforcing a cap.
// Used by tests that need direct registry access.
func (r *PlaneRegistry) register(tenantID, planeID string, ch chan *lanternv1.DpRunAssignment) func() {
	key := registryKey(tenantID, planeID)
	r.mu.Lock()
	r.conns[key] = &planeConn{tenantID: tenantID, planeID: planeID, assignCh: ch}
	r.tenantStreamCount[tenantID]++
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.conns, key)
		if r.tenantStreamCount[tenantID] > 0 {
			r.tenantStreamCount[tenantID]--
		}
		r.mu.Unlock()
	}
}

// Send pushes a run assignment to the plane identified by (tenantID, planeID).
// Returns false if the plane is not currently connected or the channel is full.
// Called by RouteRun on the dispatch path.
func (r *PlaneRegistry) Send(tenantID, planeID string, a *lanternv1.DpRunAssignment) bool {
	r.mu.Lock()
	conn, ok := r.conns[registryKey(tenantID, planeID)]
	r.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case conn.assignCh <- a:
		return true
	default:
		return false // channel full; caller may retry or log
	}
}

// PlaneForTenant returns a connected plane for the tenant, or ("", false) if
// none is connected. Selection is deterministic (lexicographically smallest
// planeID) so placement is stable across calls — a real load/region-aware
// placement is the runtime-scheduler service's job; this is the in-process
// fallback that makes single-plane tenants route correctly.
func (r *PlaneRegistry) PlaneForTenant(tenantID string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	picked := ""
	for _, c := range r.conns {
		if c.tenantID != tenantID {
			continue
		}
		if picked == "" || c.planeID < picked {
			picked = c.planeID
		}
	}
	return picked, picked != ""
}

// ConnectedPlanes returns a snapshot of currently connected (tenantID, planeID) pairs.
func (r *PlaneRegistry) ConnectedPlanes() [][2]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([][2]string, 0, len(r.conns))
	for _, c := range r.conns {
		out = append(out, [2]string{c.tenantID, c.planeID})
	}
	return out
}

// TenantStreamCount returns the number of active RunStream connections for the
// given tenant. Used in tests to assert cap enforcement.
func (r *PlaneRegistry) TenantStreamCount(tenantID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tenantStreamCount[tenantID]
}

// ---------- DataPlaneService ----------

// DataPlaneService implements lanternv1.DataPlaneServiceServer.
type DataPlaneService struct {
	lanternv1.UnimplementedDataPlaneServiceServer

	srv       *server.Server
	jwtSecret []byte
	Registry  *PlaneRegistry
}

// NewDataPlaneService constructs the service. jwtSecret is the same HMAC key
// used for user JWTs (from GetJWTSecret) — reused to avoid a second env var.
func NewDataPlaneService(srv *server.Server, jwtSecret []byte) *DataPlaneService {
	return &DataPlaneService{
		srv:       srv,
		jwtSecret: jwtSecret,
		Registry:  newPlaneRegistry(),
	}
}

func (s *DataPlaneService) logger() *zap.Logger {
	return s.srv.Logger.Named("dataplane_svc")
}

// ---------- Token issuance / verification ----------

// issueSessionToken mints a new dataplane-session JWT.
func (s *DataPlaneService) issueSessionToken(tenantID, planeID string) (string, error) {
	now := time.Now()
	claims := dpClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   planeID,
			Issuer:    dpSessionIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(dpSessionTTL)),
			ID:        uuid.NewString(),
		},
		Typ:      dpSessionTyp,
		PlaneID:  planeID,
		TenantID: tenantID,
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := t.SignedString(s.jwtSecret)
	if err != nil {
		return "", fmt.Errorf("issueSessionToken: sign: %w", err)
	}
	return signed, nil
}

// verifySessionToken validates a session token and returns the claims.
// Returns gRPC Unauthenticated on any failure.
func (s *DataPlaneService) verifySessionToken(tokenStr string) (*dpClaims, error) {
	var c dpClaims
	t, err := jwt.ParseWithClaims(tokenStr, &c, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", tok.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !t.Valid {
		return nil, status.Errorf(codes.Unauthenticated, "invalid session token")
	}
	if c.Typ != dpSessionTyp {
		return nil, status.Errorf(codes.Unauthenticated, "wrong token type")
	}
	if c.PlaneID == "" || c.TenantID == "" {
		return nil, status.Errorf(codes.Unauthenticated, "missing plane_id or tenant_id claim")
	}
	return &c, nil
}

// verifyAndMatchToken validates the session token and checks that the plane_id
// in the request matches the token's plane_id claim.
func (s *DataPlaneService) verifyAndMatchToken(tokenStr, requestPlaneID string) (*dpClaims, error) {
	c, err := s.verifySessionToken(tokenStr)
	if err != nil {
		return nil, err
	}
	if c.PlaneID != requestPlaneID {
		return nil, status.Errorf(codes.Unauthenticated, "plane_id mismatch")
	}
	return c, nil
}

// ---------- Register ----------

// Register authenticates the bootstrap token, updates the data_planes row, and
// returns a session token.
func (s *DataPlaneService) Register(ctx context.Context, req *lanternv1.DpRegisterRequest) (*lanternv1.DpRegisterResponse, error) {
	if req.GetTenantId() == "" {
		return nil, status.Errorf(codes.InvalidArgument, "tenant_id is required")
	}
	if req.GetAgentToken() == "" {
		return nil, status.Errorf(codes.Unauthenticated, "agent_token is required")
	}

	// Hash the incoming token once; we compare against stored hashes below.
	incomingHash := hashToken(req.GetAgentToken())
	incomingBytes, _ := hex.DecodeString(incomingHash)

	// Fetch ALL planes for this tenant that have a reg_token_hash set.
	// We iterate and constant-time compare so the DB doesn't see the raw hash
	// and single-row timing doesn't leak which plane was matched.
	rows, err := s.srv.Pool.Query(ctx, `
		SELECT id, reg_token_hash
		FROM data_planes
		WHERE tenant_id = $1 AND reg_token_hash IS NOT NULL
	`, req.GetTenantId())
	if err != nil {
		s.logger().Warn("register: query failed",
			zap.String("tenant_id", req.GetTenantId()),
			zap.Error(err),
		)
		return nil, status.Errorf(codes.Unauthenticated, "invalid agent_token")
	}
	defer rows.Close()

	var planeID string
	for rows.Next() {
		var id string
		var storedHash string
		if err := rows.Scan(&id, &storedHash); err != nil {
			continue
		}
		storedBytes, _ := hex.DecodeString(storedHash)
		if subtle.ConstantTimeCompare(storedBytes, incomingBytes) == 1 {
			planeID = id
			// Don't break early — keep iterating so timing doesn't reveal
			// whether the first or last row matched.
		}
	}
	if err := rows.Err(); err != nil {
		s.logger().Warn("register: row iteration error",
			zap.String("tenant_id", req.GetTenantId()),
			zap.Error(err),
		)
		return nil, status.Errorf(codes.Unauthenticated, "invalid agent_token")
	}
	if planeID == "" {
		return nil, status.Errorf(codes.Unauthenticated, "invalid agent_token")
	}

	// Mint the session token.
	sessionToken, err := s.issueSessionToken(req.GetTenantId(), planeID)
	if err != nil {
		s.logger().Error("register: mint session token failed",
			zap.String("plane_id", planeID),
			zap.Error(err),
		)
		return nil, status.Errorf(codes.Internal, "failed to issue session token")
	}

	// Mark the plane connected and update metadata.
	_, err = s.srv.Pool.Exec(ctx, `
		UPDATE data_planes
		SET status = 'connected',
		    last_heartbeat = now(),
		    config = config ||
		             jsonb_build_object(
		                 'hostname', $2::text,
		                 'agent_version', $3::text,
		                 'region', $4::text,
		                 'cloud', $5::text
		             )
		WHERE id = $1
	`, planeID, req.GetHostname(), req.GetAgentVersion(), req.GetRegion(), req.GetCloud())
	if err != nil {
		s.logger().Error("register: update data_plane failed",
			zap.String("plane_id", planeID),
			zap.Error(err),
		)
		// Non-fatal: return the token anyway; worst case the dashboard shows stale info.
	}

	s.logger().Info("data plane registered",
		zap.String("plane_id", planeID),
		zap.String("tenant_id", req.GetTenantId()),
		zap.String("hostname", req.GetHostname()),
	)

	return &lanternv1.DpRegisterResponse{
		PlaneId:                  planeID,
		SessionToken:             sessionToken,
		HeartbeatIntervalSeconds: 30,
		MetricsIntervalSeconds:   60,
	}, nil
}

// ---------- Heartbeat ----------

// Heartbeat validates the session token and updates last_heartbeat.
func (s *DataPlaneService) Heartbeat(ctx context.Context, req *lanternv1.DpHeartbeatRequest) (*lanternv1.DpHeartbeatAck, error) {
	c, err := s.verifyAndMatchToken(req.GetSessionToken(), req.GetPlaneId())
	if err != nil {
		return nil, err
	}

	_, dbErr := s.srv.Pool.Exec(ctx, `
		UPDATE data_planes
		SET last_heartbeat = now(),
		    agent_count    = $2
		WHERE id = $1 AND tenant_id = $3
	`, req.GetPlaneId(), req.GetActiveRuns(), c.TenantID)
	if dbErr != nil {
		s.logger().Warn("heartbeat: update failed",
			zap.String("plane_id", req.GetPlaneId()),
			zap.Error(dbErr),
		)
	}

	return &lanternv1.DpHeartbeatAck{Ok: true}, nil
}

// ---------- ReportMetrics ----------

// ReportMetrics validates the session token and acknowledges the metrics report.
// Metrics values are logged; dashboard persistence is a future extension.
func (s *DataPlaneService) ReportMetrics(ctx context.Context, req *lanternv1.DpMetricsReport) (*lanternv1.DpMetricsAck, error) {
	c, err := s.verifyAndMatchToken(req.GetSessionToken(), req.GetPlaneId())
	if err != nil {
		return nil, err
	}

	// Update agent_count from the metrics report (same column used by Heartbeat).
	_, dbErr := s.srv.Pool.Exec(ctx, `
		UPDATE data_planes
		SET last_heartbeat = now(),
		    agent_count    = $2
		WHERE id = $1 AND tenant_id = $3
	`, req.GetPlaneId(), req.GetActiveRuns(), c.TenantID)
	if dbErr != nil {
		s.logger().Warn("report_metrics: update failed",
			zap.String("plane_id", req.GetPlaneId()),
			zap.Error(dbErr),
		)
	}

	s.logger().Debug("metrics received",
		zap.String("plane_id", req.GetPlaneId()),
		zap.Float64("cpu_pct", req.GetCpuPct()),
		zap.Float64("mem_pct", req.GetMemPct()),
		zap.Int32("active_runs", req.GetActiveRuns()),
	)

	return &lanternv1.DpMetricsAck{Ok: true}, nil
}

// ---------- RefreshToken ----------

// RefreshToken issues a new session token from a still-valid one.
func (s *DataPlaneService) RefreshToken(_ context.Context, req *lanternv1.DpRefreshTokenRequest) (*lanternv1.DpRefreshTokenResponse, error) {
	c, err := s.verifyAndMatchToken(req.GetSessionToken(), req.GetPlaneId())
	if err != nil {
		return nil, err
	}

	newToken, err := s.issueSessionToken(c.TenantID, c.PlaneID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to refresh token")
	}

	return &lanternv1.DpRefreshTokenResponse{
		SessionToken:  newToken,
		ExpiresAtUnix: time.Now().Add(dpSessionTTL).Unix(),
	}, nil
}

// ---------- RunStream ----------

// Idle-stream constants.
const (
	// pingInterval is how often the server sends a DpPing to the client.
	pingInterval = 20 * time.Second
	// maxMissedPings is the number of consecutive unanswered pings before the
	// stream is considered dead and terminated (M1 idle-timeout fix).
	maxMissedPings = 3
)

// RunStream is the bidirectional run-dispatch stream.
// The first client frame MUST be DpHello; any other frame causes the stream
// to be aborted with Unauthenticated. The stream then:
//   - receives client frames (RunAccepted, RunStatusUpdate, RunCompleted, Pong)
//   - sends server frames (DpRunAssignment from the registry channel, DpPing)
//
// H2: at most maxRunStreamsPerTenant() concurrent RunStream connections are
// allowed per tenant; excess connections are rejected ResourceExhausted.
//
// M1: if maxMissedPings consecutive pings go unanswered the stream is closed.
func (s *DataPlaneService) RunStream(stream lanternv1.DataPlaneService_RunStreamServer) error {
	ctx := stream.Context()

	// --- Authenticate: first frame must be DpHello ---
	firstMsg, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.Unauthenticated, "stream recv failed on hello: %v", err)
	}
	hello := firstMsg.GetHello()
	if hello == nil {
		return status.Errorf(codes.Unauthenticated, "first frame must be DpHello")
	}
	c, err := s.verifyAndMatchToken(hello.GetSessionToken(), hello.GetPlaneId())
	if err != nil {
		return err
	}

	planeID := c.PlaneID
	tenantID := c.TenantID

	s.logger().Info("run stream opened",
		zap.String("plane_id", planeID),
		zap.String("tenant_id", tenantID),
	)

	// H2: enforce per-tenant RunStream connection cap.
	cap := maxRunStreamsPerTenant()
	assignCh := make(chan *lanternv1.DpRunAssignment, 8)
	deregister, ok := s.Registry.tryRegister(tenantID, planeID, assignCh, cap)
	if !ok {
		s.logger().Warn("run stream: per-tenant cap exceeded",
			zap.String("plane_id", planeID),
			zap.String("tenant_id", tenantID),
			zap.Int("cap", cap),
		)
		return status.Errorf(codes.ResourceExhausted,
			"too many concurrent RunStream connections for tenant (max %d)", cap)
	}
	defer deregister()

	// ping ticker — keepalive in the server→client direction.
	pingTicker := time.NewTicker(pingInterval)
	defer pingTicker.Stop()

	// missedPings tracks consecutive pings with no Pong received (M1).
	missedPings := 0

	// recvCh carries frames from the blocking Recv goroutine.
	type clientFrame struct {
		msg *lanternv1.DpRunStreamClientMsg
		err error
	}
	recvCh := make(chan clientFrame, 4)

	go func() {
		for {
			msg, err := stream.Recv()
			recvCh <- clientFrame{msg: msg, err: err}
			if err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			s.logger().Info("run stream closed (ctx done)",
				zap.String("plane_id", planeID),
			)
			return ctx.Err()

		case frame := <-recvCh:
			if frame.err != nil {
				s.logger().Info("run stream closed by client",
					zap.String("plane_id", planeID),
					zap.Error(frame.err),
				)
				return nil
			}
			// Reset missed-ping counter on any client frame, including Pong.
			missedPings = 0
			s.handleClientFrame(ctx, tenantID, planeID, frame.msg)

		case a := <-assignCh:
			if err := stream.Send(&lanternv1.DpRunStreamServerMsg{
				Msg: &lanternv1.DpRunStreamServerMsg_Assignment{Assignment: a},
			}); err != nil {
				s.logger().Warn("run stream: send assignment failed",
					zap.String("plane_id", planeID),
					zap.String("run_id", a.GetRunId()),
					zap.Error(err),
				)
				return err
			}
			s.logger().Info("run stream: assignment sent",
				zap.String("plane_id", planeID),
				zap.String("run_id", a.GetRunId()),
			)

		case <-pingTicker.C:
			missedPings++
			if missedPings > maxMissedPings {
				s.logger().Warn("run stream: idle timeout — too many missed pings",
					zap.String("plane_id", planeID),
					zap.Int("missed_pings", missedPings),
				)
				return status.Errorf(codes.DeadlineExceeded,
					"idle timeout: %d consecutive pings unanswered", missedPings)
			}
			if err := stream.Send(&lanternv1.DpRunStreamServerMsg{
				Msg: &lanternv1.DpRunStreamServerMsg_Ping{Ping: &lanternv1.DpPing{}},
			}); err != nil {
				s.logger().Warn("run stream: ping failed",
					zap.String("plane_id", planeID),
					zap.Error(err),
				)
				return err
			}
		}
	}
}

// handleClientFrame dispatches an authenticated RunStream client message.
// Tenant isolation is enforced: status/completion writes are scoped to tenantID.
func (s *DataPlaneService) handleClientFrame(ctx context.Context, tenantID, planeID string, msg *lanternv1.DpRunStreamClientMsg) {
	switch v := msg.GetMsg().(type) {
	case *lanternv1.DpRunStreamClientMsg_Accepted:
		// Agent confirmed receipt of the assignment; optionally update run status.
		runID := v.Accepted.GetRunId()
		s.logger().Debug("run accepted",
			zap.String("plane_id", planeID),
			zap.String("run_id", runID),
		)
		// Mark the run as running once accepted by the data plane.
		s.updateRunStatus(ctx, tenantID, planeID, runID, "running", "")

	case *lanternv1.DpRunStreamClientMsg_Status:
		upd := v.Status
		runID := upd.GetRunId()
		detail := upd.GetDetail()
		runStatus := dpRunStatusToString(upd.GetStatus())
		s.logger().Debug("run status update",
			zap.String("plane_id", planeID),
			zap.String("run_id", runID),
			zap.String("status", runStatus),
		)
		s.updateRunStatus(ctx, tenantID, planeID, runID, runStatus, detail)

	case *lanternv1.DpRunStreamClientMsg_Completed:
		comp := v.Completed
		runID := comp.GetRunId()
		finalStatus := dpRunStatusToString(comp.GetStatus())
		s.logger().Info("run completed",
			zap.String("plane_id", planeID),
			zap.String("run_id", runID),
			zap.String("status", finalStatus),
			zap.Float64("cost_usd", comp.GetCostUsd()),
		)
		s.finalizeRun(ctx, tenantID, planeID, runID, finalStatus, comp)

	case *lanternv1.DpRunStreamClientMsg_Pong:
		// Nothing to do — pong confirms the stream is alive.

	default:
		s.logger().Warn("run stream: unexpected client frame type",
			zap.String("plane_id", planeID),
		)
	}
}

// RouteRun attempts to place a queued run on a connected data plane for the
// tenant. On success it pins runs.data_plane_id to the chosen plane (so the
// inbound status/completion frames from that plane match the WHERE guards in
// updateRunStatus/finalizeRun) and pushes a DpRunAssignment down the plane's
// RunStream. It returns (planeID, true) when the run was handed off — the
// caller MUST NOT also execute the run inline.
//
// It returns ("", false) — caller executes inline — when no plane is connected,
// or when the assignment could not be delivered (channel full / racing
// disconnect). In the delivery-failure case the data_plane_id pin is rolled
// back so the inline path's own writes aren't blocked by a stale plane scope.
func (s *DataPlaneService) RouteRun(ctx context.Context, runID, tenantID, agentVersionID, inputJSON string) (string, bool) {
	if runID == "" || tenantID == "" {
		return "", false
	}
	planeID, ok := s.Registry.PlaneForTenant(tenantID)
	if !ok {
		return "", false
	}

	// Pin the run to the plane (RLS backstop via the tenant GUC). Only a still-
	// queued, not-yet-pinned run is eligible, so a re-dispatch can't hijack a run
	// already executing inline or on another plane.
	pinned := false
	err := db.WithTenantConn(ctx, s.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, `
			UPDATE runs
			SET data_plane_id = $1
			WHERE id            = $2
			  AND tenant_id     = $3
			  AND status        = 'queued'
			  AND data_plane_id IS NULL
		`, planeID, runID, tenantID)
		if e == nil {
			pinned = ct.RowsAffected() == 1
		}
		return e
	})
	if err != nil {
		s.logger().Warn("RouteRun: pin data_plane_id failed",
			zap.String("run_id", runID), zap.String("tenant_id", tenantID), zap.Error(err))
		return "", false
	}
	if !pinned {
		// Run is no longer queued/unpinned (raced with another dispatch). Leave it
		// to whoever owns it; don't double-execute.
		return "", false
	}

	assignment := &lanternv1.DpRunAssignment{
		RunId:          runID,
		AgentVersionId: agentVersionID,
		TenantId:       tenantID,
		InputJson:      inputJSON,
	}
	if s.Registry.Send(tenantID, planeID, assignment) {
		s.logger().Info("run routed to data plane",
			zap.String("run_id", runID),
			zap.String("tenant_id", tenantID),
			zap.String("plane_id", planeID),
		)
		return planeID, true
	}

	// Delivery failed (channel full). Send's select/default branch did NOT enqueue
	// the assignment, so the plane never receives it — there is no double-execution
	// window here. Roll back the pin so the inline fallback isn't scoped out by a
	// plane that never got the run.
	//
	// (The other failure mode — Send succeeds, then the plane disconnects before
	// draining its buffer — leaves the run pinned but un-executed. That is caught
	// by the recovery sweep, which re-drives queued/running runs lacking a live
	// lease. See recovery.go.)
	_ = db.WithTenantConn(ctx, s.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runs SET data_plane_id = NULL
			WHERE id = $1 AND tenant_id = $2 AND data_plane_id = $3 AND status = 'queued'
		`, runID, tenantID, planeID)
		return e
	})
	s.logger().Warn("RouteRun: plane connected but assignment undeliverable; falling back to inline",
		zap.String("run_id", runID), zap.String("plane_id", planeID))
	return "", false
}

// updateRunStatus updates a run's status in the runs table, scoped to both
// tenantID and planeID so a rogue plane cannot forge results for another plane's
// runs. Terminal states are never overwritten (idempotent).
//
// data_plane_id is pinned by RouteRun at dispatch time; the WHERE clause below
// matches only rows routed to this plane, so a plane can never forge results for
// a run it wasn't assigned (or for an inline run, where the column stays NULL).
func (s *DataPlaneService) updateRunStatus(ctx context.Context, tenantID, planeID, runID, runStatus, detail string) {
	if runID == "" {
		return
	}
	// detail is logged but not yet persisted — the runs table has no detail column.
	_ = detail
	// RLS backstop: run the write under the tenant GUC so the runs RLS policy
	// applies even if the explicit tenant_id predicate were ever dropped. The
	// WHERE clause still scopes to (run, tenant, plane) and refuses terminal states.
	err := db.WithTenantConn(ctx, s.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runs
			SET status = $1
			WHERE id          = $2
			  AND tenant_id   = $3
			  AND data_plane_id = $4
			  AND status NOT IN ('completed', 'failed', 'cancelled')
		`, runStatus, runID, tenantID, planeID)
		return e
	})
	if err != nil {
		s.logger().Warn("updateRunStatus: db exec failed",
			zap.String("run_id", runID),
			zap.String("tenant_id", tenantID),
			zap.String("plane_id", planeID),
			zap.Error(err),
		)
	}
}

// finalizeRun updates a run's status and cost fields on completion, scoped to
// both tenantID and planeID. Terminal states are never overwritten.
func (s *DataPlaneService) finalizeRun(ctx context.Context, tenantID, planeID, runID, finalStatus string, comp *lanternv1.DpRunCompleted) {
	if runID == "" {
		return
	}
	// RLS backstop: write under the tenant GUC (see updateRunStatus).
	err := db.WithTenantConn(ctx, s.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE runs
			SET status       = $1,
			    output       = $2::jsonb,
			    cost_usd     = $3,
			    tokens_in    = $4,
			    tokens_out   = $5,
			    finished_at  = now()
			WHERE id            = $6
			  AND tenant_id     = $7
			  AND data_plane_id = $8
			  AND status NOT IN ('completed', 'failed', 'cancelled')
		`, finalStatus,
			nullableJSON(comp.GetOutputJson()),
			comp.GetCostUsd(),
			comp.GetTokensIn(),
			comp.GetTokensOut(),
			runID,
			tenantID,
			planeID,
		)
		return e
	})
	if err != nil {
		s.logger().Warn("finalizeRun: db exec failed",
			zap.String("run_id", runID),
			zap.String("tenant_id", tenantID),
			zap.String("plane_id", planeID),
			zap.Error(err),
		)
	}
}

// ---------- Helpers ----------

// hashToken returns hex(sha256(token)).
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// dpRunStatusToString maps proto DpRunStatus to the string used in the runs table.
func dpRunStatusToString(s lanternv1.DpRunStatus) string {
	switch s {
	case lanternv1.DpRunStatus_DP_RUN_STATUS_ACCEPTED:
		return "queued"
	case lanternv1.DpRunStatus_DP_RUN_STATUS_RUNNING:
		return "running"
	case lanternv1.DpRunStatus_DP_RUN_STATUS_SUCCEEDED:
		return "completed"
	case lanternv1.DpRunStatus_DP_RUN_STATUS_FAILED:
		return "failed"
	case lanternv1.DpRunStatus_DP_RUN_STATUS_CANCELLED:
		return "cancelled"
	case lanternv1.DpRunStatus_DP_RUN_STATUS_TIMED_OUT:
		return "failed"
	default:
		return "running"
	}
}

// nullableJSON returns nil for an empty string (so the DB stores NULL) or the
// raw string for non-empty JSON (stored as jsonb).
func nullableJSON(s string) any {
	if s == "" {
		return nil
	}
	return s
}
