package handlers

// Tests for inbound webhook triggers (triggers.go, ADR 0028).
//
// Pure (no DB): signature verification per provider, template rendering,
// oversize body, malformed id.
// DB-backed (skip when DATABASE_URL is unset): CRUD, cross-tenant 404, every
// provider end-to-end, bad signature, replay, duplicate delivery, disabled
// hook, budget 402, per-hook rate limit, missing scope 403, and RLS enforced on
// the lantern_app pool.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const hookTestSecret = "whsec_test_secret_0123456789abcdef"

func hmacHex(secret string, msg []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(msg)
	return hex.EncodeToString(m.Sum(nil))
}

// signedHookHeaders returns headers that a real sender of provider would attach.
// For pagerduty the delivery id lives in the body, so deliveryID is ignored.
func signedHookHeaders(provider, secret string, body []byte, deliveryID string, now time.Time) http.Header {
	h := http.Header{}
	switch provider {
	case "generic":
		ts := strconv.FormatInt(now.Unix(), 10)
		h.Set("X-Pal-Signature", "t="+ts+",v1="+hmacHex(secret, append([]byte(ts+"."), body...)))
		h.Set("X-Pal-Delivery", deliveryID)
		h.Set("X-Pal-Event", "custom.event")
	case "github":
		h.Set("X-Hub-Signature-256", "sha256="+hmacHex(secret, body))
		h.Set("X-GitHub-Delivery", deliveryID)
		h.Set("X-GitHub-Event", "pull_request")
	case "sentry":
		h.Set("Sentry-Hook-Signature", hmacHex(secret, body))
		h.Set("Request-ID", deliveryID)
		h.Set("Sentry-Hook-Resource", "issue")
	case "pagerduty":
		h.Set("X-PagerDuty-Signature", "v1="+hmacHex("rotated-out-secret-xxxxxxxx", body)+",v1="+hmacHex(secret, body))
	}
	return h
}

func pagerDutyBody(eventID string) []byte {
	return []byte(`{"event":{"id":"` + eventID + `","event_type":"incident.triggered","data":{"title":"DB down"}}}`)
}

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

func TestVerifyHookDelivery(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"action":"opened","number":7}`)
	pdBody := pagerDutyBody("PD-EVT-1")

	tests := []struct {
		name      string
		provider  string
		body      []byte
		hdr       http.Header
		wantErr   bool
		wantID    string
		wantEvent string
	}{
		{"generic ok", "generic", body, signedHookHeaders("generic", hookTestSecret, body, "gen-1", now), false, "gen-1", "custom.event"},
		{"github ok", "github", body, signedHookHeaders("github", hookTestSecret, body, "gh-1", now), false, "gh-1", "pull_request"},
		{"sentry ok", "sentry", body, signedHookHeaders("sentry", hookTestSecret, body, "sn-1", now), false, "sn-1", "issue"},
		{"pagerduty ok (second of two sigs)", "pagerduty", pdBody, signedHookHeaders("pagerduty", hookTestSecret, pdBody, "", now), false, "PD-EVT-1", "incident.triggered"},

		{"generic wrong secret", "generic", body, signedHookHeaders("generic", "another-secret-0123456789", body, "g", now), true, "", ""},
		{"github wrong secret", "github", body, signedHookHeaders("github", "another-secret-0123456789", body, "g", now), true, "", ""},
		{"sentry wrong secret", "sentry", body, signedHookHeaders("sentry", "another-secret-0123456789", body, "s", now), true, "", ""},
		{"pagerduty wrong secret", "pagerduty", pdBody, signedHookHeaders("pagerduty", "another-secret-0123456789", pdBody, "", now), true, "", ""},
		{"github tampered body", "github", []byte(`{"action":"closed","number":7}`), signedHookHeaders("github", hookTestSecret, body, "g", now), true, "", ""},
		{"github missing sha256= prefix", "github", body, http.Header{"X-Hub-Signature-256": {hmacHex(hookTestSecret, body)}}, true, "", ""},
		{"github no header", "github", body, http.Header{}, true, "", ""},
		{"sentry non-hex sig", "sentry", body, http.Header{"Sentry-Hook-Signature": {"zz-not-hex"}}, true, "", ""},
		{"generic stale timestamp", "generic", body, signedHookHeaders("generic", hookTestSecret, body, "g", now.Add(-6*time.Minute)), true, "", ""},
		{"generic future timestamp", "generic", body, signedHookHeaders("generic", hookTestSecret, body, "g", now.Add(6*time.Minute)), true, "", ""},
		{"generic no timestamp", "generic", body, http.Header{"X-Lantern-Signature": {"v1=" + hmacHex(hookTestSecret, body)}}, true, "", ""},
		{"unknown provider", "gitlab", body, signedHookHeaders("github", hookTestSecret, body, "g", now), true, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d, err := verifyHookDelivery(tc.provider, hookTestSecret, tc.hdr, tc.body, now)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got delivery %+v", d)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if d.ID != tc.wantID || d.Event != tc.wantEvent {
				t.Errorf("got id=%q event=%q, want id=%q event=%q", d.ID, d.Event, tc.wantID, tc.wantEvent)
			}
			if len(d.ReplayKey) != 64 {
				t.Errorf("replay key %q is not a sha256 hex", d.ReplayKey)
			}
		})
	}
}

func TestVerifyHookDelivery_DeliveryIDFallbacks(t *testing.T) {
	now := time.Now()
	body := []byte(`{"x":1}`)

	// No delivery header → the replay key stands in, so dedup still works.
	hdr := signedHookHeaders("github", hookTestSecret, body, "", now)
	d, err := verifyHookDelivery("github", hookTestSecret, hdr, body, now)
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != d.ReplayKey {
		t.Errorf("missing delivery header: id=%q, want replay key %q", d.ID, d.ReplayKey)
	}

	// An oversized sender-supplied id is hashed, not stored verbatim.
	hdr = signedHookHeaders("github", hookTestSecret, body, strings.Repeat("a", 500), now)
	if d, err = verifyHookDelivery("github", hookTestSecret, hdr, body, now); err != nil {
		t.Fatal(err)
	}
	if len(d.ID) != 64 {
		t.Errorf("long delivery id not bounded: len=%d", len(d.ID))
	}

	// Generic: the replay key covers the timestamp, so the same body signed at
	// two times is two distinct deliveries.
	h1 := signedHookHeaders("generic", hookTestSecret, body, "", now)
	h2 := signedHookHeaders("generic", hookTestSecret, body, "", now.Add(-time.Minute))
	d1, _ := verifyHookDelivery("generic", hookTestSecret, h1, body, now)
	d2, _ := verifyHookDelivery("generic", hookTestSecret, h2, body, now)
	if d1.ReplayKey == d2.ReplayKey {
		t.Error("generic replay key ignores the signed timestamp")
	}
}

func TestRenderHookTemplate(t *testing.T) {
	root := map[string]any{
		"payload": map[string]any{
			"number": float64(7),
			"pr":     map[string]any{"title": "Fix bug", "labels": []any{"a", "b"}},
		},
		"event":    "pull_request",
		"provider": "github",
	}
	tmpl := map[string]any{
		"num":     "{{payload.number}}",
		"title":   "{{ payload.pr.title }}",
		"labels":  "{{payload.pr.labels}}",
		"summary": "PR #{{payload.number}}: {{payload.pr.title}} via {{provider}}",
		"missing": "{{payload.nope}}",
		"gap":     "x{{payload.nope}}y",
		"list":    []any{"{{event}}", "lit"},
		"static":  true,
	}
	got := renderHookTemplate(tmpl, root).(map[string]any)
	want := map[string]any{
		"num":     float64(7),
		"title":   "Fix bug",
		"labels":  []any{"a", "b"},
		"summary": "PR #7: Fix bug via github",
		"missing": nil,
		"gap":     "xy",
		"list":    []any{"pull_request", "lit"},
		"static":  true,
	}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		t.Errorf("render:\n got %s\nwant %s", gb, wb)
	}
}

func TestHookRunInput_DefaultAndNonJSON(t *testing.T) {
	d := hookDelivery{ID: "d1", Event: "push"}
	in := hookRunInput("github", "trig", d, []byte(`{"ref":"main"}`), nil)
	if in["event"] != "push" || in["deliveryId"] != "d1" || in["provider"] != "github" {
		t.Errorf("default input = %v", in)
	}
	if p, _ := in["payload"].(map[string]any); p["ref"] != "main" {
		t.Errorf("default payload = %v", in["payload"])
	}
	in = hookRunInput("generic", "trig", d, []byte("plain text"), []byte(`{"text":"{{payload}}"}`))
	if in["text"] != "plain text" {
		t.Errorf("non-JSON body should map as a string, got %v", in)
	}
}

func TestRunTriggerKind_DefaultsToAPI(t *testing.T) {
	if k := runTriggerKind(context.Background()); k != lanternv1.TriggerKind_TRIGGER_KIND_API {
		t.Errorf("default kind = %v, want API", k)
	}
}

// Pre-DB rejections: a nil pool panics if the handler reaches the DB.
func TestReceiveHook_PreDBRejections(t *testing.T) {
	srv := &server.Server{Logger: nopLogger()}
	h := NewTriggerHandler(srv, NewAuthHandler(srv, testJWTSecret), nil)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/hooks/not-a-uuid", strings.NewReader("{}")))
	if rr.Code != http.StatusNotFound {
		t.Errorf("malformed id: got %d, want 404", rr.Code)
	}

	big := bytes.Repeat([]byte("a"), hookMaxBody+1)
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/hooks/"+uuid.NewString(), bytes.NewReader(big)))
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize body: got %d, want 413", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// DB-backed tests
// ---------------------------------------------------------------------------

type triggerEnv struct {
	rest *RESTHandler
	h    *TriggerHandler
	mux  *http.ServeMux
}

func newTriggerEnv(t *testing.T, srv *server.Server) *triggerEnv {
	t.Helper()
	auth := NewAuthHandler(srv, testJWTSecret)
	rest := NewRESTHandler(srv, auth, NewAgentService(srv), NewRunService(srv))
	h := NewTriggerHandler(srv, auth, rest)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return &triggerEnv{rest: rest, h: h, mux: mux}
}

func newTriggerTestEnv(t *testing.T) *triggerEnv {
	t.Helper()
	pool := openTestPool(t)
	mustMigrate(t, pool)
	return newTriggerEnv(t, &server.Server{Pool: pool, Logger: nopLogger()})
}

// seedTriggerTenant inserts a fresh tenant plus agent (with a promoted version)
// and returns the tenant id. Triggers/deliveries cascade on tenant delete.
func seedTriggerTenant(t *testing.T, env *triggerEnv, agentName string) string {
	t.Helper()
	pool := env.rest.srv.Pool
	id := uuid.NewString()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO tenants (id, slug, name, tier, k8s_namespace)
		VALUES ($1, $2, 'Trigger Test', 'personal', 'lantern-t-' || $2)`, id, "trg-"+id[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	cleanupAgent := ensureAgentForBudgetTest(t, env.rest, id, agentName)
	t.Cleanup(func() {
		cleanupAgent()
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM agent_budgets WHERE tenant_id = $1`, id)
		_, _ = pool.Exec(bg, `DELETE FROM agent_usage_daily WHERE tenant_id = $1`, id)
		_, _ = pool.Exec(bg, `DELETE FROM tenants WHERE id = $1`, id)
	})
	return id
}

func (e *triggerEnv) call(t *testing.T, method, path, tenantID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "owner-"+tenantID[:8], "owner")))
	rr := httptest.NewRecorder()
	e.mux.ServeHTTP(rr, req)
	return rr
}

func (e *triggerEnv) createTrigger(t *testing.T, tenantID, agentName string, body map[string]any) triggerJSON {
	t.Helper()
	rr := e.call(t, http.MethodPost, "/v1/agents/"+agentName+"/triggers", tenantID, body)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create trigger: %d %s", rr.Code, rr.Body.String())
	}
	var tr triggerJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &tr); err != nil {
		t.Fatal(err)
	}
	return tr
}

func (e *triggerEnv) deliver(t *testing.T, triggerID string, hdr http.Header, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/hooks/"+triggerID, bytes.NewReader(body))
	for k, v := range hdr {
		req.Header[k] = v
	}
	rr := httptest.NewRecorder()
	e.mux.ServeHTTP(rr, req)
	return rr
}

func (e *triggerEnv) runsFor(t *testing.T, tenantID, agentName string) int {
	t.Helper()
	var n int
	if err := e.rest.srv.Pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM runs r JOIN agents a ON a.id = r.agent_id
		WHERE r.tenant_id = $1 AND a.name = $2`, tenantID, agentName).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTriggers_CRUD(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-crud")

	tr := env.createTrigger(t, tenant, "trg-crud", map[string]any{"provider": "github"})
	if !strings.HasPrefix(tr.Secret, "whsec_") || tr.HookPath != "/v1/hooks/"+tr.ID || !tr.Enabled {
		t.Fatalf("create response = %+v", tr)
	}

	// Caller-supplied secret is never echoed.
	tr2 := env.createTrigger(t, tenant, "trg-crud", map[string]any{"provider": "pagerduty", "secret": hookTestSecret,
		"inputTemplate": map[string]any{"title": "{{payload.event.data.title}}"}})
	if tr2.Secret != "" {
		t.Error("caller-supplied secret echoed back")
	}

	rr := env.call(t, http.MethodGet, "/v1/agents/trg-crud/triggers", tenant, nil)
	if rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), "whsec_") || strings.Contains(rr.Body.String(), hookTestSecret) {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	var list []triggerJSON
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list) != 2 {
		t.Fatalf("list len = %d", len(list))
	}

	// Stored secret is not plaintext when encryption is configured; either way
	// it round-trips.
	var stored []byte
	if err := env.rest.srv.Pool.QueryRow(context.Background(), `SELECT secret_enc FROM agent_triggers WHERE id = $1`, tr2.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if s, err := decryptHookSecret(stored); err != nil || s != hookTestSecret {
		t.Fatalf("secret round-trip: %q %v", s, err)
	}

	rr = env.call(t, http.MethodPatch, "/v1/triggers/"+tr.ID, tenant, map[string]any{"enabled": false, "inputTemplate": map[string]any{"a": "{{event}}"}})
	var upd triggerJSON
	_ = json.Unmarshal(rr.Body.Bytes(), &upd)
	if rr.Code != http.StatusOK || upd.Enabled || !strings.Contains(string(upd.InputTemplate), "{{event}}") {
		t.Fatalf("patch: %d %s", rr.Code, rr.Body.String())
	}
	rr = env.call(t, http.MethodPatch, "/v1/triggers/"+tr.ID, tenant, map[string]any{"inputTemplate": nil})
	upd = triggerJSON{}
	_ = json.Unmarshal(rr.Body.Bytes(), &upd)
	if rr.Code != http.StatusOK || upd.InputTemplate != nil || upd.Enabled {
		t.Fatalf("patch clear template: %d %s", rr.Code, rr.Body.String())
	}

	if rr = env.call(t, http.MethodGet, "/v1/triggers/"+tr.ID, tenant, nil); rr.Code != http.StatusOK {
		t.Fatalf("get: %d", rr.Code)
	}
	if rr = env.call(t, http.MethodDelete, "/v1/triggers/"+tr.ID, tenant, nil); rr.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rr.Code)
	}
	if rr = env.call(t, http.MethodGet, "/v1/triggers/"+tr.ID, tenant, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("get after delete: %d", rr.Code)
	}
}

func TestTriggers_CreateValidation(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-val")
	tests := []struct {
		name  string
		agent string
		body  map[string]any
		want  int
	}{
		{"unknown agent", "nope-agent", map[string]any{"provider": "github"}, http.StatusNotFound},
		{"bad provider", "trg-val", map[string]any{"provider": "gitlab"}, http.StatusBadRequest},
		{"short secret", "trg-val", map[string]any{"provider": "github", "secret": "short"}, http.StatusBadRequest},
		{"template not object", "trg-val", map[string]any{"provider": "github", "inputTemplate": []any{"x"}}, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if rr := env.call(t, http.MethodPost, "/v1/agents/"+tc.agent+"/triggers", tenant, tc.body); rr.Code != tc.want {
				t.Errorf("got %d, want %d: %s", rr.Code, tc.want, rr.Body.String())
			}
		})
	}
	if rr := env.call(t, http.MethodPatch, "/v1/triggers/"+uuid.NewString(), tenant, map[string]any{"secret": "short"}); rr.Code != http.StatusBadRequest {
		t.Errorf("patch short secret: got %d", rr.Code)
	}
}

func TestTriggers_CrossTenant404(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenantA := seedTriggerTenant(t, env, "trg-xt")
	tenantB := seedTriggerTenant(t, env, "trg-xt-b")
	tr := env.createTrigger(t, tenantA, "trg-xt", map[string]any{"provider": "github"})

	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/v1/triggers/" + tr.ID, nil},
		{http.MethodPatch, "/v1/triggers/" + tr.ID, map[string]any{"enabled": false}},
		{http.MethodDelete, "/v1/triggers/" + tr.ID, nil},
		{http.MethodPost, "/v1/agents/trg-xt/triggers", map[string]any{"provider": "github"}}, // A's agent name, B's tenant
	} {
		if rr := env.call(t, c.method, c.path, tenantB, c.body); rr.Code != http.StatusNotFound {
			t.Errorf("%s %s as tenant B: got %d, want 404", c.method, c.path, rr.Code)
		}
	}
	rr := env.call(t, http.MethodGet, "/v1/agents/trg-xt/triggers", tenantB, nil)
	if strings.TrimSpace(rr.Body.String()) != "[]" {
		t.Errorf("tenant B list of A's agent: %s", rr.Body.String())
	}
	// A's trigger is untouched.
	if rr := env.call(t, http.MethodGet, "/v1/triggers/"+tr.ID, tenantA, nil); rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"enabled":true`) {
		t.Errorf("tenant A trigger after B's attempts: %d %s", rr.Code, rr.Body.String())
	}
}

func TestReceiveHook_EachProviderStartsWebhookRun(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-prov")

	for _, provider := range []string{"generic", "github", "sentry", "pagerduty"} {
		t.Run(provider, func(t *testing.T) {
			tr := env.createTrigger(t, tenant, "trg-prov", map[string]any{"provider": provider, "secret": hookTestSecret,
				"inputTemplate": map[string]any{"via": "{{provider}}", "event": "{{event}}", "body": "{{payload}}"}})
			deliveryID := "dlv-" + uuid.NewString()
			body := []byte(`{"n":"` + deliveryID + `"}`)
			if provider == "pagerduty" {
				body = pagerDutyBody(deliveryID)
			}
			rr := env.deliver(t, tr.ID, signedHookHeaders(provider, hookTestSecret, body, deliveryID, time.Now()), body)
			if rr.Code != http.StatusAccepted {
				t.Fatalf("deliver: %d %s", rr.Code, rr.Body.String())
			}
			var resp struct{ RunID, DeliveryID string }
			_ = json.Unmarshal(rr.Body.Bytes(), &resp)
			if resp.DeliveryID != deliveryID {
				t.Errorf("deliveryId = %q, want %q", resp.DeliveryID, deliveryID)
			}

			var kind string
			var input map[string]any
			if err := env.rest.srv.Pool.QueryRow(context.Background(),
				`SELECT trigger_kind, input FROM runs WHERE id = $1 AND tenant_id = $2`, resp.RunID, tenant).Scan(&kind, &input); err != nil {
				t.Fatalf("load run %q: %v", resp.RunID, err)
			}
			if kind != "webhook" {
				t.Errorf("trigger_kind = %q, want webhook", kind)
			}
			if input["via"] != provider || input["event"] == "" || input["body"] == nil {
				t.Errorf("run input = %v", input)
			}
			var lastDelivery *time.Time
			_ = env.rest.srv.Pool.QueryRow(context.Background(), `SELECT last_delivery_at FROM agent_triggers WHERE id = $1`, tr.ID).Scan(&lastDelivery)
			if lastDelivery == nil {
				t.Error("last_delivery_at not stamped")
			}
		})
	}
}

func TestReceiveHook_SignatureReplayAndDuplicates(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-dup")
	tr := env.createTrigger(t, tenant, "trg-dup", map[string]any{"provider": "github", "secret": hookTestSecret})
	body := []byte(`{"action":"opened","id":` + strconv.FormatInt(time.Now().UnixNano(), 10) + `}`)

	// Bad signature → 401, no delivery recorded, no run.
	rr := env.deliver(t, tr.ID, signedHookHeaders("github", "attacker-secret-0123456789", body, "d-1", time.Now()), body)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("bad sig: %d", rr.Code)
	}
	if strings.Contains(rr.Body.String(), hookTestSecret) {
		t.Fatal("secret leaked in 401 body")
	}
	if n := env.runsFor(t, tenant, "trg-dup"); n != 0 {
		t.Fatalf("bad sig created %d runs", n)
	}

	good := signedHookHeaders("github", hookTestSecret, body, "d-1", time.Now())
	rr = env.deliver(t, tr.ID, good, body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("first delivery: %d %s", rr.Code, rr.Body.String())
	}
	var first map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &first)

	// Redelivery (same delivery id) → 200 duplicate, same run.
	rr = env.deliver(t, tr.ID, good, body)
	var dup map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &dup)
	if rr.Code != http.StatusOK || dup["duplicate"] != true || dup["runId"] != first["runId"] {
		t.Fatalf("redelivery: %d %s", rr.Code, rr.Body.String())
	}

	// Replay with a forged delivery id (GitHub does not sign it) → still a duplicate.
	rr = env.deliver(t, tr.ID, signedHookHeaders("github", hookTestSecret, body, "forged-new-id", time.Now()), body)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"duplicate":true`) {
		t.Fatalf("replay with forged id: %d %s", rr.Code, rr.Body.String())
	}

	if n := env.runsFor(t, tenant, "trg-dup"); n != 1 {
		t.Fatalf("runs after redelivery+replay = %d, want 1", n)
	}
}

func TestReceiveHook_DisabledUnknownAndDeletedAgent404(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-off")
	tr := env.createTrigger(t, tenant, "trg-off", map[string]any{"provider": "sentry", "secret": hookTestSecret})
	body := []byte(`{"x":1}`)

	if rr := env.call(t, http.MethodPatch, "/v1/triggers/"+tr.ID, tenant, map[string]any{"enabled": false}); rr.Code != http.StatusOK {
		t.Fatalf("disable: %d", rr.Code)
	}
	rr := env.deliver(t, tr.ID, signedHookHeaders("sentry", hookTestSecret, body, "x1", time.Now()), body)
	if rr.Code != http.StatusNotFound {
		t.Errorf("disabled hook: got %d, want 404", rr.Code)
	}
	if rr := env.deliver(t, uuid.NewString(), signedHookHeaders("sentry", hookTestSecret, body, "x2", time.Now()), body); rr.Code != http.StatusNotFound {
		t.Errorf("unknown hook: got %d, want 404", rr.Code)
	}

	// Re-enable, then archive the agent: the hook must not auto-create it.
	env.call(t, http.MethodPatch, "/v1/triggers/"+tr.ID, tenant, map[string]any{"enabled": true})
	if _, err := env.rest.srv.Pool.Exec(context.Background(), `UPDATE agents SET archived_at = now() WHERE tenant_id = $1 AND name = 'trg-off'`, tenant); err != nil {
		t.Fatal(err)
	}
	if rr := env.deliver(t, tr.ID, signedHookHeaders("sentry", hookTestSecret, body, "x3", time.Now()), body); rr.Code != http.StatusNotFound {
		t.Errorf("archived agent: got %d, want 404", rr.Code)
	}
	if n := env.runsFor(t, tenant, "trg-off"); n != 0 {
		t.Errorf("runs = %d, want 0", n)
	}
}

func TestReceiveHook_OverBudget402ReleasesDelivery(t *testing.T) {
	env := newTriggerTestEnv(t)
	agent := "e2e-trg-budget"
	tenant := seedTriggerTenant(t, env, agent)
	upsertBudgetDirect(t, env.rest, tenant, agent, 1, true)
	setUsageDirect(t, env.rest, tenant, agent, 1) // daily run cap already hit
	tr := env.createTrigger(t, tenant, agent, map[string]any{"provider": "github", "secret": hookTestSecret})
	body := []byte(`{"budget":true}`)
	hdr := signedHookHeaders("github", hookTestSecret, body, "b-1", time.Now())

	rr := env.deliver(t, tr.ID, hdr, body)
	if rr.Code != http.StatusPaymentRequired {
		t.Fatalf("over budget: got %d %s, want 402", rr.Code, rr.Body.String())
	}
	if n := env.runsFor(t, tenant, agent); n != 0 {
		t.Fatalf("over-budget delivery created %d runs", n)
	}
	var held int
	_ = env.rest.srv.Pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM agent_trigger_deliveries WHERE trigger_id = $1`, tr.ID).Scan(&held)
	if held != 0 {
		t.Fatalf("blocked delivery still recorded (%d) — provider retry would be swallowed as a duplicate", held)
	}

	// Budget resets → the provider's retry of the same delivery now runs.
	deleteUsageDirect(t, env.rest, tenant, agent)
	if rr := env.deliver(t, tr.ID, hdr, body); rr.Code != http.StatusAccepted {
		t.Fatalf("retry after reset: %d %s", rr.Code, rr.Body.String())
	}
}

func TestReceiveHook_RateLimitedPerHook(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-rl")
	env.h.limiter = newSpawnRateLimiterWithClock(1, 1, func() time.Time { return time.Unix(0, 0) })
	t.Cleanup(env.h.limiter.Stop)
	tr := env.createTrigger(t, tenant, "trg-rl", map[string]any{"provider": "github", "secret": hookTestSecret})
	other := env.createTrigger(t, tenant, "trg-rl", map[string]any{"provider": "github", "secret": hookTestSecret})

	send := func(id, n string) int {
		body := []byte(`{"n":"` + n + `"}`)
		return env.deliver(t, id, signedHookHeaders("github", hookTestSecret, body, n, time.Now()), body).Code
	}
	if c := send(tr.ID, "r1"); c != http.StatusAccepted {
		t.Fatalf("first: %d", c)
	}
	if c := send(tr.ID, "r2"); c != http.StatusTooManyRequests {
		t.Fatalf("second within window: got %d, want 429", c)
	}
	if c := send(other.ID, "r3"); c != http.StatusAccepted {
		t.Fatalf("other hook shares the bucket: got %d", c)
	}
	// Unsigned junk must not spend the allowance: it is rejected before the limiter.
	junk := []byte(`{}`)
	if c := env.deliver(t, other.ID, http.Header{"X-Hub-Signature-256": {"sha256=00"}}, junk).Code; c != http.StatusUnauthorized {
		t.Fatalf("junk: got %d, want 401", c)
	}
}

func TestTriggers_MissingScope403(t *testing.T) {
	env := newTriggerTestEnv(t)
	tenant := seedTriggerTenant(t, env, "trg-scope")
	pool := env.rest.srv.Pool
	rawKey := fmt.Sprintf("hlx_live_trgscope_%s", uuid.NewString()[:8])
	sum := sha256.Sum256([]byte(rawKey))
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, 'trg-scope', $2, $3, $4)`,
		tenant, hex.EncodeToString(sum[:]), rawKey[:8], []string{"read"}); err != nil {
		t.Fatalf("insert api key: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM api_keys WHERE tenant_id = $1`, tenant) })
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")

	tr := env.createTrigger(t, tenant, "trg-scope", map[string]any{"provider": "github"})
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/v1/agents/trg-scope/triggers"},
		{http.MethodPatch, "/v1/triggers/" + tr.ID},
		{http.MethodDelete, "/v1/triggers/" + tr.ID},
	} {
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(`{"provider":"github","enabled":false}`))
		req.Header.Set("Authorization", "Bearer "+rawKey)
		rr := httptest.NewRecorder()
		env.mux.ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Errorf("%s %s with read-only key: got %d, want 403", c.method, c.path, rr.Code)
		}
	}
	// Read-only key may still list.
	req := httptest.NewRequest(http.MethodGet, "/v1/agents/trg-scope/triggers", nil)
	req.Header.Set("Authorization", "Bearer "+rawKey)
	rr := httptest.NewRecorder()
	env.mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("list with read key: %d", rr.Code)
	}
}

// TestRLSTriggers_EnforcedAppPool runs CRUD and a delivery with the handler's
// tenant-scoped work on the lantern_app pool, where RLS genuinely applies —
// proving both the policies and the GRANTs in migration 0024.
func TestRLSTriggers_EnforcedAppPool(t *testing.T) {
	e := newEnforcedServer(t)
	env := newTriggerEnv(t, e.srv)
	tenantA := seedTriggerTenant(t, env, "trg-rls")
	tenantB := seedTriggerTenant(t, env, "trg-rls-b")

	tr := env.createTrigger(t, tenantA, "trg-rls", map[string]any{"provider": "github", "secret": hookTestSecret})
	if rr := env.call(t, http.MethodGet, "/v1/triggers/"+tr.ID, tenantA, nil); rr.Code != http.StatusOK {
		t.Fatalf("same-tenant get under RLS: %d %s", rr.Code, rr.Body.String())
	}
	if rr := env.call(t, http.MethodGet, "/v1/triggers/"+tr.ID, tenantB, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant get under RLS: %d", rr.Code)
	}

	body := []byte(`{"rls":true}`)
	rr := env.deliver(t, tr.ID, signedHookHeaders("github", hookTestSecret, body, "rls-1", time.Now()), body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("delivery under RLS: %d %s", rr.Code, rr.Body.String())
	}

	// The delivery row is invisible to tenant B on the app pool.
	var n int
	if err := e.srv.WithTenant(injectTenant(context.Background(), tenantB), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SELECT COUNT(*) FROM agent_trigger_deliveries WHERE trigger_id = $1`, tr.ID).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("tenant B sees %d of tenant A's deliveries", n)
	}
}

// ADR 0032: a generic sender configured before the rename signs with the
// X-Lantern-* names; those still verify and carry the delivery id + event.
func TestVerifyHookDelivery_GenericLegacyHeaderNames(t *testing.T) {
	now := time.Now()
	body := []byte(`{"ok":true}`)
	pal := signedHookHeaders("generic", hookTestSecret, body, "dlv-1", now)
	legacy := http.Header{}
	for k, v := range pal {
		legacy[strings.Replace(k, "X-Pal-", "X-Lantern-", 1)] = v
	}
	if _, ok := legacy["X-Lantern-Signature"]; !ok {
		t.Fatalf("fixture did not produce legacy names: %v", legacy)
	}
	d, err := verifyHookDelivery("generic", hookTestSecret, legacy, body, now)
	if err != nil {
		t.Fatalf("legacy-signed delivery rejected: %v", err)
	}
	if d.ID != "dlv-1" || d.Event != "custom.event" {
		t.Errorf("legacy delivery fields: %+v", d)
	}
}
