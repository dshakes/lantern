package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// chatFake is a scripted onboarding-agent server: each POST to the turn
// endpoint pops the next reply and records the request body.
type chatFake struct {
	mu        sync.Mutex
	replies   []string
	turns     []string
	savedKeys []string
	palPuts   int
	agentGets int
}

func (f *chatFake) register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/onboarding/agent", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.agentGets++
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"messages":[],"actions":[],"toolCalls":[],"facts":{"phase":"provider"}}`))
	})
	mux.HandleFunc("/v1/onboarding/agent/turn", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.turns = append(f.turns, string(b))
		reply := `{"mode":"agent","reply":"(end of script)","facts":{"phase":"done"}}`
		if len(f.replies) > 0 {
			reply, f.replies = f.replies[0], f.replies[1:]
		}
		_, _ = w.Write([]byte(reply))
	})
	mux.HandleFunc("/v1/settings/llm-providers", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		f.savedKeys = append(f.savedKeys, b["apiKey"])
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"status":"saved"}`))
	})
	mux.HandleFunc("/v1/settings/llm-providers/anthropic/test", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"success":true}`))
	})
}

func (f *chatFake) allTurns() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.turns, "\n")
}

func newChatServer(t *testing.T, f *chatFake, extra func(*http.ServeMux)) *httptest.Server {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	f.register(mux)
	if extra != nil {
		extra(mux)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

const chatTestKey = "sk-ant-api03-SECRETSECRETSECRETSECRET0000"

func TestOnboardChat_KeyGoesToSettingsNeverToTheAgent(t *testing.T) {
	f := &chatFake{replies: []string{
		`{"mode":"scripted","reply":"I need a model key first.","actions":[{"id":"a1","tool":"collect_provider_key","args":{}}],"facts":{"phase":"provider"}}`,
		`{"mode":"agent","reply":"Key works. What should your agent do?","toolCalls":[],"facts":{"phase":"goal"}}`,
		`{"mode":"agent","reply":"Designed standup-bot. Create it?","toolCalls":[{"tool":"design_agent","ok":true,"summary":"designed standup-bot"}],"facts":{"phase":"create"}}`,
		`{"mode":"agent","reply":"Created and ran it.","toolCalls":[{"tool":"create_agent","ok":true,"summary":"created"},{"tool":"start_run","ok":true,"summary":"run succeeded"}],"facts":{"phase":"done"}}`,
	}}
	srv := newChatServer(t, f, nil)
	cfg := &onboardConfig{
		restURL: srv.URL, forceTTY: true,
		reader: newStringReader("", chatTestKey, "summarize my standup notes", "yes create and run it"),
	}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("onboard: %v", err)
	}
	if len(f.savedKeys) != 1 || f.savedKeys[0] != chatTestKey {
		t.Fatalf("key not saved through the settings endpoint: %v", f.savedKeys)
	}
	turns := f.allTurns()
	if strings.Contains(turns, "SECRETSECRET") {
		t.Fatal("the provider key was sent to the onboarding agent")
	}
	for _, want := range []string{`"event":"start"`, `"tool":"collect_provider_key"`, `"ok":true`, "summarize my standup notes", "yes create and run it"} {
		if !strings.Contains(turns, want) {
			t.Errorf("turn bodies missing %s:\n%s", want, turns)
		}
	}
	if len(f.turns) != 4 {
		t.Errorf("turns = %d, want 4 (start, key result, goal, approve)", len(f.turns))
	}
}

func TestOnboardChat_NotUsedWithYesOrSteps(t *testing.T) {
	for _, cfg := range []*onboardConfig{
		{forceTTY: true, yes: true},
		{forceTTY: true, steps: true},
		{forceTTY: true, description: "x"},
		{forceTTY: false},
	} {
		if cfg.chatMode() {
			t.Errorf("chat mode with %+v", *cfg)
		}
	}
	if !(&onboardConfig{forceTTY: true}).chatMode() {
		t.Error("chat mode should be the default on a terminal")
	}
}

func TestPalSetupChat_ConsentOnlyFromAnExplicitYes(t *testing.T) {
	f := &chatFake{replies: []string{
		`{"mode":"agent","reply":"Before anything, your consent.","actions":[{"id":"c1","tool":"ask_consent","args":{}}],"facts":{"phase":"welcome"}}`,
		`{"mode":"agent","reply":"No problem — nothing was changed.","facts":{"phase":"welcome"}}`,
	}}
	srv := newChatServer(t, f, func(mux *http.ServeMux) {
		mux.HandleFunc("/v1/pal/onboarding", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPut {
				f.mu.Lock()
				f.palPuts++
				f.mu.Unlock()
			}
			_, _ = w.Write([]byte(`{"step":"welcome","resumeStep":"welcome"}`))
		})
	})
	var out bytes.Buffer
	cfg := &palSetupConfig{
		restURL: srv.URL, waURL: srv.URL, imURL: srv.URL, out: &out, forceTTY: true,
		reader: newStringReader("", ""), // Enter at "Do you agree? [y/N]" = no; then leave
	}
	if err := runPalSetup(cfg); err != nil {
		t.Fatalf("setup: %v\n%s", err, out.String())
	}
	if f.palPuts != 0 {
		t.Fatal("consent was saved without an explicit yes")
	}
	if !strings.Contains(f.allTurns(), `"tool":"ask_consent","ok":false`) {
		t.Errorf("declined consent not reported back:\n%s", f.allTurns())
	}
}

func TestPalSetupChat_YesNeverEntersTheConversation(t *testing.T) {
	f := &chatFake{}
	srv := newChatServer(t, f, func(mux *http.ServeMux) {
		mux.HandleFunc("/v1/pal/onboarding", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"step":"welcome","resumeStep":"welcome"}`))
		})
		mux.HandleFunc("/v1/pal/onboarding/guide", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		})
	})
	err := runPalSetup(&palSetupConfig{restURL: srv.URL, waURL: srv.URL, imURL: srv.URL, yes: true, forceTTY: true, out: &bytes.Buffer{}})
	if err == nil || f.agentGets != 0 || len(f.turns) != 0 {
		t.Fatalf("--yes must not converse (err=%v gets=%d turns=%d)", err, f.agentGets, len(f.turns))
	}
}

func TestPalSetupChat_ModelFailureFallsBackToSteps(t *testing.T) {
	f := &chatFake{replies: []string{
		`{"mode":"fallback","reply":"I couldn't reach the model.","fallbackReason":"the model call failed","facts":{"phase":"welcome"}}`,
	}}
	srv := newChatServer(t, f, func(mux *http.ServeMux) {
		mux.HandleFunc("/v1/pal/onboarding", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"step":"welcome","resumeStep":"welcome"}`))
		})
		mux.HandleFunc("/v1/pal/onboarding/guide", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		})
	})
	var out bytes.Buffer
	err := runPalSetup(&palSetupConfig{
		restURL: srv.URL, waURL: srv.URL, imURL: srv.URL, out: &out, forceTTY: true,
		reader: newStringReader("", "n"), // wizard: no questions, decline consent
	})
	if err == nil || !strings.Contains(err.Error(), "consent declined") {
		t.Fatalf("expected the step wizard to take over and stop at consent, got %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "the model call failed") || !strings.Contains(out.String(), "Continuing step by step") {
		t.Errorf("fallback not labelled:\n%s", out.String())
	}
}
