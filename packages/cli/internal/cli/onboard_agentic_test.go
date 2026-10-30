package cli

// Agentic `pal onboard`: goal prompt → generate-spec → confirm → create →
// first run with the spec's own first input. Interactive (TTY) and CI
// (--yes / non-TTY) paths, plus decline and the quickstart floor.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

const agenticSpec = `{"name":"notes-summarizer","description":"Summarizes meeting notes","systemPrompt":"You summarize meeting notes into action items.","rationale":"One LLM step fits.","model":"auto","firstInput":{"prompt":"Notes: ship v2 Friday; Ana owns QA."},"steps":[{"name":"summarize","type":"llm","description":"Write the summary"}]}`

type agenticRecorder struct {
	mu          sync.Mutex
	specCalls   int
	specGoal    string
	created     []map[string]any
	runInputs   []map[string]any
	specFailure bool
	existing    []string // agents that already exist before onboard runs
}

func newAgenticServer(t *testing.T, rec *agenticRecorder) *httptest.Server {
	t.Helper()
	// Never touch the real credentials.json (~/.pal or legacy ~/.lantern).
	t.Setenv("HOME", t.TempDir())
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	registerProvidersOK(mux)
	mux.HandleFunc("/v1/agents/generate-spec", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		rec.mu.Lock()
		rec.specCalls++
		rec.specGoal = body["description"]
		fail := rec.specFailure
		rec.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if fail {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"error":"the model call failed","code":"llm_failed"}`))
			return
		}
		_, _ = w.Write([]byte(agenticSpec))
	})
	created := map[string]bool{}
	for _, n := range rec.existing {
		created[n] = true
	}
	mux.HandleFunc("/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path[len("/v1/agents/"):]
		rec.mu.Lock()
		ok := created[name]
		rec.mu.Unlock()
		if !ok {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"id":"a1","name":"` + name + `"}`))
	})
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		rec.mu.Lock()
		rec.created = append(rec.created, body)
		created[body["name"].(string)] = true
		rec.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"a1","name":"x"}`))
	})
	mux.HandleFunc("/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		in, _ := body["input"].(map[string]any)
		rec.mu.Lock()
		rec.runInputs = append(rec.runInputs, in)
		rec.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"agentic-run","status":"queued"}`))
	})
	mux.HandleFunc("/v1/runs/agentic-run", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"agentic-run","status":"succeeded","output":{"text":"Action items: Ana owns QA."}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestOnboardAgentic_InteractiveCreatesTheDesignedAgent(t *testing.T) {
	rec := &agenticRecorder{}
	srv := newAgenticServer(t, rec)
	cfg := &onboardConfig{
		restURL:  srv.URL,
		forceTTY: true,
		reader:   newStringReader("Summarize my meeting notes into action items", "y"),
	}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	if rec.specGoal != "Summarize my meeting notes into action items" {
		t.Errorf("goal sent to generate-spec = %q", rec.specGoal)
	}
	if len(rec.created) == 0 || rec.created[0]["name"] != "notes-summarizer" {
		t.Fatalf("designed agent not created: %v", rec.created)
	}
	if rec.created[0]["systemPrompt"] != "You summarize meeting notes into action items." {
		t.Errorf("agent created without the designed instructions: %v", rec.created[0]["systemPrompt"])
	}
	if len(rec.runInputs) == 0 || rec.runInputs[0]["prompt"] != "Notes: ship v2 Friday; Ana owns QA." {
		t.Errorf("first run did not use the spec's first input: %v", rec.runInputs)
	}
}

func TestOnboardAgentic_InteractiveDeclineCreatesNothing(t *testing.T) {
	rec := &agenticRecorder{}
	srv := newAgenticServer(t, rec)
	cfg := &onboardConfig{restURL: srv.URL, forceTTY: true, reader: newStringReader("triage my inbox", "n")}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("decline must exit cleanly, got %v", err)
	}
	if len(rec.created) != 0 || len(rec.runInputs) != 0 {
		t.Fatalf("decline still created/ran: created=%v runs=%v", rec.created, rec.runInputs)
	}
}

func TestOnboardAgentic_YesNeverPrompts(t *testing.T) {
	rec := &agenticRecorder{}
	srv := newAgenticServer(t, rec)
	// forceTTY with an empty reader: any prompt would read EOF. --yes must not ask.
	cfg := &onboardConfig{restURL: srv.URL, forceTTY: true, yes: true, reader: newStringReader()}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	if rec.specGoal != defaultAgentDescription {
		t.Errorf("--yes should design from the default description, got %q", rec.specGoal)
	}
	if len(rec.created) == 0 || rec.created[0]["name"] != "notes-summarizer" {
		t.Errorf("--yes should create the designed agent without confirmation: %v", rec.created)
	}
}

func TestOnboardAgentic_SpecFailureFallsBackToQuickstart(t *testing.T) {
	rec := &agenticRecorder{specFailure: true}
	srv := newAgenticServer(t, rec)
	cfg := &onboardConfig{restURL: srv.URL, description: "anything"}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	if len(rec.created) == 0 || rec.created[0]["name"] != quickstartAgentName {
		t.Fatalf("expected quickstart floor, got %v", rec.created)
	}
	if len(rec.runInputs) == 0 || rec.runInputs[0]["prompt"] == nil {
		t.Errorf("quickstart run input missing: %v", rec.runInputs)
	}
}

func TestOnboard_SavedKeyFailingTestStopsBeforeCreate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	mux.HandleFunc("/v1/settings/llm-providers", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"provider":"anthropic","status":"active"}]`))
	})
	mux.HandleFunc("/v1/settings/llm-providers/anthropic/test", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"error":"Anthropic returned 401: invalid x-api-key"}`))
	})
	createCalled := false
	mux.HandleFunc("/v1/agents", func(w http.ResponseWriter, _ *http.Request) {
		createCalled = true
		w.WriteHeader(http.StatusCreated)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	err := runOnboard(&onboardConfig{restURL: srv.URL, yes: true})
	if err == nil {
		t.Fatal("a saved key that fails its test call must stop onboard")
	}
	if createCalled {
		t.Fatal("agent was created despite a failing provider")
	}
}

func TestOnboardAgentic_InteractiveExistingNameDefaultsToUniqueName(t *testing.T) {
	rec := &agenticRecorder{existing: []string{"notes-summarizer", "notes-summarizer-2"}}
	srv := newAgenticServer(t, rec)
	// goal, Enter on "Reuse it as-is? [y/N]" (default no), then "y" to create.
	cfg := &onboardConfig{restURL: srv.URL, forceTTY: true, reader: newStringReader("Summarize notes", "", "y")}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	if len(rec.created) == 0 || rec.created[0]["name"] != "notes-summarizer-3" {
		t.Fatalf("want a new agent with a unique suffix (notes-summarizer-3), got %v", rec.created)
	}
}

func TestOnboardAgentic_InteractiveExistingNameReuseOnYes(t *testing.T) {
	rec := &agenticRecorder{existing: []string{"notes-summarizer"}}
	srv := newAgenticServer(t, rec)
	cfg := &onboardConfig{restURL: srv.URL, forceTTY: true, reader: newStringReader("Summarize notes", "y")}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	for _, c := range rec.created {
		if c["name"] != "lantern-guide" {
			t.Fatalf("reuse must not create an agent, got %v", c)
		}
	}
	if len(rec.runInputs) == 0 {
		t.Fatal("reused agent was not run")
	}
}

func TestOnboardAgentic_YesReusesExistingWithoutAsking(t *testing.T) {
	rec := &agenticRecorder{existing: []string{"notes-summarizer"}}
	srv := newAgenticServer(t, rec)
	cfg := &onboardConfig{restURL: srv.URL, forceTTY: true, yes: true, reader: newStringReader()}
	if err := runOnboard(cfg); err != nil {
		t.Fatalf("runOnboard: %v", err)
	}
	for _, c := range rec.created {
		if c["name"] != "lantern-guide" {
			t.Fatalf("--yes must reuse silently, but created %v", c)
		}
	}
}
