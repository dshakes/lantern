package handlers

// Pure decision logic for agent promotion (ADR 0054). Nothing here touches the
// database, the clock (callers pass `now`) or a model: every verdict that gates
// a promotion, an approval or a rollback is deterministic and unit-tested.

import (
	"fmt"
	"hash/fnv"
	"strings"
	"time"
)

var promotionEnvs = []string{"sandbox", "staging", "prod"}

func validPromotionEnv(e string) bool {
	for _, v := range promotionEnvs {
		if v == e {
			return true
		}
	}
	return false
}

// needsApproval: prod always needs a human; other envs only when asked.
func needsApproval(env string, requested bool) bool { return env == "prod" || requested }

// evalFreshness is how old a passing hermetic eval may be and still count.
const evalFreshness = 24 * time.Hour

type gateResult struct {
	Name   string `json:"name"`
	Status string `json:"status"` // pass | fail
	Detail string `json:"detail"`
}

type evalEvidence struct {
	Passed    bool
	Score     float64
	CreatedAt time.Time
}

type gateInput struct {
	Env           string
	VersionExists bool
	// PriorEnvOK: the version is already active in an earlier environment
	// (progressive delivery order). Always true for sandbox.
	PriorEnvOK bool
	Eval       *evalEvidence // latest server-run (hermetic) eval for exactly this version
	// BaselineScore is the score pinned as baseline for this env, nil when none.
	BaselineScore *float64
	BudgetOK      bool
	BudgetReason  string
	// SandboxRunRequired/SandboxRunOK implement PAL_PROMOTE_REQUIRE_SANDBOX_RUN.
	SandboxRunRequired bool
	SandboxRunOK       bool
	Now                time.Time
}

func gate(name string, ok bool, pass, fail string) gateResult {
	if ok {
		return gateResult{name, "pass", pass}
	}
	return gateResult{name, "fail", fail}
}

// evaluateGates fails closed: anything that cannot be shown to hold is a fail.
// The sandbox is where a version is tried, so it needs no eval evidence; staging
// and prod do.
func evaluateGates(in gateInput) []gateResult {
	gs := []gateResult{
		gate("version", in.VersionExists, "version exists", "version not found for this agent"),
		gate("order", in.PriorEnvOK, "version is active in an earlier environment",
			"promote to sandbox or staging first (progressive delivery)"),
	}
	if in.Env != "sandbox" {
		gs = append(gs, evalGate(in))
	}
	gs = append(gs, gate("budget", in.BudgetOK, "within budget", "budget exceeded: "+in.BudgetReason))
	if in.SandboxRunRequired && in.Env == "prod" {
		gs = append(gs, gate("sandbox_run", in.SandboxRunOK, "sandbox microVM run succeeded for this version",
			"no successful sandbox microVM run recorded for this version"))
	}
	return gs
}

func evalGate(in gateInput) gateResult {
	e := in.Eval
	switch {
	case e == nil:
		return gateResult{"eval", "fail", "no hermetic eval run recorded for this version"}
	case in.Now.Sub(e.CreatedAt) > evalFreshness:
		return gateResult{"eval", "fail", fmt.Sprintf("latest eval is stale (%s old, max %s)",
			in.Now.Sub(e.CreatedAt).Round(time.Minute), evalFreshness)}
	case !e.Passed:
		return gateResult{"eval", "fail", fmt.Sprintf("latest eval did not pass every case (score %.2f)", e.Score)}
	case in.BaselineScore != nil && aggregateRegressed(e.Score, *in.BaselineScore):
		return gateResult{"eval", "fail", fmt.Sprintf("score %.2f regressed vs %s baseline %.2f", e.Score, in.Env, *in.BaselineScore)}
	}
	return gateResult{"eval", "pass", fmt.Sprintf("hermetic eval passed (score %.2f)", e.Score)}
}

func gatesPass(gs []gateResult) bool {
	for _, g := range gs {
		if g.Status != "pass" {
			return false
		}
	}
	return len(gs) > 0
}

func failedGates(gs []gateResult) string {
	var f []string
	for _, g := range gs {
		if g.Status != "pass" {
			f = append(f, g.Name+": "+g.Detail)
		}
	}
	return strings.Join(f, "; ")
}

// ---------- canary ----------

// canaryGuards are the live SLO / eval limits that trigger an automatic rollback.
type canaryGuards struct {
	MaxErrorRate float64 `json:"maxErrorRate"` // failed / terminal candidate runs
	MaxCostRatio float64 `json:"maxCostRatio"` // candidate avg cost / stable avg cost
	MinEvalScore float64 `json:"minEvalScore"` // newest hermetic eval of the candidate
	MinRuns      int     `json:"minRuns"`      // terminal candidate runs needed to pass
}

const canaryMinTripRuns = 5 // earliest a guard may trip, to avoid 1-run flukes

func (g *canaryGuards) defaults() {
	if g.MaxErrorRate <= 0 {
		g.MaxErrorRate = 0.10
	}
	if g.MaxCostRatio <= 0 {
		g.MaxCostRatio = 1.5
	}
	if g.MinRuns <= 0 {
		g.MinRuns = 20
	}
}

func (g canaryGuards) validate() error {
	if g.MaxErrorRate > 1 || g.MinEvalScore < 0 || g.MinEvalScore > 1 || g.MinRuns > 100000 || g.MaxCostRatio > 100 {
		return fmt.Errorf("guards out of range")
	}
	return nil
}

type variantStats struct {
	Terminal int // succeeded + failed
	Failed   int
	AvgCost  float64
}

type canaryObservation struct {
	Candidate, Stable variantStats
	// LatestEval is the newest hermetic eval of the candidate recorded after the
	// canary started; nil when none ran.
	LatestEval *evalEvidence
}

type canaryVerdict struct {
	Verdict string   `json:"verdict"` // hold | pass | trip
	Reasons []string `json:"reasons"`
}

// decideCanary: any tripped guard wins over a pass; too few samples holds.
func decideCanary(g canaryGuards, o canaryObservation) canaryVerdict {
	g.defaults()
	var trips []string
	if e := o.LatestEval; e != nil {
		if !e.Passed {
			trips = append(trips, "eval: newest hermetic eval of the canary failed")
		} else if g.MinEvalScore > 0 && e.Score < g.MinEvalScore {
			trips = append(trips, fmt.Sprintf("eval: score %.2f below floor %.2f", e.Score, g.MinEvalScore))
		}
	}
	c := o.Candidate
	if c.Terminal >= canaryMinTripRuns {
		if rate := float64(c.Failed) / float64(c.Terminal); rate > g.MaxErrorRate {
			trips = append(trips, fmt.Sprintf("error rate %.0f%% over %d runs exceeds %.0f%%", rate*100, c.Terminal, g.MaxErrorRate*100))
		}
		if o.Stable.Terminal >= canaryMinTripRuns && o.Stable.AvgCost > 0 && c.AvgCost > o.Stable.AvgCost*g.MaxCostRatio {
			trips = append(trips, fmt.Sprintf("cost/run %.4f is %.1fx stable %.4f (max %.1fx)",
				c.AvgCost, c.AvgCost/o.Stable.AvgCost, o.Stable.AvgCost, g.MaxCostRatio))
		}
	}
	if len(trips) > 0 {
		return canaryVerdict{"trip", trips}
	}
	if c.Terminal < g.MinRuns {
		return canaryVerdict{"hold", []string{fmt.Sprintf("%d of %d runs observed", c.Terminal, g.MinRuns)}}
	}
	return canaryVerdict{"pass", []string{fmt.Sprintf("all guards held over %d runs", c.Terminal)}}
}

// canaryBucket is the deterministic FNV-1a split the experiments machinery uses
// (PickVariant): the same run id always lands on the same side.
func canaryBucket(runID string, splitB int) bool {
	h := fnv.New32a()
	_, _ = h.Write([]byte(runID))
	return int(h.Sum32()%100) < splitB
}
