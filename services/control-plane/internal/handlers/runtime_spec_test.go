package handlers

import (
	"context"
	"encoding/json"
	"errors"
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

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
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
			{"env_name": "OPENAI_API_KEY", "secret_uri": "pal.secret://tenant/t/key/k"},
		},
	}
	want := &palv1.AgentSpec{
		ImageDigest: "sha256:abc",
		Isolation:   palv1.IsolationClass_ISOLATION_STANDARD,
		Limits: &palv1.ResourceLimits{
			Vcpu: "500m", Memory: "512Mi", Gpu: "1", ScratchSize: "1Gi",
			Timeout: durationProto(5 * time.Minute), MaxSteps: 10, MaxTokens: 1000, MaxCostUsd: 2.5,
		},
		EgressRules: []*palv1.EgressRule{{Pattern: "*.openai.com", HttpMethods: []string{"GET", "POST"}, RateBps: 4096}},
		Secrets:     []*palv1.SecretRef{{EnvName: "OPENAI_API_KEY", SecretUri: "pal.secret://tenant/t/key/k"}},
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
		if got := parseIsolation(in); got != palv1.IsolationClass_ISOLATION_STANDARD {
			t.Errorf("parseIsolation(%q) = %v, want ISOLATION_STANDARD (Firecracker)", in, got)
		}
	}
}

// fakeSchedClient captures the ScheduleRequest the control plane sends.
type fakeSchedClient struct {
	palv1.RuntimeSchedulerClient
	req *palv1.ScheduleRequest
}

func (f *fakeSchedClient) Schedule(_ context.Context, in *palv1.ScheduleRequest, _ ...grpc.CallOption) (*palv1.VmHandle, error) {
	f.req = in
	return &palv1.VmHandle{VmId: "vm-1", Node: "n", AvailabilityZone: "az"}, nil
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
	if got := sched.spec["idempotency_key"]; got != "run:"+runID+":1" {
		t.Errorf("idempotency_key = %v, want run:%s:1", got, runID)
	}
	if iso := agentSpecFromMap(sched.spec).Isolation; iso == palv1.IsolationClass_ISOLATION_UNSPECIFIED {
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
	frames []*palv1.ExecResponse
	sent   *palv1.ExecRequest
}

func (f *fakeExecStream) Send(r *palv1.ExecRequest) error { f.sent = r; return nil }
func (f *fakeExecStream) CloseSend() error                { return nil }
func (f *fakeExecStream) Recv() (*palv1.ExecResponse, error) {
	if len(f.frames) == 0 {
		return nil, io.EOF
	}
	r := f.frames[0]
	f.frames = f.frames[1:]
	return r, nil
}

func TestPumpExec_EmitsPerFrameAndCaps(t *testing.T) {
	big := make([]byte, execMaxOutputBytes)
	st := &fakeExecStream{frames: []*palv1.ExecResponse{
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

func TestRunScheduleKey_AttemptAware(t *testing.T) {
	if got := runScheduleKey("r", map[string]any{}); got != "run:r:1" {
		t.Errorf("first attempt key = %q", got)
	}
	// manifest round-tripped through JSON carries float64.
	if got := runScheduleKey("r", map[string]any{"attempt": float64(2)}); got != "run:r:2" {
		t.Errorf("re-drive key = %q, want run:r:2 (must not reuse the crashed VM)", got)
	}
}

// lostOnceScheduler models the ambiguous-response case: the first Schedule
// reaches the scheduler (which spawns the VM with that attempt's env) but the
// reply is lost; the retry with the same key gets the cached VM back.
type lostOnceScheduler struct {
	recScheduler
	bootEnv map[string]any // env the VM actually booted with (first call)
	keys    []any
}

func (s *lostOnceScheduler) Schedule(_ context.Context, spec map[string]any) (string, string, string, error) {
	s.keys = append(s.keys, spec["idempotency_key"])
	if s.bootEnv == nil {
		s.bootEnv = spec["env"].(map[string]any)
		return "", "", "", errors.New("deadline exceeded")
	}
	return "vm-replayed", "n", "az", nil
}

// An idempotent replay must persist the identity the VM booted with, or the
// VM's token can never authenticate secret vending.
func TestScheduleAgentSpec_ReplayKeepsBootIdentity(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE tenant_id=$1`, tenantID) })
	sched := &lostOnceScheduler{}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	ctx := middleware.InjectTenantID(context.Background(), tenantID)
	spec := agentSpecDTO{ImageDigest: "sha256:abc", IdempotencyKey: "k-" + uuid.NewString()}

	if _, _, _, _, _, err := h.scheduleAgentSpec(ctx, tenantID, "", spec); err == nil {
		t.Fatal("first attempt should surface the lost response")
	}
	vmID, _, _, instanceID, _, err := h.scheduleAgentSpec(ctx, tenantID, "", spec)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if sched.keys[0] != sched.keys[1] {
		t.Fatalf("retry used a different idempotency key: %v", sched.keys)
	}
	bootID := sched.bootEnv["PAL_AGENT_INSTANCE_ID"]
	var rowID string
	if err := pool.QueryRow(context.Background(), `SELECT agent_instance_id FROM runtime_vms WHERE vm_id=$1`, vmID).Scan(&rowID); err != nil {
		t.Fatal(err)
	}
	if rowID != bootID || instanceID != bootID {
		t.Errorf("row agent_instance_id=%q returned=%q, VM booted with %q", rowID, instanceID, bootID)
	}
	// The token the VM booted with names the persisted instance id.
	claims, err := h.identity.Verify(sched.bootEnv["PAL_AGENT_INSTANCE_TOKEN"].(string))
	if err != nil || claims.AgentInstanceID != rowID {
		t.Errorf("boot token claims %v (err %v) do not match row %q", claims, err, rowID)
	}
}

// Both schedule paths must carry manifest/body sandbox policy (egress_rules,
// secrets, limits) to the scheduler, in snake_case and camelCase alike.
func TestSchedulePaths_HonorEgressSecretsLimits(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM runtime_vms WHERE tenant_id=$1`, tenantID) })

	snake := `{"image_digest":"sha256:abc","isolation_class":"microvm",
		"limits":{"max_steps":4},
		"egress_rules":[{"pattern":"*.example.com","http_methods":["GET"],"rate_bps":100}],
		"secrets":[{"env_name":"API_KEY","secret_uri":"pal.secret://t/k"}]}`
	camel := `{"imageDigest":"sha256:abc","isolation":"microvm",
		"limits":{"maxSteps":4},
		"egressRules":[{"pattern":"*.example.com","httpMethods":["GET"],"rateBps":100}],
		"secrets":[{"envName":"API_KEY","secretUri":"pal.secret://t/k"}]}`
	check := func(t *testing.T, spec map[string]any) {
		t.Helper()
		a := agentSpecFromMap(spec)
		if len(a.EgressRules) != 1 || a.EgressRules[0].Pattern != "*.example.com" || a.EgressRules[0].RateBps != 100 ||
			len(a.EgressRules[0].HttpMethods) != 1 {
			t.Errorf("egress rules lost: %v", a.EgressRules)
		}
		if len(a.Secrets) != 1 || a.Secrets[0].EnvName != "API_KEY" || a.Secrets[0].SecretUri != "pal.secret://t/k" {
			t.Errorf("secrets lost: %v", a.Secrets)
		}
		if a.Limits.GetMaxSteps() != 4 {
			t.Errorf("limits lost: %v", a.Limits)
		}
	}
	tok := mintTestToken(t, tenantID, "00000000-0000-0000-0000-0000000000c1", "owner")
	for name, body := range map[string]string{"snake": snake, "camel": camel} {
		t.Run("http_"+name, func(t *testing.T) {
			sched := &specCapScheduler{}
			h := newTestRuntimeHandlerWithPool(t, pool, sched)
			req := httptest.NewRequest(http.MethodPost, "/v1/runtime/schedule", strings.NewReader(body))
			req.Header.Set("Authorization", bearerHeader(tok))
			w := httptest.NewRecorder()
			h.Schedule(w, req)
			if w.Code != http.StatusOK && w.Code != http.StatusCreated {
				t.Fatalf("schedule: %d %s", w.Code, w.Body)
			}
			check(t, sched.spec)
		})
		t.Run("run_"+name, func(t *testing.T) {
			var manifest map[string]any
			if err := json.Unmarshal([]byte(body), &manifest); err != nil {
				t.Fatal(err)
			}
			sched := &specCapScheduler{}
			h := newTestRuntimeHandlerWithPool(t, pool, sched)
			if _, err := h.ScheduleRunInMicroVM(middleware.InjectTenantID(context.Background(), tenantID),
				tenantID, "", uuid.NewString(), "sha256:abc", manifest); err != nil {
				t.Fatalf("ScheduleRunInMicroVM: %v", err)
			}
			check(t, sched.spec)
		})
	}
}

// ADR 0026: egress[].inject is parsed into the proto (both casings) and
// forwarded to the scheduler/manager; the ref is carried, never resolved here.
func TestAgentSpecFromMap_EgressInject(t *testing.T) {
	spec := map[string]any{
		"egress_rules": []any{
			map[string]any{
				"pattern": "api.openai.com",
				"inject": []any{
					map[string]any{"header": "Authorization", "secretRef": "pal.secret/llm/openai", "valuePrefix": "Bearer "},
					map[string]any{"header": "x-org", "secret_ref": "pal.secret/connector/5f2b7c1e-1111-4222-8333-444455556666/org"},
				},
			},
		},
	}
	a := agentSpecFromMap(spec)
	inj := a.GetEgressRules()[0].GetInject()
	if len(inj) != 2 {
		t.Fatalf("want 2 injections, got %d", len(inj))
	}
	if inj[0].GetHeader() != "Authorization" || inj[0].GetSecretUri() != "pal.secret/llm/openai" || inj[0].GetValuePrefix() != "Bearer " {
		t.Errorf("camelCase entry mis-parsed: %+v", inj[0])
	}
	if inj[1].GetSecretUri() == "" || inj[1].GetValuePrefix() != "" {
		t.Errorf("snake_case entry mis-parsed: %+v", inj[1])
	}
}

func TestValidateEgressInject(t *testing.T) {
	rule := func(pattern string, inj map[string]any) []map[string]any {
		return []map[string]any{{"pattern": pattern, "inject": []any{inj}}}
	}
	ok := map[string]any{"header": "Authorization", "secretRef": "pal.secret/llm/openai"}
	if err := validateEgressInject(rule("api.openai.com", ok), nil); err != nil {
		t.Fatalf("valid inject rejected: %v", err)
	}
	if err := validateEgressInject([]map[string]any{{"pattern": "x.com"}}, nil); err != nil {
		t.Fatalf("rule without inject rejected: %v", err)
	}
	const raw = "sk-live-RAWSECRET"
	bad := map[string][]map[string]any{
		"raw value as ref": rule("api.openai.com", map[string]any{"header": "Authorization", "secretRef": raw}),
		"wrong scheme":     rule("api.openai.com", map[string]any{"header": "Authorization", "secretRef": "pal.secret://tenant/t/key/k"}),
		"bad header":       rule("api.openai.com", map[string]any{"header": "X-A\r\nEvil", "secretRef": "pal.secret/llm/openai"}),
		"crlf prefix":      rule("api.openai.com", map[string]any{"header": "A", "secretRef": "pal.secret/llm/openai", "valuePrefix": "x\r\n"}),
		"ip pattern":       rule("8.8.8.8", ok),
		"cidr pattern":     rule("10.0.0.0/8", ok),
		"wildcard pattern": rule("*.openai.com", ok),
		"bare wildcard":    rule("*", ok),
	}
	for name, rules := range bad {
		err := validateEgressInject(rules, nil)
		if err == nil {
			t.Errorf("%s: want error", name)
			continue
		}
		if strings.Contains(err.Error(), raw) || strings.Contains(err.Error(), "pal.secret/llm") {
			t.Errorf("%s: error echoes the ref: %v", name, err)
		}
	}
}

// L2: the same ref in `secrets` and `egress[].inject` would vend the value
// injection exists to keep out of the VM.
func TestValidateEgressInject_RefAlsoInSecretsRejected(t *testing.T) {
	rules := []map[string]any{{"pattern": "api.openai.com", "inject": []any{
		map[string]any{"header": "Authorization", "secretRef": "pal.secret/llm/openai"},
	}}}
	for _, secrets := range [][]map[string]any{
		{{"env_name": "K", "secret_uri": "pal.secret/llm/openai"}},
		{{"envName": "K", "secretUri": "pal.secret/llm/openai"}},
	} {
		err := validateEgressInject(rules, secrets)
		if err == nil || !strings.Contains(err.Error(), "also listed in secrets") {
			t.Fatalf("want overlap rejection, got %v", err)
		}
		if strings.Contains(err.Error(), "pal.secret/") {
			t.Fatalf("error echoes the ref: %v", err)
		}
	}
	if err := validateEgressInject(rules, []map[string]any{{"secret_uri": "pal.secret/llm/anthropic"}}); err != nil {
		t.Fatalf("distinct ref rejected: %v", err)
	}
}

// A DLP policy that cannot be read must refuse the schedule, not spawn a VM
// without DLP (ADR 0030): a tenant in block mode expects enforcement.
func TestScheduleAgentSpec_DLPLoadErrorFailsClosed(t *testing.T) {
	pool := openTestPool(t)
	tenantID := uuid.NewString()
	seedTestTenant(t, pool, tenantID)
	sched := &recScheduler{vmID: "vm-should-not-exist"}
	h := newTestRuntimeHandlerWithPool(t, pool, sched)
	ctx, cancel := context.WithCancel(middleware.InjectTenantID(context.Background(), tenantID))
	cancel() // the policy read fails

	_, _, _, _, _, err := h.scheduleAgentSpec(ctx, tenantID, "", agentSpecDTO{ImageDigest: "sha256:abc"})
	if err == nil || !strings.Contains(err.Error(), "DLP") {
		t.Fatalf("err = %v, want the DLP policy load to refuse the schedule", err)
	}
	if len(sched.calls) != 0 {
		t.Fatalf("scheduler was called %v; a VM must not spawn without its DLP policy", sched.calls)
	}
}

// pal.secret/ refs are accepted, and an injected ref that is also vended into
// the VM is rejected.
func TestValidateEgressInject_PALRefsAndOverlap(t *testing.T) {
	rule := func(ref string) []map[string]any {
		return []map[string]any{{"pattern": "api.openai.com", "inject": []any{
			map[string]any{"header": "Authorization", "secretRef": ref},
		}}}
	}
	if err := validateEgressInject(rule("pal.secret/llm/openai"), nil); err != nil {
		t.Fatalf("pal.secret/ inject rejected: %v", err)
	}
	const ref = "pal.secret/llm/openai"
	err := validateEgressInject(rule(ref), []map[string]any{{"secret_uri": ref}})
	if err == nil || !strings.Contains(err.Error(), "also listed in secrets") {
		t.Errorf("inject %q + secret %q: want overlap rejection, got %v", ref, ref, err)
	}
}

func TestParseRef_PALPrefix(t *testing.T) {
	if p := parseRef("pal.secret/llm/anthropic"); p.scope != "llm" || p.provider != "anthropic" {
		t.Errorf("pal llm ref: %+v", p)
	}
	if p := parseRef("pal.secret/connector/abc/apiKey"); p.scope != "connector" || p.installID != "abc" || p.configKey != "apiKey" {
		t.Errorf("pal connector ref: %+v", p)
	}
	if p := parseRef("palx.secret/llm/openai"); p.scope != "" {
		t.Errorf("look-alike prefix accepted: %+v", p)
	}
}
