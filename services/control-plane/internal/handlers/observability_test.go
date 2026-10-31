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

	"github.com/dshakes/pal/services/control-plane/internal/obs"
)

// Secret-shaped fixtures are built at runtime (no literal credential in the repo).
var obsFakeKey = "sk" + "-ant-api03-" + "ZZZZZZZZZZZZZZZZ"

type obsFixture struct {
	t    *testing.T
	e    *enforcedServer
	h    *ObsHandler
	ten  string
	tokA string
	mu   sync.Mutex
	// summaryMode: "grounded" cites a real run, "hallucinated" cites a made-up id.
	summaryMode string
	rb          []RollbackSuggestion
}

func (f *obsFixture) SuggestRollback(_ context.Context, _ string, s RollbackSuggestion) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rb = append(f.rb, s)
	return nil
}

func newObsFixture(t *testing.T) *obsFixture {
	t.Helper()
	e := newEnforcedServer(t)
	f := &obsFixture{t: t, e: e, summaryMode: "grounded"}
	f.h = NewObsHandler(e.srv, NewAuthHandler(e.srv, testJWTSecret))
	f.h.complete = f.complete
	f.h.SetRollbackSink(f)
	f.ten = seedEnforcedTenant(t, e, "obs-"+uuid.NewString()[:8])
	f.tokA = mintTestToken(t, f.ten, "u-a", "owner")
	return f
}

func (f *obsFixture) complete(ctx context.Context, _, _ string, msgs, _ []map[string]any, _ toolDispatchFn) (evalCompletion, error) {
	sys, _ := msgs[0]["content"].(string)
	user, _ := msgs[1]["content"].(string)
	switch sys {
	case judgeSystemPrompt:
		nonce := between(user, `{"nonce":"`, `"`)
		cand := between(user, "<untrusted_candidate_"+nonce+">", "</untrusted")
		score := "1"
		if strings.Contains(cand, "GOOD") {
			score = "5"
		}
		return evalCompletion{Text: `{"nonce":"` + nonce + `","score":` + score + `,"rationale":"judged"}`, Model: "judge-model", CostUsd: 0.01}, nil
	default: // incident summary
		id := between(user, "using ONLY these ids: ", ",")
		if i := strings.Index(id, "\n"); i >= 0 {
			id = id[:i]
		}
		if f.summaryMode == "hallucinated" {
			id = uuid.NewString()
		}
		return evalCompletion{Text: "Cost regressed after the new version shipped [run:" + strings.TrimSpace(id) + "].", Model: "sum-model", CostUsd: 0.001}, nil
	}
}

func (f *obsFixture) tenant(slug string) (string, string) {
	id := seedEnforcedTenant(f.t, f.e, slug+"-"+uuid.NewString()[:8])
	return id, mintTestToken(f.t, id, "u-"+slug, "owner")
}

func (f *obsFixture) agent(tenant, name string, versions ...string) (agentID string, vids map[string]string) {
	f.t.Helper()
	ctx := context.Background()
	if err := f.e.superPool.QueryRow(ctx, `INSERT INTO agents (tenant_id, name) VALUES ($1,$2) RETURNING id`, tenant, name).Scan(&agentID); err != nil {
		f.t.Fatalf("agent: %v", err)
	}
	vids = map[string]string{}
	for _, v := range versions {
		var vid string
		if err := f.e.superPool.QueryRow(ctx, `INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
			VALUES ($1,$2,$3,'s3://x','{}'::jsonb) RETURNING id`, agentID, v, []byte(uuid.NewString())).Scan(&vid); err != nil {
			f.t.Fatalf("version: %v", err)
		}
		vids[v] = vid
	}
	return agentID, vids
}

type obsRunSeed struct {
	agent, version, status, parent, output string
	cost                                   float64
	age                                    time.Duration // created this long ago
	dur                                    time.Duration
}

func (f *obsFixture) run(tenant string, s obsRunSeed) string {
	f.t.Helper()
	if s.dur == 0 {
		s.dur = time.Second
	}
	if s.output == "" {
		s.output = `{"result":"ok"}`
	}
	created := time.Now().Add(-s.age)
	var parent any
	if s.parent != "" {
		parent = s.parent
	}
	var id string
	err := f.e.superPool.QueryRow(context.Background(), `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, output, cost_usd, created_at, started_at, finished_at, parent_run_id)
		VALUES ($1,$2,$3,$4,'api','{"prompt":"hi"}'::jsonb,$5::jsonb,$6,$7,$7,$8,$9) RETURNING id`,
		tenant, s.agent, s.version, s.status, s.output, s.cost, created, created.Add(s.dur), parent).Scan(&id)
	if err != nil {
		f.t.Fatalf("run: %v", err)
	}
	f.t.Cleanup(func() {
		_, _ = f.e.superPool.Exec(context.Background(), `DELETE FROM journal_events WHERE run_id=$1`, id)
	})
	return id
}

func (f *obsFixture) journal(runID string, seq int64, kind, step string, payload map[string]any, at time.Time) {
	f.t.Helper()
	b, _ := json.Marshal(payload)
	if _, err := f.e.superPool.Exec(context.Background(), `INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload, created_at)
		VALUES ($1,$2,$3,$4,1,$5,$6)`, runID, seq, kind, step, b, at); err != nil {
		f.t.Fatalf("journal: %v", err)
	}
}

func (f *obsFixture) do(h http.HandlerFunc, method, path, tok string, body any, pv map[string]string) *httptest.ResponseRecorder {
	f.t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	for k, v := range pv {
		req.SetPathValue(k, v)
	}
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h(rr, req)
	return rr
}

// ---------------------------------------------------------------- trace tree

func TestObsTrace_TreeRedactionAndCrossTenant404(t *testing.T) {
	f := newObsFixture(t)
	agent, vers := f.agent(f.ten, "trace-agent", "v1")
	parent := f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: "failed", cost: 0.02, dur: 3 * time.Second, age: time.Minute})
	child := f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: "succeeded", parent: parent, age: time.Minute})
	t0 := time.Now().Add(-time.Minute)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	f.journal(parent, 1, "step_started", "plan", map[string]any{"name": "Plan", "type": "ai-step"}, at(10))
	f.journal(parent, 2, "step_completed", "plan", map[string]any{"output": "done", "tokens_in": 100, "tokens_out": 20, "cost_usd": 0.01, "model": "m", "provider": "p"}, at(510))
	f.journal(parent, 3, "step_started", "fetch", map[string]any{"name": "Fetch", "type": "tool"}, at(520))
	f.journal(parent, 5, "step_retrying", "fetch", map[string]any{"attempt": 2, "error": "timeout"}, at(800))
	f.journal(parent, 6, "step_failed", "fetch", map[string]any{"error": "boom " + obsFakeKey, "tool": "http", "args": map[string]any{"url": "https://x.test", "api_key": obsFakeKey, "note": "Bearer abcdefgh12345678"}}, at(1000))
	f.journal(parent, 7, "step_started", "sub", map[string]any{"name": "Sub", "type": "subagent"}, at(1100))

	rr := f.do(f.h.GetRunTrace, "GET", "/v1/runs/"+parent+"/trace", f.tokA, nil, map[string]string{"id": parent})
	if rr.Code != 200 {
		t.Fatalf("trace: %d %s", rr.Code, rr.Body)
	}
	body := rr.Body.String()
	if strings.Contains(body, obsFakeKey) || strings.Contains(body, "abcdefgh12345678") {
		t.Fatalf("SECRET LEAKED IN TRACE: %s", body)
	}
	var tr obs.Trace
	if err := json.Unmarshal(rr.Body.Bytes(), &tr); err != nil {
		t.Fatal(err)
	}
	if len(tr.Steps) != 3 || tr.Steps[0].LLM == nil || tr.Steps[0].LLM.LatencyMs != 500 || tr.Steps[0].LLM.Model != "m" {
		t.Fatalf("llm step: %s", body)
	}
	fetch := tr.Steps[1]
	if fetch.Tool == nil || fetch.Tool.Name != "http" || len(fetch.Retries) != 1 || fetch.Status != "failed" {
		t.Fatalf("tool step: %+v", fetch)
	}
	if tr.Steps[2].ChildRun == nil || tr.Steps[2].ChildRun.RunID != child {
		t.Fatalf("child run not nested under the subagent step: %s", body)
	}

	// Cross-tenant: tenant B asking for tenant A's run (and its child) is a 404, identical to a missing run.
	_, tokB := f.tenant("other")
	for _, id := range []string{parent, child, uuid.NewString(), "not-a-uuid"} {
		rr := f.do(f.h.GetRunTrace, "GET", "/v1/runs/"+id+"/trace", tokB, nil, map[string]string{"id": id})
		if rr.Code != 404 {
			t.Fatalf("cross-tenant/missing %s: want 404 got %d %s", id, rr.Code, rr.Body)
		}
	}
	if rr := f.do(f.h.GetRunTrace, "GET", "/x", "garbage", nil, map[string]string{"id": parent}); rr.Code != 401 {
		t.Fatalf("unauth: %d", rr.Code)
	}
}

// ----------------------------------------------------------------- incidents

func (f *obsFixture) seedCostRegression(agentName string) (agent string, bad []string) {
	agent, vers := f.agent(f.ten, agentName, "v1", "v2")
	for i := 0; i < 30; i++ { // healthy baseline: v1, ~$0.01, 1-3 days ago
		f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: "succeeded", cost: 0.01 + float64(i%5)*0.0001, age: 24*time.Hour + time.Duration(i)*time.Hour})
	}
	for i := 0; i < 6; i++ { // regression: v2 at 5x cost in the last hour
		bad = append(bad, f.run(f.ten, obsRunSeed{agent: agent, version: vers["v2"], status: "succeeded", cost: 0.05, age: time.Duration(i+1) * 5 * time.Minute}))
	}
	return agent, bad
}

func TestObsIncident_OpensDedupsAuditsAndGroundsSummary(t *testing.T) {
	f := newObsFixture(t)
	_, bad := f.seedCostRegression("regress-agent")

	opened, _ := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten)
	if opened != 1 {
		t.Fatalf("want exactly one cost incident, opened=%d", opened)
	}
	if again, _ := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten); again != 0 {
		t.Fatalf("a live incident must absorb repeat detections, opened=%d", again)
	}

	rr := f.do(f.h.ListIncidents, "GET", "/v1/incidents?status=active", f.tokA, nil, nil)
	var list struct{ Incidents []incidentDTO }
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list.Incidents) != 1 {
		t.Fatalf("list: %s", rr.Body)
	}
	inc := list.Incidents[0]
	if inc.Kind != "anomaly:cost" || inc.FirstBadVersion != "v2" || inc.LastGoodVersion != "v1" || len(inc.AffectedRunIDs) != 6 {
		t.Fatalf("incident facts: %+v", inc)
	}
	for _, id := range inc.AffectedRunIDs {
		found := false
		for _, b := range bad {
			found = found || b == id
		}
		if !found {
			t.Fatalf("affected run %s is not one of the regressed runs", id)
		}
	}
	if !inc.Rollback.Suggested || inc.Rollback.ToVersion != "v1" || inc.Rollback.FromVersion != "v2" {
		t.Fatalf("rollback interface: %+v", inc.Rollback)
	}
	if len(f.rb) != 1 {
		t.Fatalf("rollback sink must be called exactly once, got %d", len(f.rb))
	}
	if inc.SummarySource != "model" || !strings.Contains(inc.Summary, "[run:") {
		t.Fatalf("grounded model summary should have been accepted: %+v", inc)
	}

	// Cross-tenant detail/ack/resolve are 404.
	_, tokB := f.tenant("other")
	for _, c := range []struct {
		h    http.HandlerFunc
		name string
	}{{f.h.GetIncident, "get"}, {f.h.Acknowledge, "ack"}, {f.h.Resolve, "resolve"}} {
		if rr := f.do(c.h, "POST", "/x", tokB, nil, map[string]string{"id": inc.ID}); rr.Code != 404 {
			t.Fatalf("cross-tenant %s: want 404 got %d", c.name, rr.Code)
		}
	}

	// acknowledge → audited; repeat is 409; resolve → audited; resolved can't re-ack.
	if rr := f.do(f.h.Acknowledge, "POST", "/x", f.tokA, map[string]string{"note": "looking"}, map[string]string{"id": inc.ID}); rr.Code != 200 {
		t.Fatalf("ack: %d %s", rr.Code, rr.Body)
	}
	if rr := f.do(f.h.Acknowledge, "POST", "/x", f.tokA, nil, map[string]string{"id": inc.ID}); rr.Code != 409 {
		t.Fatalf("double ack: want 409 got %d", rr.Code)
	}
	if rr := f.do(f.h.Resolve, "POST", "/x", f.tokA, map[string]string{"note": "rolled back"}, map[string]string{"id": inc.ID}); rr.Code != 200 {
		t.Fatalf("resolve: %d %s", rr.Code, rr.Body)
	}
	if rr := f.do(f.h.Acknowledge, "POST", "/x", f.tokA, nil, map[string]string{"id": inc.ID}); rr.Code != 409 {
		t.Fatalf("ack after resolve: want 409 got %d", rr.Code)
	}
	rr = f.do(f.h.GetIncident, "GET", "/x", f.tokA, nil, map[string]string{"id": inc.ID})
	var det incidentDTO
	_ = json.Unmarshal(rr.Body.Bytes(), &det)
	var actions []string
	for _, ev := range det.Timeline {
		actions = append(actions, ev.Action+":"+ev.Actor)
	}
	want := "opened:system,acknowledged:u-a,resolved:u-a"
	if got := strings.Join(actions, ","); !strings.HasPrefix(got, "opened:system") || !strings.Contains(got, "acknowledged:") || !strings.HasSuffix(got, "resolved:"+det.ResolvedBy) || len(det.Timeline) != 3 {
		t.Fatalf("audit timeline = %q (shape %q)", got, want)
	}
	if det.Status != "resolved" || det.ResolvedBy == "" || det.AcknowledgedBy == "" {
		t.Fatalf("final state: %+v", det)
	}
}

func TestObsIncident_HallucinatedSummaryRejected(t *testing.T) {
	f := newObsFixture(t)
	f.summaryMode = "hallucinated"
	f.seedCostRegression("halluc-agent")
	f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten)
	rr := f.do(f.h.ListIncidents, "GET", "/v1/incidents", f.tokA, nil, nil)
	var list struct{ Incidents []incidentDTO }
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list.Incidents) != 1 || list.Incidents[0].SummarySource != "deterministic" {
		t.Fatalf("a summary citing a run outside the incident must be rejected: %s", rr.Body)
	}
}

func TestObsIncident_QuietTrafficOpensNothing(t *testing.T) {
	f := newObsFixture(t)
	agent, vers := f.agent(f.ten, "quiet-agent", "v1")
	for i := 0; i < 40; i++ {
		f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: "succeeded", cost: 0.01, age: time.Duration(i+1) * 20 * time.Minute})
	}
	if n, _ := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten); n != 0 {
		t.Fatalf("false positive on steady traffic: %d incidents", n)
	}
}

func TestGroundedSummary(t *testing.T) {
	a, b := uuid.NewString(), uuid.NewString()
	if _, ok := groundedSummary("Cost rose [run:"+a+"].", []string{a, b}); !ok {
		t.Fatal("valid citation rejected")
	}
	for name, txt := range map[string]string{
		"no citation":      "Cost rose.",
		"foreign citation": "Cost rose [run:" + uuid.NewString() + "].",
		"bare foreign id":  "Cost rose [run:" + a + "] see " + uuid.NewString(),
		"empty":            "",
	} {
		if _, ok := groundedSummary(txt, []string{a, b}); ok {
			t.Fatalf("%s accepted", name)
		}
	}
}

// ----------------------------------------------------------------------- SLO

func TestObsSLO_ConfigStatusAndBurnIncident(t *testing.T) {
	f := newObsFixture(t)
	agent, vers := f.agent(f.ten, "slo-agent", "v1")
	// 40 runs, one per minute for the last 40 min; 3 of every 4 fail → ~75% failures.
	for i := 0; i < 40; i++ {
		st := "failed"
		if i%4 == 0 {
			st = "succeeded"
		}
		f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: st, age: time.Duration(i+1) * time.Minute})
	}
	if rr := f.do(f.h.PutSLO, "PUT", "/x", f.tokA, map[string]any{"objective": 1.5, "windowDays": 28}, map[string]string{"name": "slo-agent"}); rr.Code != 400 {
		t.Fatalf("invalid objective accepted: %d", rr.Code)
	}
	if rr := f.do(f.h.PutSLO, "PUT", "/x", f.tokA, map[string]any{"objective": 0.95, "windowDays": 28, "latencyMs": 5000}, map[string]string{"name": "no-such-agent"}); rr.Code != 404 {
		t.Fatalf("slo for missing agent: %d", rr.Code)
	}
	if rr := f.do(f.h.PutSLO, "PUT", "/x", f.tokA, map[string]any{"objective": 0.95, "windowDays": 28, "latencyMs": 5000}, map[string]string{"name": "slo-agent"}); rr.Code != 200 {
		t.Fatalf("put slo: %d %s", rr.Code, rr.Body)
	}
	rr := f.do(f.h.GetSLOStatus, "GET", "/x", f.tokA, nil, map[string]string{"name": "slo-agent"})
	var st struct {
		Configured bool
		SLIs       []sliStatus `json:"slis"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &st)
	if !st.Configured || len(st.SLIs) != 2 || st.SLIs[0].Name != "success" {
		t.Fatalf("status: %s", rr.Body)
	}
	s := st.SLIs[0]
	if s.Total != 40 || s.Good != 10 || s.BudgetRemaining >= 0 || len(s.Alerts) == 0 || s.Alerts[0].Severity != "page" {
		t.Fatalf("success SLI should be exhausted and paging: %+v", s)
	}
	f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten)
	var kind string
	if err := f.e.superPool.QueryRow(context.Background(), `SELECT kind FROM agent_incidents WHERE tenant_id=$1 AND kind='slo:success'`, f.ten).Scan(&kind); err != nil {
		t.Fatalf("burn-rate page did not open an slo:success incident: %v", err)
	}
}

// --------------------------------------------------------- production evals

func TestObsProdEvals_SamplingBudgetAndDrift(t *testing.T) {
	f := newObsFixture(t)
	agent, vers := f.agent(f.ten, "pe-agent", "v1", "v2")
	mk := func(ver string, good bool, age time.Duration) {
		out := `{"result":"bad answer"}`
		if good {
			out = `{"result":"GOOD answer"}`
		}
		f.run(f.ten, obsRunSeed{agent: agent, version: vers[ver], status: "succeeded", output: out, age: age})
	}
	for i := 0; i < 12; i++ {
		mk("v1", true, time.Duration(i+10)*time.Minute)
	}
	for i := 0; i < 12; i++ {
		mk("v2", false, time.Duration(i+1)*time.Minute)
	}
	// Opt-in: nothing is scored until enabled.
	if _, n := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten); n != 0 {
		t.Fatalf("scored %d runs without opt-in", n)
	}
	cfg := map[string]any{"enabled": true, "sampleRate": 1, "dailyBudgetUsd": 0.05}
	if rr := f.do(f.h.PutProdEvals, "PUT", "/x", f.tokA, map[string]any{"enabled": true, "sampleRate": 3}, map[string]string{"name": "pe-agent"}); rr.Code != 400 {
		t.Fatalf("bad sampleRate accepted: %d", rr.Code)
	}
	if rr := f.do(f.h.PutProdEvals, "PUT", "/x", f.tokA, cfg, map[string]string{"name": "pe-agent"}); rr.Code != 200 {
		t.Fatalf("put cfg: %d %s", rr.Code, rr.Body)
	}
	// Budget 0.05 at $0.01 per judge call → the cap stops sampling after ~5 even at rate 1.0.
	_, n := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten)
	if n < 5 || n > 6 {
		t.Fatalf("daily budget must cap judge spend: scored %d runs (want 5-6 at $0.01 each under $0.05)", n)
	}
	var spent float64
	_ = f.e.superPool.QueryRow(context.Background(), `SELECT COALESCE(SUM(cost_usd),0)::float8 FROM prod_eval_scores WHERE tenant_id=$1`, f.ten).Scan(&spent)
	if spent > 0.0601 {
		t.Fatalf("spent %.4f over the 0.05 cap", spent)
	}
	// Lift the cap; the rest get scored and v2's drop shows as drift.
	cfg["dailyBudgetUsd"] = 5
	f.do(f.h.PutProdEvals, "PUT", "/x", f.tokA, cfg, map[string]string{"name": "pe-agent"})
	f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten)
	rr := f.do(f.h.GetProdEvals, "GET", "/x", f.tokA, nil, map[string]string{"name": "pe-agent"})
	var out struct {
		Versions []versionDrift
		Scored   int
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.Scored != 24 || len(out.Versions) != 2 {
		t.Fatalf("expected 24 scored over 2 versions: %s", rr.Body)
	}
	var drifted *versionDrift
	for i := range out.Versions {
		if out.Versions[i].Drifted {
			drifted = &out.Versions[i]
		}
	}
	if drifted == nil || drifted.Version != "v2" || drifted.MeanScore >= out.Versions[0].MeanScore {
		t.Fatalf("v2 score drift not surfaced: %s", rr.Body)
	}
}

func TestSampledDeterministic(t *testing.T) {
	id := uuid.NewString()
	if sampled(id, 0) || !sampled(id, 1.0001) {
		t.Fatal("rate bounds")
	}
	hits := 0
	for i := 0; i < 2000; i++ {
		if sampled(fmt.Sprintf("run-%d", i), 0.1) {
			hits++
		}
	}
	if hits < 120 || hits > 280 {
		t.Fatalf("sampling rate off: %d/2000 at 10%%", hits)
	}
}

// A run in which one tool was approved by the agent's policy and one was
// denied (journalDeny's exact payload shape): the trace shows both, the denial
// is flagged and redacted, and the run is still sampled by production evals.
func TestObsTrace_PolicyDeniedStepAndProdEvalInteraction(t *testing.T) {
	f := newObsFixture(t)
	agent, vers := f.agent(f.ten, "policy-agent", "v1")
	run := f.run(f.ten, obsRunSeed{agent: agent, version: vers["v1"], status: "succeeded", output: `{"result":"GOOD partial answer"}`, age: time.Minute})
	t0 := time.Now().Add(-time.Minute)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	f.journal(run, 1, "step_started", "lookup", map[string]any{"name": "Lookup", "type": "tool"}, at(1))
	f.journal(run, 3, "step_completed", "lookup", map[string]any{"output": "ok", "tool": "crm.lookup", "args": map[string]any{"order": "1"}}, at(20))
	f.journal(run, 4, "step_started", "pay", map[string]any{"name": "Refund", "type": "connector"}, at(21))
	f.journal(run, 6, "policy_denied", "pay", map[string]any{"kind": "connector", "target": "stripe", "reason": "not allowed: " + obsFakeKey}, at(23))
	f.journal(run, 7, "step_failed", "pay", map[string]any{"error": "agent policy denied connector stripe", "tool": "stripe.refund", "args": map[string]any{"authorization": obsFakeKey}}, at(24))

	rr := f.do(f.h.GetRunTrace, "GET", "/x", f.tokA, nil, map[string]string{"id": run})
	if rr.Code != 200 || strings.Contains(rr.Body.String(), obsFakeKey) {
		t.Fatalf("trace: %d (leak=%v) %s", rr.Code, strings.Contains(rr.Body.String(), obsFakeKey), rr.Body)
	}
	var tr obs.Trace
	_ = json.Unmarshal(rr.Body.Bytes(), &tr)
	if len(tr.Steps) != 2 || tr.Steps[0].PolicyDenied != nil || tr.Steps[1].PolicyDenied == nil ||
		tr.Steps[1].PolicyDenied.Target != "stripe" || tr.Steps[1].Status != "failed" {
		t.Fatalf("policy denial not shown correctly: %s", rr.Body)
	}

	// The partial-denial run is a succeeded run: prod evals still score it.
	f.do(f.h.PutProdEvals, "PUT", "/x", f.tokA, map[string]any{"enabled": true, "sampleRate": 1, "dailyBudgetUsd": 1}, map[string]string{"name": "policy-agent"})
	if _, n := f.h.ScanTenant(injectTenant(context.Background(), f.ten), f.ten); n != 1 {
		t.Fatalf("scored %d, want 1", n)
	}
}
