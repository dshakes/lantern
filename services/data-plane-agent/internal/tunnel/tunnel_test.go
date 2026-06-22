package tunnel_test

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

// stubDispatcher satisfies tunnel.Dispatcher for tests.
type stubDispatcher struct {
	dispatched []*tunnel.RunAssignment
}

func (s *stubDispatcher) DispatchRun(_ context.Context, a *tunnel.RunAssignment) error {
	s.dispatched = append(s.dispatched, a)
	return nil
}

func (s *stubDispatcher) ActiveRunCount() int { return len(s.dispatched) }

// stubReporter satisfies tunnel.Reporter for tests.
type stubReporter struct {
	changes []string
}

func (s *stubReporter) OnRunStatusChange(runID, st string, _ map[string]string) {
	s.changes = append(s.changes, runID+":"+st)
}

func (s *stubReporter) OnMetrics(_ *tunnel.MetricsSnapshot) {}

func (s *stubReporter) DrainPending() []tunnel.PendingReport { return nil }

func TestTunnel_Status_NotConnected(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	disp := &stubDispatcher{}
	rep := &stubReporter{}
	cfg := tunnel.Config{
		ControlPlaneEndpoint:  "localhost:9999",
		TenantID:              "tenant-1",
		AgentToken:            "tok",
		HeartbeatInterval:     30 * time.Second,
		ReconnectInitialDelay: 10 * time.Millisecond,
		ReconnectMaxDelay:     100 * time.Millisecond,
		ReconnectJitterPct:    10,
		TLSInsecureSkipVerify: true,
	}
	tun := tunnel.New(cfg, disp, rep, logger)
	s := tun.Status()
	if s.Connected {
		t.Error("expected Connected=false before any connection attempt")
	}
	if s.TenantID != "tenant-1" {
		t.Errorf("TenantID: got %q, want %q", s.TenantID, "tenant-1")
	}
}

// TestTunnel_ShutdownBeforeRun verifies that Shutdown() stops the tunnel
// immediately without connecting (unreachable endpoint).
func TestTunnel_ShutdownBeforeRun(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	disp := &stubDispatcher{}
	rep := &stubReporter{}
	cfg := tunnel.Config{
		ControlPlaneEndpoint:  "localhost:19999", // unreachable
		TenantID:              "tenant-1",
		AgentToken:            "tok",
		HeartbeatInterval:     30 * time.Second,
		ReconnectInitialDelay: 5 * time.Second, // long delay so we'd notice if it doesn't stop
		ReconnectMaxDelay:     30 * time.Second,
		ReconnectJitterPct:    10,
		TLSInsecureSkipVerify: true,
	}
	tun := tunnel.New(cfg, disp, rep, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- tun.Run(ctx) }()

	// Shut down before any reconnect attempt completes.
	tun.Shutdown()

	select {
	case <-errCh:
		// OK — tunnel stopped
	case <-time.After(3 * time.Second):
		t.Fatal("tunnel.Run did not return after Shutdown")
	}
}

// TestTunnel_ContextCancel verifies context cancellation stops the tunnel.
func TestTunnel_ContextCancel(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	disp := &stubDispatcher{}
	rep := &stubReporter{}
	cfg := tunnel.Config{
		ControlPlaneEndpoint:  "localhost:29999", // unreachable
		TenantID:              "tenant-1",
		AgentToken:            "tok",
		HeartbeatInterval:     30 * time.Second,
		ReconnectInitialDelay: 50 * time.Millisecond,
		ReconnectMaxDelay:     100 * time.Millisecond,
		ReconnectJitterPct:    10,
		TLSInsecureSkipVerify: true,
	}
	tun := tunnel.New(cfg, disp, rep, logger)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	errCh := make(chan error, 1)
	go func() { errCh <- tun.Run(ctx) }()

	select {
	case err := <-errCh:
		if err != nil && err != context.DeadlineExceeded && err != context.Canceled {
			t.Errorf("unexpected error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("tunnel.Run did not return after context cancellation")
	}
}
