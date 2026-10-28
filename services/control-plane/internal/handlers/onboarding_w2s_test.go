package handlers

// W2-S tests: starter gallery, email-verify run gate, free-tier caps and the
// onboarding transition metric. DB-gated like the rest of the package; use a
// dedicated database (parallel agents share the dev one):
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern_w2s?sslmode=disable \
//	  go test ./internal/handlers/ -run W2S -count=1

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestW2S_GalleryTemplates(t *testing.T) {
	rr := httptest.NewRecorder()
	(&TemplateHandler{}).ListTemplates(rr, httptest.NewRequest(http.MethodGet, "/v1/agents/templates", nil))
	var list []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	want := []string{"support-desk", "pr-triage", "incident-responder", "daily-digest", "data-analyst", "telegram-assistant"}
	for i, id := range want {
		g := list[i]
		if g["id"] != id || g["gallery"] != true {
			t.Fatalf("slot %d = %v gallery=%v, want gallery template %s", i, g["id"], g["gallery"], id)
		}
		if m := g["model"]; m != "fast" && m != "balanced" {
			t.Errorf("%s model = %v, want fast|balanced", id, m)
		}
		for _, f := range []string{"pitch", "firstInput", "systemPrompt"} {
			if s, _ := g[f].(string); s == "" {
				t.Errorf("%s missing %s", id, f)
			}
		}
		if err := validAgentModel(g["model"].(string)); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
	// non-gallery templates must not leak their prompts
	for _, g := range list[len(want):] {
		if g["gallery"] == true {
			t.Errorf("unexpected extra gallery template %v", g["id"])
		}
		if _, ok := g["systemPrompt"]; ok {
			t.Errorf("%v leaks systemPrompt", g["id"])
		}
	}
}

func TestW2S_OnboardingSpecAcceptsCapabilityModels(t *testing.T) {
	st := onboardingState{Step: "spec", Spec: &onboardingSpec{Name: "pr-triage", Model: "balanced"}}
	if err := st.validate(); err != nil {
		t.Fatalf("balanced rejected: %v", err)
	}
	st.Spec.Model = "gpt-5"
	if err := st.validate(); err == nil {
		t.Fatal("vendor model accepted (invariant #6)")
	}
}

func TestW2S_TransitionMetricDoesNotPanicOnNilOrSame(t *testing.T) {
	same, empty := "goal", ""
	recordOnboardingTransition(context.Background(), nil, "goal")
	recordOnboardingTransition(context.Background(), &same, "goal")
	recordOnboardingTransition(context.Background(), &empty, "done")
}

func TestW2S_FreeTierEnv(t *testing.T) {
	t.Setenv("LANTERN_FREE_TIER_COST_USD_PER_DAY", "")
	t.Setenv("LANTERN_FREE_TIER_MAX_VMS", "banana")
	ft := freeTierFromEnv()
	if ft.CostUSDPerDay != defaultFreeCostUSDPerDay || ft.MaxVMs != defaultFreeMaxVMs {
		t.Fatalf("defaults not applied: %+v", ft)
	}
	t.Setenv("LANTERN_FREE_TIER_COST_USD_PER_DAY", "off")
	t.Setenv("LANTERN_FREE_TIER_MAX_VMS", "5")
	ft = freeTierFromEnv()
	if ft.CostUSDPerDay != 0 || ft.MaxVMs != 5 {
		t.Fatalf("env not honoured: %+v", ft)
	}
}

func freeTierRows(t *testing.T, h *AuthHandler, tenantID string) (budget *float64, vms *int) {
	t.Helper()
	ctx := context.Background()
	var b float64
	if err := h.srv.Pool.QueryRow(ctx, `SELECT max_cost_usd_per_day FROM agent_budgets WHERE tenant_id=$1 AND agent_name='*'`, tenantID).Scan(&b); err == nil {
		budget = &b
	}
	var v int
	if err := h.srv.Pool.QueryRow(ctx, `SELECT max_concurrent_vms FROM runtime_quotas WHERE tenant_id=$1`, tenantID).Scan(&v); err == nil {
		vms = &v
	}
	return
}

func TestW2S_SignupAppliesFreeTier(t *testing.T) {
	h := newAuthTestHandler(t)
	t.Setenv("LANTERN_ENV", "")
	t.Setenv("LANTERN_FREE_TIER_COST_USD_PER_DAY", "3.5")
	t.Setenv("LANTERN_FREE_TIER_MAX_VMS", "3")
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	rr := doSignup(h, email, "supersecret-pw-123", "Free Tier")
	if rr.Code != http.StatusCreated {
		t.Fatalf("signup: %d %s", rr.Code, rr.Body.String())
	}
	var resp authResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	b, v := freeTierRows(t, h, resp.User.TenantID)
	if b == nil || *b != 3.5 || v == nil || *v != 3 {
		t.Fatalf("caps = %v / %v, want 3.5 / 3", b, v)
	}
}

// OAuth first-login shares applyFreeTierDefaults; exercise it directly, and
// prove "off" writes nothing and a re-apply never overwrites an owner's edit.
func TestW2S_ApplyFreeTierDefaults(t *testing.T) {
	h := newAuthTestHandler(t)
	ctx := context.Background()
	var tenantID string
	if err := h.srv.Pool.QueryRow(ctx, `INSERT INTO tenants (slug,name,tier,k8s_namespace) VALUES ('w2s-'||substr(md5(random()::text),1,8),'w2s','personal','lantern-t-w2s-'||substr(md5(random()::text),1,8)) RETURNING id`).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = h.srv.Pool.Exec(ctx, `DELETE FROM tenants WHERE id=$1`, tenantID) })

	t.Setenv("LANTERN_FREE_TIER_COST_USD_PER_DAY", "off")
	t.Setenv("LANTERN_FREE_TIER_MAX_VMS", "off")
	run := func() {
		tx, _ := h.srv.Pool.Begin(ctx)
		defer tx.Rollback(ctx) //nolint:errcheck
		if err := applyFreeTierDefaults(ctx, tx, tenantID); err != nil {
			t.Fatal(err)
		}
		_ = tx.Commit(ctx)
	}
	run()
	if b, v := freeTierRows(t, h, tenantID); b != nil || v != nil {
		t.Fatalf("off still wrote rows: %v %v", b, v)
	}
	t.Setenv("LANTERN_FREE_TIER_COST_USD_PER_DAY", "2")
	t.Setenv("LANTERN_FREE_TIER_MAX_VMS", "2")
	run()
	_, _ = h.srv.Pool.Exec(ctx, `UPDATE agent_budgets SET max_cost_usd_per_day=50 WHERE tenant_id=$1 AND agent_name='*'`, tenantID)
	run()
	if b, _ := freeTierRows(t, h, tenantID); b == nil || *b != 50 {
		t.Fatalf("re-apply clobbered an owner edit: %v", b)
	}
}

func TestW2S_VerifyGate(t *testing.T) {
	h := newAuthTestHandler(t)
	ctx := context.Background()
	mk := func(provider string, verified bool) (tenant, user string) {
		if err := h.srv.Pool.QueryRow(ctx, `INSERT INTO tenants (slug,name,tier,k8s_namespace) VALUES ('w2sv-'||substr(md5(random()::text),1,8),'w2s','personal','lantern-t-w2sv-'||substr(md5(random()::text),1,8)) RETURNING id`).Scan(&tenant); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = h.srv.Pool.Exec(ctx, `DELETE FROM tenants WHERE id=$1`, tenant) })
		q := `INSERT INTO users (tenant_id,email,display_name,auth_provider,auth_subject,email_verified_at) VALUES ($1,'w2sv-'||substr(md5(random()::text),1,8)||'@example.test','u',$2,gen_random_uuid()::text,` + map[bool]string{true: "now()", false: "NULL"}[verified] + `) RETURNING id`
		if err := h.srv.Pool.QueryRow(ctx, q, tenant, provider).Scan(&user); err != nil {
			t.Fatal(err)
		}
		return
	}
	call := func(tenant, user, role string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/runs", nil)
		req.Header.Set("Authorization", "Bearer "+mintTestToken(t, tenant, user, role))
		rr := httptest.NewRecorder()
		if h.requireVerifiedEmail(rr, req) {
			rr.WriteHeader(http.StatusNoContent)
		}
		return rr
	}
	code := func(rr *httptest.ResponseRecorder) string {
		var b map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &b)
		return b["code"]
	}
	ut, uu := mk("local", false)
	vt, vu := mk("local", true)
	ot, ou := mk("google", false)

	t.Setenv("LANTERN_ENV", "")
	if rr := call(ut, uu, "owner"); rr.Code != http.StatusNoContent {
		t.Fatalf("dev mode must not gate: %d", rr.Code)
	}
	t.Setenv("LANTERN_ENV", "production")
	if rr := call(ut, uu, "owner"); rr.Code != http.StatusForbidden || code(rr) != "email_unverified" {
		t.Fatalf("unverified in prod: %d %s", rr.Code, rr.Body.String())
	}
	if rr := call(ut, "00000000-0000-0000-0000-0000000000ff", "owner"); rr.Code != http.StatusForbidden {
		t.Fatalf("unknown user must fail closed: %d", rr.Code)
	}
	if rr := call(vt, vu, "owner"); rr.Code != http.StatusNoContent {
		t.Fatalf("verified user blocked: %d", rr.Code)
	}
	if rr := call(ot, ou, "owner"); rr.Code != http.StatusNoContent {
		t.Fatalf("oauth user blocked: %d", rr.Code)
	}
	if rr := call(vt, "svc", "service"); rr.Code != http.StatusNoContent {
		t.Fatalf("service key blocked: %d", rr.Code)
	}
}
