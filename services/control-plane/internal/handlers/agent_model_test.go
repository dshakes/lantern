package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// reqModel returns the "model" field of a recorded provider request body.
func reqModel(t *testing.T, r *http.Request) string {
	t.Helper()
	if r == nil {
		t.Fatal("provider request was not recorded")
	}
	b, _ := io.ReadAll(r.Body)
	var body struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatalf("provider request body not JSON: %v", err)
	}
	return body.Model
}

func anthropicStatusResponse(code int) func(*http.Request) (*http.Response, error) {
	return func(_ *http.Request) (*http.Response, error) {
		b, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]any{"type": "api_error", "message": "overloaded"}})
		return &http.Response{
			StatusCode: code,
			Body:       io.NopCloser(bytes.NewReader(b)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
		}, nil
	}
}

func TestPreferModel(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "")
	type cand = struct{ Provider, Model string }
	var (
		opus   = cand{"anthropic", opusModel()}
		haiku  = cand{"anthropic", haikuModel()}
		gpt4o  = cand{"openai", "gpt-4o"}
		mini   = cand{"openai", "gpt-4o-mini"}
		custom = cand{"anthropic", "claude-opus-4-1"}
	)
	tests := []struct {
		name                    string
		hasAnthropic, hasOpenAI bool
		preferred               string
		want                    []cand // nil → default chain, unchanged
	}{
		{name: "empty keeps default chain", hasAnthropic: true, hasOpenAI: true, preferred: ""},
		{name: "auto keeps default chain", hasAnthropic: true, hasOpenAI: true, preferred: "auto"},
		{name: "unconfigured provider keeps default chain", hasAnthropic: true, preferred: "chat-small"},
		// Cheap tier: preferred → other provider's cheap tier → nothing pricier (fail instead).
		{name: "fast, both providers", hasAnthropic: true, hasOpenAI: true, preferred: "fast", want: []cand{haiku, mini}},
		{name: "fast, openai only fails rather than escalate", hasOpenAI: true, preferred: "fast", want: []cand{mini}},
		{name: "fast, anthropic only fails rather than escalate", hasAnthropic: true, preferred: "fast", want: []cand{haiku}},
		{name: "reasoning-small", hasAnthropic: true, hasOpenAI: true, preferred: "reasoning-small", want: []cand{haiku, mini}},
		{name: "chat-small", hasAnthropic: true, hasOpenAI: true, preferred: "chat-small", want: []cand{mini, haiku}},
		{name: "vendor cheap id", hasAnthropic: true, hasOpenAI: true, preferred: "gpt-4o-mini", want: []cand{mini, haiku}},
		// Non-cheap preference keeps the whole default chain as its tail.
		{name: "reasoning-large keeps full tail", hasAnthropic: true, hasOpenAI: true, preferred: "reasoning-large", want: []cand{{"anthropic", sonnetModel()}, opus, haiku, gpt4o, mini}},
		{name: "vendor frontier passthrough", hasAnthropic: true, hasOpenAI: true, preferred: "claude-opus-4-1", want: []cand{custom, opus, haiku, gpt4o, mini}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			key := func(on bool) string {
				if on {
					return "sk-test"
				}
				return ""
			}
			t.Setenv("ANTHROPIC_API_KEY", key(tc.hasAnthropic))
			t.Setenv("OPENAI_API_KEY", key(tc.hasOpenAI))
			logger, _ := zap.NewDevelopment()
			h := NewLlmProxyHandler(&server.Server{Logger: logger}, nil)

			base := resolveCandidateChain(tc.hasAnthropic, tc.hasOpenAI, true)
			got := h.preferModel(context.Background(), "t1", tc.preferred, base)
			want := tc.want
			if want == nil {
				want = base
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("chain: got %v, want %v (default %v)", got, want, base)
			}
		})
	}
}

func TestCallLLMWithFailover_PreferredModel(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "")
	msgs := []map[string]any{{"role": "user", "content": "hi"}}
	const tenant = "00000000-0000-0000-0000-000000000001"

	t.Run("fast agent calls the cheap model first", func(t *testing.T) {
		stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse("ok")}}
		h := newTestProxyWithStub(t, stub)
		_, _, prov, model, _, _, err := h.callLLMWithFailover(context.Background(), tenant, "reasoning-small", msgs, nil, nil, nil, nil, 1, true)
		if err != nil {
			t.Fatal(err)
		}
		if got := reqModel(t, stub.req(0)); got != haikuModel() {
			t.Errorf("first provider call model: got %q, want %q", got, haikuModel())
		}
		if prov != "anthropic" || model != haikuModel() {
			t.Errorf("used: got %s/%s, want anthropic/%s", prov, model, haikuModel())
		}
	})

	t.Run("retryable error on preferred model fails over", func(t *testing.T) {
		stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
			anthropicStatusResponse(http.StatusInternalServerError),
			anthropicOKResponse("fallback"),
		}}
		h := newTestProxyWithStub(t, stub)
		t.Setenv("OPENAI_API_KEY", "sk-test") // cheap failover target: gpt-4o-mini
		stub.responses[1] = okByProvider("fallback")
		var attempts []candidateAttempt
		text, _, _, model, _, _, err := h.callLLMWithFailover(context.Background(), tenant, "reasoning-small", msgs, nil, nil, nil,
			func(a candidateAttempt) { attempts = append(attempts, a) }, 1, true)
		if err != nil {
			t.Fatalf("expected failover success, got %v", err)
		}
		if text != "fallback" {
			t.Errorf("text: got %q", text)
		}
		if first := reqModel(t, stub.req(0)); first != haikuModel() {
			t.Errorf("first call: got %q, want preferred %q", first, haikuModel())
		}
		if model != "gpt-4o-mini" || reqModel(t, stub.req(1)) != "gpt-4o-mini" {
			t.Errorf("failover target: used %q, second request %q — want the other provider's cheap tier gpt-4o-mini", model, reqModel(t, stub.req(1)))
		}
		if len(attempts) != 2 || attempts[0].Err == nil || attempts[1].Err != nil {
			t.Errorf("attempts: got %+v, want [failed preferred, succeeded fallback]", attempts)
		}
	})

	t.Run("cheap agent never escalates to frontier on failover", func(t *testing.T) {
		stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
			anthropicStatusResponse(http.StatusInternalServerError),
			anthropicOKResponse("must not be reached"),
		}}
		h := newTestProxyWithStub(t, stub) // anthropic only: default chain is [opus, haiku]
		if _, _, _, _, _, _, err := h.callLLMWithFailover(context.Background(), tenant, "fast", msgs, nil, nil, nil, nil, 1, true); err == nil {
			t.Fatal("expected failure, not an escalation to a frontier model")
		}
		if stub.callCount() != 1 {
			t.Errorf("provider calls: got %d, want 1 (haiku only)", stub.callCount())
		}
	})

	t.Run("cheap agent fails after both cheap tiers, no gpt-4o/sonnet/opus", func(t *testing.T) {
		stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){
			anthropicStatusResponse(http.StatusInternalServerError),
			anthropicStatusResponse(http.StatusInternalServerError),
			okByProvider("must not be reached"),
		}}
		h := newTestProxyWithStub(t, stub)
		t.Setenv("OPENAI_API_KEY", "sk-test")
		if _, _, _, _, _, _, err := h.callLLMWithFailover(context.Background(), tenant, "fast", msgs, nil, nil, nil, nil, 1, true); err == nil {
			t.Fatal("expected failure once both cheap tiers failed")
		}
		if stub.callCount() != 2 || reqModel(t, stub.req(0)) != haikuModel() || reqModel(t, stub.req(1)) != "gpt-4o-mini" {
			t.Errorf("calls: %d (want 2: haiku, gpt-4o-mini)", stub.callCount())
		}
	})

	t.Run("auto is the default chain", func(t *testing.T) {
		for _, preferred := range []string{"auto", ""} {
			stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse("ok")}}
			h := newTestProxyWithStub(t, stub)
			if _, _, _, _, _, _, err := h.callLLMWithFailover(context.Background(), tenant, preferred, msgs, nil, nil, nil, nil, 1, true); err != nil {
				t.Fatal(err)
			}
			want := resolveCandidateChain(true, false, true)[0].Model
			if got := reqModel(t, stub.req(0)); got != want {
				t.Errorf("preferred=%q: first call model %q, want default head %q", preferred, got, want)
			}
		}
	})

	t.Run("vendor model passthrough", func(t *testing.T) {
		stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse("ok")}}
		h := newTestProxyWithStub(t, stub)
		if _, _, _, _, _, _, err := h.callLLMWithFailover(context.Background(), tenant, "claude-opus-4-1", msgs, nil, nil, nil, nil, 1, true); err != nil {
			t.Fatal(err)
		}
		if got := reqModel(t, stub.req(0)); got != "claude-opus-4-1" {
			t.Errorf("first call model: got %q, want claude-opus-4-1", got)
		}
	})
}

func TestStreamWithFailover_PreferredModel(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_API_KEY", "")
	var mu sync.Mutex
	var models []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		models = append(models, body.Model)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, openAISSEBody([]string{"ok"}, 5, 2))
	}))
	defer ts.Close()
	h := newStreamHandler(&http.Client{Transport: routeToServer(ts)})

	_, _, usedModel, _, _, err := h.streamWithFailover(context.Background(), "tenant1", "chat-small",
		[]map[string]any{{"role": "user", "content": "hi"}}, func(string) {}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(models) == 0 || models[0] != "gpt-4o-mini" || usedModel != "gpt-4o-mini" {
		t.Errorf("stream: requests %v, used %q — want gpt-4o-mini first", models, usedModel)
	}
}

// TestInlineRun_HonoursAgentModel is the end-to-end proof: an agent whose
// agents.model is a cheap capability runs on that model, and the model that
// answered is recorded on the run's step_completed journal row.
func TestInlineRun_HonoursAgentModel(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-fake-key")
	cheap := "reasoning-small"
	tests := []struct {
		name      string
		model     *string
		wantFirst func(h *LlmProxyHandler) string
	}{
		{"cheap capability", &cheap, func(*LlmProxyHandler) string { return haikuModel() }},
		{"unset model keeps default chain", nil, func(h *LlmProxyHandler) string {
			ctx := context.Background()
			return resolveCandidateChain(
				h.providerAvailable(ctx, recoveryTestDevTenantID, "anthropic"),
				h.providerAvailable(ctx, recoveryTestDevTenantID, "openai"), false)[0].Model
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, srv := newChaosHandler(t)
			f := insertDRFixture(t, srv.Pool, fmt.Sprintf("agent-model-%d", time.Now().UnixNano()), "queued")
			if _, err := srv.Pool.Exec(context.Background(), `UPDATE agents SET model = $1 WHERE id = $2`, tc.model, f.agentID); err != nil {
				t.Fatalf("set agent model: %v", err)
			}
			stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){okByProvider("done")}}
			h.llmProxy = NewLlmProxyHandler(srv, NewAuthHandler(srv, testJWTSecret))
			h.llmProxy.httpClient = &http.Client{Transport: stub}

			var agentName string
			_ = srv.Pool.QueryRow(context.Background(), `SELECT name FROM agents WHERE id = $1`, f.agentID).Scan(&agentName)
			if _, _, err := h.executeRunInlineSync(tenantCtx(recoveryTestDevTenantID), f.runID, recoveryTestDevTenantID, agentName, map[string]any{"message": "hi"}); err != nil {
				t.Fatalf("executeRunInlineSync: %v", err)
			}
			want := tc.wantFirst(h.llmProxy)
			if got := reqModel(t, stub.req(0)); got != want {
				t.Errorf("first provider call model: got %q, want %q", got, want)
			}
			var recorded string
			if err := srv.Pool.QueryRow(context.Background(), `
				SELECT convert_from(payload, 'UTF8')::jsonb->>'model' FROM journal_events
				WHERE run_id = $1 AND kind = 'step_completed' AND step_id = $2`, f.runID, llmStepID).Scan(&recorded); err != nil {
				t.Fatalf("read step_completed: %v", err)
			}
			if recorded != want {
				t.Errorf("model recorded on run: got %q, want %q", recorded, want)
			}
		})
	}
}

// okByProvider answers in the shape of whichever provider was called: a dev
// DB whose tenant has an OpenAI key configured may start the default chain on
// OpenAI.
func okByProvider(text string) func(*http.Request) (*http.Response, error) {
	return func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.anthropic.com" {
			return anthropicOKResponse(text)(r)
		}
		b, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 1, "completion_tokens": 1},
		})
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(b)),
			Header: http.Header{"Content-Type": []string{"application/json"}}}, nil
	}
}

func TestAgentModel_PatchAndGet(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tenantID := recoveryTestDevTenantID
	agentName, _ := twoTierAgent(t, pool, tenantID, map[string]any{"runtime": "node"})

	do := func(method, tenant string, body any) *httptest.ResponseRecorder {
		var rdr io.Reader = http.NoBody
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, "/v1/agents/"+agentName, rdr)
		req.SetPathValue("name", agentName)
		req.Header.Set("Authorization", "Bearer "+mintTestToken(t, tenant, "00000000-0000-0000-0000-000000000002", "owner"))
		w := httptest.NewRecorder()
		if method == http.MethodPatch {
			h.UpdateAgent(w, req)
		} else {
			h.GetAgent(w, req)
		}
		return w
	}

	if w := do(http.MethodPatch, tenantID, map[string]any{"model": "fast"}); w.Code != http.StatusOK {
		t.Fatalf("PATCH model: HTTP %d %s", w.Code, w.Body.String())
	}
	w := do(http.MethodGet, tenantID, nil)
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["model"] != "fast" {
		t.Errorf("GET model: got %v, want fast (body %s)", got["model"], w.Body.String())
	}

	// Another tenant cannot set this agent's model.
	if w := do(http.MethodPatch, "00000000-0000-0000-0000-0000000000ff", map[string]any{"model": "reasoning-frontier"}); w.Code != http.StatusNotFound && w.Code != http.StatusUnauthorized {
		t.Errorf("cross-tenant PATCH: HTTP %d, want 404/401", w.Code)
	}
	var stored string
	_ = pool.QueryRow(context.Background(), `SELECT model FROM agents WHERE tenant_id = $1 AND name = $2`, tenantID, agentName).Scan(&stored)
	if stored != "fast" {
		t.Errorf("model after cross-tenant PATCH: got %q, want fast", stored)
	}
}

// TestWorkflowAIStep_AgentModel: an ai-step with no capability ("auto") runs on
// the agent's model; a node's explicit capability still wins.
func TestWorkflowAIStep_AgentModel(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-fake-key")
	tests := []struct {
		name, nodeCapability, want string
	}{
		{"auto node uses agent model", "", haikuModel()},
		{"explicit node capability wins", "reasoning-frontier", opusModel()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, srv := newChaosHandler(t)
			f := insertDRFixture(t, srv.Pool, fmt.Sprintf("agent-model-wf-%d", time.Now().UnixNano()), "running")
			data := map[string]any{"prompt": "summarize"}
			if tc.nodeCapability != "" {
				data["capability"] = tc.nodeCapability
			}
			wf, _ := json.Marshal(map[string]any{
				"nodes": []map[string]any{
					{"id": "t", "type": "trigger", "data": map[string]any{}},
					{"id": "a", "type": "ai-step", "data": data},
					{"id": "e", "type": "end", "data": map[string]any{}},
				},
				"edges": []map[string]any{{"id": "1", "source": "t", "target": "a"}, {"id": "2", "source": "a", "target": "e"}},
			})
			if _, err := srv.Pool.Exec(context.Background(),
				`UPDATE agents SET model = 'reasoning-small', workflow = $1::jsonb WHERE id = $2`, string(wf), f.agentID); err != nil {
				t.Fatalf("seed workflow: %v", err)
			}
			stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){okByProvider("done")}}
			h.llmProxy = NewLlmProxyHandler(srv, NewAuthHandler(srv, testJWTSecret))
			h.llmProxy.httpClient = &http.Client{Transport: stub}

			var agentName string
			_ = srv.Pool.QueryRow(context.Background(), `SELECT name FROM agents WHERE id = $1`, f.agentID).Scan(&agentName)
			if !h.runWorkflowIfPresent(tenantCtx(recoveryTestDevTenantID), f.runID, recoveryTestDevTenantID, agentName, map[string]any{}) {
				t.Fatal("workflow not executed")
			}
			if got := reqModel(t, stub.req(0)); got != tc.want {
				t.Errorf("ai-step model: got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidAgentModel(t *testing.T) {
	tests := []struct {
		model string
		ok    bool
	}{
		{"", true}, {"auto", true}, {"fast", true}, {"cheap", true}, {"reasoning-small", true},
		{"chat-edge", true}, {"gpt-4o-mini", true}, {"o3-mini", true}, {"claude-haiku-4-5-20251001", true},
		{"tts", false}, {"embed-large", false}, {"gemini-pro", false}, {"Claude-Opus", false},
		{"sk-ant-api03-secretsecret", false}, {"claude-" + string(bytes.Repeat([]byte("x"), 100)), false},
		{"gpt 4o; drop table", false},
	}
	for _, tc := range tests {
		err := validAgentModel(tc.model)
		if (err == nil) != tc.ok {
			t.Errorf("validAgentModel(%q): err=%v, want ok=%v", tc.model, err, tc.ok)
		}
		if err != nil && tc.model != "" && bytes.Contains([]byte(err.Error()), []byte(tc.model)) {
			t.Errorf("validAgentModel(%q): error echoes the input", tc.model)
		}
	}
}

// TestAgentModel_CreateValidates: POST /v1/agents persists a valid model and
// rejects an invalid one with 400 without echoing it.
func TestAgentModel_CreateValidates(t *testing.T) {
	pool := openTestPool(t)
	h := newTwoTierRESTHandler(t, pool)
	tok := mintTestToken(t, recoveryTestDevTenantID, "00000000-0000-0000-0000-000000000002", "owner")
	post := func(body map[string]any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/v1/agents", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+tok)
		w := httptest.NewRecorder()
		h.CreateAgent(w, req)
		return w
	}
	name := fmt.Sprintf("agent-model-create-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agents WHERE tenant_id = $1 AND name = $2`, recoveryTestDevTenantID, name)
	})

	const secretish = "sk-ant-api03-not-a-model"
	if w := post(map[string]any{"name": name, "model": secretish}); w.Code != http.StatusBadRequest || bytes.Contains(w.Body.Bytes(), []byte(secretish)) {
		t.Fatalf("invalid model: HTTP %d body %s — want 400 without the value echoed", w.Code, w.Body.String())
	}
	w := post(map[string]any{"name": name, "model": "fast"})
	if w.Code != http.StatusCreated {
		t.Fatalf("create: HTTP %d %s", w.Code, w.Body.String())
	}
	var stored string
	_ = pool.QueryRow(context.Background(), `SELECT COALESCE(model, '') FROM agents WHERE tenant_id = $1 AND name = $2`, recoveryTestDevTenantID, name).Scan(&stored)
	if stored != "fast" {
		t.Errorf("stored model: got %q, want fast", stored)
	}
}

// TestTemplateApply_PersistsPromptLabelsModel is the regression test for the
// template-create UPDATE (templates.go), which wrote the then-missing
// agents.model column and so silently dropped system_prompt and labels too.
func TestTemplateApply_PersistsPromptLabelsModel(t *testing.T) {
	pool := openTestPool(t)
	rest := newTwoTierRESTHandler(t, pool)
	th := NewTemplateHandler(rest, rest.auth)
	tpl := templates["lantern-guide"]
	name := fmt.Sprintf("agent-model-tpl-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM schedules WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, name)
		_, _ = pool.Exec(bg, `DELETE FROM agent_budgets WHERE tenant_id = $1 AND agent_name = $2`, recoveryTestDevTenantID, name)
		_, _ = pool.Exec(bg, `DELETE FROM agents WHERE tenant_id = $1 AND name = $2`, recoveryTestDevTenantID, name)
	})

	b, _ := json.Marshal(map[string]any{"templateId": tpl.ID, "name": name})
	req := httptest.NewRequest(http.MethodPost, "/v1/agents/from-template", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+mintTestToken(t, recoveryTestDevTenantID, "00000000-0000-0000-0000-000000000002", "owner"))
	w := httptest.NewRecorder()
	th.Apply(w, req)
	if w.Code >= 300 {
		t.Fatalf("apply: HTTP %d %s", w.Code, w.Body.String())
	}
	assertAgentRestoredFromTemplate(t, pool, name, tpl)
}

// TestInlineRun_BackfillPersistsPromptLabelsModel is the regression test for
// the executor's lazy back-fill UPDATE, which failed the same way.
func TestInlineRun_BackfillPersistsPromptLabelsModel(t *testing.T) {
	t.Setenv("LANTERN_USE_CLAUDE_CODE", "")
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-fake-key")
	h, srv := newChaosHandler(t)
	tpl := templates["lantern-guide"]
	f := insertDRFixture(t, srv.Pool, fmt.Sprintf("agent-model-backfill-%d", time.Now().UnixNano()), "queued")
	if _, err := srv.Pool.Exec(context.Background(),
		`UPDATE agents SET labels = jsonb_build_object('lantern.template', $1::text) WHERE id = $2`, tpl.ID, f.agentID); err != nil {
		t.Fatalf("seed labels: %v", err)
	}
	h.llmProxy = NewLlmProxyHandler(srv, NewAuthHandler(srv, testJWTSecret))
	h.llmProxy.httpClient = &http.Client{Transport: &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){okByProvider("done")}}}

	var name string
	_ = srv.Pool.QueryRow(context.Background(), `SELECT name FROM agents WHERE id = $1`, f.agentID).Scan(&name)
	if _, _, err := h.executeRunInlineSync(tenantCtx(recoveryTestDevTenantID), f.runID, recoveryTestDevTenantID, name, map[string]any{"message": "hi"}); err != nil {
		t.Fatalf("executeRunInlineSync: %v", err)
	}
	assertAgentRestoredFromTemplate(t, srv.Pool, name, tpl)
}

func assertAgentRestoredFromTemplate(t *testing.T, pool interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}, name string, tpl templateDef) {
	t.Helper()
	var prompt, model, labelTemplate string
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(system_prompt, ''), COALESCE(model, ''), COALESCE(labels->>'lantern.template', '')
		FROM agents WHERE tenant_id = $1 AND name = $2`, recoveryTestDevTenantID, name).Scan(&prompt, &model, &labelTemplate); err != nil {
		t.Fatalf("read agent: %v", err)
	}
	if prompt != tpl.SystemPrompt {
		t.Errorf("system_prompt not persisted (got %d chars, want %d)", len(prompt), len(tpl.SystemPrompt))
	}
	if model != tpl.Model {
		t.Errorf("model: got %q, want %q", model, tpl.Model)
	}
	if labelTemplate != tpl.ID {
		t.Errorf("labels lantern.template: got %q, want %q", labelTemplate, tpl.ID)
	}
}
