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
	tests := []struct {
		name         string
		hasOpenAI    bool
		preferred    string
		wantHead     cand // zero → chain must be unchanged
		wantUnchaged bool
	}{
		{name: "empty keeps default chain", hasOpenAI: true, preferred: "", wantUnchaged: true},
		{name: "auto keeps default chain", hasOpenAI: true, preferred: "auto", wantUnchaged: true},
		{name: "capability heads chain", hasOpenAI: true, preferred: "reasoning-small", wantHead: cand{"anthropic", haikuModel()}},
		{name: "openai capability heads chain", hasOpenAI: true, preferred: "chat-small", wantHead: cand{"openai", "gpt-4o-mini"}},
		{name: "vendor model passthrough", hasOpenAI: true, preferred: "claude-opus-4-1", wantHead: cand{"anthropic", "claude-opus-4-1"}},
		{name: "unconfigured provider keeps default chain", hasOpenAI: false, preferred: "chat-small", wantUnchaged: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ANTHROPIC_API_KEY", "sk-test")
			openai := ""
			if tc.hasOpenAI {
				openai = "sk-test"
			}
			t.Setenv("OPENAI_API_KEY", openai)
			logger, _ := zap.NewDevelopment()
			h := NewLlmProxyHandler(&server.Server{Logger: logger}, nil)

			base := resolveCandidateChain(true, tc.hasOpenAI, true)
			got := h.preferModel(context.Background(), "t1", tc.preferred, base)
			if tc.wantUnchaged {
				if fmt.Sprint(got) != fmt.Sprint(base) {
					t.Fatalf("chain changed: got %v, want %v", got, base)
				}
				return
			}
			if got[0] != tc.wantHead {
				t.Fatalf("head: got %v, want %v (chain %v)", got[0], tc.wantHead, got)
			}
			// The rest of the default chain is the failover tail, without a duplicate.
			seen := map[cand]int{}
			for _, c := range got {
				seen[c]++
			}
			if seen[tc.wantHead] != 1 {
				t.Errorf("preferred candidate appears %d times in %v", seen[tc.wantHead], got)
			}
			for _, c := range base {
				if seen[c] == 0 {
					t.Errorf("default candidate %v dropped from failover tail %v", c, got)
				}
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
		if model == haikuModel() || reqModel(t, stub.req(1)) != model {
			t.Errorf("failover target: used %q, second request %q — want a different model than the failed preferred one", model, reqModel(t, stub.req(1)))
		}
		if len(attempts) != 2 || attempts[0].Err == nil || attempts[1].Err != nil {
			t.Errorf("attempts: got %+v, want [failed preferred, succeeded fallback]", attempts)
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
