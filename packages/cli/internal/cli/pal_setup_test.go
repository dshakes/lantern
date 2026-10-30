package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ---- parity with the server + dashboard (services/testdata/pal_onboarding_cases.json) ----

type palFixture struct {
	ConsentVersion       string `json:"consentVersion"`
	VoiceSamplingAllowed []struct {
		Name  string `json:"name"`
		State palDoc `json:"state"`
		Want  bool   `json:"want"`
	} `json:"voiceSamplingAllowed"`
	WhatsApp []struct {
		Name  string `json:"name"`
		Input struct {
			Reachable  bool `json:"reachable"`
			HTTPStatus int  `json:"httpStatus"`
			Status     *struct {
				Status string `json:"status"`
				Paired bool   `json:"paired"`
			} `json:"status"`
		} `json:"input"`
		Want string `json:"want"`
	} `json:"whatsapp"`
	IMessage []struct {
		Name  string `json:"name"`
		Input struct {
			Reachable   bool `json:"reachable"`
			HTTPStatus  int  `json:"httpStatus"`
			Diagnostics *struct {
				State  string `json:"state"`
				Reason string `json:"reason"`
			} `json:"diagnostics"`
		} `json:"input"`
		Want string `json:"want"`
	} `json:"imessage"`
}

func loadPalFixture(t *testing.T) palFixture {
	t.Helper()
	raw, err := os.ReadFile("../../../../services/testdata/pal_onboarding_cases.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f palFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return f
}

func TestPalSetup_FixtureParity(t *testing.T) {
	f := loadPalFixture(t)
	if f.ConsentVersion != palConsentVersion {
		t.Fatalf("fixture consentVersion %q != palConsentVersion %q", f.ConsentVersion, palConsentVersion)
	}
	for _, c := range f.VoiceSamplingAllowed {
		st := c.State
		if got := st.mayLearnVoice(); got != c.Want {
			t.Errorf("voiceSampling %q: got %v want %v", c.Name, got, c.Want)
		}
	}
	for _, c := range f.WhatsApp {
		p := bridgeProbe{Reachable: c.Input.Reachable, HTTPStatus: c.Input.HTTPStatus}
		if c.Input.Status != nil {
			p.Status, p.Paired = c.Input.Status.Status, c.Input.Status.Paired
		}
		if got := palWhatsAppReadiness(p); got != c.Want {
			t.Errorf("whatsapp %q: got %q want %q", c.Name, got, c.Want)
		}
	}
	for _, c := range f.IMessage {
		p := bridgeProbe{Reachable: c.Input.Reachable, HTTPStatus: c.Input.HTTPStatus}
		if c.Input.Diagnostics != nil {
			p.State, p.Reason = c.Input.Diagnostics.State, c.Input.Diagnostics.Reason
		}
		if got := palIMessageReadiness(p); got != c.Want {
			t.Errorf("imessage %q: got %q want %q", c.Name, got, c.Want)
		}
		if got := palIMessageReadiness(p); got != "ready" && palChannelFixes[got] == "" {
			t.Errorf("imessage %q: state %q has no fix text", c.Name, got)
		}
	}
}

func TestPalSelectSamples_ConsentGate(t *testing.T) {
	hits := []map[string]any{}
	for i := 0; i < 10; i++ {
		hits = append(hits, map[string]any{"text": "message " + string(rune('a'+i)), "fromMe": true})
	}
	hits = append(hits, map[string]any{"text": "theirs", "fromMe": false}, map[string]any{"text": "group", "fromMe": true, "isGroup": true})
	if got := palSelectSamples(&palDoc{}, hits); got != nil {
		t.Fatalf("no consent: sampled %v", got)
	}
	noVoice := &palDoc{Consent: &palDocConsent{Version: palConsentVersion, AcceptedAt: "2026-10-01T00:00:00Z"}}
	if got := palSelectSamples(noVoice, hits); got != nil {
		t.Fatalf("no voice opt-in: sampled %v", got)
	}
	ok := &palDoc{Consent: &palDocConsent{Version: palConsentVersion, AcceptedAt: "2026-10-01T00:00:00Z", VoiceSampling: true}}
	if got := palSelectSamples(ok, hits); len(got) != 10 {
		t.Fatalf("opted in: got %d samples, want 10 (own 1:1 only)", len(got))
	}
}

// ---- --apply file merging ---------------------------------------------------------

func TestPalMergeProfileFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "owner-profile.md")
	orig := "# Owner profile\n\n## About me\nI run a store.\n\n## Facts\n- spouse: Sam\n- married: yes\n\n## Relationships\n- Raju: friend\n\n## Style lessons (managed)\n- keep it short <!-- id:x -->\n"
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err := palMergeProfileFile(path,
		[]string{"- spouse: Samantha", "- kids: Kai, Nia"},
		[]string{"- Shiva: brother | never: bro"})
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("changed = %d, want 3", n)
	}
	got, _ := os.ReadFile(path)
	s := string(got)
	for _, want := range []string{"- spouse: Samantha", "- kids: Kai, Nia", "- married: yes", "- Raju: friend", "- Shiva: brother | never: bro", "I run a store.", "<!-- id:x -->"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in:\n%s", want, s)
		}
	}
	if strings.Contains(s, "- spouse: Sam\n") {
		t.Error("old spouse line kept alongside the confirmed one")
	}
	// New lines land inside their sections, not at the end of the file.
	if strings.Index(s, "Shiva") > strings.Index(s, "## Style lessons") {
		t.Errorf("relationship appended outside its section:\n%s", s)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", st.Mode().Perm())
	}
	baks, _ := filepath.Glob(path + ".bak-*")
	if len(baks) != 1 {
		t.Fatalf("backups = %v, want 1", baks)
	}
	// Idempotent: re-applying changes nothing and writes no new backup.
	if n, _ := palMergeProfileFile(path, []string{"- spouse: Samantha"}, nil); n != 0 {
		t.Errorf("re-apply changed %d", n)
	}
	// Missing file: created with the sections.
	fresh := filepath.Join(dir, "new", "owner-profile.md")
	if _, err := palMergeProfileFile(fresh, []string{"- spouse: Sam"}, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(fresh); !strings.Contains(string(b), "## Facts\n- spouse: Sam") {
		t.Errorf("fresh file: %s", b)
	}
}

func TestPalUpsertEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.env")
	_ = os.WriteFile(path, []byte("# comment\nexport PAL_QUIET_START=1\nOTHER=x\n"), 0o600)
	if err := palUpsertEnvFile(path, map[string]string{"PAL_QUIET_START": "22", "PAL_QUIET_END": "7"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	want := "# comment\nPAL_QUIET_START=22\nOTHER=x\nPAL_QUIET_END=7\n"
	if string(b) != want {
		t.Errorf("got %q want %q", b, want)
	}
}

// ---- the flow, end to end against fakes --------------------------------------------

type palFake struct {
	mu          sync.Mutex
	doc         map[string]any
	puts        int
	voiceCalls  int
	searchCalls int
	prefPuts    int
	prefs       map[string]string
}

// resume mirrors the server's palResumeStep closely enough for the fake.
func (f *palFake) resume() string {
	c, _ := f.doc["consent"].(map[string]any)
	if c == nil || c["acceptedAt"] == nil || c["version"] != palConsentVersion {
		return "welcome"
	}
	v, _ := f.doc["voice"].(map[string]any)
	if v == nil || (v["skipped"] != true && v["approved"] != true) {
		return "channels"
	}
	tr, _ := f.doc["trust"].(map[string]any)
	if tr == nil || tr["prefsSaved"] != true || tr["holdsAcknowledged"] != true {
		return "trust"
	}
	p, _ := f.doc["profile"].(map[string]any)
	if p == nil || p["done"] != true {
		return "profile"
	}
	return "done"
}

func newPalFakes(t *testing.T, f *palFake) (api, wa, im *httptest.Server) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	mux := http.NewServeMux()
	registerHealthOK(mux)
	registerLoginOK(mux)
	registerGetMe(mux)
	writeDoc := func(w http.ResponseWriter) {
		out := map[string]any{}
		for k, v := range f.doc {
			out[k] = v
		}
		out["resumeStep"] = f.resume()
		_ = json.NewEncoder(w).Encode(out)
	}
	mux.HandleFunc("/v1/pal/onboarding", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPut {
			f.puts++
			f.doc = map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&f.doc)
		}
		writeDoc(w)
	})
	mux.HandleFunc("/v1/pal/onboarding/guide", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest) // no model key: callers must fall back
		_, _ = w.Write([]byte(`{"code":"no_provider"}`))
	})
	mux.HandleFunc("/v1/pal/onboarding/voice", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.voiceCalls++
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"profile":{"register":"casual","sentenceLength":"terse","warmth":"warm","patterns":["lowercase"]},"preview":{"inbound":"dinner fri?","draft":"ya in"},"sampleCount":6}`))
	})
	mux.HandleFunc("/v1/pal/onboarding/profile/extract", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"section":"relationships","key":"Shiva","value":"brother","quote":"my brother Shiva"}]}`))
	})
	mux.HandleFunc("/v1/life-events/prefs", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method == http.MethodPut {
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			f.prefs[b["kind"]] = b["mode"]
			f.prefPuts++
			_, _ = w.Write([]byte(`{}`))
			return
		}
		out := []map[string]string{}
		for _, k := range palLifeEventKinds {
			m := f.prefs[k]
			if m == "" {
				m = "ask"
			}
			out = append(out, map[string]string{"kind": k, "mode": m})
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	api = httptest.NewServer(mux)
	t.Cleanup(api.Close)

	waMux := http.NewServeMux()
	waMux.HandleFunc("/session/t1/status", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"connected","paired":true}`))
	})
	waMux.HandleFunc("/session/t1/whatsapp/search", func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		f.searchCalls++
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"results":[{"text":"on my way","fromMe":true},{"text":"lol same","fromMe":true},{"text":"theirs","fromMe":false}]}`))
	})
	waMux.HandleFunc("/session/t1/attention", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"generatedAt":1,"channel":"whatsapp","items":[{"n":1,"icon":"⏳","label":"Reply to Raju","why":"waiting 3 days"}]}`))
	})
	wa = httptest.NewServer(waMux)
	t.Cleanup(wa.Close)

	imMux := http.NewServeMux()
	imMux.HandleFunc("/session/t1/diagnostics", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"state":"permission_required","reason":"Permission denied reading chat.db. Grant Full Disk Access to the process running the iMessage bridge"}`))
	})
	im = httptest.NewServer(imMux)
	t.Cleanup(im.Close)
	return api, wa, im
}

func TestPalSetup_ConsentNeverGivenNonInteractively(t *testing.T) {
	f := &palFake{doc: map[string]any{}, prefs: map[string]string{}}
	api, wa, im := newPalFakes(t, f)
	var out bytes.Buffer
	err := runPalSetup(&palSetupConfig{restURL: api.URL, waURL: wa.URL, imURL: im.URL, yes: true, out: &out})
	if !errors.Is(err, errPalConsentNeedsTTY) {
		t.Fatalf("got %v, want errPalConsentNeedsTTY", err)
	}
	if f.puts != 0 {
		t.Fatalf("--yes wrote %d document(s); consent must never be given on the owner's behalf", f.puts)
	}
	if !strings.Contains(out.String(), "I'm pal") {
		t.Errorf("fallback intro not shown when the guide is unavailable:\n%s", out.String())
	}
}

func TestPalSetup_FullFlowWithoutVoiceConsent(t *testing.T) {
	f := &palFake{doc: map[string]any{}, prefs: map[string]string{}}
	api, wa, im := newPalFakes(t, f)
	var out bytes.Buffer
	cfg := &palSetupConfig{
		restURL: api.URL, waURL: wa.URL, imURL: im.URL, out: &out, forceTTY: true,
		reader: newStringReader(
			"",  // welcome: no questions
			"y", // agree
			"n", // decline voice learning
			// channels: WhatsApp is live → no prompts; voice: skipped without prompts
			"",                                    // trust: keep current
			"",                                    // quiet hours: none
			"",                                    // understood (default yes)
			"my brother Shiva is visiting Sunday", // profile text
			"y",                                   // save Shiva
			"",                                    // done with profile
			"n",                                   // don't apply now
		),
	}
	if err := runPalSetup(cfg); err != nil {
		t.Fatalf("setup: %v\n%s", err, out.String())
	}
	if f.resume() != "done" {
		t.Fatalf("ended at %q", f.resume())
	}
	// Consent gate: declining voice learning means no history read, no voice call.
	if f.searchCalls != 0 || f.voiceCalls != 0 {
		t.Fatalf("sampled messages without consent: search=%d voice=%d", f.searchCalls, f.voiceCalls)
	}
	if f.prefPuts != len(palLifeEventKinds) {
		t.Errorf("pref PUTs = %d, want %d", f.prefPuts, len(palLifeEventKinds))
	}
	o := out.String()
	for _, want := range []string{"Full Disk Access", "WhatsApp: connected", "Reply to Raju", "You're set."} {
		if !strings.Contains(o, want) {
			t.Errorf("output missing %q:\n%s", want, o)
		}
	}
	prof, _ := f.doc["profile"].(map[string]any)
	items, _ := prof["items"].([]any)
	if len(items) != 1 || strings.Contains(o, "\"quote\"") {
		t.Errorf("profile items = %v", items)
	}
	if it, _ := items[0].(map[string]any); it["quote"] != nil {
		t.Errorf("the quote is review context and must not be persisted: %v", it)
	}
}

func TestPalApply_RefusesBeforeDone(t *testing.T) {
	f := &palFake{doc: map[string]any{}, prefs: map[string]string{}}
	api, wa, im := newPalFakes(t, f)
	err := runPalSetup(&palSetupConfig{restURL: api.URL, waURL: wa.URL, imURL: im.URL, apply: true, out: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), "finish setup first") {
		t.Fatalf("got %v", err)
	}
}

func TestPalSetup_VoiceWithConsentReadsOnlyOwnMessages(t *testing.T) {
	f := &palFake{doc: map[string]any{}, prefs: map[string]string{}}
	api, wa, im := newPalFakes(t, f)
	var out bytes.Buffer
	cfg := &palSetupConfig{
		restURL: api.URL, waURL: wa.URL, imURL: im.URL, out: &out, forceTTY: true,
		reader: newStringReader("", "y", "y", "a", "", "", "", "", "n"),
	}
	if err := runPalSetup(cfg); err != nil {
		t.Fatalf("setup: %v\n%s", err, out.String())
	}
	if f.searchCalls == 0 || f.voiceCalls != 1 {
		t.Fatalf("search=%d voice=%d, want history read and one voice call", f.searchCalls, f.voiceCalls)
	}
	v, _ := f.doc["voice"].(map[string]any)
	if v["approved"] != true {
		t.Fatalf("voice not approved: %v", v)
	}
	if !strings.Contains(out.String(), "ya in") {
		t.Errorf("preview not shown:\n%s", out.String())
	}
}
