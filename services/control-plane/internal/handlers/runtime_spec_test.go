package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
)

// Defect 1: limits / egress_rules / secrets must survive map -> AgentSpec,
// both in-process (typed maps, as scheduleAgentSpec builds them) and after a
// JSON round trip (any / float64).
func TestAgentSpecFromMap_RoundTripsLimitsEgressSecrets(t *testing.T) {
	in := map[string]any{
		"image_digest": "sha256:abc",
		"isolation":    "microvm",
		"limits": map[string]any{
			"vcpu": "500m", "memory": "512Mi", "gpu": "1", "scratch_size": "1Gi",
			"timeout": "5m", "max_steps": 10, "max_tokens": 1000, "max_cost_usd": 2.5,
		},
		"egress_rules": []map[string]any{
			{"pattern": "*.openai.com", "http_methods": []any{"GET", "POST"}, "rate_bps": 4096},
		},
		"secrets": []map[string]any{
			{"env_name": "OPENAI_API_KEY", "secret_uri": "lantern.secret://tenant/t/key/k"},
		},
	}
	want := &lanternv1.AgentSpec{
		ImageDigest: "sha256:abc",
		Isolation:   lanternv1.IsolationClass_ISOLATION_STANDARD,
		Limits: &lanternv1.ResourceLimits{
			Vcpu: "500m", Memory: "512Mi", Gpu: "1", ScratchSize: "1Gi",
			Timeout: durationProto(5 * time.Minute), MaxSteps: 10, MaxTokens: 1000, MaxCostUsd: 2.5,
		},
		EgressRules: []*lanternv1.EgressRule{{Pattern: "*.openai.com", HttpMethods: []string{"GET", "POST"}, RateBps: 4096}},
		Secrets:     []*lanternv1.SecretRef{{EnvName: "OPENAI_API_KEY", SecretUri: "lantern.secret://tenant/t/key/k"}},
	}
	if got := agentSpecFromMap(in); !proto.Equal(got, want) {
		t.Errorf("typed map: got %v\nwant %v", got, want)
	}

	// JSON round trip (what a persisted/relayed spec looks like).
	b, _ := json.Marshal(in)
	var rt map[string]any
	_ = json.Unmarshal(b, &rt)
	if got := agentSpecFromMap(rt); !proto.Equal(got, want) {
		t.Errorf("json round trip: got %v\nwant %v", got, want)
	}

	// camelCase keys (REST DTO spelling) decode too.
	camel := map[string]any{
		"egress_rules": []any{map[string]any{"pattern": "x.com", "httpMethods": []any{"GET"}, "rateBps": 7.0}},
		"secrets":      []any{map[string]any{"envName": "A", "secretUri": "u"}},
		"limits":       map[string]any{"maxSteps": 3.0, "timeout": 30.0},
	}
	g := agentSpecFromMap(camel)
	if g.EgressRules[0].RateBps != 7 || g.EgressRules[0].HttpMethods[0] != "GET" || g.Secrets[0].EnvName != "A" ||
		g.Limits.MaxSteps != 3 || g.Limits.Timeout.AsDuration() != 30*time.Second {
		t.Errorf("camelCase decode wrong: %v", g)
	}
}

func TestParseIsolation_MicroVMAndFirecrackerAreStandard(t *testing.T) {
	for _, in := range []string{"microvm", "MicroVM", "firecracker"} {
		if got := parseIsolation(in); got != lanternv1.IsolationClass_ISOLATION_STANDARD {
			t.Errorf("parseIsolation(%q) = %v, want ISOLATION_STANDARD (Firecracker)", in, got)
		}
	}
}

// fakeSchedClient captures the ScheduleRequest the control plane sends.
type fakeSchedClient struct {
	lanternv1.RuntimeSchedulerClient
	req *lanternv1.ScheduleRequest
}

func (f *fakeSchedClient) Schedule(_ context.Context, in *lanternv1.ScheduleRequest, _ ...grpc.CallOption) (*lanternv1.VmHandle, error) {
	f.req = in
	return &lanternv1.VmHandle{VmId: "vm-1", Node: "n", AvailabilityZone: "az"}, nil
}

// Defect 3: the key in the spec map reaches ScheduleRequest.IdempotencyKey.
func TestGRPCScheduleClient_SetsIdempotencyKey(t *testing.T) {
	f := &fakeSchedClient{}
	c := &grpcSchedulerClient{client: f}
	if _, _, _, err := c.Schedule(context.Background(), map[string]any{
		"tenant_id": "t", "image_digest": "d", "idempotency_key": "run:r1",
		"limits": map[string]any{"vcpu": "1"},
	}); err != nil {
		t.Fatal(err)
	}
	if f.req.IdempotencyKey != "run:r1" {
		t.Errorf("IdempotencyKey = %q, want run:r1", f.req.IdempotencyKey)
	}
	if f.req.Spec.Limits.GetVcpu() != "1" {
		t.Errorf("limits not forwarded: %v", f.req.Spec)
	}
}

// Defects 2+3 end to end through the run path (needs Postgres).
func TestScheduleRunInMicroVM_KeyAndIsolation(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)
	sched := &specCapScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)

	runID := uuid.NewString()
	if _, err := h.ScheduleRunInMicroVM(middleware.InjectTenantID(context.Background(), tenantID), tenantID, "", runID, "sha256:abc",
		map[string]any{"limits": map[string]any{"vcpu": "1"}}); err != nil {
		t.Fatalf("ScheduleRunInMicroVM: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE tenant_id=$1`, tenantID) })
	if got := sched.spec["idempotency_key"]; got != "run:"+runID {
		t.Errorf("idempotency_key = %v, want run:%s", got, runID)
	}
	if iso := agentSpecFromMap(sched.spec).Isolation; iso == lanternv1.IsolationClass_ISOLATION_UNSPECIFIED {
		t.Error("run path isolation decoded to UNSPECIFIED")
	}
	if agentSpecFromMap(sched.spec).Limits.GetVcpu() != "1" {
		t.Error("limits lost between run path and AgentSpec")
	}
}

type specCapScheduler struct {
	recScheduler
	spec map[string]any
}

func (s *specCapScheduler) Schedule(ctx context.Context, spec map[string]any) (string, string, string, error) {
	s.spec = spec
	return s.recScheduler.Schedule(ctx, spec)
}

// ---------------------------------------------------------------------------
// Defect 6: streaming exec
// ---------------------------------------------------------------------------

type fakeExecStream struct {
	frames []*lanternv1.ExecResponse
	sent   *lanternv1.ExecRequest
}

func (f *fakeExecStream) Send(r *lanternv1.ExecRequest) error { f.sent = r; return nil }
func (f *fakeExecStream) CloseSend() error                    { return nil }
func (f *fakeExecStream) Recv() (*lanternv1.ExecResponse, error) {
	if len(f.frames) == 0 {
		return nil, io.EOF
	}
	r := f.frames[0]
	f.frames = f.frames[1:]
	return r, nil
}

func TestPumpExec_EmitsPerFrameAndCaps(t *testing.T) {
	big := make([]byte, execMaxOutputBytes)
	st := &fakeExecStream{frames: []*lanternv1.ExecResponse{
		{Stdout: []byte("a")},
		{Stderr: []byte("e")},
		{Stdout: big}, // pushes stdout over the cap by 1 byte
		{Done: true, ExitCode: 3},
	}}
	var events []string
	total := 0
	exit, trunc, err := pumpExec(st, "vm", "ls", nil, func(stream string, d []byte) error {
		events = append(events, stream)
		if stream == "stdout" {
			total += len(d)
		}
		return nil
	})
	if err != nil || exit != 3 || !trunc {
		t.Fatalf("exit=%d trunc=%v err=%v", exit, trunc, err)
	}
	if strings.Join(events, ",") != "stdout,stderr,stdout" {
		t.Errorf("events = %v (chunks must be emitted per frame, in order)", events)
	}
	if total != execMaxOutputBytes {
		t.Errorf("stdout total = %d, want cap %d", total, execMaxOutputBytes)
	}
	if st.sent.VmId != "vm" || st.sent.Command != "ls" {
		t.Errorf("first frame wrong: %v", st.sent)
	}
}

type streamSched struct {
	recScheduler
	chunks [][2]string // {stream, data}
	exit   int32
}

func (s *streamSched) ExecStream(_ context.Context, node, _, _ string, _ []string, emit func(string, []byte) error) (int32, bool, error) {
	s.execNode = node
	for _, c := range s.chunks {
		if err := emit(c[0], []byte(c[1])); err != nil {
			return 0, false, err
		}
	}
	return s.exit, false, nil
}

func doExecAccept(h *RuntimeHandler, tok, vmID, accept string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/vms/"+vmID+"/exec", strings.NewReader(`{"command":"ls"}`))
	req.Header.Set("Authorization", bearerHeader(tok))
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	req.SetPathValue("id", vmID)
	w := httptest.NewRecorder()
	h.ExecVM(w, req)
	return w
}

func TestExecVM_SSEStreamsChunksAndKeepsJSONDefault(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)
	vmID := "vm-" + uuid.NewString()
	seedRuntimeVM(t, pool, tenantID, vmID, "n1")

	sched := &streamSched{chunks: [][2]string{{"stdout", "hello"}, {"stderr", "oops"}, {"stdout", "world"}}, exit: 7}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	tok := mintTestToken(t, tenantID, "user-1", "owner")

	w := doExecAccept(h, tok, vmID, "text/event-stream")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE: code=%d ct=%q body=%s", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
	want := "event: stdout\ndata: {\"data\":\"hello\"}\n\n" +
		"event: stderr\ndata: {\"data\":\"oops\"}\n\n" +
		"event: stdout\ndata: {\"data\":\"world\"}\n\n" +
		"event: exit\ndata: {\"exitCode\":7}\n\n"
	if w.Body.String() != want {
		t.Errorf("SSE body:\n%q\nwant:\n%q", w.Body.String(), want)
	}

	// Default (no Accept) stays buffered JSON via Exec.
	w = doExecAccept(h, tok, vmID, "")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Errorf("default: code=%d ct=%q", w.Code, w.Header().Get("Content-Type"))
	}
}

func durationProto(d time.Duration) *durationpb.Duration { return durationpb.New(d) }
