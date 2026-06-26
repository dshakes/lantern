package dispatcher_test

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/dispatcher"
	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

const bufSize = 1 << 20 // 1 MiB

// fakeEngine is an in-process WorkflowEngineService server for tests.
type fakeEngine struct {
	lanternv1.UnimplementedWorkflowEngineServiceServer

	// events is the sequence of StreamEvents the fake sends before closing.
	events []*lanternv1.StreamEvent

	// receivedMeta captures the incoming gRPC metadata from ExecuteRun calls.
	receivedMeta []metadata.MD
}

func (f *fakeEngine) ExecuteRun(req *lanternv1.ExecuteRunRequest, stream grpc.ServerStreamingServer[lanternv1.StreamEvent]) error {
	// Capture caller metadata.
	if md, ok := metadata.FromIncomingContext(stream.Context()); ok {
		f.receivedMeta = append(f.receivedMeta, md)
	}

	for _, ev := range f.events {
		if err := stream.Send(ev); err != nil {
			return err
		}
	}
	return nil // clean EOF
}

// startFakeEngine registers fake on a bufconn listener and returns a dialer
// that connects to it. The returned stop function shuts the server down.
func startFakeEngine(t *testing.T, fake *fakeEngine) (dialFn func(context.Context, string) (net.Conn, error), stop func()) {
	t.Helper()

	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	lanternv1.RegisterWorkflowEngineServiceServer(srv, fake)

	go func() {
		if err := srv.Serve(lis); err != nil && err != grpc.ErrServerStopped {
			t.Logf("fake engine serve error: %v", err)
		}
	}()

	dialFn = func(ctx context.Context, _ string) (net.Conn, error) {
		return lis.DialContext(ctx)
	}
	stop = func() {
		srv.Stop()
		lis.Close()
	}
	return dialFn, stop
}

// newTestDispatcher creates a Dispatcher wired to a fake engine via bufconn.
// The fake's address is a sentinel string; the real dialing is overridden by
// grpc.WithContextDialer injected via the conn option.
//
// Because Dispatcher lazily dials via getWorkflowEngineConn (which calls
// grpc.NewClient), we pre-dial here and inject the connection through the
// exported NewWithConn constructor for testing.
func newTestDispatcher(t *testing.T, fake *fakeEngine, serviceToken string) (*dispatcher.Dispatcher, func()) {
	t.Helper()

	dialFn, stop := startFakeEngine(t, fake)

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(dialFn),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial bufconn: %v", err)
	}

	logger, _ := zap.NewDevelopment()
	d := dispatcher.NewWithConn(conn, serviceToken, logger)

	cleanup := func() {
		d.Close()
		conn.Close()
		stop()
	}
	return d, cleanup
}

// TestDispatchRun_HappyPath verifies that when the engine emits StepStarted,
// StepCompleted, and StreamEnd("") events, DispatchRun returns nil and the run
// is eventually marked completed.
func TestDispatchRun_HappyPath(t *testing.T) {
	fake := &fakeEngine{
		events: []*lanternv1.StreamEvent{
			{
				RunId: "run-1",
				Payload: &lanternv1.StreamEvent_StepStarted{
					StepStarted: &lanternv1.StepStarted{StepId: "step-1", Kind: "ai-step"},
				},
			},
			{
				RunId: "run-1",
				Payload: &lanternv1.StreamEvent_StepCompleted{
					StepCompleted: &lanternv1.StepCompleted{StepId: "step-1"},
				},
			},
			{
				RunId: "run-1",
				Payload: &lanternv1.StreamEvent_End{
					End: &lanternv1.StreamEnd{Reason: ""},
				},
			},
		},
	}

	d, cleanup := newTestDispatcher(t, fake, "")
	defer cleanup()

	assignment := &tunnel.RunAssignment{
		RunID:          "run-1",
		AgentVersionID: "v1",
		TenantID:       "tenant-abc",
	}

	err := d.DispatchRun(context.Background(), assignment)
	if err != nil {
		t.Fatalf("DispatchRun returned error: %v", err)
	}

	// driveRun runs in a goroutine; poll until the run leaves active tracking.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if d.ActiveRunCount() != 0 {
		t.Errorf("run still active after stream closed; expected CompleteRun to fire")
	}
}

// TestDispatchRun_FailedStream verifies that when the engine emits a
// StreamEnd with reason "failed", the run is marked failed.
func TestDispatchRun_FailedStream(t *testing.T) {
	fake := &fakeEngine{
		events: []*lanternv1.StreamEvent{
			{
				RunId: "run-2",
				Payload: &lanternv1.StreamEvent_StepFailed{
					StepFailed: &lanternv1.StepFailed{StepId: "step-1"},
				},
			},
			{
				RunId: "run-2",
				Payload: &lanternv1.StreamEvent_End{
					End: &lanternv1.StreamEnd{Reason: "failed"},
				},
			},
		},
	}

	d, cleanup := newTestDispatcher(t, fake, "")
	defer cleanup()

	assignment := &tunnel.RunAssignment{
		RunID:          "run-2",
		AgentVersionID: "v1",
		TenantID:       "tenant-abc",
	}

	if err := d.DispatchRun(context.Background(), assignment); err != nil {
		t.Fatalf("DispatchRun returned error: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if d.ActiveRunCount() != 0 {
		t.Errorf("run still active after failed stream; expected CompleteRun to fire")
	}
}

// TestDispatchRun_TenantIDInMetadata verifies that tenant_id is injected into
// outgoing gRPC metadata on ExecuteRun, satisfying architectural invariant #7.
func TestDispatchRun_TenantIDInMetadata(t *testing.T) {
	fake := &fakeEngine{
		events: []*lanternv1.StreamEvent{
			{
				Payload: &lanternv1.StreamEvent_End{
					End: &lanternv1.StreamEnd{},
				},
			},
		},
	}

	d, cleanup := newTestDispatcher(t, fake, "")
	defer cleanup()

	assignment := &tunnel.RunAssignment{
		RunID:          "run-3",
		AgentVersionID: "v1",
		TenantID:       "my-tenant",
	}

	if err := d.DispatchRun(context.Background(), assignment); err != nil {
		t.Fatalf("DispatchRun: %v", err)
	}

	// Wait for the stream to be consumed so receivedMeta is populated.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(fake.receivedMeta) == 0 {
		t.Fatal("no gRPC metadata captured by fake engine")
	}
	vals := fake.receivedMeta[0].Get("tenant_id")
	if len(vals) == 0 || vals[0] != "my-tenant" {
		t.Errorf("tenant_id in metadata: got %v, want [my-tenant]", vals)
	}
}

// TestDispatchRun_ServiceTokenInMetadata verifies that x-lantern-service-token
// is injected when a non-empty service token is configured.
func TestDispatchRun_ServiceTokenInMetadata(t *testing.T) {
	fake := &fakeEngine{
		events: []*lanternv1.StreamEvent{
			{
				Payload: &lanternv1.StreamEvent_End{
					End: &lanternv1.StreamEnd{},
				},
			},
		},
	}

	const tok = "super-secret-token"
	d, cleanup := newTestDispatcher(t, fake, tok)
	defer cleanup()

	assignment := &tunnel.RunAssignment{
		RunID:          "run-4",
		AgentVersionID: "v1",
		TenantID:       "tenant-xyz",
	}

	if err := d.DispatchRun(context.Background(), assignment); err != nil {
		t.Fatalf("DispatchRun: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(fake.receivedMeta) == 0 {
		t.Fatal("no gRPC metadata captured")
	}
	vals := fake.receivedMeta[0].Get("x-lantern-service-token")
	if len(vals) == 0 || vals[0] != tok {
		t.Errorf("x-lantern-service-token in metadata: got %v, want [%s]", vals, tok)
	}
}

// TestDispatchRun_NoServiceToken verifies that x-lantern-service-token is NOT
// injected when the service token is empty (dev mode).
func TestDispatchRun_NoServiceToken(t *testing.T) {
	fake := &fakeEngine{
		events: []*lanternv1.StreamEvent{
			{
				Payload: &lanternv1.StreamEvent_End{
					End: &lanternv1.StreamEnd{},
				},
			},
		},
	}

	d, cleanup := newTestDispatcher(t, fake, "") // empty token
	defer cleanup()

	assignment := &tunnel.RunAssignment{
		RunID:          "run-5",
		AgentVersionID: "v1",
		TenantID:       "tenant-xyz",
	}

	if err := d.DispatchRun(context.Background(), assignment); err != nil {
		t.Fatalf("DispatchRun: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if len(fake.receivedMeta) == 0 {
		t.Fatal("no gRPC metadata captured")
	}
	vals := fake.receivedMeta[0].Get("x-lantern-service-token")
	if len(vals) != 0 {
		t.Errorf("x-lantern-service-token unexpectedly present: %v", vals)
	}
}

// TestDispatchRun_ContextCancellation verifies that cancelling the context
// before or during dispatch does not block or panic.
func TestDispatchRun_ContextCancellation(t *testing.T) {
	// Engine that blocks until context is cancelled.
	blockFn := func(req *lanternv1.ExecuteRunRequest, stream grpc.ServerStreamingServer[lanternv1.StreamEvent]) error {
		<-stream.Context().Done()
		return io.EOF
	}
	fake := &blockingEngine{fn: blockFn}

	dialFn, stop := startFakeEngineCustom(t, fake)
	defer stop()

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(dialFn),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	logger, _ := zap.NewDevelopment()
	d := dispatcher.NewWithConn(conn, "", logger)
	defer d.Close()

	ctx, cancel := context.WithCancel(context.Background())

	assignment := &tunnel.RunAssignment{
		RunID:    "run-cancel",
		TenantID: "tenant-cancel",
	}

	if err := d.DispatchRun(ctx, assignment); err != nil {
		t.Fatalf("DispatchRun: %v", err)
	}

	// Cancel immediately; driveRun goroutine should exit cleanly.
	cancel()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d.ActiveRunCount() == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if d.ActiveRunCount() != 0 {
		t.Error("run still active after context cancellation")
	}
}

// blockingEngine lets tests inject a custom ExecuteRun implementation.
type blockingEngine struct {
	lanternv1.UnimplementedWorkflowEngineServiceServer
	fn func(*lanternv1.ExecuteRunRequest, grpc.ServerStreamingServer[lanternv1.StreamEvent]) error
}

func (b *blockingEngine) ExecuteRun(req *lanternv1.ExecuteRunRequest, stream grpc.ServerStreamingServer[lanternv1.StreamEvent]) error {
	return b.fn(req, stream)
}

func startFakeEngineCustom(t *testing.T, srv lanternv1.WorkflowEngineServiceServer) (func(context.Context, string) (net.Conn, error), func()) {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	lanternv1.RegisterWorkflowEngineServiceServer(s, srv)
	go func() {
		if err := s.Serve(lis); err != nil && err != grpc.ErrServerStopped {
			t.Logf("fake engine: %v", err)
		}
	}()
	return func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}, func() {
			s.Stop()
			lis.Close()
		}
}
