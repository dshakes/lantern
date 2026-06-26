package handlers

// runs_stream_test.go — DB-backed tests for RunService.StreamRunEvents (gRPC).
//
// Skips cleanly when DATABASE_URL is unset (same convention as
// run_events_test.go / runtime_test.go). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test -race -run 'StreamRun|RunEvent' ./internal/handlers/ -v -count=1

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// fakeStreamEventsServer implements RunService_StreamRunEventsServer
// (grpc.ServerStreamingServer[StreamEvent]) over a slice + a controllable
// context. Sends are captured under a mutex so the test goroutine can read
// them safely while the handler's tail loop runs concurrently.
type fakeStreamEventsServer struct {
	grpc.ServerStream // embedded — only Context + Send are exercised
	ctx               context.Context
	mu                sync.Mutex
	sent              []*lanternv1.StreamEvent
}

func (f *fakeStreamEventsServer) Context() context.Context { return f.ctx }

func (f *fakeStreamEventsServer) Send(ev *lanternv1.StreamEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, ev)
	return nil
}

func (f *fakeStreamEventsServer) snapshot() []*lanternv1.StreamEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*lanternv1.StreamEvent, len(f.sent))
	copy(out, f.sent)
	return out
}

// newRunServiceForStreamTest builds a RunService backed by a real pool, plus a
// RESTHandler so we can reuse the run/journal seed helpers from run_events_test.go.
func newRunServiceForStreamTest(t *testing.T) (*RunService, *RESTHandler) {
	t.Helper()
	pool := openTestPool(t) // skips when DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	runSvc := NewRunService(srv)
	auth := NewAuthHandler(srv, "test-jwt-secret-for-stream-run-events")
	rest := &RESTHandler{srv: srv, agentSvc: NewAgentService(srv), runSvc: runSvc, auth: auth}
	return runSvc, rest
}

// TestStreamRunEvents_ReplayTerminal seeds a terminal run + ordered
// journal_events and asserts StreamRunEvents replays them in seq order then
// returns (no tail) without a deadline.
func TestStreamRunEvents_ReplayTerminal(t *testing.T) {
	runSvc, rest := newRunServiceForStreamTest(t)

	runID := insertRunForEvents(t, rest, devTenantID, "succeeded")

	seeds := []struct {
		seq  int64
		kind string
	}{
		{1, "step_started"},
		{2, "step_completed"},
		{3, "run_completed"},
	}
	for _, s := range seeds {
		insertJournalEvent(t, rest, runID, s.seq, s.kind, llmStepID, []byte(`{"type":"llm"}`))
	}

	ctx := middleware.InjectTenantID(context.Background(), devTenantID)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fake := &fakeStreamEventsServer{ctx: ctx}

	err := runSvc.StreamRunEvents(&lanternv1.StreamRunEventsRequest{RunId: runID}, fake)
	if err != nil {
		t.Fatalf("StreamRunEvents returned error: %v", err)
	}

	got := fake.snapshot()
	if len(got) != len(seeds) {
		t.Fatalf("expected %d events, got %d", len(seeds), len(got))
	}
	// Assert seq order + kind mapping.
	for i, ev := range got {
		if ev.GetSeq() != uint64(seeds[i].seq) {
			t.Errorf("event %d: seq = %d, want %d", i, ev.GetSeq(), seeds[i].seq)
		}
		if ev.GetRunId() != runID {
			t.Errorf("event %d: run_id = %q, want %q", i, ev.GetRunId(), runID)
		}
	}
	if got[0].GetStepStarted() == nil {
		t.Errorf("seq 1 should map to StepStarted, got %T", got[0].GetPayload())
	}
	if got[1].GetStepCompleted() == nil {
		t.Errorf("seq 2 should map to StepCompleted, got %T", got[1].GetPayload())
	}
	// run_completed has no dedicated proto kind → forwarded as a Log so nothing
	// is dropped on the wire.
	if log := got[2].GetLog(); log == nil || log.GetMessage() != "run_completed" {
		t.Errorf("seq 3 should map to Log{message:run_completed}, got %T", got[2].GetPayload())
	}
}

// TestStreamRunEvents_TailUntilTerminal starts streaming a non-terminal run,
// then concurrently appends a journal event and flips the run to terminal. The
// handler must forward the tailed event and return once terminal.
func TestStreamRunEvents_TailUntilTerminal(t *testing.T) {
	runSvc, rest := newRunServiceForStreamTest(t)

	runID := insertRunForEvents(t, rest, devTenantID, "running")
	insertJournalEvent(t, rest, runID, 1, "step_started", llmStepID, []byte(`{"type":"llm"}`))

	ctx := middleware.InjectTenantID(context.Background(), devTenantID)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	fake := &fakeStreamEventsServer{ctx: ctx}

	done := make(chan error, 1)
	go func() {
		done <- runSvc.StreamRunEvents(&lanternv1.StreamRunEventsRequest{RunId: runID}, fake)
	}()

	// Give the handler time to replay seq 1 and enter the tail loop, then
	// append a new event and flip the run terminal.
	time.Sleep(1 * time.Second)
	insertJournalEvent(t, rest, runID, 2, "step_completed", llmStepID, []byte(`{}`))
	if _, err := rest.srv.Pool.Exec(context.Background(),
		`UPDATE runs SET status = 'succeeded', finished_at = now() WHERE id = $1`, runID); err != nil {
		t.Fatalf("flip terminal: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StreamRunEvents returned error: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("StreamRunEvents did not return after run reached terminal status")
	}

	got := fake.snapshot()
	// Filter out heartbeats; assert both journal events were forwarded in order.
	var seqs []uint64
	for _, ev := range got {
		if ev.GetHeartbeat() != nil {
			continue
		}
		seqs = append(seqs, ev.GetSeq())
	}
	if len(seqs) < 2 || seqs[0] != 1 || seqs[1] != 2 {
		t.Errorf("expected journal seqs [1 2] forwarded in order, got %v", seqs)
	}
}

// TestStreamRunEvents_TenantScoping asserts a caller cannot stream a run owned
// by a different tenant.
func TestStreamRunEvents_TenantScoping(t *testing.T) {
	runSvc, rest := newRunServiceForStreamTest(t)

	runID := insertRunForEvents(t, rest, devTenantID, "succeeded")

	otherTenant := "00000000-0000-0000-0000-0000000000aa"
	ctx := middleware.InjectTenantID(context.Background(), otherTenant)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fake := &fakeStreamEventsServer{ctx: ctx}

	err := runSvc.StreamRunEvents(&lanternv1.StreamRunEventsRequest{RunId: runID}, fake)
	if status.Code(err) != codes.NotFound {
		t.Errorf("cross-tenant stream: want NotFound, got %v", err)
	}
	if len(fake.snapshot()) != 0 {
		t.Error("no events should be sent for a cross-tenant run")
	}
}

// TestStreamRunEvents_MissingRunID asserts the argument guard.
func TestStreamRunEvents_MissingRunID(t *testing.T) {
	runSvc, _ := newRunServiceForStreamTest(t)

	ctx := middleware.InjectTenantID(context.Background(), devTenantID)
	fake := &fakeStreamEventsServer{ctx: ctx}

	err := runSvc.StreamRunEvents(&lanternv1.StreamRunEventsRequest{RunId: ""}, fake)
	if status.Code(err) != codes.InvalidArgument {
		t.Errorf("missing run_id: want InvalidArgument, got %v", err)
	}
}
