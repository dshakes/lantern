package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type kioskSession struct {
	Token    string `json:"token"`
	TenantID string `json:"tenantId"`
	Mode     string `json:"mode"`
}

type kioskEnv struct {
	h      *KioskHandler
	es     *enforcedServer
	mux    *http.ServeMux
	bodies []string // every response body, for the secret grep
}

func newKioskEnv(t *testing.T) *kioskEnv {
	t.Helper()
	t.Setenv("LANTERN_KIOSK", "1")
	t.Setenv("LANTERN_AUTHZ_ENFORCE", "1")
	es := newEnforcedServer(t)
	auth := NewAuthHandler(es.srv, testJWTSecret)
	rest := NewRESTHandler(es.srv, auth, NewAgentService(es.srv), NewRunService(es.srv))
	k := NewKioskHandler(es.srv, auth)
	k.perIPPerHour = 1000
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/kiosk/session", k.CreateSession)
	mux.HandleFunc("GET /v1/agents", rest.ListAgents)
	mux.HandleFunc("POST /v1/agents", auth.WithScope(ScopeAgentsWrite, rest.CreateAgent))
	mux.HandleFunc("GET /v1/agents/{name}", rest.GetAgent)
	mux.HandleFunc("GET /v1/runs", rest.ListRuns)
	mux.HandleFunc("GET /v1/runs/{id}", rest.GetRun)
	mux.HandleFunc("POST /v1/runs", auth.WithScope(ScopeRunsExecute, rest.CreateRun))
	mux.HandleFunc("POST /v1/settings/llm-providers", auth.WithScope(ScopeSettingsWrite, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	e := &kioskEnv{h: k, es: es, mux: mux}
	t.Cleanup(func() {
		k.now = func() time.Time { return time.Now().Add(24 * time.Hour) }
		_, _ = k.SweepExpired(context.Background())
	})
	return e
}

func (e *kioskEnv) do(method, path, token, body string) (int, string) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "203.0.113.9:4000"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	b := w.Body.String()
	e.bodies = append(e.bodies, b)
	return w.Code, b
}

func (e *kioskEnv) session(t *testing.T) kioskSession {
	t.Helper()
	code, b := e.do("POST", "/v1/kiosk/session", "", "")
	if code != http.StatusCreated {
		t.Fatalf("session: %d %s", code, b)
	}
	var s kioskSession
	if err := json.Unmarshal([]byte(b), &s); err != nil || s.Token == "" {
		t.Fatalf("bad session body %q: %v", b, err)
	}
	return s
}

func TestKiosk_DisabledIs404(t *testing.T) {
	t.Setenv("LANTERN_KIOSK", "")
	k := &KioskHandler{}
	w := httptest.NewRecorder()
	k.CreateSession(w, httptest.NewRequest("POST", "/v1/kiosk/session", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 without LANTERN_KIOSK=1, got %d", w.Code)
	}
}

func TestKiosk_TwoVisitorIsolationAndNoSecrets(t *testing.T) {
	e := newKioskEnv(t)
	a, b := e.session(t), e.session(t)
	if a.Mode != "replay" || a.TenantID == b.TenantID {
		t.Fatalf("want distinct replay tenants, got %+v %+v", a, b)
	}

	// A's seeded run ids.
	_, listA := e.do("GET", "/v1/runs", a.Token, "")
	var la []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(listA), &la)
	if len(la) == 0 {
		t.Fatalf("visitor A should see seeded runs, got %s", listA)
	}
	_, listB := e.do("GET", "/v1/runs", b.Token, "")
	for _, r := range la {
		if strings.Contains(listB, r.ID) {
			t.Fatalf("visitor B's run list leaks A's run %s", r.ID)
		}
		if code, _ := e.do("GET", "/v1/runs/"+r.ID, b.Token, ""); code != http.StatusNotFound {
			t.Fatalf("B reading A's run: want 404 got %d", code)
		}
		if code, _ := e.do("GET", "/v1/runs/"+r.ID, a.Token, ""); code != http.StatusOK {
			t.Fatalf("A reading own run: want 200 got %d", code)
		}
	}

	// An agent only A created is invisible to B.
	if code, body := e.do("POST", "/v1/agents", a.Token, `{"name":"only-a"}`); code != http.StatusCreated {
		t.Fatalf("A create agent: %d %s", code, body)
	}
	if code, _ := e.do("GET", "/v1/agents/only-a", b.Token, ""); code != http.StatusNotFound {
		t.Fatalf("B reading A's agent: want 404 got %d", code)
	}
	e.do("GET", "/v1/agents", a.Token, "")

	// AUTHZ_ENFORCE: a kiosk token cannot write provider settings.
	if code, _ := e.do("POST", "/v1/settings/llm-providers", a.Token, `{}`); code != http.StatusForbidden {
		t.Fatalf("settings:write must be 403 for kiosk, got %d", code)
	}

	// Budget demo: the pre-spent agent is blocked with 402.
	if code, body := e.do("POST", "/v1/runs", a.Token, `{"agentName":"budget-capped","input":{"input":"hi"}}`); code != http.StatusPaymentRequired {
		t.Fatalf("budget-capped run: want 402 got %d %s", code, body)
	}

	// No provider key anywhere: not in any response body, not in the DB.
	keyRe := regexp.MustCompile(`sk-[A-Za-z0-9_-]{8,}|"api_?[kK]ey"\s*:\s*"[^"]|api_key_encrypted`)
	for _, body := range e.bodies {
		if keyRe.MatchString(body) {
			t.Fatalf("provider-key-looking material in a kiosk response: %.200s", body)
		}
	}
	var n int
	if err := e.es.superPool.QueryRow(context.Background(),
		`SELECT count(*) FROM llm_provider_configs WHERE tenant_id IN ($1,$2)`, a.TenantID, b.TenantID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("kiosk tenants must hold zero provider configs, got %d (%v)", n, err)
	}
}

func TestKiosk_ExpiredSessionPurgedAcrossAllTables(t *testing.T) {
	e := newKioskEnv(t)
	ctx := context.Background()
	s := e.session(t)
	// A normal tenant that merely LOOKS expired must survive the sweep.
	var decoy string
	if err := e.es.superPool.QueryRow(ctx, `
		INSERT INTO tenants (slug, name, tier, k8s_namespace, settings)
		VALUES ($1, 'decoy', 'personal', $2, '{"kiosk":true,"kiosk_expires_at":"2000-01-01T00:00:00Z"}'::jsonb) RETURNING id`,
		fmt.Sprintf("real-%d", time.Now().UnixNano()), fmt.Sprintf("lantern-t-real-%d", time.Now().UnixNano())).Scan(&decoy); err != nil {
		t.Fatal(err)
	}
	defer e.es.superPool.Exec(ctx, `DELETE FROM tenants WHERE id = $1`, decoy) //nolint:errcheck

	// Not yet expired -> untouched.
	if n, err := e.h.SweepExpired(ctx); err != nil || n != 0 {
		t.Fatalf("premature sweep removed %d (%v)", n, err)
	}
	e.h.now = func() time.Time { return time.Now().Add(e.h.ttl + time.Minute) }
	if n, err := e.h.SweepExpired(ctx); err != nil || n < 1 {
		t.Fatalf("sweep removed %d (%v), want >=1", n, err)
	}

	// Zero rows for that tenant in EVERY table that has a tenant_id column.
	rows, err := e.es.superPool.Query(ctx, `
		SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
		WHERE n.nspname = 'public' AND c.relkind = 'r'`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		tables = append(tables, s)
	}
	rows.Close()
	if len(tables) < 20 {
		t.Fatalf("catalog walk found only %d tenant tables", len(tables))
	}
	for _, tb := range tables {
		var n int
		q := fmt.Sprintf(`SELECT count(*) FROM %s WHERE tenant_id = $1`, pgx.Identifier{tb}.Sanitize())
		if err := e.es.superPool.QueryRow(ctx, q, s.TenantID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s still has %d rows for the purged kiosk tenant (%v)", tb, n, err)
		}
	}
	var left int
	_ = e.es.superPool.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE id = $1`, s.TenantID).Scan(&left)
	if left != 0 {
		t.Fatal("tenants row survived")
	}
	_ = e.es.superPool.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE id = $1`, decoy).Scan(&left)
	if left != 1 {
		t.Fatal("sweep deleted a non-kiosk tenant")
	}
}

func TestKiosk_RateLimitsAndCapacity(t *testing.T) {
	e := newKioskEnv(t)
	e.h.perIPPerHour = 2
	e.h.hitsByIP = map[string][]time.Time{}
	e.session(t)
	e.session(t)
	if code, _ := e.do("POST", "/v1/kiosk/session", "", ""); code != http.StatusTooManyRequests {
		t.Fatalf("3rd session from one IP: want 429 got %d", code)
	}
	e.h.perIPPerHour = 1000
	e.h.maxSessions = 1 // >= live kiosk tenants already -> at capacity
	if code, _ := e.do("POST", "/v1/kiosk/session", "", ""); code != http.StatusServiceUnavailable {
		t.Fatalf("over capacity: want 503 got %d", code)
	}
}

func TestCheckKioskConfig(t *testing.T) {
	env := func(kv ...string) func(string) string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return func(k string) string { return m[k] }
	}
	good := []string{"LANTERN_KIOSK", "1", "LANTERN_RLS_ENFORCE", "1", "LANTERN_AUTHZ_ENFORCE", "1", "JWT_SECRET", "a-real-random-secret"}
	cases := []struct {
		name  string
		prod  bool
		env   []string
		fatal bool
	}{
		{"off is a no-op", true, nil, false},
		{"dev with enforcement ok", false, good, false},
		{"prod refused", true, good, true},
		{"prod explicitly allowed", true, append(append([]string{}, good...), "LANTERN_KIOSK_ALLOW_PROD", "1"), false},
		{"RLS off refused", false, []string{"LANTERN_KIOSK", "1", "LANTERN_AUTHZ_ENFORCE", "1"}, true},
		{"authz off refused", false, []string{"LANTERN_KIOSK", "1", "LANTERN_RLS_ENFORCE", "1"}, true},
		{"provider key without fixture URL refused", false, append(append([]string{}, good...), "OPENAI_API_KEY", "x"), true},
		{"missing JWT secret refused", false, []string{"LANTERN_KIOSK", "1", "LANTERN_RLS_ENFORCE", "1", "LANTERN_AUTHZ_ENFORCE", "1"}, true},
		{"dev-default JWT secret refused", false, []string{"LANTERN_KIOSK", "1", "LANTERN_RLS_ENFORCE", "1", "LANTERN_AUTHZ_ENFORCE", "1", "JWT_SECRET", devJWTSecret}, true},
		{"provider key pinned to fixture ok", false, append(append([]string{}, good...), "OPENAI_API_KEY", "x", "LANTERN_LLM_BASEURL_OPENAI", "http://llm-replay:9090"), false},
	}
	for _, c := range cases {
		if fatal, msg := CheckKioskConfig(c.prod, env(c.env...)); fatal != c.fatal {
			t.Errorf("%s: fatal=%v (%s), want %v", c.name, fatal, msg, c.fatal)
		}
	}
}
