// Package tunnel manages the persistent gRPC connection between the data plane
// agent and the PAL control plane. It handles connection establishment,
// reconnection with exponential backoff, registration, heartbeats, metrics
// reporting, token refresh, and bidirectional run-dispatch via RunStream.
package tunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
)

var tracer = otel.Tracer("pal.data-plane-agent.tunnel")

// Config holds the tunnel configuration.
type Config struct {
	ControlPlaneEndpoint string
	// ControlPlaneEndpoints is an ordered, priority-first list of control-plane
	// endpoints for multi-region failover (ADR 0046). When it has more than one
	// entry the tunnel connects to the first one whose gRPC health check reports
	// pal.v1.DataPlaneService SERVING, and fails back to a higher-priority
	// endpoint once it is healthy again. Empty → ControlPlaneEndpoint only, with
	// no health probing (the single-region behaviour).
	ControlPlaneEndpoints []string
	// FailbackInterval is how often a tunnel connected to a lower-priority
	// endpoint probes the higher-priority ones. Zero → 60s.
	FailbackInterval      time.Duration
	TenantID              string
	AgentToken            string
	AgentVersion          string
	HeartbeatInterval     time.Duration
	MetricsInterval       time.Duration
	TokenRefreshBefore    time.Duration // refresh token this long before expiry
	ReconnectInitialDelay time.Duration
	ReconnectMaxDelay     time.Duration
	ReconnectJitterPct    int
	TLSInsecureSkipVerify bool
}

// Status represents the current state of the tunnel.
type Status struct {
	Connected     bool
	Endpoint      string // control-plane endpoint of the current session
	PlaneID       string
	TenantID      string
	Uptime        time.Duration
	ActiveRuns    int
	LastHeartbeat time.Time
}

// Dispatcher is called when the control plane sends a run assignment.
type Dispatcher interface {
	DispatchRun(ctx context.Context, assignment *RunAssignment) error
	ActiveRunCount() int
}

// Reporter is called to send status updates and metrics back to the control plane.
type Reporter interface {
	OnRunStatusChange(runID, status string, metadata map[string]string)
	OnMetrics(metrics *MetricsSnapshot)
	DrainPending() []PendingReport
}

// RunAssignment represents a run dispatched from the control plane.
type RunAssignment struct {
	RunID          string
	AgentVersionID string
	TenantID       string
	Config         map[string]string
}

// MetricsSnapshot holds periodic metrics to report.
type MetricsSnapshot struct {
	ActiveRuns    int
	QueueDepth    int
	CPUPercent    float64
	MemoryPercent float64
}

// PendingReport is a queued status update that could not be sent during disconnection.
type PendingReport struct {
	RunID    string
	Status   string
	Metadata map[string]string
	Time     time.Time
}

// sessionState holds mutable auth material updated atomically after each
// Register / RefreshToken call.
type sessionState struct {
	mu           sync.RWMutex
	planeID      string
	sessionToken string
	tokenExpiry  time.Time
}

func (s *sessionState) set(planeID, token string, expiry time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.planeID = planeID
	s.sessionToken = token
	s.tokenExpiry = expiry
}

func (s *sessionState) get() (planeID, token string, expiry time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.planeID, s.sessionToken, s.tokenExpiry
}

// Tunnel manages the gRPC connection to the control plane.
type Tunnel struct {
	cfg        Config
	dispatcher Dispatcher
	reporter   Reporter
	logger     *zap.Logger

	conn     *grpc.ClientConn
	session  sessionState
	endpoint atomic.Value // string: endpoint of the current session

	connected atomic.Bool
	startTime time.Time

	lastHeartbeat atomic.Value // time.Time

	// draining is set to true when the control plane asks this plane to drain.
	draining atomic.Bool

	shutdownCh chan struct{}
}

// New creates a new Tunnel.
func New(cfg Config, dispatcher Dispatcher, reporter Reporter, logger *zap.Logger) *Tunnel {
	if cfg.MetricsInterval == 0 {
		cfg.MetricsInterval = 60 * time.Second
	}
	if cfg.TokenRefreshBefore == 0 {
		cfg.TokenRefreshBefore = 10 * time.Minute
	}
	t := &Tunnel{
		cfg:        cfg,
		dispatcher: dispatcher,
		reporter:   reporter,
		logger:     logger.Named("tunnel"),
		shutdownCh: make(chan struct{}),
		startTime:  time.Now(),
	}
	if cfg.FailbackInterval == 0 {
		t.cfg.FailbackInterval = 60 * time.Second
	}
	t.lastHeartbeat.Store(time.Time{})
	t.endpoint.Store("")
	return t
}

// IsConnected returns true if the tunnel is currently connected to the control plane.
func (t *Tunnel) IsConnected() bool {
	return t.connected.Load()
}

// IsInDrain returns true when the control plane has asked this plane to drain.
func (t *Tunnel) IsInDrain() bool {
	return t.draining.Load()
}

// Status returns the current tunnel status.
func (t *Tunnel) Status() Status {
	planeID, _, _ := t.session.get()
	lastHB, _ := t.lastHeartbeat.Load().(time.Time)
	return Status{
		Connected:     t.connected.Load(),
		Endpoint:      t.endpoint.Load().(string),
		PlaneID:       planeID,
		TenantID:      t.cfg.TenantID,
		Uptime:        time.Since(t.startTime),
		ActiveRuns:    t.dispatcher.ActiveRunCount(),
		LastHeartbeat: lastHB,
	}
}

// Run starts the tunnel and blocks until the context is cancelled. It handles
// reconnection with exponential backoff.
func (t *Tunnel) Run(ctx context.Context) error {
	delay := t.cfg.ReconnectInitialDelay

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.shutdownCh:
			return nil
		default:
		}

		err := t.connectAndServe(ctx)
		if err == nil {
			// Clean shutdown.
			return nil
		}
		if errors.Is(err, errFailback) {
			// A higher-priority control plane is healthy again: reconnect now.
			t.connected.Store(false)
			delay = t.cfg.ReconnectInitialDelay
			continue
		}
		if errors.Is(err, context.Canceled) {
			return err
		}

		t.connected.Store(false)
		t.logger.Warn("tunnel disconnected, reconnecting",
			zap.Error(err),
			zap.Duration("delay", delay),
		)

		// Exponential backoff with jitter.
		jitter := time.Duration(float64(delay) * float64(t.cfg.ReconnectJitterPct) / 100.0 * (2*rand.Float64() - 1))
		sleepDuration := delay + jitter
		if sleepDuration < 0 {
			sleepDuration = t.cfg.ReconnectInitialDelay
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.shutdownCh:
			return nil
		case <-time.After(sleepDuration):
		}

		// Double the delay, capped at max.
		delay *= 2
		if delay > t.cfg.ReconnectMaxDelay {
			delay = t.cfg.ReconnectMaxDelay
		}
	}
}

// Shutdown gracefully stops the tunnel.
func (t *Tunnel) Shutdown() {
	close(t.shutdownCh)
	if t.conn != nil {
		t.conn.Close()
	}
}

// connectAndServe establishes the gRPC connection, registers with the control
// plane, and runs the heartbeat + message loop. It returns when the connection
// is lost or the context is cancelled.
func (t *Tunnel) connectAndServe(ctx context.Context) error {
	ctx, span := tracer.Start(ctx, "tunnel.connectAndServe")
	defer span.End()

	// --- Pick the endpoint (multi-region: first healthy in priority order) ---
	idx, err := t.selectEndpoint(ctx)
	if err != nil {
		return err
	}
	endpoint := t.endpoints()[idx]

	// --- Dial the control plane ---
	t.logger.Info("connecting to control plane",
		zap.String("endpoint", endpoint),
		zap.Int("priority", idx),
		zap.String("tenant_id", t.cfg.TenantID),
	)

	conn, err := grpc.NewClient(endpoint, t.dialOpts()...)
	if err != nil {
		return fmt.Errorf("dial control plane: %w", err)
	}
	t.conn = conn
	defer conn.Close() //nolint:errcheck // a superseded session's connection must not leak

	// The session ends early, with cause errFailback, if a higher-priority
	// endpoint becomes healthy while we're on a fallback.
	ctx, cancelSession := context.WithCancelCause(ctx)
	defer cancelSession(nil)
	go t.watchFailback(ctx, idx, cancelSession)

	dpClient := palv1.NewDataPlaneServiceClient(conn)

	// --- Register ---
	planeID, sessionToken, tokenExpiry, err := t.register(ctx, dpClient)
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}
	t.session.set(planeID, sessionToken, tokenExpiry)
	t.endpoint.Store(endpoint)
	t.connected.Store(true)

	span.SetAttributes(
		attribute.String("plane_id", planeID),
		attribute.String("tenant_id", t.cfg.TenantID),
	)

	t.logger.Info("registered with control plane",
		zap.String("plane_id", planeID),
		zap.String("tenant_id", t.cfg.TenantID),
	)

	// --- Drain pending reports ---
	// These are reports queued during a prior disconnection. On reconnect, the
	// RunStream will be re-opened and the dispatcher will re-send them via the
	// stream. For now we log them so nothing is silently lost.
	pending := t.reporter.DrainPending()
	for _, p := range pending {
		t.logger.Info("draining queued status update",
			zap.String("run_id", p.RunID),
			zap.String("status", p.Status),
		)
	}

	// --- Run the heartbeat + run-stream loop ---
	err = t.messageLoop(ctx, dpClient)
	if errors.Is(context.Cause(ctx), errFailback) {
		return errFailback
	}
	return err
}

// register calls DataPlaneService.Register and returns (planeID, sessionToken, expiry).
func (t *Tunnel) register(ctx context.Context, client palv1.DataPlaneServiceClient) (planeID, sessionToken string, expiry time.Time, err error) {
	ctx, span := tracer.Start(ctx, "tunnel.register")
	defer span.End()

	if t.cfg.TenantID == "" {
		return "", "", time.Time{}, fmt.Errorf("tenant_id is required")
	}
	if t.cfg.AgentToken == "" {
		return "", "", time.Time{}, fmt.Errorf("agent_token is required")
	}

	req := &palv1.DpRegisterRequest{
		TenantId:     t.cfg.TenantID,
		AgentToken:   t.cfg.AgentToken,
		AgentVersion: t.cfg.AgentVersion,
		Hostname:     hostname(),
		Os:           goOS(),
		Arch:         goArch(),
	}

	resp, err := client.Register(ctx, req)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("Register RPC: %w", err)
	}

	planeID = resp.GetPlaneId()
	sessionToken = resp.GetSessionToken()
	// The control plane issues 1-hour tokens; we don't have the exact expiry in
	// the response, so estimate from now + 1h minus our refresh-before window.
	expiry = time.Now().Add(time.Hour)

	span.SetAttributes(attribute.String("plane_id", planeID))
	return planeID, sessionToken, expiry, nil
}

// messageLoop runs the heartbeat ticker, metrics ticker, token refresh, and
// the RunStream — all concurrently inside a single select loop.
func (t *Tunnel) messageLoop(ctx context.Context, client palv1.DataPlaneServiceClient) error {
	heartbeatTicker := time.NewTicker(t.cfg.HeartbeatInterval)
	defer heartbeatTicker.Stop()

	metricsTicker := time.NewTicker(t.cfg.MetricsInterval)
	defer metricsTicker.Stop()

	// Check token expiry every minute.
	tokenRefreshTicker := time.NewTicker(time.Minute)
	defer tokenRefreshTicker.Stop()

	// Open the RunStream.
	streamErrCh := make(chan error, 1)
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()

	go func() {
		streamErrCh <- t.runStream(streamCtx, client)
	}()

	for {
		select {
		case <-ctx.Done():
			cancelStream()
			return ctx.Err()

		case <-t.shutdownCh:
			cancelStream()
			return nil

		case err := <-streamErrCh:
			// RunStream exited — return so the outer loop reconnects.
			if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
				t.logger.Warn("run stream exited with error", zap.Error(err))
			}
			return fmt.Errorf("run stream closed: %w", err)

		case <-heartbeatTicker.C:
			if err := t.sendHeartbeat(ctx, client); err != nil {
				t.logger.Warn("heartbeat failed", zap.Error(err))
				cancelStream()
				return fmt.Errorf("heartbeat: %w", err)
			}

		case <-metricsTicker.C:
			t.sendMetrics(ctx, client)

		case <-tokenRefreshTicker.C:
			_, _, expiry := t.session.get()
			if time.Until(expiry) < t.cfg.TokenRefreshBefore {
				if err := t.refreshToken(ctx, client); err != nil {
					t.logger.Warn("token refresh failed", zap.Error(err))
					// Non-fatal for now; the stream will fail on next RPC if expired.
				}
			}
		}
	}
}

// sendHeartbeat calls DataPlaneService.Heartbeat.
func (t *Tunnel) sendHeartbeat(ctx context.Context, client palv1.DataPlaneServiceClient) error {
	ctx, span := tracer.Start(ctx, "tunnel.heartbeat")
	defer span.End()

	planeID, sessionToken, _ := t.session.get()
	activeRuns := int32(t.dispatcher.ActiveRunCount())

	resp, err := client.Heartbeat(ctx, &palv1.DpHeartbeatRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
		ActiveRuns:   activeRuns,
	})
	if err != nil {
		return fmt.Errorf("Heartbeat RPC: %w", err)
	}

	if resp.GetDraining() {
		t.draining.Store(true)
		t.logger.Info("control plane requested drain — no new runs accepted")
	}

	t.lastHeartbeat.Store(time.Now())
	t.logger.Debug("heartbeat ok",
		zap.String("plane_id", planeID),
		zap.Int32("active_runs", activeRuns),
		zap.Bool("draining", resp.GetDraining()),
	)
	return nil
}

// sendMetrics calls DataPlaneService.ReportMetrics.
func (t *Tunnel) sendMetrics(ctx context.Context, client palv1.DataPlaneServiceClient) {
	_, span := tracer.Start(ctx, "tunnel.metrics")
	defer span.End()

	planeID, sessionToken, _ := t.session.get()
	activeRuns := t.dispatcher.ActiveRunCount()

	metrics := &MetricsSnapshot{
		ActiveRuns: activeRuns,
		QueueDepth: 0, // populated by the dispatcher in a future iteration
	}
	t.reporter.OnMetrics(metrics)

	_, err := client.ReportMetrics(ctx, &palv1.DpMetricsReport{
		PlaneId:      planeID,
		SessionToken: sessionToken,
		ActiveRuns:   int32(activeRuns),
		Ts:           timestamppb.Now(),
	})
	if err != nil {
		t.logger.Warn("ReportMetrics RPC failed", zap.Error(err))
	} else {
		t.logger.Debug("metrics reported", zap.Int("active_runs", activeRuns))
	}
}

// refreshToken calls DataPlaneService.RefreshToken and stores the new token.
func (t *Tunnel) refreshToken(ctx context.Context, client palv1.DataPlaneServiceClient) error {
	_, span := tracer.Start(ctx, "tunnel.refreshToken")
	defer span.End()

	planeID, sessionToken, _ := t.session.get()

	resp, err := client.RefreshToken(ctx, &palv1.DpRefreshTokenRequest{
		PlaneId:      planeID,
		SessionToken: sessionToken,
	})
	if err != nil {
		return fmt.Errorf("RefreshToken RPC: %w", err)
	}

	expiry := time.Unix(resp.GetExpiresAtUnix(), 0)
	t.session.set(planeID, resp.GetSessionToken(), expiry)

	t.logger.Info("session token refreshed",
		zap.String("plane_id", planeID),
		zap.Time("new_expiry", expiry),
	)
	return nil
}

// runStream opens the DataPlaneService.RunStream bidi stream, sends DpHello,
// then loops: receiving server frames (assignments, pings) and sending client
// frames (accepted, status, completed, pongs).
func (t *Tunnel) runStream(ctx context.Context, client palv1.DataPlaneServiceClient) error {
	planeID, sessionToken, _ := t.session.get()

	stream, err := client.RunStream(ctx)
	if err != nil {
		return fmt.Errorf("RunStream open: %w", err)
	}

	// First frame: DpHello to authenticate the stream.
	if err := stream.Send(&palv1.DpRunStreamClientMsg{
		Msg: &palv1.DpRunStreamClientMsg_Hello{
			Hello: &palv1.DpHello{
				PlaneId:      planeID,
				SessionToken: sessionToken,
			},
		},
	}); err != nil {
		return fmt.Errorf("send DpHello: %w", err)
	}

	t.logger.Info("run stream authenticated",
		zap.String("plane_id", planeID),
	)

	for {
		msg, err := stream.Recv()
		if err != nil {
			st, ok := status.FromError(err)
			if ok && st.Code() == codes.Canceled {
				return context.Canceled
			}
			if errors.Is(err, io.EOF) {
				return io.EOF
			}
			return fmt.Errorf("stream.Recv: %w", err)
		}

		switch v := msg.GetMsg().(type) {
		case *palv1.DpRunStreamServerMsg_Assignment:
			t.handleAssignment(ctx, stream, v.Assignment)

		case *palv1.DpRunStreamServerMsg_Ping:
			if err := stream.Send(&palv1.DpRunStreamClientMsg{
				Msg: &palv1.DpRunStreamClientMsg_Pong{Pong: &palv1.DpPong{}},
			}); err != nil {
				return fmt.Errorf("send Pong: %w", err)
			}

		case *palv1.DpRunStreamServerMsg_Cancel:
			t.logger.Info("run cancel received",
				zap.String("run_id", v.Cancel.GetRunId()),
			)
			// Cancellation plumbing is a future step; log for now.
		}
	}
}

// handleAssignment dispatches a run assignment from the control plane.
func (t *Tunnel) handleAssignment(
	ctx context.Context,
	stream palv1.DataPlaneService_RunStreamClient,
	a *palv1.DpRunAssignment,
) {
	runID := a.GetRunId()

	// If draining, refuse the assignment (control plane should not be sending
	// new ones, but guard defensively).
	if t.draining.Load() {
		t.logger.Warn("rejecting assignment: plane is draining",
			zap.String("run_id", runID),
		)
		return
	}

	t.logger.Info("run assignment received",
		zap.String("run_id", runID),
		zap.String("agent_version_id", a.GetAgentVersionId()),
	)

	// Send RunAccepted before dispatching so the CP knows we have it.
	if err := stream.Send(&palv1.DpRunStreamClientMsg{
		Msg: &palv1.DpRunStreamClientMsg_Accepted{
			Accepted: &palv1.DpRunAccepted{RunId: runID},
		},
	}); err != nil {
		t.logger.Warn("send RunAccepted failed", zap.String("run_id", runID), zap.Error(err))
	}

	// Dispatch the run asynchronously so the stream loop isn't blocked.
	go func() {
		assignment := &RunAssignment{
			RunID:          runID,
			AgentVersionID: a.GetAgentVersionId(),
			TenantID:       a.GetTenantId(),
		}
		if err := t.dispatcher.DispatchRun(ctx, assignment); err != nil {
			t.logger.Error("dispatch run failed",
				zap.String("run_id", runID),
				zap.Error(err),
			)
			t.reporter.OnRunStatusChange(runID, "failed", map[string]string{
				"error": err.Error(),
			})
			return
		}

		// Signal completion (stub — real status arrives from the workflow engine
		// via the reporter in a future iteration).
		t.reporter.OnRunStatusChange(runID, "running", nil)
	}()
}
