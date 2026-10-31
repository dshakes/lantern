package handlers

// Hermetic, server-side eval execution (ADR 0052).
//
// POST /v1/eval-suites/{id}/run executes every case of a suite against the
// agent's REAL prompt, model preference and tool surface — the same tool-loop
// path the inline run executor uses (callLLMWithFailover) — but every tool call
// is answered by the case's mocks. Nothing a tool would do ever happens: an
// unmocked tool returns an error to the model, never a real dispatch. The
// recorded tool calls become the trajectory the assertions grade.
//
// It is not a run (no `runs` row, invariant #2 untouched) and has no external
// side effects, so a crash loses only the in-flight measurement; the caller
// retries. Spend is capped per request (maxCostUsd), metered against the
// agent's budget, and refused up front on a hard-fail budget (402).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/grounding"
	"github.com/dshakes/pal/services/control-plane/internal/workflow"
)

type toolDispatchFn func(ctx context.Context, name string, args map[string]any) (any, error)

type evalCompletion struct {
	Text                string
	Calls               []ToolInvocation
	Provider, Model     string
	TokensIn, TokensOut int64
	CostUsd             float64
}

// evalCompleteFn is the LLM seam for the eval runner and judge. Production:
// LlmProxyHandler.evalComplete (capability-addressed failover chain, honours
// withExcludedModels). Tests inject a deterministic fake.
type evalCompleteFn func(ctx context.Context, tenantID, preferred string, messages, tools []map[string]any, dispatch toolDispatchFn) (evalCompletion, error)

func (h *LlmProxyHandler) evalComplete(ctx context.Context, tenantID, preferred string, messages, tools []map[string]any, dispatch toolDispatchFn) (evalCompletion, error) {
	tctx, spend := withToolUsage(ctx)
	text, invs, p, m, tin, tout, err := h.callLLMWithFailover(tctx, tenantID, preferred, messages, tools, dispatch, nil, nil, 5, false)
	if err != nil {
		return evalCompletion{}, err
	}
	tin, tout, cost := spend.addTo(p, m, tin, tout)
	return evalCompletion{Text: text, Calls: invs, Provider: p, Model: m, TokensIn: tin, TokensOut: tout, CostUsd: cost}, nil
}

// SetLLM wires the LLM seam (cmd/server/main.go). Without it the run, generate
// and calibrate endpoints answer 503; suite CRUD and RecordRun are unaffected.
func (h *EvalHandler) SetLLM(llm *LlmProxyHandler) {
	h.llm = llm
	if llm != nil {
		h.complete = llm.evalComplete
	}
}

type evalToolCall struct {
	Tool   string         `json:"tool"`
	Args   map[string]any `json:"args,omitempty"`
	Result any            `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
	Mocked bool           `json:"mocked"`
}

type evalSample struct {
	Output     string            `json:"output"`
	ToolCalls  []evalToolCall    `json:"toolCalls,omitempty"`
	LatencyMs  int64             `json:"latencyMs"`
	CostUsd    float64           `json:"costUsd"`
	TokensIn   int64             `json:"tokensIn,omitempty"`
	TokensOut  int64             `json:"tokensOut,omitempty"`
	Model      string            `json:"model,omitempty"`
	Passed     bool              `json:"passed"`
	Score      float64           `json:"score"`
	Error      string            `json:"error,omitempty"`
	Assertions []assertionResult `json:"assertions,omitempty"`
	// toolInvocations backs the grounded assertion; not persisted.
	toolInvocations []ToolInvocation
}

const errNotMocked = "hermetic eval: tool %q is not mocked for this case — real tools never run in an eval; add a mock"

// mockDispatcher answers tool calls from fixtures only. It never reaches a
// real tool: this function is the whole of the eval's tool surface.
func mockDispatcher(mocks []evalMock) toolDispatchFn {
	return func(_ context.Context, name string, args map[string]any) (any, error) {
		known := false
		for _, m := range mocks {
			if m.Tool != name {
				continue
			}
			known = true
			if !matchArgs(m.Match, args) {
				continue
			}
			if m.Error != "" {
				return nil, errors.New(m.Error)
			}
			if m.Result == nil {
				return map[string]any{"ok": true}, nil
			}
			return m.Result, nil
		}
		if known {
			return nil, fmt.Errorf("hermetic eval: no mock for %q matched these arguments", name)
		}
		return nil, fmt.Errorf(errNotMocked, name)
	}
}

// hermeticTools is the tool surface the agent sees: the tenant's real tool
// schemas (so the eval matches production) plus a definition for every mocked
// tool that is not installed — from the connector catalog when known, else
// from the mock's own description/parameters — so a suite is portable to a CI
// tenant with no connectors.
func hermeticTools(base []map[string]any, mocks []evalMock) []map[string]any {
	have := map[string]bool{}
	for _, t := range base {
		if fn, ok := t["function"].(map[string]any); ok {
			if n, ok := fn["name"].(string); ok {
				have[n] = true
			}
		}
	}
	out := append([]map[string]any{}, base...)
	for _, m := range mocks {
		if have[m.Tool] {
			continue
		}
		have[m.Tool] = true
		desc, params := m.Description, m.Parameters
		for _, ct := range connectorTools {
			if ct.Name() == m.Tool {
				desc = firstNonEmpty(desc, ct.Description)
				if params == nil {
					params, _ = any(ct.Params).(map[string]any)
				}
			}
		}
		if params == nil {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{"type": "function", "function": map[string]any{
			"name": m.Tool, "description": firstNonEmpty(desc, "Tool "+m.Tool), "parameters": params,
		}})
	}
	return out
}

func toolNames(tools []map[string]any) []string {
	var names []string
	for _, t := range tools {
		if fn, ok := t["function"].(map[string]any); ok {
			if n, ok := fn["name"].(string); ok {
				names = append(names, n)
			}
		}
	}
	return names
}

// evalAgent is the slice of the agent definition an eval needs.
type evalAgent struct {
	Name         string
	SystemPrompt string
	Model        string
	Description  string
}

func (h *EvalHandler) loadEvalAgent(ctx context.Context, tenantID, name string) (*evalAgent, string, error) {
	var a evalAgent
	var stored *string
	var labels, wf []byte
	var manifest []byte
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT system_prompt, COALESCE(model,''), COALESCE(labels,'{}'::jsonb)::text,
			       COALESCE(workflow,'{}'::jsonb)::text
			FROM agents WHERE name = $1 AND tenant_id = $2`, name, tenantID,
		).Scan(&stored, &a.Model, &labels, &wf); err != nil {
			return err
		}
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(av.manifest,'{}'::jsonb)::text FROM agent_versions av
			JOIN agents ag ON ag.current_version_id = av.id
			WHERE ag.name = $1 AND ag.tenant_id = $2 LIMIT 1`, name, tenantID).Scan(&manifest)
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	a.Name = name
	var def workflow.Definition
	if json.Unmarshal(wf, &def) == nil && len(def.Nodes) > 0 {
		return &a, "workflow", nil
	}
	var lm LoopManifest
	if json.Unmarshal(manifest, &lm) == nil && lm.Type == "loop" {
		return &a, "loop", nil
	}
	if stored != nil && *stored != "" {
		a.SystemPrompt = *stored
	} else {
		var lbl struct {
			TemplateID string `json:"pal.template"`
		}
		_ = json.Unmarshal(labels, &lbl)
		tid := firstNonEmpty(lbl.TemplateID, name)
		if tpl, ok := templates[tid]; ok && tpl.SystemPrompt != "" {
			a.SystemPrompt = tpl.SystemPrompt
			a.Model = firstNonEmpty(a.Model, tpl.Model)
		}
	}
	if a.SystemPrompt == "" {
		a.SystemPrompt = fmt.Sprintf("You are the agent '%s'. Process the user's input and produce a useful result.", name)
	}
	return &a, "tool-loop", nil
}

// ---------- request / response ----------

type runSuiteRequest struct {
	Branch       string   `json:"branch,omitempty"`
	CommitSha    string   `json:"commitSha,omitempty"`
	AgentVersion string   `json:"agentVersion,omitempty"`
	Samples      int      `json:"samples,omitempty"`      // overrides every case's samples
	JudgeSamples int      `json:"judgeSamples,omitempty"` // overrides judge.samples
	JudgeModel   string   `json:"judgeModel,omitempty"`   // capability
	MaxCostUsd   float64  `json:"maxCostUsd,omitempty"`   // default 1.00, cap 25
	Cases        []string `json:"cases,omitempty"`        // run a subset by name
	SetBaseline  bool     `json:"setBaseline,omitempty"`  // pin on a non-regressed, all-pass run
}

const (
	defaultEvalMaxCostUsd = 1.0
	capEvalMaxCostUsd     = 25.0
	evalConcurrency       = 4
	evalUnitTimeout       = 3 * time.Minute
)

type evalBaseline struct {
	RunID string
	Score float64
	Cases []evalCaseResult
}

func (h *EvalHandler) loadBaseline(ctx context.Context, tenantID, agentName, branch string) *evalBaseline {
	if branch == "" {
		return nil
	}
	var b evalBaseline
	var raw []byte
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT r.id, r.score, r.cases_result FROM eval_baselines b
			JOIN eval_runs r ON r.id = b.eval_run_id
			WHERE b.tenant_id = $1 AND b.agent_name = $2 AND b.branch = $3`,
			tenantID, agentName, branch).Scan(&b.RunID, &b.Score, &raw)
	})
	if err != nil {
		return nil
	}
	_ = json.Unmarshal(raw, &b.Cases)
	return &b
}

// suiteHistory returns per-case pass/fail, oldest first, over the last 10 runs.
func (h *EvalHandler) suiteHistory(ctx context.Context, tenantID, suiteID string) map[string][]bool {
	out := map[string][]bool{}
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT cases_result FROM eval_runs WHERE tenant_id = $1 AND suite_id = $2
			ORDER BY created_at DESC LIMIT 10`, tenantID, suiteID)
		if err != nil {
			return err
		}
		defer rows.Close()
		var runs [][]evalCaseResult
		for rows.Next() {
			var raw []byte
			if rows.Scan(&raw) != nil {
				continue
			}
			var crs []evalCaseResult
			_ = json.Unmarshal(raw, &crs)
			runs = append(runs, crs)
		}
		for i := len(runs) - 1; i >= 0; i-- {
			for _, c := range runs[i] {
				out[c.Name] = append(out[c.Name], c.Passed)
			}
		}
		return rows.Err()
	})
	return out
}

// RunSuite handles POST /v1/eval-suites/{id}/run.
func (h *EvalHandler) RunSuite(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if h.complete == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "eval runner not configured", "code": "no_llm"})
		return
	}
	var req runSuiteRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
			return
		}
	}
	if req.Samples < 0 || req.Samples > maxEvalSamples || req.JudgeSamples < 0 || req.JudgeSamples > maxJudgeSamples {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("samples must be in [1,%d], judgeSamples in [1,%d]", maxEvalSamples, maxJudgeSamples)})
		return
	}
	if err := validJudgeModel(req.JudgeModel); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.MaxCostUsd < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "maxCostUsd must be >= 0"})
		return
	}
	if req.MaxCostUsd == 0 {
		req.MaxCostUsd = defaultEvalMaxCostUsd
	}
	req.MaxCostUsd = math.Min(req.MaxCostUsd, capEvalMaxCostUsd)

	suiteID := r.PathValue("id")
	var agentName, suiteName string
	var casesJSON []byte
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT agent_name, name, cases FROM eval_suites WHERE id = $1 AND tenant_id = $2`,
			suiteID, tenantID).Scan(&agentName, &suiteName, &casesJSON)
	}); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "suite not found"})
		return
	}
	var cases []evalCase
	_ = json.Unmarshal(casesJSON, &cases)
	if len(req.Cases) > 0 {
		want := map[string]bool{}
		for _, n := range req.Cases {
			want[n] = true
		}
		kept := cases[:0]
		for _, c := range cases {
			if want[c.Name] {
				kept = append(kept, c)
			}
		}
		cases = kept
	}
	if len(cases) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no cases to run"})
		return
	}
	if len(cases) > maxEvalCasesPerRun {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("at most %d cases per run; use `cases` to run a subset", maxEvalCasesPerRun)})
		return
	}
	specs := make([]*evalAssertSpec, len(cases))
	execs := 0
	for i, c := range cases {
		if err := validateCase(c); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		specs[i], _ = parseAssert(c.Assert)
		if req.Samples > 0 {
			cases[i].Samples = req.Samples
		}
		if cases[i].Samples == 0 {
			cases[i].Samples = 1
		}
		execs += cases[i].Samples
	}
	if execs > maxEvalExecutions {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("cases × samples = %d exceeds %d per run", execs, maxEvalExecutions)})
		return
	}

	agent, kind, err := h.loadEvalAgent(ctx, tenantID, agentName)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if kind != "tool-loop" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"code":  "unsupported_agent_kind",
			"error": fmt.Sprintf("hermetic evals run tool-loop agents; %q is a %s agent — use `pal test` (live runs) for it", agentName, kind),
		})
		return
	}
	if bc := CheckBudget(ctx, h.srv.Pool, tenantID, agentName, 0); !bc.Allowed && bc.HardFail {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "budget exceeded: " + bc.Reason, "code": "budget_exceeded"})
		return
	}

	baseline := h.loadBaseline(ctx, tenantID, agentName, req.Branch)
	res := h.executeSuite(ctx, tenantID, agent, cases, specs, req, baseline)

	// Fold history (incl. this run) for flakiness, then the gate.
	history := h.suiteHistory(ctx, tenantID, suiteID)
	for _, c := range res.results {
		history[c.Name] = append(history[c.Name], c.Passed)
	}
	flaky := historicalFlaky(history)
	for i := range res.results {
		if flaky[res.results[i].Name] {
			res.results[i].Flaky = true
		}
	}

	passed, wsum, wtotal := 0, 0.0, 0.0
	for i, c := range res.results {
		if c.Passed {
			passed++
		}
		wt := cases[i].Weight
		if wt <= 0 {
			wt = 1
		}
		wsum += wt * c.Score
		wtotal += wt
	}
	score := wsum / wtotal
	total := len(res.results)
	allPassed := passed == total

	// Non-nil so clients always get JSON arrays, never null.
	deltas := []caseDelta{}
	regressedCases, flakyCases := []string{}, []string{}
	var baselineScore *float64
	regressed := false
	if baseline != nil {
		baselineScore = &baseline.Score
		deltas = caseDeltas(res.results, baseline.Cases, flaky)
		for _, d := range deltas {
			if d.Regressed {
				regressedCases = append(regressedCases, d.Name)
			}
		}
		regressed = aggregateRegressed(score, baseline.Score) || len(regressedCases) > 0
	}
	for _, c := range res.results {
		if c.Flaky {
			flakyCases = append(flakyCases, c.Name)
		}
	}

	totalCost := res.agentCost + res.judgeCost
	resultsJSON, _ := json.Marshal(res.results)
	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO eval_runs
			  (tenant_id, suite_id, agent_name, agent_version, commit_sha, branch, passed, score,
			   cases_total, cases_passed, cases_result, duration_ms, total_cost_usd)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
			RETURNING id`, tenantID, suiteID, agentName, req.AgentVersion, req.CommitSha, req.Branch,
			allPassed, score, total, passed, resultsJSON, res.durationMs, totalCost).Scan(&id)
	})
	if err != nil {
		h.logger().Error("record hermetic eval run failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record eval run"})
		return
	}
	if recErr := RecordUsageSpend(ctx, h.srv.Pool, tenantID, agentName, res.tokensIn, res.tokensOut, totalCost); recErr != nil {
		h.logger().Warn("eval run: RecordUsageSpend failed", zap.Error(recErr))
	}

	pinned := false
	if req.SetBaseline && req.Branch != "" && allPassed && !regressed {
		if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				INSERT INTO eval_baselines (tenant_id, agent_name, branch, eval_run_id) VALUES ($1,$2,$3,$4)
				ON CONFLICT (tenant_id, agent_name, branch) DO UPDATE SET eval_run_id = EXCLUDED.eval_run_id, set_at = now()`,
				tenantID, agentName, req.Branch, id)
			return e
		}); err == nil {
			pinned = true
		}
	}

	resp := map[string]any{
		"id": id, "suiteId": suiteID, "suiteName": suiteName, "agentName": agentName, "mode": "hermetic",
		"passed": allPassed, "score": score, "casesTotal": total, "casesPassed": passed,
		"regressed": regressed, "baselineScore": baselineScore, "caseDeltas": deltas,
		"regressedCases": regressedCases, "flakyCases": flakyCases, "caseResults": res.results,
		"durationMs": res.durationMs, "totalCostUsd": totalCost, "agentCostUsd": res.agentCost,
		"judgeCostUsd": res.judgeCost, "judgeModel": firstNonEmpty(req.JudgeModel, defaultJudgeModel()),
		"agentModels": res.agentModels, "pinnedBaseline": pinned,
	}
	if baseline != nil {
		resp["baselineRunId"] = baseline.RunID
	}
	if res.stopped != "" {
		resp["stoppedEarly"] = res.stopped
	}
	status := http.StatusOK
	if regressed {
		status = http.StatusUnprocessableEntity // 422 — the CI gate
	}
	writeJSON(w, status, resp)
}

type suiteExecution struct {
	results              []evalCaseResult
	agentCost, judgeCost float64
	tokensIn, tokensOut  int64
	durationMs           int64
	agentModels          []string
	stopped              string
}

// executeSuite runs every (case, sample) unit with bounded concurrency under a
// shared cost ceiling, grades each sample, and folds samples into case results.
func (h *EvalHandler) executeSuite(ctx context.Context, tenantID string, agent *evalAgent, cases []evalCase, specs []*evalAssertSpec, req runSuiteRequest, baseline *evalBaseline) suiteExecution {
	start := time.Now()
	baseTools, _ := toolsForTenant(ctx, h.srv.Pool, tenantID)
	judge := &evalJudge{complete: h.complete, tenantID: tenantID, model: firstNonEmpty(req.JudgeModel, defaultJudgeModel()), instructions: agent.SystemPrompt}
	evalKey := uuid.NewString()

	baseOut := map[string]string{}
	if baseline != nil {
		for _, c := range baseline.Cases {
			out := c.Actual
			if out == "" && len(c.Samples) > 0 {
				out = c.Samples[0].Output
			}
			baseOut[c.Name] = out
		}
	}

	type unit struct{ ci, si int }
	samples := make([][]evalSample, len(cases))
	judgeCost := make([][]float64, len(cases))
	var units []unit
	for i, c := range cases {
		samples[i] = make([]evalSample, c.Samples)
		judgeCost[i] = make([]float64, c.Samples)
		for k := 0; k < c.Samples; k++ {
			units = append(units, unit{i, k})
		}
	}

	var mu sync.Mutex
	spent, stopped := 0.0, ""
	models := map[string]bool{}
	sem := make(chan struct{}, evalConcurrency)
	var wg sync.WaitGroup
	for _, u := range units {
		mu.Lock()
		over := spent >= req.MaxCostUsd
		if over && stopped == "" {
			stopped = fmt.Sprintf("cost ceiling $%.2f reached; remaining samples not executed", req.MaxCostUsd)
		}
		mu.Unlock()
		if over {
			samples[u.ci][u.si] = evalSample{Error: "not executed: eval cost ceiling reached"}
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(u unit) {
			defer wg.Done()
			defer func() { <-sem }()
			c, spec := cases[u.ci], specs[u.ci]
			uctx, cancel := context.WithTimeout(ctx, evalUnitTimeout)
			defer cancel()
			s := h.executeSample(WithLLMIdempotencyBase(uctx, llmIdempotencyBaseFor(evalKey, fmt.Sprintf("eval:%d", u.ci), u.si+1)), tenantID, agent, c, baseTools)
			jc := h.gradeSample(uctx, judge, c, spec, &s, baseOut[c.Name], req.JudgeSamples)
			mu.Lock()
			spent += s.CostUsd + jc
			if s.Model != "" {
				models[s.Model] = true
			}
			mu.Unlock()
			samples[u.ci][u.si] = s
			judgeCost[u.ci][u.si] = jc
		}(u)
	}
	wg.Wait()

	ex := suiteExecution{stopped: stopped, agentModels: []string{}}
	for i, c := range cases {
		cr := foldSamples(c, samples[i])
		for k := range judgeCost[i] {
			cr.JudgeCostUsd += judgeCost[i][k]
		}
		ex.agentCost += cr.CostUsd
		ex.judgeCost += cr.JudgeCostUsd
		for _, s := range samples[i] {
			ex.tokensIn += s.TokensIn
			ex.tokensOut += s.TokensOut
		}
		ex.results = append(ex.results, cr)
	}
	for m := range models {
		ex.agentModels = append(ex.agentModels, m)
	}
	sort.Strings(ex.agentModels)
	ex.durationMs = time.Since(start).Milliseconds()
	return ex
}

// executeSample runs the agent once against the case's mocks.
func (h *EvalHandler) executeSample(ctx context.Context, tenantID string, agent *evalAgent, c evalCase, baseTools []map[string]any) evalSample {
	tools := hermeticTools(baseTools, c.Mocks)
	system := agent.SystemPrompt
	if len(tools) > 0 {
		system += toolBindingPrompt(toolNames(tools))
	}
	userContent, _ := json.Marshal(map[string]any{"prompt": c.Input})
	msgs := []map[string]any{
		{"role": "system", "content": system},
		{"role": "user", "content": string(userContent)},
	}
	start := time.Now()
	comp, err := h.complete(ctx, tenantID, agent.Model, msgs, tools, mockDispatcher(c.Mocks))
	s := evalSample{LatencyMs: time.Since(start).Milliseconds()}
	if err != nil {
		s.Error = "agent: " + clip(err.Error(), 300)
		return s
	}
	s.Output = clip(comp.Text, maxEvalTextBytes)
	s.CostUsd, s.TokensIn, s.TokensOut, s.Model = comp.CostUsd, comp.TokensIn, comp.TokensOut, comp.Model
	for _, inv := range comp.Calls {
		s.ToolCalls = append(s.ToolCalls, evalToolCall{
			Tool: inv.Name, Args: inv.Args, Result: inv.Result, Error: inv.Error,
			Mocked: inv.Error == "" || !strings.HasPrefix(inv.Error, "hermetic eval:"),
		})
	}
	s.toolInvocations = comp.Calls
	return s
}

// gradeSample applies every assertion to one sample; returns judge spend.
func (h *EvalHandler) gradeSample(ctx context.Context, judge *evalJudge, c evalCase, spec *evalAssertSpec, s *evalSample, baselineOut string, judgeSamples int) float64 {
	if s.Error != "" {
		s.Passed, s.Score = false, 0
		return 0
	}
	as := gradeDeterministic(c, spec, *s)
	if spec.Grounded {
		if grounding.HasUnbackedClaims(s.Output, invocationsToPerformed(s.toolInvocations)) {
			as = append(as, fail("grounded", "output claims an action no tool call backs"))
		} else {
			as = append(as, pass("grounded"))
		}
	}
	cost := 0.0
	withSamples := func(j judgeSpec) judgeSpec {
		if judgeSamples > 0 {
			j.Samples = judgeSamples
		}
		return j
	}
	if spec.Judge != nil {
		o := judge.rubric(ctx, "judge", withSamples(*spec.Judge), c.Input, s.Output, "", s.Model)
		as, cost = append(as, o.result), cost+o.costUsd
	}
	if spec.Faithfulness != nil {
		ev, _ := json.Marshal(s.ToolCalls)
		o := judge.rubric(ctx, "faithfulness", withSamples(*spec.Faithfulness), c.Input, s.Output, string(ev), s.Model)
		as, cost = append(as, o.result), cost+o.costUsd
	}
	if spec.Pairwise != nil {
		o := judge.pairwise(ctx, *spec.Pairwise, c.Input, s.Output, baselineOut, s.Model)
		as, cost = append(as, o.result), cost+o.costUsd
	}
	s.Assertions = as
	s.Passed, s.Score = sampleVerdict(as, s.Output, "")
	return cost
}

// foldSamples turns N graded samples into one case result: score = mean,
// stddev across samples, passed only if EVERY sample passed (pass^k), flaky
// when some but not all did.
func foldSamples(c evalCase, ss []evalSample) evalCaseResult {
	cr := evalCaseResult{Name: c.Name, Expected: c.Expected, Samples: ss}
	scores := make([]float64, len(ss))
	passes := 0
	var lat int64
	for i, s := range ss {
		scores[i] = s.Score
		if s.Passed {
			passes++
		}
		lat += s.LatencyMs
		cr.CostUsd += s.CostUsd
		if cr.Error == "" && s.Error != "" {
			cr.Error = s.Error
		}
	}
	cr.Score, cr.Stddev = meanStddev(scores)
	pr := float64(passes) / float64(max(len(ss), 1))
	cr.PassRate = &pr
	cr.Passed = len(ss) > 0 && passes == len(ss)
	cr.Flaky = passes > 0 && passes < len(ss)
	if len(ss) > 0 {
		cr.LatencyMs = lat / int64(len(ss))
		cr.Actual = ss[0].Output
		cr.Assertions = ss[0].Assertions
		for _, s := range ss { // surface a failing sample's assertions when there is one
			if !s.Passed {
				cr.Assertions = s.Assertions
				if cr.Error == "" {
					cr.Error = failingDetail(s.Assertions)
				}
				break
			}
		}
	}
	return cr
}

func failingDetail(as []assertionResult) string {
	var parts []string
	for _, a := range as {
		if !a.Passed && !a.Skipped {
			parts = append(parts, a.Kind+": "+firstNonEmpty(a.Detail, a.Rationale))
		}
	}
	return clip(strings.Join(parts, "; "), 500)
}
