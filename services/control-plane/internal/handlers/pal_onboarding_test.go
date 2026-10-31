package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// ---- parity with the dashboard + CLI (services/testdata/pal_onboarding_cases.json) ----

type palCases struct {
	ConsentVersion string `json:"consentVersion"`
	Resume         []struct {
		Name  string             `json:"name"`
		State palOnboardingState `json:"state"`
		Want  string             `json:"want"`
	} `json:"resume"`
	CanEnter []struct {
		Name             string             `json:"name"`
		Step             string             `json:"step"`
		State            palOnboardingState `json:"state"`
		ChannelsVerified bool               `json:"channelsVerified"`
		Want             bool               `json:"want"`
	} `json:"canEnter"`
	VoiceSamplingAllowed []struct {
		Name  string             `json:"name"`
		State palOnboardingState `json:"state"`
		Want  bool               `json:"want"`
	} `json:"voiceSamplingAllowed"`
}

func loadPalCases(t *testing.T) palCases {
	t.Helper()
	raw, err := os.ReadFile("../../../testdata/pal_onboarding_cases.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var c palCases
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return c
}

func TestPalOnboarding_StateMachineParity(t *testing.T) {
	c := loadPalCases(t)
	if c.ConsentVersion != PalConsentVersion {
		t.Fatalf("fixture consentVersion %q != PalConsentVersion %q — bump both sides together", c.ConsentVersion, PalConsentVersion)
	}
	for _, tc := range c.Resume {
		st := tc.State
		if got := palResumeStep(&st); got != tc.Want {
			t.Errorf("resume %q: got %q want %q", tc.Name, got, tc.Want)
		}
	}
	for _, tc := range c.CanEnter {
		st := tc.State
		if got := palCanEnter(tc.Step, &st, tc.ChannelsVerified); got != tc.Want {
			t.Errorf("canEnter %q: got %v want %v", tc.Name, got, tc.Want)
		}
	}
	for _, tc := range c.VoiceSamplingAllowed {
		st := tc.State
		if got := st.mayLearnVoice(); got != tc.Want {
			t.Errorf("voiceSampling %q: got %v want %v", tc.Name, got, tc.Want)
		}
	}
}

// ---- validation: consent gate + step skipping + profile grammar -------------

func palConsented(voice bool) *palConsent {
	c := time.Now().UTC()
	return &palConsent{Version: PalConsentVersion, AcceptedAt: &c, VoiceSampling: voice}
}

func TestPalOnboarding_ValidateConsentAndSkips(t *testing.T) {
	profile := &palVoiceProfile{Register: "casual", SentenceLength: "terse", LanguageMix: "English", EmojiUse: "rare", Warmth: "warm"}

	// A derived voice profile cannot be persisted without the voice opt-in.
	st := palOnboardingState{Step: "voice", Consent: palConsented(false), Voice: &palVoice{Profile: profile}}
	if err := st.validate(); err == nil || err != errConsentRequired {
		t.Fatalf("profile without voice consent: got %v, want errConsentRequired", err)
	}
	st.Consent = palConsented(true)
	if err := st.validate(); err != nil {
		t.Fatalf("profile with consent: %v", err)
	}
	// Approval needs a profile.
	st = palOnboardingState{Step: "voice", Consent: palConsented(true), Voice: &palVoice{Approved: true}}
	if err := st.validate(); err == nil {
		t.Error("approved without a profile must be rejected")
	}
	// A stored step cannot skip ahead of the facts.
	st = palOnboardingState{Step: "trust", Consent: palConsented(false)}
	if err := st.validate(); err == nil || !strings.Contains(err.Error(), "not reachable") {
		t.Errorf("skip to trust: got %v", err)
	}
	st = palOnboardingState{Step: "channels"}
	if err := st.validate(); err == nil {
		t.Error("channels without consent must be rejected")
	}
	// Quiet hours bounds.
	bad := 24
	st = palOnboardingState{Step: "trust", Consent: palConsented(false), Voice: &palVoice{Skipped: true}, Trust: &palTrust{QuietStart: &bad}}
	if err := st.validate(); err == nil {
		t.Error("quiet hour 24 must be rejected")
	}
	// Vendor-free voice values only.
	st = palOnboardingState{Step: "voice", Consent: palConsented(true), Voice: &palVoice{Profile: &palVoiceProfile{Register: "shouty", SentenceLength: "terse", Warmth: "warm"}}}
	if err := st.validate(); err == nil {
		t.Error("unknown register must be rejected")
	}
}

func TestPalProfileItem_Grammar(t *testing.T) {
	ok := []palProfileItem{
		{Section: "facts", Key: "spouse", Value: "Sam"},
		{Section: "facts", Key: "kids", Value: "Kai, Nia"},
		{Section: "facts", Key: "marital status", Value: "married"},
		{Section: "facts", Key: "wedding anniversary", Value: "2017-06-03"},
		{Section: "relationships", Key: "Sujith", Value: "college friend", AddressAs: "Sujith", Never: []string{"bava", "anna"}},
	}
	for _, it := range ok {
		if err := it.validate(); err != nil {
			t.Errorf("%+v: %v", it, err)
		}
	}
	bad := []palProfileItem{
		{Section: "facts", Key: "favorite color", Value: "blue"},         // not a fact the bridge understands
		{Section: "facts", Key: "marital status", Value: "complicated"},  // not an allowed value
		{Section: "facts", Key: "spouse", Value: "Sam", AddressAs: "S"},  // addressAs is relationships-only
		{Section: "relationships", Key: "Mom: hi", Value: "mother"},      // ":" would break the line grammar
		{Section: "relationships", Key: "Raju", Value: "friend | never"}, // "|" injects a clause
		{Section: "relationships", Key: "Raju", Value: "friend\n## Facts"},
		{Section: "relationships", Key: "Raju", Value: "friend", Never: []string{"a,b"}},
		{Section: "notes", Key: "x", Value: "y"},
	}
	for _, it := range bad {
		if err := it.validate(); err == nil {
			t.Errorf("%+v: want rejection", it)
		}
	}
	facts, rels := renderPalProfile(ok)
	if len(facts) != 4 || facts[0] != "- spouse: Sam" {
		t.Errorf("facts render: %v", facts)
	}
	if len(rels) != 1 || rels[0] != "- Sujith: college friend | address as: Sujith | never: bava, anna" {
		t.Errorf("relationships render: %v", rels)
	}
}

// ---- LLM output parsers ---------------------------------------------------------

func TestParsePalProfileProposals_QuoteGrounding(t *testing.T) {
	source := "I'm married to Sam and we have two kids,   Kai and Nia. My brother Shiva lives in Austin."
	llm := "```json\n" + `{"items":[
	 {"section":"facts","key":"spouse","value":"Sam","quote":"married to Sam"},
	 {"section":"facts","key":"kids","value":"Kai, Nia","quote":"two kids, Kai and Nia"},
	 {"section":"relationships","key":"Shiva","value":"brother","quote":"My brother Shiva"},
	 {"section":"relationships","key":"Priya","value":"sister","quote":"my sister Priya"},
	 {"section":"facts","key":"wedding anniversary","value":"2017-06-03","quote":""}
	]}` + "\n```"
	items, err := parsePalProfileProposals(llm, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("got %d items %+v, want 3 (the invented sister and the unquoted date are dropped)", len(items), items)
	}
	for _, it := range items {
		if it.Key == "Priya" || it.Key == "wedding anniversary" {
			t.Errorf("ungrounded item kept: %+v", it)
		}
	}
	if _, err := parsePalProfileProposals("nope", source); err == nil {
		t.Error("non-JSON must error")
	}
}

func TestParsePalTrustSuggestion_NeverAutoForMoney(t *testing.T) {
	s, err := parsePalTrustSuggestion(`{"modes":{"delivery":"auto","otp":"auto","bill":"auto","fraud_alert":"auto","promo":"off","made_up":"auto","travel":"yolo"},"quietStart":22,"quietEnd":7,"why":"hands-off"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"delivery": "auto", "otp": "auto", "bill": "ask", "fraud_alert": "ask", "promo": "off"}
	if len(s.Modes) != len(want) {
		t.Fatalf("modes %v want %v", s.Modes, want)
	}
	for k, v := range want {
		if s.Modes[k] != v {
			t.Errorf("%s = %q want %q", k, s.Modes[k], v)
		}
	}
	if s.QuietStart == nil || *s.QuietStart != 22 || *s.QuietEnd != 7 {
		t.Errorf("quiet hours lost: %v %v", s.QuietStart, s.QuietEnd)
	}
	// Half a quiet window is dropped, not guessed.
	s, _ = parsePalTrustSuggestion(`{"modes":{"otp":"ask"},"quietStart":22}`)
	if s.QuietStart != nil || s.QuietEnd != nil {
		t.Error("half a quiet window must be dropped")
	}
	if _, err := parsePalTrustSuggestion(`{"modes":{}}`); err == nil {
		t.Error("empty suggestion must error")
	}
}

func TestParsePalVoice(t *testing.T) {
	good := `{"profile":{"register":"casual","sentenceLength":"terse","languageMix":"English","emojiUse":"rare","warmth":"warm","patterns":["lowercase","no periods","a","b","c","d"]},"preview":{"inbound":"free sat?","draft":"ya def"}}`
	res, err := parsePalVoice(good)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Profile.Patterns) != 5 || res.Preview.Draft != "ya def" {
		t.Errorf("unexpected %+v", res)
	}
	for _, bad := range []string{
		`{"profile":{"register":"formal","sentenceLength":"terse","warmth":"warm"},"preview":{"inbound":"a","draft":"b"}}`,
		`{"profile":{"register":"casual","sentenceLength":"terse","warmth":"warm"},"preview":{"inbound":"a","draft":""}}`,
		`not json`,
	} {
		if _, err := parsePalVoice(bad); err == nil {
			t.Errorf("want error for %s", bad)
		}
	}
}

// ---- consent gate on the voice endpoint (no DB: loadState stubbed) -----------

func newPalHandlerWithState(t *testing.T, stub *stubRoundTripper, st *palOnboardingState) *PalOnboardingHandler {
	t.Helper()
	llm := newTestProxyWithStub(t, stub)
	h := NewPalOnboardingHandler(llm.srv, llm.auth, llm)
	h.loadState = func(context.Context, string) (*palOnboardingState, error) { return st, nil }
	return h
}

func TestPalVoice_ConsentGate(t *testing.T) {
	samples := []string{"ya", "on my way", "lol same", "can't tonight, tmrw?", "sounds good", "ok cool"}
	voiceJSON := `{"profile":{"register":"very-casual","sentenceLength":"terse","languageMix":"English","emojiUse":"none","warmth":"warm","patterns":["lowercase"]},"preview":{"inbound":"dinner friday?","draft":"ya im in"}}`

	// No consent at all: refused BEFORE any LLM call, samples never reach a provider.
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse(voiceJSON)}}
	h := newPalHandlerWithState(t, stub, &palOnboardingState{})
	rr := onbReq(t, h.Voice, http.MethodPost, "/v1/pal/onboarding/voice", onboardingTestTenant, map[string]any{"samples": samples})
	if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), "consent_required") {
		t.Fatalf("no consent: got %d %s, want 403 consent_required", rr.Code, rr.Body.String())
	}
	if stub.callCount() != 0 {
		t.Fatalf("provider called %d times without consent", stub.callCount())
	}

	// General consent but no voice opt-in: still refused.
	h = newPalHandlerWithState(t, stub, &palOnboardingState{Consent: palConsented(false)})
	rr = onbReq(t, h.Voice, http.MethodPost, "/v1/pal/onboarding/voice", onboardingTestTenant, map[string]any{"samples": samples})
	if rr.Code != http.StatusForbidden || stub.callCount() != 0 {
		t.Fatalf("no voice opt-in: got %d (calls %d), want 403 and no call", rr.Code, stub.callCount())
	}

	// Opted in: too few samples → typed 422, no call.
	h = newPalHandlerWithState(t, stub, &palOnboardingState{Consent: palConsented(true)})
	rr = onbReq(t, h.Voice, http.MethodPost, "/v1/pal/onboarding/voice", onboardingTestTenant, map[string]any{"samples": samples[:2]})
	if rr.Code != http.StatusUnprocessableEntity || !strings.Contains(rr.Body.String(), "not_enough_samples") {
		t.Fatalf("few samples: got %d %s", rr.Code, rr.Body.String())
	}

	// Opted in with enough samples: profile + preview.
	rr = onbReq(t, h.Voice, http.MethodPost, "/v1/pal/onboarding/voice", onboardingTestTenant, map[string]any{"samples": samples, "ownerName": "Ada"})
	if rr.Code != http.StatusOK {
		t.Fatalf("consented: got %d %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Profile     palVoiceProfile `json:"profile"`
		Preview     palVoicePreview `json:"preview"`
		SampleCount int             `json:"sampleCount"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.Profile.Register != "very-casual" || out.Preview.Draft != "ya im in" || out.SampleCount != len(samples) {
		t.Errorf("unexpected voice result %+v", out)
	}
	if stub.callCount() != 1 {
		t.Errorf("provider calls = %d, want 1", stub.callCount())
	}
}

func TestPalGuide_UnknownStepAndNoProvider(t *testing.T) {
	stub := &stubRoundTripper{responses: []func(*http.Request) (*http.Response, error){anthropicOKResponse("pal answers your messages in your voice.")}}
	h := newPalHandlerWithState(t, stub, &palOnboardingState{})
	rr := onbReq(t, h.Guide, http.MethodPost, "/v1/pal/onboarding/guide", onboardingTestTenant, map[string]string{"step": "teleport", "message": "hi"})
	if rr.Code != http.StatusBadRequest {
		t.Errorf("unknown step: %d", rr.Code)
	}
	rr = onbReq(t, h.Guide, http.MethodPost, "/v1/pal/onboarding/guide", onboardingTestTenant, map[string]string{"step": "welcome", "message": "what is this?"})
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "your voice") {
		t.Fatalf("guide: %d %s", rr.Code, rr.Body.String())
	}
	t.Setenv("ANTHROPIC_API_KEY", "")
	rr = onbReq(t, h.Guide, http.MethodPost, "/v1/pal/onboarding/guide", onboardingTestTenant, map[string]string{"step": "welcome", "message": "hi"})
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "no_provider") {
		t.Errorf("no provider: %d %s", rr.Code, rr.Body.String())
	}
}

// ---- DB-backed state: resume, isolation, gates ------------------------------

func TestPalOnboardingState_ResumeIsolationAndGates(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewPalOnboardingHandler(srv, auth, NewLlmProxyHandler(srv, auth))
	a, b := seedOnboardingTenant(t, pool), seedOnboardingTenant(t, pool)

	get := func(tenant string) (int, map[string]any) {
		rr := onbReq(t, h.GetState, http.MethodGet, "/v1/pal/onboarding", tenant, nil)
		var out map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &out)
		return rr.Code, out
	}
	put := func(tenant string, body any) int {
		return onbReq(t, h.PutState, http.MethodPut, "/v1/pal/onboarding", tenant, body).Code
	}

	if code, st := get(a); code != http.StatusOK || st["resumeStep"] != "welcome" || st["consentVersion"] != PalConsentVersion {
		t.Fatalf("fresh: %d %v", code, st)
	}
	consent := map[string]any{"version": PalConsentVersion, "acceptedAt": "2026-10-01T00:00:00Z", "voiceSampling": false}

	// Skipping ahead is refused server-side.
	if c := put(a, map[string]any{"step": "trust", "consent": consent}); c != http.StatusBadRequest {
		t.Errorf("skip to trust: %d, want 400", c)
	}
	// A voice profile without the opt-in is refused with a typed code.
	rr := onbReq(t, h.PutState, http.MethodPut, "/v1/pal/onboarding", a, map[string]any{
		"step": "voice", "consent": consent,
		"voice": map[string]any{"profile": map[string]any{"register": "casual", "sentenceLength": "terse", "warmth": "warm"}},
	})
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "consent_required") {
		t.Fatalf("profile w/o consent: %d %s", rr.Code, rr.Body.String())
	}

	// Resume mid-flow; unknown fields (samples, keys) are never persisted.
	if c := put(a, map[string]any{
		"step": "trust", "consent": consent, "voice": map[string]any{"skipped": true, "samples": []string{"sk-private-sample"}},
		"trust": map[string]any{"prefsSaved": true}, "apiKey": "sk-should-not-persist",
	}); c != http.StatusOK {
		t.Fatalf("put trust: %d", c)
	}
	if _, st := get(a); st["resumeStep"] != "trust" {
		t.Fatalf("resume: %v", st)
	}
	var raw string
	_ = pool.QueryRow(context.Background(), `SELECT settings::text FROM tenants WHERE id = $1`, a).Scan(&raw)
	for _, secret := range []string{"sk-private-sample", "sk-should-not-persist"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("%q reached tenants.settings", secret)
		}
	}
	// The Runtime onboarding document is a separate key and untouched.
	if strings.Contains(raw, `"onboarding"`) {
		t.Errorf("pal onboarding wrote the Runtime onboarding key: %s", raw)
	}

	// Profile items persist and render; done stamps completedAt.
	if c := put(a, map[string]any{
		"step": "done", "consent": consent, "voice": map[string]any{"skipped": true},
		"trust":   map[string]any{"prefsSaved": true, "holdsAcknowledged": true},
		"profile": map[string]any{"done": true, "items": []map[string]any{{"section": "facts", "key": "spouse", "value": "Sam"}}},
	}); c != http.StatusOK {
		t.Fatalf("put done: %d", c)
	}
	if _, st := get(a); st["resumeStep"] != "done" || st["completedAt"] == nil {
		t.Fatalf("done: %v", st)
	}
	rr = onbReq(t, h.GetProfileMarkdown, http.MethodGet, "/v1/pal/onboarding/profile", a, nil)
	if !strings.Contains(rr.Body.String(), "- spouse: Sam") {
		t.Errorf("profile render: %s", rr.Body.String())
	}

	// Tenant B sees nothing; B's reset leaves A alone.
	if _, st := get(b); st["resumeStep"] != "welcome" || st["profile"] != nil {
		t.Fatalf("cross-tenant leak: %v", st)
	}
	if rr := onbReq(t, h.DeleteState, http.MethodDelete, "/v1/pal/onboarding", b, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete b: %d", rr.Code)
	}
	if _, st := get(a); st["resumeStep"] != "done" {
		t.Fatalf("B reset clobbered A: %v", st)
	}
	onbReq(t, h.DeleteState, http.MethodDelete, "/v1/pal/onboarding", a, nil)
	if _, st := get(a); st["resumeStep"] != "welcome" {
		t.Errorf("after delete: %v", st)
	}
	if code, _ := get("00000000-0000-0000-0000-00000000dead"); code != http.StatusNotFound {
		t.Errorf("ghost tenant: %d", code)
	}
}

func TestPalOnboardingRoutes_ScopeEnforcement(t *testing.T) {
	pool := openTestPool(t)
	mustMigrate(t, pool)
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	mux := http.NewServeMux()
	NewPalOnboardingHandler(srv, auth, NewLlmProxyHandler(srv, auth)).RegisterRoutes(mux)
	tenant := seedOnboardingTenant(t, pool)

	seq := 0
	key := func(scopes ...string) string {
		seq++
		raw := fmt.Sprintf("hlx_live_palscope_%04d", seq)
		sum := sha256.Sum256([]byte(raw))
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, $2, $3, $4, $5)`,
			tenant, fmt.Sprintf("pal-scope-test-%d", seq), hex.EncodeToString(sum[:]), raw[:8], scopes); err != nil {
			t.Fatalf("insert key: %v", err)
		}
		return raw
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM api_keys WHERE name LIKE 'pal-scope-test-%'`)
	})
	do := func(method, path, raw, body string) int {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+raw)
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, req)
		return rr.Code
	}
	readOnly := key(string(ScopeRead))
	for _, p := range []string{"/v1/pal/onboarding/guide", "/v1/pal/onboarding/voice", "/v1/pal/onboarding/profile/extract", "/v1/pal/onboarding/trust/suggest"} {
		if c := do(http.MethodPost, p, readOnly, `{"step":"welcome","text":"x"}`); c != http.StatusForbidden {
			t.Errorf("%s with read-only key: %d, want 403 (spends tenant money)", p, c)
		}
	}
	if c := do(http.MethodPut, "/v1/pal/onboarding", readOnly, `{"step":"welcome"}`); c != http.StatusForbidden {
		t.Errorf("PUT with read-only key: %d, want 403", c)
	}
	if c := do(http.MethodGet, "/v1/pal/onboarding", readOnly, ""); c != http.StatusOK {
		t.Errorf("GET with read: %d, want 200", c)
	}
}
