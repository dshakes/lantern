package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

// ---------- pure logic ----------

func baseGate(env string) gateInput {
	b := 0.9
	return gateInput{Env: env, VersionExists: true, PriorEnvOK: true, BudgetOK: true, BaselineScore: &b,
		Eval: &evalEvidence{Passed: true, Score: 0.95, CreatedAt: time.Now()}, Now: time.Now()}
}

func TestEvaluateGates(t *testing.T) {
	cases := []struct {
		name   string
		mut    func(*gateInput)
		env    string
		wantOK bool
		failed string
	}{
		{"all good", func(*gateInput) {}, "prod", true, ""},
		{"no eval", func(g *gateInput) { g.Eval = nil }, "staging", false, "eval"},
		{"stale eval", func(g *gateInput) { g.Eval.CreatedAt = time.Now().Add(-25 * time.Hour) }, "prod", false, "eval"},
		{"failed case", func(g *gateInput) { g.Eval.Passed = false }, "prod", false, "eval"},
		{"regressed vs env baseline", func(g *gateInput) { g.Eval.Score = 0.5 }, "prod", false, "eval"},
		{"no baseline is ok", func(g *gateInput) { g.BaselineScore = nil }, "prod", true, ""},
		{"budget", func(g *gateInput) { g.BudgetOK = false }, "prod", false, "budget"},
		{"order", func(g *gateInput) { g.PriorEnvOK = false }, "prod", false, "order"},
		{"missing version", func(g *gateInput) { g.VersionExists = false }, "sandbox", false, "version"},
		{"sandbox needs no eval", func(g *gateInput) { g.Eval = nil }, "sandbox", true, ""},
		{"sandbox run required", func(g *gateInput) { g.SandboxRunRequired = true }, "prod", false, "sandbox_run"},
		{"sandbox run ok", func(g *gateInput) { g.SandboxRunRequired, g.SandboxRunOK = true, true }, "prod", true, ""},
	}
	for _, c := range cases {
		in := baseGate(c.env)
		c.mut(&in)
		gs := evaluateGates(in)
		if gatesPass(gs) != c.wantOK {
			t.Errorf("%s: pass=%v want %v (%v)", c.name, gatesPass(gs), c.wantOK, gs)
		}
		if c.failed != "" && !strings.Contains(failedGates(gs), c.failed) {
			t.Errorf("%s: failed gates %q lacks %q", c.name, failedGates(gs), c.failed)
		}
	}
	if gatesPass(nil) {
		t.Error("empty gate list must not pass (fail closed)")
	}
}

func TestDecideCanary(t *testing.T) {
	g := canaryGuards{MaxErrorRate: 0.1, MaxCostRatio: 1.5, MinRuns: 20}
	ok := variantStats{Terminal: 30, Failed: 1, AvgCost: 0.01}
	stable := variantStats{Terminal: 100, Failed: 2, AvgCost: 0.01}
	cases := []struct {
		name string
		obs  canaryObservation
		want string
	}{
		{"healthy pass", canaryObservation{Candidate: ok, Stable: stable}, "pass"},
		{"too few runs holds", canaryObservation{Candidate: variantStats{Terminal: 8, AvgCost: 0.01}, Stable: stable}, "hold"},
		{"error rate trips early", canaryObservation{Candidate: variantStats{Terminal: 6, Failed: 4}, Stable: stable}, "trip"},
		{"one failure of two never trips", canaryObservation{Candidate: variantStats{Terminal: 2, Failed: 1}, Stable: stable}, "hold"},
		{"cost trips", canaryObservation{Candidate: variantStats{Terminal: 30, AvgCost: 0.05}, Stable: stable}, "trip"},
		{"failed eval trips", canaryObservation{Candidate: ok, Stable: stable, LatestEval: &evalEvidence{Passed: false}}, "trip"},
		{"eval floor trips", canaryObservation{Candidate: ok, Stable: stable, LatestEval: &evalEvidence{Passed: true, Score: 0.4}}, "trip"},
	}
	g.MinEvalScore = 0.8
	for _, c := range cases {
		if v := decideCanary(g, c.obs); v.Verdict != c.want {
			t.Errorf("%s: got %s (%v) want %s", c.name, v.Verdict, v.Reasons, c.want)
		}
	}
}

func TestCanaryBucketSplit(t *testing.T) {
	n := 0
	for i := 0; i < 2000; i++ {
		id := uuid.NewString()
		if canaryBucket(id, 20) != canaryBucket(id, 20) {
			t.Fatal("bucket not deterministic")
		}
		if canaryBucket(id, 20) {
			n++
		}
	}
	if n < 300 || n > 500 { // 20% of 2000 = 400
		t.Errorf("20%% split routed %d/2000", n)
	}
	if canaryBucket("x", 0) {
		t.Error("0% must route nothing")
	}
}

// ---------- DB-backed ----------

type promoFixture struct {
	t      *testing.T
	e      *enforcedServer
	h      *PromotionHandler
	mux    *http.ServeMux
	tenant string
	agent  string
	owner  string
	member string
	apikey string
}

func newPromoFixture(t *testing.T) *promoFixture {
	t.Helper()
	e := newEnforcedServer(t)
	auth := NewAuthHandler(e.srv, testJWTSecret)
	h := NewPromotionHandler(e.srv, auth)
	f := &promoFixture{t: t, e: e, h: h, mux: http.NewServeMux(), agent: "support-" + uuid.NewString()[:6]}
	f.tenant = seedEnforcedTenant(t, e, "promo-"+uuid.NewString()[:8])
	t.Cleanup(func() { // runs RESTRICT agent deletion; the audit trail is append-only except under erasure
		bg := context.Background()
		_, _ = e.superPool.Exec(bg, `DELETE FROM runs WHERE tenant_id=$1`, f.tenant)
		if tx, err := e.superPool.Begin(bg); err == nil {
			_, _ = tx.Exec(bg, `SELECT set_config('pal.erasure','on',true)`)
			_, _ = tx.Exec(bg, `DELETE FROM agent_promotion_audit WHERE tenant_id=$1`, f.tenant)
			_ = tx.Commit(bg)
		}
	})
	f.owner = mintTestToken(t, f.tenant, "owner1", "owner")
	f.member = mintTestToken(t, f.tenant, "member1", "member")
	f.apikey = mintTestToken(t, f.tenant, "key1", "service")
	f.mux.HandleFunc("POST /v1/agents/{name}/promote", h.Promote)
	f.mux.HandleFunc("POST /v1/agents/{name}/versions", h.CreateVersion)
	f.mux.HandleFunc("GET /v1/agents/{name}/environments", h.ListEnvironments)
	f.mux.HandleFunc("POST /v1/agents/{name}/environments/{env}/rollback", h.Rollback)
	f.mux.HandleFunc("POST /v1/agents/{name}/environments/prod/canary/evaluate", h.EvaluateCanaryHTTP)
	f.mux.HandleFunc("POST /v1/agents/{name}/environments/sandbox/runs", h.RecordSandboxRun)
	f.mux.HandleFunc("GET /v1/promotions", h.ListPromotions)
	f.mux.HandleFunc("GET /v1/promotions/audit", h.Audit)
	f.mux.HandleFunc("POST /v1/promotions/{id}/approve", h.Approve)
	f.mux.HandleFunc("POST /v1/promotions/{id}/reject", h.Reject)

	ctx := context.Background()
	var agentID string
	must(t, e.superPool.QueryRow(ctx, `INSERT INTO agents (tenant_id, name, system_prompt, model) VALUES ($1,$2,'p','auto') RETURNING id`,
		f.tenant, f.agent).Scan(&agentID))
	for _, v := range []string{"v1", "v2"} {
		var vid string
		must(t, e.superPool.QueryRow(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
			VALUES ($1,$2,decode(md5($3),'hex'),'local://t','{}'::jsonb) RETURNING id`, agentID, v, agentID+v).Scan(&vid))
		if v == "v1" {
			_, err := e.superPool.Exec(ctx, `UPDATE agents SET current_version_id=$1 WHERE id=$2`, vid, agentID)
			must(t, err)
		}
	}
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *promoFixture) call(method, path, token string, body any) (int, map[string]any) {
	f.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// evidence inserts a server-run (hermetic) eval row, the only kind a gate accepts.
func (f *promoFixture) evidence(version, source string, passed bool, score float64, age time.Duration) {
	f.t.Helper()
	ctx := context.Background()
	var suite string
	err := f.e.superPool.QueryRow(ctx, `SELECT id::text FROM eval_suites WHERE tenant_id=$1 AND agent_name=$2 LIMIT 1`, f.tenant, f.agent).Scan(&suite)
	if err != nil {
		must(f.t, f.e.superPool.QueryRow(ctx, `INSERT INTO eval_suites (tenant_id, agent_name, name, cases) VALUES ($1,$2,'s','[]'::jsonb) RETURNING id::text`,
			f.tenant, f.agent).Scan(&suite))
	}
	_, err = f.e.superPool.Exec(ctx, `INSERT INTO eval_runs (tenant_id, suite_id, agent_name, agent_version, passed, score, cases_total, cases_passed, source, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,1,1,$7, now() - $8::interval)`, f.tenant, suite, f.agent, version, passed, score, source, fmt.Sprintf("%d seconds", int(age.Seconds())))
	must(f.t, err)
}

func (f *promoFixture) promote(token, env, version string, extra map[string]any) (int, map[string]any) {
	body := map[string]any{"env": env, "version": version}
	for k, v := range extra {
		body[k] = v
	}
	return f.call("POST", "/v1/agents/"+f.agent+"/promote", token, body)
}

func (f *promoFixture) auditCount(action string) int {
	var n int
	must(f.t, f.e.superPool.QueryRow(context.Background(), `SELECT count(*) FROM agent_promotion_audit WHERE tenant_id=$1 AND agent_name=$2 AND action=$3`,
		f.tenant, f.agent, action).Scan(&n))
	return n
}

func promoID(out map[string]any) string {
	p, _ := out["promotion"].(map[string]any)
	id, _ := p["id"].(string)
	return id
}

func promoStatus(out map[string]any) string {
	p, _ := out["promotion"].(map[string]any)
	s, _ := p["status"].(string)
	return s
}

// ready walks v2 through sandbox + staging so only prod gates remain.
func (f *promoFixture) ready(version string) {
	f.t.Helper()
	f.evidence(version, "hermetic", true, 0.95, time.Minute)
	for _, env := range []string{"sandbox", "staging"} {
		if code, out := f.promote(f.owner, env, version, nil); code != 200 {
			f.t.Fatalf("promote %s: %d %v", env, code, out)
		}
	}
}

func (f *promoFixture) prodVersion() string {
	var v string
	must(f.t, f.e.superPool.QueryRow(context.Background(), `SELECT version FROM agent_environments WHERE tenant_id=$1 AND agent_name=$2 AND env='prod'`, f.tenant, f.agent).Scan(&v))
	return v
}

func (f *promoFixture) currentVersion() string {
	var v string
	must(f.t, f.e.superPool.QueryRow(context.Background(), `SELECT av.version FROM agents a JOIN agent_versions av ON av.id=a.current_version_id WHERE a.tenant_id=$1 AND a.name=$2`, f.tenant, f.agent).Scan(&v))
	return v
}

func TestPromotion_EvalGateBlocksAndOnlyServerEvidenceCounts(t *testing.T) {
	f := newPromoFixture(t)
	if code, _ := f.promote(f.owner, "sandbox", "v2", nil); code != 200 {
		t.Fatalf("sandbox promote: %d", code)
	}
	// No evidence at all.
	code, out := f.promote(f.owner, "staging", "v2", nil)
	if code != 422 || out["code"] != "gate_failed" {
		t.Fatalf("want 422 gate_failed, got %d %v", code, out)
	}
	// A client-recorded run claiming the same version is not evidence.
	f.evidence("v2", "client", true, 1, time.Minute)
	if code, _ = f.promote(f.owner, "staging", "v2", nil); code != 422 {
		t.Fatalf("client-source eval must not satisfy the gate, got %d", code)
	}
	// Stale hermetic evidence.
	f.evidence("v2", "hermetic", true, 0.95, 30*time.Hour)
	if code, _ = f.promote(f.owner, "staging", "v2", nil); code != 422 {
		t.Fatalf("stale eval must not satisfy the gate, got %d", code)
	}
	// Failing hermetic evidence newer than the stale pass.
	f.evidence("v2", "hermetic", false, 0.2, time.Minute)
	if code, _ = f.promote(f.owner, "staging", "v2", nil); code != 422 {
		t.Fatalf("failed eval must block, got %d", code)
	}
	if f.auditCount("promote_blocked") != 4 {
		t.Errorf("each blocked attempt must be audited, got %d", f.auditCount("promote_blocked"))
	}
	f.evidence("v2", "hermetic", true, 0.95, time.Second)
	if code, out = f.promote(f.owner, "staging", "v2", nil); code != 200 {
		t.Fatalf("passing eval should promote: %d %v", code, out)
	}
}

func TestPromotion_ProdNeedsHumanApprovalAndOrder(t *testing.T) {
	f := newPromoFixture(t)
	f.evidence("v2", "hermetic", true, 0.95, time.Minute)
	// Order: nothing is in sandbox/staging yet.
	if code, _ := f.promote(f.owner, "prod", "v2", nil); code != 422 {
		t.Fatalf("prod before sandbox must be blocked, got %d", code)
	}
	for _, env := range []string{"sandbox", "staging"} {
		if code, out := f.promote(f.owner, env, "v2", nil); code != 200 {
			t.Fatalf("%s: %d %v", env, code, out)
		}
	}
	// An agent principal proposes; nothing moves.
	code, out := f.promote(f.apikey, "prod", "v2", nil)
	if code != 202 || promoStatus(out) != "pending_approval" {
		t.Fatalf("agent proposal must be pending: %d %v", code, out)
	}
	id := promoID(out)
	if f.currentVersion() != "v1" {
		t.Fatal("proposal must not change the live version")
	}
	if code, _ = f.call("POST", "/v1/promotions/"+id+"/approve", f.apikey, nil); code != 403 {
		t.Fatalf("API key/agent must not approve, got %d", code)
	}
	if code, _ = f.call("POST", "/v1/promotions/"+id+"/approve", f.member, nil); code != 403 {
		t.Fatalf("non-admin member must not approve, got %d", code)
	}
	if code, _ = f.promote(f.owner, "prod", "v2", nil); code != 409 {
		t.Fatalf("second open prod promotion must conflict, got %d", code)
	}
	code, out = f.call("POST", "/v1/promotions/"+id+"/approve", f.owner, map[string]any{"note": "ok"})
	if code != 200 || promoStatus(out) != "promoted" {
		t.Fatalf("owner approval should promote: %d %v", code, out)
	}
	if p := out["promotion"].(map[string]any); p["approver"] != "owner1@test.example" {
		t.Errorf("approver not recorded: %v", p["approver"])
	}
	if f.currentVersion() != "v2" || f.prodVersion() != "v2" {
		t.Errorf("prod not switched: current=%s env=%s", f.currentVersion(), f.prodVersion())
	}
	// Replay is idempotent: still 200, one 'approved' row.
	if code, _ = f.call("POST", "/v1/promotions/"+id+"/approve", f.owner, nil); code != 200 {
		t.Fatalf("approve replay: %d", code)
	}
	if f.auditCount("approved") != 1 || f.auditCount("promoted") < 1 {
		t.Errorf("audit counts: approved=%d", f.auditCount("approved"))
	}
}

func TestPromotion_ApprovalRerunsGates(t *testing.T) {
	f := newPromoFixture(t)
	f.ready("v2")
	_, out := f.promote(f.apikey, "prod", "v2", nil)
	id := promoID(out)
	// Evidence goes stale between proposal and approval.
	_, err := f.e.superPool.Exec(context.Background(), `UPDATE eval_runs SET created_at = now() - interval '48 hours' WHERE tenant_id=$1`, f.tenant)
	must(t, err)
	code, out := f.call("POST", "/v1/promotions/"+id+"/approve", f.owner, nil)
	if code != 422 {
		t.Fatalf("approval must re-check gates: %d %v", code, out)
	}
	if f.currentVersion() != "v1" {
		t.Fatal("blocked approval changed live version")
	}
	if f.auditCount("approve_blocked") != 1 {
		t.Error("blocked approval not audited")
	}
	if code, _ = f.call("POST", "/v1/promotions/"+id+"/reject", f.owner, map[string]any{"note": "stale"}); code != 200 {
		t.Fatalf("reject: %d", code)
	}
}

func (f *promoFixture) runs(version string, ok, failed int, cost float64) {
	f.t.Helper()
	ctx := context.Background()
	var agentID, vid string
	must(f.t, f.e.superPool.QueryRow(ctx, `SELECT a.id::text, av.id::text FROM agents a JOIN agent_versions av ON av.agent_id=a.id WHERE a.tenant_id=$1 AND a.name=$2 AND av.version=$3`,
		f.tenant, f.agent, version).Scan(&agentID, &vid))
	for i := 0; i < ok+failed; i++ {
		st := "succeeded"
		if i < failed {
			st = "failed"
		}
		_, err := f.e.superPool.Exec(ctx, `INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, cost_usd)
			VALUES ($1,$2,$3,$4,'api','{}'::jsonb,$5)`, f.tenant, agentID, vid, st, cost)
		must(f.t, err)
	}
}

func (f *promoFixture) startCanary() string {
	f.t.Helper()
	f.ready("v2")
	// Baseline run history for the stable side.
	f.runs("v1", 10, 0, 0.01)
	_, out := f.promote(f.apikey, "prod", "v2", map[string]any{"canaryPct": 25, "guards": map[string]any{"minRuns": 10}})
	id := promoID(out)
	if code, out := f.call("POST", "/v1/promotions/"+id+"/approve", f.owner, nil); code != 200 || promoStatus(out) != "canary" {
		f.t.Fatalf("canary start: %d %v", code, out)
	}
	return id
}

func TestPromotion_CanaryRoutesAndGuardTripRollsBack(t *testing.T) {
	f := newPromoFixture(t)
	id := f.startCanary()
	if f.currentVersion() != "v1" || f.prodVersion() != "v1" {
		t.Fatal("canary must leave the stable version serving")
	}
	// Routing: run ids split deterministically, ~25% to v2, labels set.
	ctx := middleware.InjectTenantID(context.Background(), f.tenant)
	var agentID, v1ID string
	must(t, f.e.superPool.QueryRow(context.Background(), `SELECT a.id::text, a.current_version_id::text FROM agents a WHERE a.tenant_id=$1 AND a.name=$2`, f.tenant, f.agent).Scan(&agentID, &v1ID))
	canary := 0
	for i := 0; i < 400; i++ {
		rid := uuid.NewString()
		var got string
		var labels map[string]string
		must(t, f.e.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			got, labels = pickPromotedVersion(ctx, tx, f.tenant, agentID, f.agent, rid, v1ID)
			return nil
		}))
		if labels["pal.variant"] == "canary" {
			canary++
			if got == v1ID {
				t.Fatal("canary run resolved to the stable version")
			}
		}
	}
	if canary < 60 || canary > 140 {
		t.Errorf("25%% canary routed %d/400", canary)
	}

	// Healthy so far: hold, nothing happens.
	code, out := f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/canary/evaluate", f.apikey, nil)
	if code != 200 || out["action"] != "none" {
		t.Fatalf("expected hold: %d %v", code, out)
	}
	// The canary starts failing: guard trips and rolls back with no human involved.
	f.runs("v2", 4, 6, 0.01)
	code, out = f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/canary/evaluate", f.apikey, nil)
	if code != 200 || out["action"] != "rolled_back" {
		t.Fatalf("expected auto rollback: %d %v", code, out)
	}
	var envStatus, expStatus, promoSt string
	must(t, f.e.superPool.QueryRow(context.Background(), `SELECT e.status, x.status FROM agent_environments e JOIN agent_experiments x ON x.name = 'canary-'||substr($3,1,8) AND x.tenant_id=e.tenant_id
		WHERE e.tenant_id=$1 AND e.agent_name=$2 AND e.env='prod'`, f.tenant, f.agent, id).Scan(&envStatus, &expStatus))
	must(t, f.e.superPool.QueryRow(context.Background(), `SELECT status FROM agent_promotions WHERE id::text=$1`, id).Scan(&promoSt))
	if envStatus != "active" || expStatus != "concluded" || promoSt != "rolled_back" {
		t.Errorf("post-trip state env=%s exp=%s promo=%s", envStatus, expStatus, promoSt)
	}
	if f.prodVersion() != "v1" || f.currentVersion() != "v1" {
		t.Error("stable version must still serve after rollback")
	}
	// New runs no longer split.
	must(t, f.e.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		for i := 0; i < 50; i++ {
			if _, l := pickPromotedVersion(ctx, tx, f.tenant, agentID, f.agent, uuid.NewString(), v1ID); l["pal.variant"] == "canary" {
				t.Fatal("canary still routing after rollback")
			}
		}
		return nil
	}))
	if f.auditCount("rolled_back") != 1 {
		t.Errorf("rolled_back audit rows = %d", f.auditCount("rolled_back"))
	}
	// Idempotent: explicit rollback after the auto rollback is a no-op and writes nothing.
	code, out = f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/rollback", f.owner, nil)
	if code != 200 || out["alreadyRolledBack"] != true {
		t.Fatalf("rollback replay: %d %v", code, out)
	}
	if f.auditCount("rolled_back") != 1 {
		t.Error("idempotent rollback wrote a second audit row")
	}
}

func TestPromotion_CanaryPassCompletesRollout(t *testing.T) {
	f := newPromoFixture(t)
	f.startCanary()
	f.runs("v2", 12, 0, 0.01)
	code, out := f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/canary/evaluate", f.apikey, nil)
	if code != 200 || out["action"] != "completed" {
		t.Fatalf("expected completion: %d %v", code, out)
	}
	if f.prodVersion() != "v2" || f.currentVersion() != "v2" {
		t.Errorf("rollout incomplete: env=%s current=%s", f.prodVersion(), f.currentVersion())
	}
	if f.auditCount("canary_passed") != 1 {
		t.Error("canary_passed not audited")
	}
}

func TestPromotion_RollbackRevertsAndIsConcurrencySafe(t *testing.T) {
	f := newPromoFixture(t)
	f.ready("v2")
	_, out := f.promote(f.apikey, "prod", "v2", nil)
	f.call("POST", "/v1/promotions/"+promoID(out)+"/approve", f.owner, nil)
	if f.currentVersion() != "v2" {
		t.Fatal("setup: v2 not live")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _ := f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/rollback", f.apikey, map[string]any{"note": "bad"})
			codes <- c
		}()
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != 200 {
			t.Errorf("concurrent rollback returned %d", c)
		}
	}
	if f.prodVersion() != "v1" || f.currentVersion() != "v1" {
		t.Errorf("not reverted: env=%s current=%s", f.prodVersion(), f.currentVersion())
	}
	if n := f.auditCount("rolled_back"); n != 1 {
		t.Errorf("8 concurrent rollbacks wrote %d audit rows, want exactly 1", n)
	}
}

func TestPromotion_AuditIsAppendOnlyAndTenantScoped(t *testing.T) {
	f := newPromoFixture(t)
	f.promote(f.owner, "sandbox", "v2", nil)
	ctx := context.Background()
	if _, err := f.e.superPool.Exec(ctx, `UPDATE agent_promotion_audit SET actor='x' WHERE tenant_id=$1`, f.tenant); err == nil {
		t.Error("audit UPDATE must be refused")
	}
	if _, err := f.e.superPool.Exec(ctx, `DELETE FROM agent_promotion_audit WHERE tenant_id=$1`, f.tenant); err == nil {
		t.Error("audit DELETE must be refused")
	}
	// Another tenant sees none of it and cannot approve our promotion.
	other := seedEnforcedTenant(t, f.e, "promo-b-"+uuid.NewString()[:8])
	tok := mintTestToken(t, other, "ob", "owner")
	code, _ := f.call("GET", "/v1/promotions/audit?agentName="+f.agent, tok, nil)
	if code != 200 {
		t.Fatalf("audit list: %d", code)
	}
	req := httptest.NewRequest("GET", "/v1/promotions/audit?agentName="+f.agent, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("cross-tenant audit leak: %s", rec.Body.String())
	}
	f.evidence("v2", "hermetic", true, 0.9, time.Minute)
	f.promote(f.owner, "staging", "v2", nil)
	_, out := f.promote(f.owner, "prod", "v2", nil)
	if code, _ := f.call("POST", "/v1/promotions/"+promoID(out)+"/approve", tok, nil); code != 404 {
		t.Errorf("cross-tenant approve must be 404, got %d", code)
	}
}

func TestPromotion_SandboxEvidenceRequiresOwnVM(t *testing.T) {
	f := newPromoFixture(t)
	f.promote(f.owner, "sandbox", "v2", nil)
	vm := "vm-" + uuid.NewString()[:8]
	path := "/v1/agents/" + f.agent + "/environments/sandbox/runs"
	if code, _ := f.call("POST", path, f.owner, map[string]any{"version": "v2", "vmId": vm, "ok": true}); code != 404 {
		t.Fatalf("unknown VM must be refused, got %d", code)
	}
	_, err := f.e.superPool.Exec(context.Background(), `INSERT INTO runtime_vms (vm_id, tenant_id, state) VALUES ($1,$2,'terminated')`, vm, f.tenant)
	if err != nil {
		t.Skipf("runtime_vms shape differs: %v", err)
	}
	if code, out := f.call("POST", path, f.owner, map[string]any{"version": "v2", "vmId": vm, "ok": true, "exitCode": 0}); code != 200 {
		t.Fatalf("record: %d %v", code, out)
	}
	if code, _ := f.call("POST", path, f.owner, map[string]any{"version": "v1", "vmId": vm, "ok": true}); code != 409 {
		t.Errorf("evidence for a version the sandbox does not serve must conflict, got %d", code)
	}
}

// The real RunService.CreateRun path: before any environment exists runs use the
// legacy current version; during a canary a stable fraction lands on the candidate
// and is labelled; a rolled-back canary stops splitting.
func TestPromotion_CreateRunHonoursEnvironments(t *testing.T) {
	f := newPromoFixture(t)
	rs := NewRunService(f.e.srv)
	ctx := injectTenant(context.Background(), f.tenant)
	dist := func(n int) map[string]int {
		out := map[string]int{}
		for i := 0; i < n; i++ {
			run, err := rs.CreateRun(ctx, &palv1.CreateRunRequest{AgentName: f.agent})
			if err != nil {
				t.Fatalf("CreateRun: %v", err)
			}
			var v, variant string
			must(t, f.e.superPool.QueryRow(context.Background(), `SELECT av.version, COALESCE(r.labels->>'pal.variant','') FROM runs r
				JOIN agent_versions av ON av.id=r.agent_version_id WHERE r.id::text=$1`, run.GetId()).Scan(&v, &variant))
			out[v+"/"+variant]++
		}
		return out
	}
	if d := dist(5); d["v1/"] != 5 {
		t.Fatalf("legacy agents must be untouched: %v", d)
	}
	f.startCanary()
	d := dist(120)
	if d["v2/canary"] < 10 || d["v2/canary"] > 60 || d["v1/stable"]+d["v2/canary"] != 120 {
		t.Fatalf("25%% canary distribution off: %v", d)
	}
	f.runs("v2", 0, 10, 0.01)
	f.call("POST", "/v1/agents/"+f.agent+"/environments/prod/canary/evaluate", f.apikey, nil)
	if d := dist(40); d["v2/canary"] != 0 || d["v1/stable"] != 40 {
		t.Fatalf("after rollback all runs must be stable: %v", d)
	}
}

func TestPromotion_FreezeIsContentAddressedAndIdempotent(t *testing.T) {
	f := newPromoFixture(t)
	path := "/v1/agents/" + f.agent + "/versions"
	code, out := f.call("POST", path, f.owner, map[string]any{"label": "fz1"})
	if code != 201 || out["version"] != "fz1" {
		t.Fatalf("first freeze: %d %v", code, out)
	}
	// Same content again (any label): returns the existing version, creates nothing.
	code, out = f.call("POST", path, f.owner, map[string]any{"label": "other"})
	if code != 200 || out["version"] != "fz1" || out["created"] != false {
		t.Fatalf("identical content must be idempotent: %d %v", code, out)
	}
	// Changed draft + a label already used by different content -> conflict.
	_, err := f.e.superPool.Exec(context.Background(), `UPDATE agents SET system_prompt='changed' WHERE tenant_id=$1 AND name=$2`, f.tenant, f.agent)
	must(t, err)
	if code, _ = f.call("POST", path, f.owner, map[string]any{"label": "fz1"}); code != 409 {
		t.Fatalf("label reuse with new content must conflict, got %d", code)
	}
	code, out = f.call("POST", path, f.owner, nil)
	if code != 201 || out["version"] == "fz1" {
		t.Fatalf("auto label for changed content: %d %v", code, out)
	}
	if code, _ = f.call("POST", path, f.owner, map[string]any{"label": "bad label!"}); code != 400 {
		t.Fatalf("bad label must be 400, got %d", code)
	}
	// Freezing never moves traffic.
	if f.currentVersion() != "v1" {
		t.Fatal("freeze changed the serving version")
	}
}
