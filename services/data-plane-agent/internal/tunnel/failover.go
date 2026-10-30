package tunnel

// Multi-region control-plane failover (ADR 0046).
//
// The agent is given an ordered list of control-plane endpoints, one per
// region, primary first. A standby region runs in read-only mode and reports
// lantern.v1.DataPlaneService NOT_SERVING on the standard gRPC health service,
// so "first endpoint that reports SERVING" is exactly "the active region".
// After a failover the promoted region flips to SERVING and the agent moves to
// it on its next reconnect; once a higher-priority region is healthy again the
// agent fails back to it.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
)

// errFailback ends a session on a fallback endpoint so Run reconnects to a
// higher-priority one immediately (no backoff).
var errFailback = errors.New("higher-priority control plane is healthy again; failing back")

const (
	dataPlaneHealthService = "lantern.v1.DataPlaneService"
	healthCheckTimeout     = 3 * time.Second
	// failbackHealthyProbes consecutive healthy probes are required before
	// failing back, so a flapping primary doesn't bounce every agent.
	failbackHealthyProbes = 2
)

func (t *Tunnel) endpoints() []string {
	if len(t.cfg.ControlPlaneEndpoints) > 0 {
		return t.cfg.ControlPlaneEndpoints
	}
	return []string{t.cfg.ControlPlaneEndpoint}
}

func (t *Tunnel) dialOpts() []grpc.DialOption {
	creds := insecure.NewCredentials()
	if !t.cfg.TLSInsecureSkipVerify {
		creds = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS13})
	}
	return []grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
	}
}

// healthy reports whether endpoint serves the data-plane tunnel service.
// Any error (unreachable, timeout, unknown service, NOT_SERVING) is unhealthy.
func (t *Tunnel) healthy(ctx context.Context, endpoint string) bool {
	conn, err := grpc.NewClient(endpoint, t.dialOpts()...)
	if err != nil {
		return false
	}
	defer conn.Close() //nolint:errcheck
	ctx, cancel := context.WithTimeout(ctx, healthCheckTimeout)
	defer cancel()
	resp, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{Service: dataPlaneHealthService})
	return err == nil && resp.GetStatus() == healthpb.HealthCheckResponse_SERVING
}

// selectEndpoint returns the index of the first healthy endpoint in priority
// order. With a single endpoint it returns 0 without probing — unchanged
// single-region behaviour (the Register call is the health check).
func (t *Tunnel) selectEndpoint(ctx context.Context) (int, error) {
	eps := t.endpoints()
	if len(eps) == 1 {
		return 0, nil
	}
	for i, ep := range eps {
		if t.healthy(ctx, ep) {
			return i, nil
		}
		t.logger.Warn("control-plane endpoint unhealthy, trying next", zap.String("endpoint", ep), zap.Int("priority", i))
	}
	return -1, fmt.Errorf("no healthy control-plane endpoint among %d", len(eps))
}

// watchFailback runs for the life of a session on endpoint idx. When idx > 0
// it probes the higher-priority endpoints every FailbackInterval and ends the
// session with errFailback once one is healthy for failbackHealthyProbes
// consecutive probes.
func (t *Tunnel) watchFailback(ctx context.Context, idx int, cancel context.CancelCauseFunc) {
	if idx == 0 {
		return
	}
	eps := t.endpoints()
	streak := make([]int, idx)
	ticker := time.NewTicker(t.cfg.FailbackInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		for i := 0; i < idx; i++ {
			if !t.healthy(ctx, eps[i]) {
				streak[i] = 0
				continue
			}
			streak[i]++
			if streak[i] >= failbackHealthyProbes {
				t.logger.Info("failing back to higher-priority control plane",
					zap.String("endpoint", eps[i]), zap.String("from", eps[idx]))
				cancel(errFailback)
				return
			}
		}
	}
}
