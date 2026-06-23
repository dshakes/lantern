package engine

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// fakeModelServer is an in-process ModelService that records the last
// CompleteRequest it received and returns a canned CompleteResponse, so the
// test can assert the engine builds the request correctly and maps the
// response into the step result.
type fakeModelServer struct {
	lanternv1.UnimplementedModelServiceServer
	lastReq *lanternv1.CompleteRequest
	resp    *lanternv1.CompleteResponse
	err     error
}

func (f *fakeModelServer) Complete(_ context.Context, req *lanternv1.CompleteRequest) (*lanternv1.CompleteResponse, error) {
	f.lastReq = req
	if f.err != nil {
		return nil, f.err
	}
	return f.resp, nil
}

// newFakeModelClient spins up the fake server on a bufconn listener and returns
// a connected ModelServiceClient plus a cleanup func.
func newFakeModelClient(t *testing.T, fake *fakeModelServer) (lanternv1.ModelServiceClient, func()) {
	t.Helper()

	lis := bufconn.Listen(1024 * 1024)
	srv := grpc.NewServer()
	lanternv1.RegisterModelServiceServer(srv, fake)

	go func() {
		// Serve returns once the listener is closed in cleanup; ignore that error.
		_ = srv.Serve(lis)
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("grpc.NewClient: %v", err)
	}

	cleanup := func() {
		_ = conn.Close()
		srv.Stop()
		_ = lis.Close()
	}
	return lanternv1.NewModelServiceClient(conn), cleanup
}

// TestExecuteLLMCall_BuildsRequestAndMapsResponse verifies that an llm_call step
// dispatches through the model router: the CompleteRequest carries the resolved
// capability, the messages, the tenant_id, and the idempotency key; and the
// CompleteResponse (text, tokens, cost) is mapped into the step output.
func TestExecuteLLMCall_BuildsRequestAndMapsResponse(t *testing.T) {
	fake := &fakeModelServer{
		resp: &lanternv1.CompleteResponse{
			ModelUsed: "vendor-model-x",
			Message:   &lanternv1.Message{Role: "assistant", Content: "hello from the router"},
			TokensIn:  12,
			TokensOut: 7,
			CostUsd:   0.0009,
		},
	}
	client, cleanup := newFakeModelClient(t, fake)
	defer cleanup()

	se := NewStepExecutor(nil, nil, zap.NewNop(), client)
	state := NewRunState("run-42", "tenant-99", "v3")
	idempotencyKey := "run-42:step-7:1"

	data := json.RawMessage(`{
		"capability": "reasoning-large",
		"optimize": "balanced",
		"prompt": "summarize the doc",
		"max_tokens": 256,
		"temperature": 0.4
	}`)

	out, err := se.executeLLMCall(context.Background(), state, "step-7", idempotencyKey, data)
	if err != nil {
		t.Fatalf("executeLLMCall: %v", err)
	}

	// --- assert the request the engine built ---
	req := fake.lastReq
	if req == nil {
		t.Fatal("model router received no request")
	}
	if req.GetCapability() != lanternv1.Capability_CAPABILITY_REASONING_LARGE {
		t.Errorf("capability = %v, want REASONING_LARGE", req.GetCapability())
	}
	if req.GetOptimize() != lanternv1.OptimizeTarget_OPTIMIZE_BALANCED {
		t.Errorf("optimize = %v, want BALANCED", req.GetOptimize())
	}
	if req.GetTenantId() != "tenant-99" {
		t.Errorf("tenant_id = %q, want tenant-99", req.GetTenantId())
	}
	if req.GetRunId() != "run-42" {
		t.Errorf("run_id = %q, want run-42", req.GetRunId())
	}
	if req.GetStepId() != "step-7" {
		t.Errorf("step_id = %q, want step-7", req.GetStepId())
	}
	if req.GetIdempotencyKey() != idempotencyKey {
		t.Errorf("idempotency_key = %q, want %q", req.GetIdempotencyKey(), idempotencyKey)
	}
	if req.GetMaxTokens() != 256 {
		t.Errorf("max_tokens = %d, want 256", req.GetMaxTokens())
	}
	if req.GetTemperature() != 0.4 {
		t.Errorf("temperature = %v, want 0.4", req.GetTemperature())
	}
	if got := len(req.GetMessages()); got != 1 {
		t.Fatalf("messages len = %d, want 1", got)
	}
	if m := req.GetMessages()[0]; m.GetRole() != "user" || m.GetContent() != "summarize the doc" {
		t.Errorf("message = %+v, want user/'summarize the doc'", m)
	}

	// --- assert the response maps into the step output ---
	var result struct {
		Text      string  `json:"text"`
		ModelUsed string  `json:"model_used"`
		TokensIn  int64   `json:"tokens_in"`
		TokensOut int64   `json:"tokens_out"`
		CostUSD   float64 `json:"cost_usd"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if result.Text != "hello from the router" {
		t.Errorf("text = %q", result.Text)
	}
	if result.ModelUsed != "vendor-model-x" {
		t.Errorf("model_used = %q", result.ModelUsed)
	}
	if result.TokensIn != 12 || result.TokensOut != 7 {
		t.Errorf("tokens = %d/%d, want 12/7", result.TokensIn, result.TokensOut)
	}
	if result.CostUSD != 0.0009 {
		t.Errorf("cost_usd = %v, want 0.0009", result.CostUSD)
	}
}

// TestExecuteLLMCall_ExplicitMessages verifies the messages array is forwarded
// verbatim and that a trailing prompt is appended as a user turn.
func TestExecuteLLMCall_ExplicitMessages(t *testing.T) {
	fake := &fakeModelServer{
		resp: &lanternv1.CompleteResponse{Message: &lanternv1.Message{Content: "ok"}},
	}
	client, cleanup := newFakeModelClient(t, fake)
	defer cleanup()

	se := NewStepExecutor(nil, nil, zap.NewNop(), client)
	state := NewRunState("run-1", "tenant-1", "v1")

	data := json.RawMessage(`{
		"capability": "auto",
		"messages": [
			{"role": "system", "content": "be terse"},
			{"role": "user", "content": "hi"}
		]
	}`)

	if _, err := se.executeLLMCall(context.Background(), state, "step-1", "run-1:step-1:1", data); err != nil {
		t.Fatalf("executeLLMCall: %v", err)
	}

	req := fake.lastReq
	if req.GetCapability() != lanternv1.Capability_CAPABILITY_AUTO {
		t.Errorf("capability = %v, want AUTO", req.GetCapability())
	}
	if got := len(req.GetMessages()); got != 2 {
		t.Fatalf("messages len = %d, want 2", got)
	}
	if req.GetMessages()[0].GetRole() != "system" || req.GetMessages()[1].GetContent() != "hi" {
		t.Errorf("messages = %+v", req.GetMessages())
	}
}

// TestExecuteLLMCall_NilClient verifies that with no model-router client the
// step returns the typed ErrModelRouterUnavailable instead of a fake result.
func TestExecuteLLMCall_NilClient(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil)
	state := NewRunState("run-1", "tenant-1", "v1")

	_, err := se.executeLLMCall(context.Background(), state, "step-1", "run-1:step-1:1", json.RawMessage(`{"prompt":"hi"}`))
	if !errors.Is(err, ErrModelRouterUnavailable) {
		t.Fatalf("err = %v, want ErrModelRouterUnavailable", err)
	}
}

// TestExecuteLLMCall_NoMessages verifies an empty payload is rejected rather
// than dispatched to the router.
func TestExecuteLLMCall_NoMessages(t *testing.T) {
	fake := &fakeModelServer{resp: &lanternv1.CompleteResponse{}}
	client, cleanup := newFakeModelClient(t, fake)
	defer cleanup()

	se := NewStepExecutor(nil, nil, zap.NewNop(), client)
	state := NewRunState("run-1", "tenant-1", "v1")

	if _, err := se.executeLLMCall(context.Background(), state, "step-1", "k", json.RawMessage(`{"capability":"auto"}`)); err == nil {
		t.Fatal("expected error for payload with no prompt/messages")
	}
	if fake.lastReq != nil {
		t.Error("router should not have been called for an empty payload")
	}
}

// TestExecuteToolCall_TypedError verifies the tool step fails honestly with the
// typed ErrToolDispatchUnavailable rather than fabricating output.
func TestExecuteToolCall_TypedError(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil)
	state := NewRunState("run-1", "tenant-1", "v1")

	_, err := se.executeToolCall(context.Background(), state, "step-1", "k", json.RawMessage(`{"tool_name":"search"}`))
	if !errors.Is(err, ErrToolDispatchUnavailable) {
		t.Fatalf("err = %v, want ErrToolDispatchUnavailable", err)
	}
}

// TestCapabilityFromString covers the capability selector mapping including the
// underscore/hyphen normalization and the AUTO fallback.
func TestCapabilityFromString(t *testing.T) {
	cases := []struct {
		in   string
		want lanternv1.Capability
	}{
		{"reasoning-large", lanternv1.Capability_CAPABILITY_REASONING_LARGE},
		{"reasoning_large", lanternv1.Capability_CAPABILITY_REASONING_LARGE},
		{"REASONING-LARGE", lanternv1.Capability_CAPABILITY_REASONING_LARGE},
		{"chat-small", lanternv1.Capability_CAPABILITY_CHAT_SMALL},
		{"auto", lanternv1.Capability_CAPABILITY_AUTO},
		{"", lanternv1.Capability_CAPABILITY_AUTO},
		{"nonsense", lanternv1.Capability_CAPABILITY_AUTO},
	}
	for _, c := range cases {
		if got := capabilityFromString(c.in); got != c.want {
			t.Errorf("capabilityFromString(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

// TestOptimizeFromString covers the optimize-target selector mapping.
func TestOptimizeFromString(t *testing.T) {
	cases := []struct {
		in   string
		want lanternv1.OptimizeTarget
	}{
		{"cheap", lanternv1.OptimizeTarget_OPTIMIZE_CHEAP},
		{"fast", lanternv1.OptimizeTarget_OPTIMIZE_FAST},
		{"best", lanternv1.OptimizeTarget_OPTIMIZE_BEST},
		{"balanced", lanternv1.OptimizeTarget_OPTIMIZE_BALANCED},
		{"", lanternv1.OptimizeTarget_OPTIMIZE_UNSPECIFIED},
		{"nonsense", lanternv1.OptimizeTarget_OPTIMIZE_UNSPECIFIED},
	}
	for _, c := range cases {
		if got := optimizeFromString(c.in); got != c.want {
			t.Errorf("optimizeFromString(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
