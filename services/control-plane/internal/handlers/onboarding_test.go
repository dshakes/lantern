package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const onboardingTestTenant = "00000000-0000-0000-0000-0000000000aa"

// ---- parseAgentSpec (pure) -------------------------------------------------

func TestParseAgentSpec(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		wantErr bool
		check   func(t *testing.T, spec map[string]any)
	}{
		{
			name: "markdown-wrapped, vendor model normalized to capability",
			text: "```json\n{\"name\":\"Inbox Triage Bot!\",\"description\":\"d\",\"systemPrompt\":\"p\",\"model\":\"gpt-5\",\"firstInput\":{\"prompt\":\"x\"}}\n```",
			check: func(t *testing.T, s map[string]any) {
				if s["name"] != "inbox-triage-bot" {
					t.Errorf("name = %v, want inbox-triage-bot", s["name"])
				}
				if s["model"] != "auto" {
					t.Errorf("model = %v, want auto (invariant #6)", s["model"])
				}
			},
		},
		{
			name: "missing systemPrompt/firstInput/description get grounded defaults",
			text: `{"name":"summarizer"}`,
			check: func(t *testing.T, s map[string]any) {
				if sp, _ := s["systemPrompt"].(string); !strings.Contains(sp, "summarize my notes") {
					t.Errorf("systemPrompt not grounded in goal: %q", sp)
				}
				if s["description"] != "summarize my notes" {
					t.Errorf("description = %v", s["description"])
				}
				if fi, ok := s["firstInput"].(map[string]any); !ok || fi["prompt"] == "" {
					t.Errorf("firstInput missing: %v", s["firstInput"])
				}
			},
		},
		{name: "no json", text: "sorry, I can't", wantErr: true},
		{name: "malformed json", text: `{"name": }`, wantErr: true},
		{name: "empty name", text: `{"name":"!!!"}`, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spec, err := parseAgentSpec(tc.text, "summarize my notes")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got spec %v", spec)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			tc.check(t, spec)
		})
	}
}

// ---- POST /v1/agents/generate-spec ----------------------------------------

func onbReq(t *testing.T, fn http.HandlerFunc, method, path, tenant string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = strings.NewReader(string(b))
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenant, "user-onb", "owner")))
	rr := httptest.NewRecorder()
	fn(rr, req)
	return rr
}

func TestGenerateAgentSpec_NoProvider(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	h := NewLlmProxyHandler(srv, NewAuthHandler(srv, testJWTSecret))

	rr := onbReq(t, h.GenerateAgentSpec, http.MethodPost, "/v1/agents/generate-spec", onboardingTestTenant,
		map[string]string{"description": "triage my inbox"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400; body %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["code"] != "no_provider" {
		t.Errorf("code = %q, want no_provider (the dashboard keys its one-click fix on it)", body["code"])
	}
}

func TestGenerateAgentSpec_ReturnsParsedSpec(t *testing.T) {
	specJSON := `{"name":"standup-writer","description":"Writes standups","systemPrompt":"You write standups.","firstInput":{"prompt":"Yesterday I fixed the login bug."},"rationale":"One LLM step is enough.","model":"chat-small","steps":[{"name":"draft","type":"llm","description":"d","config":{}}]}`
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse(specJSON)}}
	h := newTestProxyWithStub(t, stub)

	rr := onbReq(t, h.GenerateAgentSpec, http.MethodPost, "/v1/agents/generate-spec", onboardingTestTenant,
		map[string]string{"description": "write my daily standup"})
	if rr.Code != http.StatusOK {
		t.Fatalf("got %d, want 200; body %s", rr.Code, rr.Body.String())
	}
	var spec map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &spec); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The regression this guards: the endpoint used to return the completion
	// envelope ({model, content}), so `name` was always empty and every caller
	// silently fell back to a static agent.
	if spec["name"] != "standup-writer" || spec["systemPrompt"] != "You write standups." || spec["model"] != "chat-small" {
		t.Errorf("unexpected spec: %v", spec)
	}
	if _, isEnvelope := spec["content"]; isEnvelope {
		t.Error("response is still the completion envelope")
	}
	if stub.callCount() != 1 {
		t.Errorf("provider calls = %d, want 1", stub.callCount())
	}
}

func TestGenerateAgentSpec_BadModelOutput(t *testing.T) {
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse("I'd rather not.")}}
	h := newTestProxyWithStub(t, stub)
	rr := onbReq(t, h.GenerateAgentSpec, http.MethodPost, "/v1/agents/generate-spec", onboardingTestTenant,
		map[string]string{"description": "x"})
	if rr.Code != http.StatusBadGateway || !strings.Contains(rr.Body.String(), "bad_spec") {
		t.Fatalf("got %d %s, want 502 bad_spec", rr.Code, rr.Body.String())
	}
}

// ---- POST /v1/onboarding/explain ------------------------------------------

func TestOnboardingExplain(t *testing.T) {
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
		anthropicOKResponse("Your agent wrote a standup from one line. Try it with a full day's notes."),
	}}
	llm := newTestProxyWithStub(t, stub)
	h := NewOnboardingHandler(llm.srv, llm.auth, llm)

	rr := onbReq(t, h.Explain, http.MethodPost, "/v1/onboarding/explain", onboardingTestTenant,
		map[string]string{"goal": "standups", "agentName": "standup-writer", "output": "Yesterday: fixed login."})
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "wrote a standup") {
		t.Fatalf("got %d %s", rr.Code, rr.Body.String())
	}

	rr = onbReq(t, h.Explain, http.MethodPost, "/v1/onboarding/explain", onboardingTestTenant, map[string]string{"goal": "x"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("empty output+error: got %d, want 400", rr.Code)
	}

	t.Setenv("ANTHROPIC_API_KEY", "")
	rr = onbReq(t, h.Explain, http.MethodPost, "/v1/onboarding/explain", onboardingTestTenant, map[string]string{"error": "boom"})
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "no_provider") {
		t.Errorf("no provider: got %d %s, want 400 no_provider", rr.Code, rr.Body.String())
	}
}

// ---- GET/PUT/DELETE /v1/onboarding (DB-backed) ----------------------------

func seedOnboardingTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	id := uuid.NewString()
	slug := "onb-test-" + id[:8]
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Onboarding Test', 'personal', 'ns-' || $2)`, id, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM tenants WHERE id = $1::uuid", id)
	})
	return id
}

func getOnboarding(t *testing.T, h *OnboardingHandler, tenant string) (int, map[string]any) {
	t.Helper()
	rr := onbReq(t, h.GetState, http.MethodGet, "/v1/onboarding", tenant, nil)
	var out map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	return rr.Code, out
}

func TestOnboardingState_ResumeAndTenantIsolation(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewOnboardingHandler(srv, auth, NewLlmProxyHandler(srv, auth))
	a, b := seedOnboardingTenant(t, pool), seedOnboardingTenant(t, pool)

	// Fresh tenant: empty document, not an error.
	if code, st := getOnboarding(t, h, a); code != http.StatusOK || len(st) != 0 {
		t.Fatalf("fresh: got %d %v, want 200 {}", code, st)
	}

	// Save mid-flow, including a field that must NEVER be persisted.
	rr := onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", a, map[string]any{
		"step": "run", "goal": "write standups", "agentName": "standup-writer", "agentCreated": true,
		"spec": map[string]any{
			"name":         "standup-writer",
			"systemPrompt": "You write standups.",
			"firstInput":   map[string]any{"prompt": "Yesterday: login fix", "token": "sk-nested-first-input"},
			"apiKey":       "sk-nested-spec-key",
			"env":          map[string]any{"OPENAI_API_KEY": "sk-nested-env"},
		},
		"apiKey": "sk-should-not-persist",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("put: got %d %s", rr.Code, rr.Body.String())
	}
	code, st := getOnboarding(t, h, a)
	if code != http.StatusOK || st["step"] != "run" || st["agentName"] != "standup-writer" || st["agentCreated"] != true {
		t.Fatalf("resume: got %d %v", code, st)
	}
	if _, leaked := st["apiKey"]; leaked {
		t.Fatal("unknown field apiKey was persisted (invariant #10)")
	}
	var raw string
	_ = pool.QueryRow(context.Background(), `SELECT settings::text FROM tenants WHERE id = $1`, a).Scan(&raw)
	for _, secret := range []string{"sk-should-not-persist", "sk-nested-spec-key", "sk-nested-env", "sk-nested-first-input"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("secret %q reached tenants.settings: %s", secret, raw)
		}
	}
	// The fields the flow uses survive.
	spec, _ := st["spec"].(map[string]any)
	if spec["systemPrompt"] != "You write standups." || spec["firstInput"].(map[string]any)["prompt"] != "Yesterday: login fix" {
		t.Fatalf("typed spec lost real fields: %v", spec)
	}
	if rr := onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", a, map[string]any{
		"step": "spec", "spec": map[string]any{"name": "x", "model": "gpt-5"},
	}); rr.Code != http.StatusBadRequest {
		t.Errorf("vendor model in spec: got %d, want 400 (invariant #6)", rr.Code)
	}

	// Tenant B sees nothing of A's, and B's reset does not touch A.
	if _, stB := getOnboarding(t, h, b); len(stB) != 0 {
		t.Fatalf("cross-tenant read leaked: %v", stB)
	}
	if rr := onbReq(t, h.DeleteState, http.MethodDelete, "/v1/onboarding", b, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete B: %d", rr.Code)
	}
	if _, st := getOnboarding(t, h, a); st["step"] != "run" {
		t.Fatalf("B's reset clobbered A: %v", st)
	}

	// A token for a tenant that does not exist gets 404, not someone's state.
	ghost := uuid.NewString()
	if code, _ := getOnboarding(t, h, ghost); code != http.StatusNotFound {
		t.Errorf("ghost GET: got %d, want 404", code)
	}
	if rr := onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", ghost, map[string]any{"step": "goal"}); rr.Code != http.StatusNotFound {
		t.Errorf("ghost PUT: got %d, want 404", rr.Code)
	}

	// Validation + done stamps completedAt.
	if rr := onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", a, map[string]any{"step": "teleport"}); rr.Code != http.StatusBadRequest {
		t.Errorf("bad step: got %d, want 400", rr.Code)
	}
	if rr := onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", a, map[string]any{"step": "create", "agentName": "Bad Name"}); rr.Code != http.StatusBadRequest {
		t.Errorf("bad agentName: got %d, want 400", rr.Code)
	}
	onbReq(t, h.PutState, http.MethodPut, "/v1/onboarding", a, map[string]any{"step": "done"})
	if _, st := getOnboarding(t, h, a); st["completedAt"] == nil {
		t.Errorf("done without completedAt: %v", st)
	}

	// Start over.
	onbReq(t, h.DeleteState, http.MethodDelete, "/v1/onboarding", a, nil)
	if _, st := getOnboarding(t, h, a); len(st) != 0 {
		t.Errorf("after delete: %v", st)
	}
}

// ---- clip (rune-safe) -------------------------------------------------------

func TestClip_RuneSafe(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello world", 5, "hello…"},
		{"నమస్కారం మిత్రమా", 4, "నమస్…"}, // Telugu: 4 runes = న మ స ్
		{"🚀🚀🚀🚀", 2, "🚀🚀…"},
		{"", 3, ""},
	}
	for _, c := range cases {
		got := clip(c.in, c.n)
		if got != c.want {
			t.Errorf("clip(%q,%d) = %q, want %q", c.in, c.n, got, c.want)
		}
		if !utf8.ValidString(got) {
			t.Errorf("clip(%q,%d) produced invalid UTF-8", c.in, c.n)
		}
	}
}

// ---- route scopes under PAL_AUTHZ_ENFORCE=1 (DB-backed API keys) ----------

func TestOnboardingRoutes_ScopeEnforcement(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	mux := http.NewServeMux()
	NewOnboardingHandler(srv, auth, NewLlmProxyHandler(srv, auth)).RegisterRoutes(mux)
	tenant := seedOnboardingTenant(t, pool)

	seq := 0
	key := func(scopes ...string) string {
		seq++
		raw := fmt.Sprintf("hlx_live_onbscope_%04d", seq)
		sum := sha256.Sum256([]byte(raw))
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, $2, $3, $4, $5)`,
			tenant, fmt.Sprintf("onb-scope-test-%d", seq), hex.EncodeToString(sum[:]), raw[:8], scopes); err != nil {
			t.Fatalf("insert key: %v", err)
		}
		return raw
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM api_keys WHERE name LIKE 'onb-scope-test-%'`)
	})
	do := func(method, path, raw, body string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+raw)
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, req)
		return rr.Code
	}

	readOnly := key(string(ScopeRead))
	execute := key(string(ScopeRunsExecute))
	explainBody := `{"error":"boom"}`

	// explain spends tenant money on an LLM call: a read-only key is refused.
	if c := do(http.MethodPost, "/v1/onboarding/explain", readOnly, explainBody); c != http.StatusForbidden {
		t.Errorf("explain with read-only key: got %d, want 403", c)
	}
	// runs:execute passes the scope gate (then 400 no_provider — not 403).
	if c := do(http.MethodPost, "/v1/onboarding/explain", execute, explainBody); c == http.StatusForbidden || c == http.StatusUnauthorized {
		t.Errorf("explain with runs:execute: got %d, want past the scope gate", c)
	}
	// GET needs a read scope: runs:execute alone does not imply read.
	if c := do(http.MethodGet, "/v1/onboarding", execute, ""); c != http.StatusForbidden {
		t.Errorf("GET with runs:execute only: got %d, want 403", c)
	}
	if c := do(http.MethodGet, "/v1/onboarding", readOnly, ""); c != http.StatusOK {
		t.Errorf("GET with read: got %d, want 200", c)
	}
	// Writes need settings:write.
	if c := do(http.MethodPut, "/v1/onboarding", readOnly, `{"step":"goal"}`); c != http.StatusForbidden {
		t.Errorf("PUT with read-only key: got %d, want 403", c)
	}
}
