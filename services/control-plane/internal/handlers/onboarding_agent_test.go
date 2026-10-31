package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// ---- harness: a stub model + a fake REST mux that mirrors the real routes ----
//
// The fake mux enforces the same document validation the real handlers do
// (onboardingState.validate, palOnboardingState.validate → palCanEnter), so
// gate tests exercise the real guard rails, not a re-implementation.

type memChatStore struct {
	mu   sync.Mutex
	docs map[string]*onbChatDoc
}

func (m *memChatStore) load(_ context.Context, tenantID, product string) (*onbChatDoc, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.docs[tenantID+"/"+product]; ok {
		b, _ := json.Marshal(d)
		out := &onbChatDoc{}
		_ = json.Unmarshal(b, out)
		return out, nil
	}
	return &onbChatDoc{}, nil
}

func (m *memChatStore) save(_ context.Context, tenantID, product string, d *onbChatDoc) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, _ := json.Marshal(d)
	out := &onbChatDoc{}
	_ = json.Unmarshal(b, out)
	m.docs[tenantID+"/"+product] = out
	return nil
}

func (m *memChatStore) clear(_ context.Context, tenantID, product string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.docs, tenantID+"/"+product)
	return nil
}

func (m *memChatStore) raw() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, _ := json.Marshal(m.docs)
	return string(b)
}

type fakeAPI struct {
	mu         sync.Mutex
	hasKey     bool
	keyWorks   bool
	savedKeys  []string
	runtimeDoc onboardingState
	palDoc     palOnboardingState
	agents     map[string]bool
	calls      []string // "METHOD path"
	specName   string
	runStatus  string
}

func (f *fakeAPI) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (f *fakeAPI) mux() *http.ServeMux {
	m := http.NewServeMux()
	note := func(r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
	}
	m.HandleFunc("POST /v1/settings/llm-providers", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		var b struct{ Provider, APIKey string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		f.savedKeys = append(f.savedKeys, b.APIKey)
		f.hasKey = true
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"status": "saved", "provider": b.Provider})
	})
	m.HandleFunc("POST /v1/settings/llm-providers/{p}/test", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		if f.keyWorks {
			writeJSON(w, http.StatusOK, map[string]any{"success": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "401 invalid x-api-key"})
	})
	m.HandleFunc("GET /v1/settings/llm-providers", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []map[string]string{{"provider": "anthropic", "status": "configured"}})
	})
	m.HandleFunc("GET /v1/onboarding", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		writeJSON(w, http.StatusOK, f.runtimeDoc)
	})
	m.HandleFunc("PUT /v1/onboarding", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		var st onboardingState
		if err := json.NewDecoder(r.Body).Decode(&st); err != nil || st.validate() != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid"})
			return
		}
		if st.Step == "done" && st.CompletedAt == nil {
			now := time.Now()
			st.CompletedAt = &now
		}
		f.mu.Lock()
		f.runtimeDoc = st
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, st)
	})
	m.HandleFunc("GET /v1/pal/onboarding", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		writeJSON(w, http.StatusOK, f.palDoc)
	})
	m.HandleFunc("PUT /v1/pal/onboarding", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		var st palOnboardingState
		if err := json.NewDecoder(r.Body).Decode(&st); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
		if err := st.validate(); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		f.mu.Lock()
		f.palDoc = st
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, st)
	})
	m.HandleFunc("POST /v1/agents/generate-spec", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		writeJSON(w, http.StatusOK, map[string]any{
			"name": f.specName, "description": "Summarizes standup notes", "systemPrompt": "You summarize standups.",
			"firstInput": map[string]any{"prompt": "Yesterday: fixed login."}, "model": "auto", "apiKey": "sk-should-be-dropped",
		})
	})
	m.HandleFunc("POST /v1/agents", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		var b struct{ Name, Model string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.agents[b.Name] {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "agent already exists"})
			return
		}
		if b.Model != "auto" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "model must be a capability"})
			return
		}
		f.agents[b.Name] = true
		writeJSON(w, http.StatusCreated, map[string]string{"name": b.Name})
	})
	m.HandleFunc("GET /v1/agents/{name}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if !f.agents[r.PathValue("name")] {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"name": r.PathValue("name")})
	})
	m.HandleFunc("POST /v1/runs", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		writeJSON(w, http.StatusCreated, map[string]string{"id": "run-1", "status": "queued"})
	})
	m.HandleFunc("GET /v1/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"id": "run-1", "status": f.runStatus, "output": map[string]any{"text": "Yesterday you fixed login."}})
	})
	m.HandleFunc("POST /v1/pal/onboarding/trust/suggest", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		qs, qe := 22, 7
		writeJSON(w, http.StatusOK, palTrustSuggestion{Modes: map[string]string{"delivery": "auto", "bill": "ask"}, QuietStart: &qs, QuietEnd: &qe, Why: "hands-off on deliveries"})
	})
	m.HandleFunc("POST /v1/pal/onboarding/profile/extract", func(w http.ResponseWriter, r *http.Request) {
		note(r)
		writeJSON(w, http.StatusOK, map[string]any{"items": []palProfileProposal{{palProfileItem: palProfileItem{Section: "facts", Key: "spouse", Value: "Sam"}, Quote: "my wife Sam"}}})
	})
	return m
}

// stubModel returns scripted replies in order and records every prompt.
type stubModel struct {
	mu      sync.Mutex
	replies []string
	err     error
	systems []string
	users   []string
}

func (s *stubModel) complete(_ context.Context, _, system, user string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.systems = append(s.systems, system)
	s.users = append(s.users, user)
	if s.err != nil {
		return "", s.err
	}
	if len(s.replies) == 0 {
		return `{"say":"(no more scripted replies)","tool":null}`, nil
	}
	r := s.replies[0]
	s.replies = s.replies[1:]
	return r, nil
}

func (s *stubModel) allPrompts() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.systems, "\n") + strings.Join(s.users, "\n")
}

type agentHarness struct {
	h     *OnboardingAgentHandler
	api   *fakeAPI
	model *stubModel
	store *memChatStore
}

func newAgentHarness(t *testing.T, replies ...string) *agentHarness {
	t.Helper()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	api := &fakeAPI{hasKey: true, keyWorks: true, agents: map[string]bool{}, specName: "standup-summarizer", runStatus: "succeeded"}
	model := &stubModel{replies: replies}
	store := &memChatStore{docs: map[string]*onbChatDoc{}}
	h := NewOnboardingAgentHandler(srv, auth, nil)
	h.store = store
	h.complete = model.complete
	h.providerReady = func(context.Context, string) bool { api.mu.Lock(); defer api.mu.Unlock(); return api.hasKey }
	h.runPoll = time.Millisecond
	h.runWait = time.Second
	h.SetDispatcher(api.mux())
	return &agentHarness{h: h, api: api, model: model, store: store}
}

func (ah *agentHarness) turn(t *testing.T, body map[string]any) onbTurnResponse {
	t.Helper()
	rr := onbReq(t, ah.h.Turn, http.MethodPost, "/v1/onboarding/agent/turn", onboardingTestTenant, body)
	if rr.Code != http.StatusOK {
		t.Fatalf("turn: %d %s", rr.Code, rr.Body.String())
	}
	var out onbTurnResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func findCall(calls []onbToolCall, tool string) *onbToolCall {
	for i := range calls {
		if calls[i].Tool == tool {
			return &calls[i]
		}
	}
	return nil
}

// ---- tests -------------------------------------------------------------------

func TestOnboardingAgent_NoProviderIsScriptedAndAsksForKeyForm(t *testing.T) {
	ah := newAgentHarness(t)
	ah.api.hasKey = false
	for _, product := range []string{"runtime", "pal"} {
		out := ah.turn(t, map[string]any{"product": product, "event": "start"})
		if out.Mode != "scripted" {
			t.Fatalf("%s: mode %q, want scripted (no model to ask)", product, out.Mode)
		}
		if len(out.Actions) != 1 || out.Actions[0].Tool != "collect_provider_key" {
			t.Fatalf("%s: actions %+v, want the secure key form", product, out.Actions)
		}
		if out.Facts.Phase != "provider" {
			t.Errorf("%s: phase %q, want provider", product, out.Facts.Phase)
		}
	}
	if len(ah.model.users) != 0 {
		t.Fatalf("model was called %d times without a provider key", len(ah.model.users))
	}
}

func TestOnboardingAgent_PastedKeyIsSavedTestedAndRedacted(t *testing.T) {
	const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"
	ah := newAgentHarness(t, `{"say":"Your key works. What should your first agent do?","tool":null}`)
	ah.api.hasKey = false

	out := ah.turn(t, map[string]any{"product": "runtime", "message": "here you go " + key})
	if len(ah.api.savedKeys) != 1 || ah.api.savedKeys[0] != key {
		t.Fatalf("key not passed to the real save endpoint: %v", ah.api.savedKeys)
	}
	if ah.api.count("POST /v1/settings/llm-providers/anthropic/test") != 1 {
		t.Fatal("the saved key was not tested with a real call")
	}
	if c := findCall(out.ToolCalls, "save_provider_key"); c == nil || !c.OK {
		t.Fatalf("save_provider_key tool call: %+v", out.ToolCalls)
	}
	if out.Mode != "agent" {
		t.Errorf("mode %q after a working key, want agent", out.Mode)
	}
	resp, _ := json.Marshal(out)
	for where, s := range map[string]string{"response": string(resp), "transcript": ah.store.raw(), "model prompt": ah.model.allPrompts()} {
		if strings.Contains(s, key) || strings.Contains(s, "ABCDEFGHIJKLMNOP") {
			t.Fatalf("provider key leaked into the %s", where)
		}
	}
	if !strings.Contains(ah.store.raw(), "removed from chat") {
		t.Error("transcript should carry the placeholder where the key was")
	}
}

func TestOnboardingAgent_BadPastedKeyExplainsAndReoffersForm(t *testing.T) {
	ah := newAgentHarness(t)
	ah.api.hasKey, ah.api.keyWorks = false, false
	out := ah.turn(t, map[string]any{"product": "pal", "message": "sk-proj-0000000000000000000000000000"})
	if out.Mode != "scripted" || len(out.Actions) != 1 || out.Actions[0].Tool != "collect_provider_key" {
		t.Fatalf("bad key: mode %q actions %+v", out.Mode, out.Actions)
	}
	if !strings.Contains(out.Reply, "invalid x-api-key") {
		t.Errorf("reply should say why the key failed: %q", out.Reply)
	}
	if len(ah.model.users) != 0 {
		t.Error("model must not be called with a key that failed its test")
	}
}

func TestOnboardingAgent_RuntimeFlowSelectsRealTools(t *testing.T) {
	ah := newAgentHarness(t,
		`{"say":"Designing that now.","tool":{"name":"design_agent","args":{"goal":"summarize my standup notes"}}}`,
		`{"say":"Here's standup-summarizer. Create it?","tool":null}`,
		// turn 2
		"```json\n{\"say\":\"Creating it.\",\"tool\":{\"name\":\"create_agent\",\"args\":{}}}\n```",
		`{"say":"Created. Running it once.","tool":{"name":"start_run","args":{}}}`,
		`{"say":"It ran and summarized your note.","tool":null}`,
	)
	out := ah.turn(t, map[string]any{"product": "runtime", "message": "I want an agent that summarizes my standup notes"})
	if c := findCall(out.ToolCalls, "design_agent"); c == nil || !c.OK {
		t.Fatalf("design_agent: %+v", out.ToolCalls)
	}
	if ah.api.runtimeDoc.Spec == nil || ah.api.runtimeDoc.Spec.Name != "standup-summarizer" || ah.api.runtimeDoc.Goal == "" {
		t.Fatalf("design not persisted through PUT /v1/onboarding: %+v", ah.api.runtimeDoc)
	}
	if out.Facts.Phase != "create" || out.Reply != "Here's standup-summarizer. Create it?" {
		t.Fatalf("after design: phase %q reply %q", out.Facts.Phase, out.Reply)
	}
	if strings.Contains(ah.store.raw(), "sk-should-be-dropped") {
		t.Fatal("an unknown spec field reached the transcript")
	}

	out = ah.turn(t, map[string]any{"product": "runtime", "message": "yes, create it and try it"})
	if c := findCall(out.ToolCalls, "create_agent"); c == nil || !c.OK {
		t.Fatalf("create_agent: %+v", out.ToolCalls)
	}
	if c := findCall(out.ToolCalls, "start_run"); c == nil || !c.OK || !strings.Contains(c.Summary, "succeeded") {
		t.Fatalf("start_run: %+v", out.ToolCalls)
	}
	st := ah.api.runtimeDoc
	if !st.AgentCreated || !st.SpecApproved || st.RunStatus != "succeeded" || st.RunID != "run-1" {
		t.Fatalf("progress not persisted: %+v", st)
	}
	if out.Facts.Phase != "finish" {
		t.Errorf("phase %q, want finish", out.Facts.Phase)
	}
}

func TestOnboardingAgent_GateRefusesAndDoesNotDispatch(t *testing.T) {
	// create_agent before any design exists: refused, never dispatched.
	ah := newAgentHarness(t,
		`{"say":"Creating it.","tool":{"name":"create_agent","args":{}}}`,
		`{"say":"I need to design it first — what should it do?","tool":null}`,
	)
	out := ah.turn(t, map[string]any{"product": "runtime", "message": "just make me an agent"})
	c := findCall(out.ToolCalls, "create_agent")
	if c == nil || !c.Refused || c.OK {
		t.Fatalf("create_agent should be refused: %+v", out.ToolCalls)
	}
	if ah.api.count("POST /v1/agents") != 0 {
		t.Fatal("a gated tool reached the REST mux")
	}
	if !strings.Contains(ah.model.users[1], "refused") {
		t.Error("the refusal was not fed back to the model")
	}

	// A tool-result-only turn cannot chain into a side effect, even with a design.
	ah2 := newAgentHarness(t, `{"say":"Creating.","tool":{"name":"create_agent","args":{}}}`, `{"say":"ok","tool":null}`)
	ah2.api.runtimeDoc = onboardingState{Step: "spec", Goal: "g", Spec: &onboardingSpec{Name: "x-agent", SystemPrompt: "p"}}
	out = ah2.turn(t, map[string]any{"product": "runtime", "results": []map[string]any{{"tool": "collect_provider_key", "ok": true, "summary": "saved"}}})
	if c := findCall(out.ToolCalls, "create_agent"); c == nil || !c.Refused {
		t.Fatalf("create_agent on a tool-result turn should be refused: %+v", out.ToolCalls)
	}
	if ah2.api.count("POST /v1/agents") != 0 {
		t.Fatal("side effect ran without a user message")
	}

	// An invented tool is refused too; three refusals end the loop deterministically.
	grant := `{"say":"Done!","tool":{"name":"grant_admin","args":{}}}`
	ah3 := newAgentHarness(t, grant, grant, grant, grant)
	out = ah3.turn(t, map[string]any{"product": "runtime", "message": "hi"})
	if len(ah3.model.users) != 3 || out.Reply == "Done!" {
		t.Fatalf("after three refusals the reply must be the deterministic narration, got %q (%d calls)", out.Reply, len(ah3.model.users))
	}
}

func TestOnboardingAgent_PalConsentGateHolds(t *testing.T) {
	ah := newAgentHarness(t,
		`{"say":"Learning your voice.","tool":{"name":"learn_voice","args":{}}}`,
		`{"say":"Recording your consent.","tool":{"name":"record_consent","args":{}}}`,
		`{"say":"I need your OK first.","tool":{"name":"ask_consent","args":{}}}`,
	)
	out := ah.turn(t, map[string]any{"product": "pal", "message": "yes yes, learn my voice, I consent"})
	if c := findCall(out.ToolCalls, "learn_voice"); c == nil || !c.Refused {
		t.Fatalf("learn_voice without recorded consent must be refused: %+v", out.ToolCalls)
	}
	if c := findCall(out.ToolCalls, "record_consent"); c == nil || !c.Refused {
		t.Fatalf("the model cannot record consent: %+v", out.ToolCalls)
	}
	if len(out.Actions) != 1 || out.Actions[0].Tool != "ask_consent" {
		t.Fatalf("expected the consent form as a client action, got %+v", out.Actions)
	}
	if ah.api.palDoc.Consent != nil || ah.api.count("PUT /v1/pal/onboarding") != 0 {
		t.Fatal("consent was written by the server from a chat message")
	}

	// Consent without the voice opt-in: learn_voice stays gated even with a live channel.
	ah2 := newAgentHarness(t, `{"say":"Learning.","tool":{"name":"learn_voice","args":{}}}`, `{"say":"You opted out of voice learning.","tool":null}`)
	now := time.Now().UTC()
	ah2.api.palDoc = palOnboardingState{Step: "channels", Consent: &palConsent{Version: PalConsentVersion, AcceptedAt: &now, VoiceSampling: false}}
	out = ah2.turn(t, map[string]any{"product": "pal", "results": []map[string]any{
		{"tool": "check_channels", "ok": true, "summary": "iMessage ready", "channels": map[string]string{"imessage": "ready", "whatsapp": "offline"}},
	}})
	if c := findCall(out.ToolCalls, "learn_voice"); c == nil || !c.Refused || !strings.Contains(c.Summary, "opted in") {
		t.Fatalf("learn_voice without the opt-in must be refused: %+v", out.ToolCalls)
	}
	if !out.Facts.ChannelsVerified || out.Facts.Phase != "voice" {
		t.Errorf("live channel report should verify channels: %+v", out.Facts)
	}
}

func TestOnboardingAgent_PalVoiceAllowedOnlyWithOptInAndLiveChannel(t *testing.T) {
	ah := newAgentHarness(t, `{"say":"Reading a sample of what you've sent.","tool":{"name":"learn_voice","args":{"correction":"less formal"}}}`)
	now := time.Now().UTC()
	ah.api.palDoc = palOnboardingState{Step: "channels", Consent: &palConsent{Version: PalConsentVersion, AcceptedAt: &now, VoiceSampling: true}}
	ah.h.store.save(context.Background(), onboardingTestTenant, "pal", &onbChatDoc{Channels: &onbChannelObs{IMessage: "ready", At: now}})
	out := ah.turn(t, map[string]any{"product": "pal", "message": "go ahead"})
	if len(out.Actions) != 1 || out.Actions[0].Tool != "learn_voice" || out.Actions[0].Args.Correction != "less formal" {
		t.Fatalf("learn_voice should be handed to the client: %+v (calls %+v)", out.Actions, out.ToolCalls)
	}

	// A stale channel check no longer verifies.
	ah.h.now = func() time.Time { return now.Add(time.Hour) }
	f := ah.h.facts(httptest.NewRequest("GET", "/", nil), onboardingTestTenant, "pal", &onbChatDoc{Channels: &onbChannelObs{IMessage: "ready", At: now}})
	if f.ChannelsVerified {
		t.Error("an hour-old channel check must not verify channels")
	}
}

func TestOnboardingAgent_PalTrustAndProfileHandOffToClientCards(t *testing.T) {
	ah := newAgentHarness(t,
		`{"say":"Here's what I'd set.","tool":{"name":"propose_trust","args":{"text":"handle deliveries, quiet 10pm to 7am"}}}`,
	)
	now := time.Now().UTC()
	ah.api.palDoc = palOnboardingState{Step: "trust", Consent: &palConsent{Version: PalConsentVersion, AcceptedAt: &now}, Voice: &palVoice{Skipped: true}}
	out := ah.turn(t, map[string]any{"product": "pal", "message": "handle deliveries, quiet 10pm to 7am"})
	if len(out.Actions) != 1 || out.Actions[0].Tool != "confirm_trust" || out.Actions[0].Args.Modes["delivery"] != "auto" {
		t.Fatalf("propose_trust → confirm_trust card: %+v", out.Actions)
	}
	if ah.api.palDoc.Trust != nil {
		t.Fatal("trust must not be saved until the owner confirms")
	}

	// extract_profile is gated until trust is saved.
	ah2 := newAgentHarness(t, `{"say":"Noting that.","tool":{"name":"extract_profile","args":{"text":"my wife Sam"}}}`, `{"say":"Let's finish trust first.","tool":null}`)
	ah2.api.palDoc = ah.api.palDoc
	out = ah2.turn(t, map[string]any{"product": "pal", "message": "my wife Sam"})
	if c := findCall(out.ToolCalls, "extract_profile"); c == nil || !c.Refused {
		t.Fatalf("extract_profile before trust must be refused: %+v", out.ToolCalls)
	}
}

func TestOnboardingAgent_ResumeRecapsAndReoffersPendingAction(t *testing.T) {
	ah := newAgentHarness(t, `{"say":"I need your OK first.","tool":{"name":"ask_consent","args":{}}}`)
	ah.turn(t, map[string]any{"product": "pal", "message": "set me up"})

	// Reload: GET returns the transcript and the pending action.
	rr := onbReq(t, ah.h.Get, http.MethodGet, "/v1/onboarding/agent?product=pal", onboardingTestTenant, nil)
	var got onbTurnResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if rr.Code != http.StatusOK || len(got.Messages) < 2 || len(got.Actions) != 1 || got.Actions[0].Tool != "ask_consent" {
		t.Fatalf("resume GET: %d %+v", rr.Code, got)
	}

	// A reload right after the agent spoke shows the transcript; no model call.
	calls := len(ah.model.users)
	out := ah.turn(t, map[string]any{"product": "pal", "event": "resume"})
	if len(ah.model.users) != calls || len(out.Actions) != 1 || out.Actions[0].Tool != "ask_consent" {
		t.Fatalf("immediate resume: %d model calls, actions %+v", len(ah.model.users)-calls, out.Actions)
	}

	// Coming back later gets a recap.
	later := time.Now().UTC().Add(time.Hour)
	ah.h.now = func() time.Time { return later }
	ah.model.replies = []string{`{"say":"Welcome back — you were about to review consent.","tool":null}`}
	out = ah.turn(t, map[string]any{"product": "pal", "event": "resume"})
	if !strings.Contains(ah.model.users[len(ah.model.users)-1], "came back") {
		t.Error("resume turn should ask the model for a recap")
	}
	if !strings.Contains(out.Reply, "Welcome back") || len(out.Messages) < 3 {
		t.Fatalf("resume reply: %q (%d msgs)", out.Reply, len(out.Messages))
	}

	// Reloading again replaces the recap instead of stacking another.
	later = later.Add(time.Hour)
	ah.model.replies = []string{`{"say":"Welcome back again.","tool":null}`}
	before := len(out.Messages)
	out = ah.turn(t, map[string]any{"product": "pal", "event": "resume"})
	if len(out.Messages) != before || out.Messages[len(out.Messages)-1].Text != "Welcome back again." {
		t.Fatalf("recaps stacked: %d → %d messages", before, len(out.Messages))
	}

	// Other product and other tenant see nothing.
	rr = onbReq(t, ah.h.Get, http.MethodGet, "/v1/onboarding/agent?product=runtime", onboardingTestTenant, nil)
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if len(got.Messages) != 0 {
		t.Fatalf("runtime transcript leaked pal messages: %+v", got.Messages)
	}
	rr = onbReq(t, ah.h.Get, http.MethodGet, "/v1/onboarding/agent?product=pal", uuid.NewString(), nil)
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if len(got.Messages) != 0 {
		t.Fatal("cross-tenant transcript read")
	}
}

func TestOnboardingAgent_ModelFailureFallsBackLabelled(t *testing.T) {
	ah := newAgentHarness(t)
	ah.model.err = errors.New("all configured providers failed: 529 overloaded")
	out := ah.turn(t, map[string]any{"product": "runtime", "message": "build me a triage agent"})
	if out.Mode != "fallback" || out.FallbackReason == "" {
		t.Fatalf("mode %q reason %q, want labelled fallback", out.Mode, out.FallbackReason)
	}
	if out.Reply == "" || strings.Contains(out.Reply, "529") {
		t.Errorf("fallback reply should be deterministic copy, not the raw provider error: %q", out.Reply)
	}

	// Non-JSON prose is still a reply; an unusable JSON blob falls back.
	ah2 := newAgentHarness(t, "Sure — what should the agent do?")
	if out := ah2.turn(t, map[string]any{"product": "runtime", "message": "hi"}); out.Mode != "agent" || out.Reply != "Sure — what should the agent do?" {
		t.Fatalf("prose reply: %+v", out)
	}
}

func TestOnboardingAgent_ClientClaimNeverSetsFacts(t *testing.T) {
	ah := newAgentHarness(t, `{"say":"Your voice isn't saved yet — want to try again?","tool":null}`)
	now := time.Now().UTC()
	ah.api.palDoc = palOnboardingState{Step: "channels", Consent: &palConsent{Version: PalConsentVersion, AcceptedAt: &now, VoiceSampling: true}}
	out := ah.turn(t, map[string]any{"product": "pal", "results": []map[string]any{{"tool": "learn_voice", "ok": true, "summary": "approved"}}})
	if out.Facts.Pal.voiceDone() || out.Facts.Phase == "trust" {
		t.Fatalf("a client report advanced the flow without a read-back: %+v", out.Facts)
	}
	if !strings.Contains(ah.model.systems[0], "voice: not done") {
		t.Error("facts given to the model must come from the read-back")
	}
}

func TestRedactSecrets(t *testing.T) {
	in := "keys: sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbb AKIAABCDEFGHIJKLMNOP ghp_cccccccccccccccccccccccccccccccccccc Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop"
	out := redactSecrets(in)
	for _, s := range []string{"aaaaaaaa", "bbbbbbbb", "AKIAABCD", "ghp_cccc", "eyJhbGci"} {
		if strings.Contains(out, s) {
			t.Errorf("%q survived redaction: %s", s, out)
		}
	}
	if p, k := extractProviderKey("use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa please"); p != "anthropic" || !strings.HasPrefix(k, "sk-ant-") {
		t.Errorf("extractProviderKey anthropic: %q %q", p, k)
	}
	if p, _ := extractProviderKey("sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbb"); p != "openai" {
		t.Errorf("extractProviderKey openai: %q", p)
	}
	if p, _ := extractProviderKey("the word skeleton is not a key"); p != "" {
		t.Errorf("false positive: %q", p)
	}
}

func TestAllowedOnboardingTools_Matrix(t *testing.T) {
	now := time.Now()
	consented := &palOnboardingState{Consent: &palConsent{Version: PalConsentVersion, AcceptedAt: &now, VoiceSampling: true}}
	cases := []struct {
		name     string
		product  string
		facts    onbFacts
		userTurn bool
		tool     string
		want     bool
	}{
		{"runtime design needs key", "runtime", onbFacts{Runtime: &onboardingState{}}, true, "design_agent", false},
		{"runtime design with key", "runtime", onbFacts{ProviderReady: true, Runtime: &onboardingState{}}, true, "design_agent", true},
		{"run before create", "runtime", onbFacts{ProviderReady: true, Runtime: &onboardingState{}}, true, "start_run", false},
		{"finish before success", "runtime", onbFacts{ProviderReady: true, Runtime: &onboardingState{AgentCreated: true, RunStatus: "failed"}}, true, "finish", false},
		{"pal channels before consent", "pal", onbFacts{ProviderReady: true, Pal: &palOnboardingState{}}, true, "check_channels", false},
		{"pal channels after consent", "pal", onbFacts{ProviderReady: true, Pal: consented}, true, "check_channels", true},
		{"pal voice without live channel", "pal", onbFacts{ProviderReady: true, Pal: consented}, true, "learn_voice", false},
		{"pal voice with live channel", "pal", onbFacts{ProviderReady: true, Pal: consented, ChannelsVerified: true}, false, "learn_voice", true},
		{"pal skip voice without live channel", "pal", onbFacts{ProviderReady: true, Pal: consented}, true, "skip_voice", false},
		{"pal skip voice with live channel", "pal", onbFacts{ProviderReady: true, Pal: consented, ChannelsVerified: true}, true, "skip_voice", true},
		{"pal brief before profile", "pal", onbFacts{ProviderReady: true, Pal: consented}, true, "show_brief", false},
		{"key form always", "pal", onbFacts{}, false, "collect_provider_key", true},
	}
	for _, c := range cases {
		why, ok := allowedOnboardingTools(c.product, &c.facts, c.userTurn)[c.tool]
		if got := ok && why == ""; got != c.want {
			t.Errorf("%s: %s allowed=%v (%q), want %v", c.name, c.tool, got, why, c.want)
		}
	}
}

// ---- DB-backed: the transcript store (fresh DATABASE_URL) ----------------------

func TestOnboardingAgentStore_PersistResumeIsolation(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	store := onbDBStore{srv: srv}
	ctx := context.Background()
	a, b := seedOnboardingTenant(t, pool), seedOnboardingTenant(t, pool)

	// Existing onboarding documents must survive transcript writes.
	if _, err := pool.Exec(ctx, `UPDATE tenants SET settings = '{"onboarding":{"step":"goal"},"palOnboarding":{"step":"welcome"}}' WHERE id = $1`, a); err != nil {
		t.Fatal(err)
	}
	doc := &onbChatDoc{}
	doc.add("user", "my key is sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzz ok", "", nil, time.Now())
	doc.add("agent", "hello", "", nil, time.Now())
	if err := store.save(ctx, a, "pal", doc); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := store.save(ctx, a, "runtime", &onbChatDoc{Messages: []onbChatMessage{{Role: "user", Text: "runtime msg"}}}); err != nil {
		t.Fatalf("save runtime: %v", err)
	}
	got, err := store.load(ctx, a, "pal")
	if err != nil || len(got.Messages) != 2 || got.Messages[1].Text != "hello" {
		t.Fatalf("load: %v %+v", err, got)
	}
	var raw string
	_ = pool.QueryRow(ctx, `SELECT settings::text FROM tenants WHERE id = $1`, a).Scan(&raw)
	if strings.Contains(raw, "zzzzzzzz") {
		t.Fatalf("a key reached tenants.settings: %s", raw)
	}
	if !strings.Contains(raw, `"onboarding"`) || !strings.Contains(raw, `"palOnboarding"`) || !strings.Contains(raw, "runtime msg") {
		t.Fatalf("transcript write clobbered sibling documents: %s", raw)
	}
	if other, _ := store.load(ctx, b, "pal"); len(other.Messages) != 0 {
		t.Fatal("cross-tenant transcript read")
	}
	if err := store.clear(ctx, a, "pal"); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.load(ctx, a, "pal"); len(got.Messages) != 0 {
		t.Fatal("clear did not clear")
	}
	if got, _ := store.load(ctx, a, "runtime"); len(got.Messages) != 1 {
		t.Fatal("clearing pal cleared runtime")
	}
	if err := store.save(ctx, uuid.NewString(), "pal", doc); !errors.Is(err, errPalTenantNotFound) {
		t.Fatalf("ghost tenant save: %v", err)
	}
}

func TestOnboardingAgent_ServerToolRunsOncePerTurn(t *testing.T) {
	run := `{"say":"Running.","tool":{"name":"start_run","args":{}}}`
	ah := newAgentHarness(t, run, run, run, run)
	ah.api.runStatus = "failed"
	ah.api.agents["x-agent"] = true
	ah.api.runtimeDoc = onboardingState{Step: "run", Goal: "g", Spec: &onboardingSpec{Name: "x-agent", SystemPrompt: "p"}, SpecApproved: true, AgentCreated: true, AgentName: "x-agent"}
	out := ah.turn(t, map[string]any{"product": "runtime", "message": "run it"})
	if n := ah.api.count("POST /v1/runs"); n != 1 {
		t.Fatalf("start_run dispatched %d times in one turn, want 1", n)
	}
	refused := 0
	for _, c := range out.ToolCalls {
		if c.Tool == "start_run" && c.Refused {
			refused++
		}
	}
	if refused == 0 {
		t.Fatalf("repeat start_run should be refused: %+v", out.ToolCalls)
	}
}

func TestOnboardingAgentRoutes_ScopeEnforcement(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	mux := http.NewServeMux()
	h := NewOnboardingAgentHandler(srv, auth, NewLlmProxyHandler(srv, auth))
	h.RegisterRoutes(mux)
	h.SetDispatcher(mux)
	tenant := seedOnboardingTenant(t, pool)
	key := func(name string, scopes ...string) string {
		raw := "hlx_live_onbagent_" + name
		sum := sha256.Sum256([]byte(raw))
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, $2, $3, $4, $5)`,
			tenant, "onb-agent-scope-"+name, hex.EncodeToString(sum[:]), raw[:8], scopes); err != nil {
			t.Fatalf("insert key: %v", err)
		}
		return raw
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM api_keys WHERE name LIKE 'onb-agent-scope-%'`)
	})
	do := func(method, path, raw, body string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+raw)
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, req)
		return rr.Code
	}
	readOnly := key("read", string(ScopeRead))
	if c := do(http.MethodPost, "/v1/onboarding/agent/turn", readOnly, `{"product":"runtime"}`); c != http.StatusForbidden {
		t.Errorf("turn with a read-only key: got %d, want 403", c)
	}
	if c := do(http.MethodGet, "/v1/onboarding/agent?product=runtime", readOnly, ""); c != http.StatusOK {
		t.Errorf("GET with read: got %d, want 200", c)
	}
	if c := do(http.MethodDelete, "/v1/onboarding/agent?product=runtime", readOnly, ""); c != http.StatusForbidden {
		t.Errorf("DELETE with read-only key: got %d, want 403", c)
	}
}

// A redesign ("also list action items") edits the same agent: the name the user
// already saw stays, even when the design model invents a new one.
func TestOnboardingAgent_RedesignKeepsTheName(t *testing.T) {
	ah := newAgentHarness(t,
		`{"say":"Designing it.","tool":{"name":"design_agent","args":{"goal":"summarize standups"}}}`,
		`{"say":"Here it is.","tool":null}`,
		`{"say":"Updating it.","tool":{"name":"design_agent","args":{"goal":"summarize standups, plus action items per person"}}}`,
		`{"say":"Updated.","tool":null}`,
	)
	ah.turn(t, map[string]any{"product": "runtime", "message": "an agent that summarizes my standups"})
	ah.api.specName = "standup-cleaner" // the model renames on the second design
	ah.turn(t, map[string]any{"product": "runtime", "message": "also list action items per person"})
	if ah.api.count("POST /v1/agents/generate-spec") != 2 {
		t.Fatalf("design ran %d times, want 2", ah.api.count("POST /v1/agents/generate-spec"))
	}
	if got := ah.api.runtimeDoc.Spec.Name; got != "standup-summarizer" {
		t.Fatalf("redesign renamed the agent to %q, want the original standup-summarizer", got)
	}
	if !strings.Contains(ah.api.runtimeDoc.Goal, "action items") {
		t.Errorf("redesign goal not saved: %q", ah.api.runtimeDoc.Goal)
	}
}

// POST /v1/agents upserts, so create_agent must refuse an existing name rather
// than overwrite that agent (found in the real-model walkthrough).
func TestOnboardingAgent_CreateNeverOverwritesAnExistingAgent(t *testing.T) {
	ah := newAgentHarness(t,
		`{"say":"Creating it.","tool":{"name":"create_agent","args":{"name":"taken-name"}}}`,
		`{"say":"That name is taken.","tool":null}`,
	)
	ah.api.agents["taken-name"] = true
	ah.api.runtimeDoc = onboardingState{Goal: "g", Spec: &onboardingSpec{Name: "standup-summarizer", Description: "d", SystemPrompt: "p", Model: "auto"}}
	out := ah.turn(t, map[string]any{"product": "runtime", "message": "create it and call it taken-name"})
	c := findCall(out.ToolCalls, "create_agent")
	if c == nil || c.OK || !strings.Contains(c.Summary, "already exists") {
		t.Fatalf("create over an existing name: %+v", out.ToolCalls)
	}
	if n := ah.api.count("POST /v1/agents"); n != 0 {
		t.Fatalf("POST /v1/agents called %d times for an existing name — it would overwrite that agent", n)
	}
	if ah.api.runtimeDoc.AgentCreated {
		t.Fatal("progress claims the agent was created")
	}
}

// The model is told what a readiness word means, so "offline" (bridge not
// running) is not narrated as a permissions problem.
func TestOnbFactsSummary_ExplainsChannelReadiness(t *testing.T) {
	f := onbFacts{Phase: "channels", Pal: &palOnboardingState{}, Channels: &onbChannelObs{WhatsApp: "offline", IMessage: "needs_full_disk_access"}}
	got := onbFactsSummary(onbProductPal, f)
	if !strings.Contains(got, "isn't running") || !strings.Contains(got, "Full Disk Access") {
		t.Fatalf("readiness not explained:\n%s", got)
	}
}
