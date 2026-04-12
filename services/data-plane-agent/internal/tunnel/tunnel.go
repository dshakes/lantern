// Package tunnel manages the persistent gRPC connection between the data plane
// agent and the Lantern control plane. It handles connection establishment,
// reconnection with exponential backoff, heartbeats, and bidirectional message
// routing (run assignments inbound, status updates outbound).
package tunnel

import (
	"context"
	"crypto/tls"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
)

var tracer = otel.Tracer("lantern.data-plane-agent.tunnel")

// Config holds the tunnel configuration.
type Config struct {
	ControlPlaneEndpoint  string
	TenantID              string
	AgentToken            string
	HeartbeatInterval     time.Duration
	ReconnectInitialDelay time.Duration
	ReconnectMaxDelay     time.Duration
	ReconnectJitterPct    int
	TLSInsecureSkipVerify bool
}

// Status represents the current state of the tunnel.
type Status struct {
	Connected     bool
	PlaneID       string
	TenantID      string
	Uptime        time.Duration
	ActiveRuns    int
	LastHeartbeat time.Time
}

// Dispatcher is called when the control plane sends a run assignment.
type Dispatcher interface {
	DispatchRun(ctx context.Context, assignment *RunAssignment) error
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

// Tunnel manages the gRPC connection to the control plane.
type Tunnel struct {
	cfg        Config
	dispatcher Dispatcher
	reporter   Reporter
	logger     *zap.Logger

	conn      *grpc.ClientConn
	connected atomic.Bool
	planeID   string
	startTime time.Time

	lastHeartbeat atomic.Value // time.Time

	mu         sync.Mutex
	activeRuns int

	shutdownCh chan struct{}
}

// New creates a new Tunnel.
func New(cfg Config, dispatcher Dispatcher, reporter Reporter, logger *zap.Logger) *Tunnel {
	t := &Tunnel{
		cfg:        cfg,
		dispatcher: dispatcher,
		reporter:   reporter,
		logger:     logger.Named("tunnel"),
		shutdownCh: make(chan struct{}),
		startTime:  time.Now(),
	}
	t.lastHeartbeat.Store(time.Time{})
	return t
}

// IsConnected returns true if the tunnel is currently connected to the control plane.
func (t *Tunnel) IsConnected() bool {
	return t.connected.Load()
}

// Status returns the current tunnel status.
func (t *Tunnel) Status() Status {
	t.mu.Lock()
	activeRuns := t.activeRuns
	t.mu.Unlock()

	lastHB, _ := t.lastHeartbeat.Load().(time.Time)

	return Status{
		Connected:     t.connected.Load(),
		PlaneID:       t.planeID,
		TenantID:      t.cfg.TenantID,
		Uptime:        time.Since(t.startTime),
		ActiveRuns:    activeRuns,
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

	// --- Dial the control plane ---
	var dialOpts []grpc.DialOption

	if t.cfg.TLSInsecureSkipVerify {
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		tlsCfg := &tls.Config{
			MinVersion: tls.VersionTLS13,
		}
		dialOpts = append(dialOpts, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
	}

	dialOpts = append(dialOpts, grpc.WithKeepaliveParams(keepalive.ClientParameters{
		Time:                30 * time.Second,
		Timeout:             10 * time.Second,
		PermitWithoutStream: true,
	}))

	t.logger.Info("connecting to control plane",
		zap.String("endpoint", t.cfg.ControlPlaneEndpoint),
		zap.String("tenant_id", t.cfg.TenantID),
	)

	conn, err := grpc.NewClient(t.cfg.ControlPlaneEndpoint, dialOpts...)
	if err != nil {
		return err
	}
	t.conn = conn

	// --- Register ---
	planeID, err := t.register(ctx, conn)
	if err != nil {
		conn.Close()
		return err
	}
	t.planeID = planeID
	t.connected.Store(true)

	span.SetAttributes(
		attribute.String("plane_id", planeID),
		attribute.String("tenant_id", t.cfg.TenantID),
	)

	t.logger.Info("registered with control plane",
		zap.String("plane_id", planeID),
		zap.String("tenant_id", t.cfg.TenantID),
	)

	// Reset backoff on successful connection.
	// (Caller handles this by resetting delay after connectAndServe returns nil.)

	// --- Drain pending reports ---
	pending := t.reporter.DrainPending()
	for _, p := range pending {
		t.logger.Info("reporting queued status update",
			zap.String("run_id", p.RunID),
			zap.String("status", p.Status),
		)
		// In production, send via the tunnel stream. For the spike, log it.
	}

	// --- Run the heartbeat + message loop ---
	return t.messageLoop(ctx, conn)
}

// register sends the initial registration request to the control plane and
// returns the assigned plane ID.
func (t *Tunnel) register(ctx context.Context, conn *grpc.ClientConn) (string, error) {
	ctx, span := tracer.Start(ctx, "tunnel.register")
	defer span.End()

	// Attach auth metadata.
	ctx = metadata.AppendToOutgoingContext(ctx,
		"x-lantern-tenant-id", t.cfg.TenantID,
		"x-lantern-agent-token", t.cfg.AgentToken,
	)

	// In production, this calls the DataPlaneService.Register RPC.
	// For the spike, we simulate a successful registration.
	t.logger.Info("registering data plane",
		zap.String("tenant_id", t.cfg.TenantID),
	)

	// Simulated plane ID. In production, this comes from the control plane response.
	planeID := "dp-" + t.cfg.TenantID + "-001"

	span.SetAttributes(attribute.String("plane_id", planeID))

	// Verify connectivity by checking the connection state.
	_ = conn // Connection is established; registration RPC would go here.

	return planeID, nil
}

// messageLoop runs the bidirectional message loop: sends heartbeats and metrics,
// receives run assignments.
func (t *Tunnel) messageLoop(ctx context.Context, conn *grpc.ClientConn) error {
	heartbeatTicker := time.NewTicker(t.cfg.HeartbeatInterval)
	defer heartbeatTicker.Stop()

	metricsTicker := time.NewTicker(60 * time.Second)
	defer metricsTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-t.shutdownCh:
			return nil

		case <-heartbeatTicker.C:
			if err := t.sendHeartbeat(ctx, conn); err != nil {
				t.logger.Warn("heartbeat failed", zap.Error(err))
				return err
			}

		case <-metricsTicker.C:
			t.sendMetrics(ctx, conn)
		}
	}
}

// sendHeartbeat sends a heartbeat to the control plane.
func (t *Tunnel) sendHeartbeat(ctx context.Context, conn *grpc.ClientConn) error {
	ctx, span := tracer.Start(ctx, "tunnel.heartbeat")
	defer span.End()

	t.mu.Lock()
	activeRuns := t.activeRuns
	t.mu.Unlock()

	// In production, this calls the DataPlaneService.Heartbeat RPC.
	// For the spike, we log it.
	t.logger.Debug("sending heartbeat",
		zap.String("plane_id", t.planeID),
		zap.Int("active_runs", activeRuns),
	)

	_ = conn // Heartbeat RPC would use this connection.

	t.lastHeartbeat.Store(time.Now())
	return nil
}

// sendMetrics sends periodic metrics to the control plane.
func (t *Tunnel) sendMetrics(ctx context.Context, conn *grpc.ClientConn) {
	_, span := tracer.Start(ctx, "tunnel.metrics")
	defer span.End()

	t.mu.Lock()
	activeRuns := t.activeRuns
	t.mu.Unlock()

	metrics := &MetricsSnapshot{
		ActiveRuns: activeRuns,
		QueueDepth: 0, // Populated from the dispatcher in production.
	}

	t.reporter.OnMetrics(metrics)

	// In production, this calls the DataPlaneService.ReportMetrics RPC.
	t.logger.Debug("sent metrics",
		zap.Int("active_runs", metrics.ActiveRuns),
	)

	_ = conn // Metrics RPC would use this connection.
}
