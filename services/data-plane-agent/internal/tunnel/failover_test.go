package tunnel_test

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

// fakeRegion is one region's control plane: a real gRPC server on loopback
// with the standard health service and a minimal DataPlaneService.
type fakeRegion struct {
	lanternv1.UnimplementedDataPlaneServiceServer
	name      string
	addr      string
	health    *health.Server
	registers atomic.Int32
	srv       *grpc.Server
}

func newFakeRegion(t *testing.T, name string, serving bool) *fakeRegion {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRegion{name: name, addr: lis.Addr().String(), health: health.NewServer(), srv: grpc.NewServer()}
	f.setServing(serving)
	healthpb.RegisterHealthServer(f.srv, f.health)
	lanternv1.RegisterDataPlaneServiceServer(f.srv, f)
	go func() { _ = f.srv.Serve(lis) }()
	t.Cleanup(f.srv.Stop)
	return f
}

func (f *fakeRegion) setServing(on bool) {
	st := healthpb.HealthCheckResponse_NOT_SERVING
	if on {
		st = healthpb.HealthCheckResponse_SERVING
	}
	f.health.SetServingStatus("lantern.v1.DataPlaneService", st)
}

func (f *fakeRegion) Register(context.Context, *lanternv1.DpRegisterRequest) (*lanternv1.DpRegisterResponse, error) {
	f.registers.Add(1)
	return &lanternv1.DpRegisterResponse{PlaneId: "plane-" + f.name, SessionToken: "tok-" + f.name}, nil
}

func (f *fakeRegion) Heartbeat(context.Context, *lanternv1.DpHeartbeatRequest) (*lanternv1.DpHeartbeatAck, error) {
	return &lanternv1.DpHeartbeatAck{}, nil
}

func (f *fakeRegion) ReportMetrics(context.Context, *lanternv1.DpMetricsReport) (*lanternv1.DpMetricsAck, error) {
	return &lanternv1.DpMetricsAck{}, nil
}

func (f *fakeRegion) RunStream(stream lanternv1.DataPlaneService_RunStreamServer) error {
	if _, err := stream.Recv(); err != nil { // DpHello
		return err
	}
	<-stream.Context().Done()
	return nil
}

func startTunnel(t *testing.T, endpoints ...string) *tunnel.Tunnel {
	t.Helper()
	tun := tunnel.New(tunnel.Config{
		ControlPlaneEndpoints: endpoints,
		TenantID:              "tenant-1",
		AgentToken:            "agent-tok",
		HeartbeatInterval:     50 * time.Millisecond,
		ReconnectInitialDelay: 20 * time.Millisecond,
		ReconnectMaxDelay:     100 * time.Millisecond,
		FailbackInterval:      50 * time.Millisecond,
		TLSInsecureSkipVerify: true,
	}, &stubDispatcher{}, &stubReporter{}, zap.NewNop())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = tun.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return tun
}

func waitEndpoint(t *testing.T, tun *tunnel.Tunnel, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s := tun.Status(); s.Connected && s.Endpoint == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	s := tun.Status()
	t.Fatalf("tunnel on %q (connected=%v), want %q", s.Endpoint, s.Connected, want)
}

// The primary region is a read-only standby (NOT_SERVING): the agent skips
// it and never sends it a Register.
func TestFailover_SkipsNotServingPrimary(t *testing.T) {
	a := newFakeRegion(t, "a", false)
	b := newFakeRegion(t, "b", true)
	tun := startTunnel(t, a.addr, b.addr)
	waitEndpoint(t, tun, b.addr)
	if a.registers.Load() != 0 {
		t.Fatalf("registered with a NOT_SERVING region")
	}
	if tun.Status().PlaneID != "plane-b" {
		t.Fatalf("plane id = %q", tun.Status().PlaneID)
	}
}

// The primary region dies outright: the agent reconnects to the secondary.
func TestFailover_PrimaryDown(t *testing.T) {
	a := newFakeRegion(t, "a", true)
	b := newFakeRegion(t, "b", true)
	tun := startTunnel(t, a.addr, b.addr)
	waitEndpoint(t, tun, a.addr)

	a.srv.Stop()
	waitEndpoint(t, tun, b.addr)
}

// Once the higher-priority region is healthy again the agent fails back.
func TestFailover_FailsBackToPrimary(t *testing.T) {
	a := newFakeRegion(t, "a", false)
	b := newFakeRegion(t, "b", true)
	tun := startTunnel(t, a.addr, b.addr)
	waitEndpoint(t, tun, b.addr)

	a.setServing(true)
	waitEndpoint(t, tun, a.addr)
	if a.registers.Load() == 0 {
		t.Fatalf("failback did not register with the primary")
	}
}

// No region is healthy: the agent stays disconnected rather than registering
// with a standby, and connects as soon as one becomes healthy.
func TestFailover_NoHealthyEndpoint(t *testing.T) {
	a := newFakeRegion(t, "a", false)
	b := newFakeRegion(t, "b", false)
	tun := startTunnel(t, a.addr, b.addr)
	time.Sleep(200 * time.Millisecond)
	if tun.Status().Connected || a.registers.Load()+b.registers.Load() != 0 {
		t.Fatalf("connected with no healthy region")
	}
	b.setServing(true)
	waitEndpoint(t, tun, b.addr)
}

// A single endpoint keeps the single-region behaviour: no health probe, so a
// control plane without the health service is still used.
func TestFailover_SingleEndpointDoesNotProbe(t *testing.T) {
	a := newFakeRegion(t, "a", false) // would be skipped if probed
	tun := startTunnel(t, a.addr)
	waitEndpoint(t, tun, a.addr)
}
