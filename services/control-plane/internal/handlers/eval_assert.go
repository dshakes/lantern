package handlers

// Eval case schema v2 (ADR 0052): typed assertions, tool mocks, and the pure
// scoring math (variance, flakiness, per-case regression). Everything here is
// deterministic and unit-tested; the LLM-backed graders live in eval_judge.go
// and the hermetic executor in eval_runner.go.
//
// Backward compatibility: a case's `assert` is still stored as the free-form
// JSON object it always was. v2 keys are parsed out of it at validation and
// grading time; legacy keys (contains, grounded) keep their exact semantics.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

// Limits. They bound spend and latency of one eval request; raising them is a
// deliberate change, not a config knob.
const (
	maxEvalSamples      = 5
	maxJudgeSamples     = 5
	defaultJudgeSamples = 3
	maxEvalCasesPerRun  = 25
	maxEvalExecutions   = 60 // cases × samples per run
	defaultJudgePassAt  = 0.75
	defaultPairwisePass = 0.5
	maxEvalTextBytes    = 8000
)

// evalAssertSpec is the typed view of evalCase.Assert.
type evalAssertSpec struct {
	Contains     string          `json:"contains,omitempty"`
	NotContains  string          `json:"notContains,omitempty"`
	Regex        string          `json:"regex,omitempty"`
	MinLen       int             `json:"minLen,omitempty"`
	MaxLen       int             `json:"maxLen,omitempty"`
	Grounded     bool            `json:"grounded,omitempty"`
	Judge        *judgeSpec      `json:"judge,omitempty"`
	Faithfulness *judgeSpec      `json:"faithfulness,omitempty"`
	Pairwise     *pairwiseSpec   `json:"pairwise,omitempty"`
	Trajectory   *trajectorySpec `json:"trajectory,omitempty"`
	MaxLatencyMs int64           `json:"maxLatencyMs,omitempty"`
	MaxCostUsd   float64         `json:"maxCostUsd,omitempty"`
	regex        *regexp.Regexp  `json:"-"`
}

type judgeSpec struct {
	Rubric    string  `json:"rubric,omitempty"`
	Reference string  `json:"reference,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`
	Samples   int     `json:"samples,omitempty"`
	// Model is a capability (e.g. "reasoning-large"), never a vendor id (invariant #6).
	Model string `json:"model,omitempty"`
}

type pairwiseSpec struct {
	Criteria  string  `json:"criteria,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`
	Model     string  `json:"model,omitempty"`
}

type trajectorySpec struct {
	Expect   []toolExpectation `json:"expect,omitempty"`
	Order    string            `json:"order,omitempty"` // any (default) | in_order | exact
	Forbid   []string          `json:"forbid,omitempty"`
	MaxCalls int               `json:"maxCalls,omitempty"`
}

type toolExpectation struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args,omitempty"`
}

// evalMock is one deterministic tool fixture. A tool call is answered by the
// first mock whose Tool matches and whose Match constraints all hold.
type evalMock struct {
	Tool        string         `json:"tool"`
	Match       map[string]any `json:"match,omitempty"`
	Result      any            `json:"result,omitempty"`
	Error       string         `json:"error,omitempty"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
	// Synthetic marks a fixture an author (or the generator) made up rather
	// than captured from a real run. Informational.
	Synthetic bool `json:"synthetic,omitempty"`
}

var capabilityOnly = map[string]bool{
	"auto": true, "reasoning-frontier": true, "reasoning-large": true, "reasoning-small": true,
	"chat-large": true, "chat-small": true, "best": true, "balanced": true, "fast": true, "cheap": true,
}

func validJudgeModel(m string) error {
	if m == "" || capabilityOnly[m] {
		return nil
	}
	return fmt.Errorf("judge model must be a capability (e.g. \"reasoning-large\"), not a vendor model id")
}

// parseAssert decodes and validates a case's assert map. Unknown keys are
// tolerated (they were always tolerated) but every known key must be well-formed.
func parseAssert(raw map[string]any) (*evalAssertSpec, error) {
	spec := &evalAssertSpec{}
	if len(raw) == 0 {
		return spec, nil
	}
	b, _ := json.Marshal(raw)
	if err := json.Unmarshal(b, spec); err != nil {
		return nil, fmt.Errorf("assert: %w", err)
	}
	if spec.Regex != "" {
		re, err := regexp.Compile(spec.Regex)
		if err != nil {
			return nil, fmt.Errorf("assert.regex: %w", err)
		}
		spec.regex = re
	}
	if spec.MinLen < 0 || spec.MaxLen < 0 || (spec.MaxLen > 0 && spec.MinLen > spec.MaxLen) {
		return nil, errors.New("assert: minLen/maxLen out of range")
	}
	if spec.MaxLatencyMs < 0 || spec.MaxCostUsd < 0 {
		return nil, errors.New("assert: maxLatencyMs/maxCostUsd must be >= 0")
	}
	for name, j := range map[string]*judgeSpec{"judge": spec.Judge, "faithfulness": spec.Faithfulness} {
		if j == nil {
			continue
		}
		if name == "judge" && strings.TrimSpace(j.Rubric) == "" {
			return nil, errors.New("assert.judge.rubric is required")
		}
		if j.Threshold < 0 || j.Threshold > 1 {
			return nil, fmt.Errorf("assert.%s.threshold must be in [0,1]", name)
		}
		if j.Samples < 0 || j.Samples > maxJudgeSamples {
			return nil, fmt.Errorf("assert.%s.samples must be in [1,%d]", name, maxJudgeSamples)
		}
		if err := validJudgeModel(j.Model); err != nil {
			return nil, fmt.Errorf("assert.%s.model: %w", name, err)
		}
	}
	if p := spec.Pairwise; p != nil {
		if p.Threshold < 0 || p.Threshold > 1 {
			return nil, errors.New("assert.pairwise.threshold must be in [0,1]")
		}
		if err := validJudgeModel(p.Model); err != nil {
			return nil, fmt.Errorf("assert.pairwise.model: %w", err)
		}
	}
	if t := spec.Trajectory; t != nil {
		switch t.Order {
		case "", "any", "in_order", "exact":
		default:
			return nil, errors.New(`assert.trajectory.order must be "any", "in_order" or "exact"`)
		}
		if t.MaxCalls < 0 {
			return nil, errors.New("assert.trajectory.maxCalls must be >= 0")
		}
		for i, e := range t.Expect {
			if strings.TrimSpace(e.Tool) == "" {
				return nil, fmt.Errorf("assert.trajectory.expect[%d].tool is required", i)
			}
			if err := validateMatcher(e.Args); err != nil {
				return nil, fmt.Errorf("assert.trajectory.expect[%d].args: %w", i, err)
			}
		}
	}
	return spec, nil
}

// validateCase checks a whole case (assert + mocks + samples) at the API boundary.
func validateCase(c evalCase) error {
	if strings.TrimSpace(c.Name) == "" {
		return errors.New("case name is required")
	}
	if c.Samples < 0 || c.Samples > maxEvalSamples {
		return fmt.Errorf("case %q: samples must be in [1,%d]", c.Name, maxEvalSamples)
	}
	if _, err := parseAssert(c.Assert); err != nil {
		return fmt.Errorf("case %q: %w", c.Name, err)
	}
	for i, m := range c.Mocks {
		if strings.TrimSpace(m.Tool) == "" {
			return fmt.Errorf("case %q: mocks[%d].tool is required", c.Name, i)
		}
		if err := validateMatcher(m.Match); err != nil {
			return fmt.Errorf("case %q: mocks[%d].match: %w", c.Name, i, err)
		}
	}
	return nil
}

// ---------- arg matching (shared by mocks and trajectory) ----------

// A matcher value is either a literal (JSON-equal) or an operator object:
// {"$any": true}, {"$contains": "x"}, {"$regex": "^a"}.
func validateMatcher(m map[string]any) error {
	for k, v := range m {
		if op, ok := v.(map[string]any); ok {
			if re, has := op["$regex"].(string); has {
				if _, err := regexp.Compile(re); err != nil {
					return fmt.Errorf("%s: $regex: %w", k, err)
				}
			}
		}
	}
	return nil
}

func matchArgs(want, got map[string]any) bool {
	for k, w := range want {
		g, present := got[k]
		if op, ok := w.(map[string]any); ok && isOperator(op) {
			if !present {
				return false
			}
			if _, any := op["$any"]; any {
				continue
			}
			gs := fmt.Sprint(g)
			if s, ok := op["$contains"].(string); ok && !strings.Contains(gs, s) {
				return false
			}
			if s, ok := op["$regex"].(string); ok {
				re, err := regexp.Compile(s)
				if err != nil || !re.MatchString(gs) {
					return false
				}
			}
			continue
		}
		if !present || !jsonEqual(w, g) {
			return false
		}
	}
	return true
}

func isOperator(op map[string]any) bool {
	for k := range op {
		if strings.HasPrefix(k, "$") {
			return true
		}
	}
	return false
}

// jsonEqual compares after a JSON round-trip so 1 == 1.0 and map key order is moot.
func jsonEqual(a, b any) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	var av, bv any
	_ = json.Unmarshal(ab, &av)
	_ = json.Unmarshal(bb, &bv)
	return reflect.DeepEqual(av, bv)
}

// ---------- deterministic graders ----------

type assertionResult struct {
	Kind      string  `json:"kind"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Skipped   bool    `json:"skipped,omitempty"`
	Detail    string  `json:"detail,omitempty"`
	Rationale string  `json:"rationale,omitempty"`
	Stddev    float64 `json:"stddev,omitempty"`
	Samples   int     `json:"samples,omitempty"`
	Model     string  `json:"model,omitempty"`
	// InjectionSuspected: the candidate output contained text addressed to the
	// grader; the judge was not consulted and the assertion failed closed.
	InjectionSuspected bool `json:"injectionSuspected,omitempty"`
}

func pass(kind string) assertionResult { return assertionResult{Kind: kind, Passed: true, Score: 1} }
func fail(kind, detail string) assertionResult {
	return assertionResult{Kind: kind, Score: 0, Detail: detail}
}

// gradeDeterministic runs every non-LLM assertion against one sample.
func gradeDeterministic(c evalCase, spec *evalAssertSpec, s evalSample) []assertionResult {
	var out []assertionResult
	actual := s.Output
	if spec.Contains != "" {
		if strings.Contains(actual, spec.Contains) {
			out = append(out, pass("contains"))
		} else {
			out = append(out, fail("contains", fmt.Sprintf("output does not contain %q", clip(spec.Contains, 80))))
		}
	} else if c.Expected != "" {
		// Legacy: expected is a substring match when no explicit contains is set.
		if strings.Contains(actual, c.Expected) {
			out = append(out, pass("expected"))
		} else {
			out = append(out, fail("expected", "output does not contain the expected text"))
		}
	}
	if spec.NotContains != "" {
		if strings.Contains(actual, spec.NotContains) {
			out = append(out, fail("notContains", fmt.Sprintf("output contains forbidden %q", clip(spec.NotContains, 80))))
		} else {
			out = append(out, pass("notContains"))
		}
	}
	if spec.regex != nil {
		if spec.regex.MatchString(actual) {
			out = append(out, pass("regex"))
		} else {
			out = append(out, fail("regex", "output does not match regex"))
		}
	}
	if spec.MinLen > 0 || spec.MaxLen > 0 {
		n := len([]rune(actual))
		switch {
		case spec.MinLen > 0 && n < spec.MinLen:
			out = append(out, fail("length", fmt.Sprintf("length %d < minLen %d", n, spec.MinLen)))
		case spec.MaxLen > 0 && n > spec.MaxLen:
			out = append(out, fail("length", fmt.Sprintf("length %d > maxLen %d", n, spec.MaxLen)))
		default:
			out = append(out, pass("length"))
		}
	}
	if spec.Trajectory != nil {
		out = append(out, gradeTrajectory(spec.Trajectory, s.ToolCalls))
	}
	if spec.MaxLatencyMs > 0 {
		if s.LatencyMs <= spec.MaxLatencyMs {
			out = append(out, pass("latency"))
		} else {
			out = append(out, fail("latency", fmt.Sprintf("%dms > budget %dms", s.LatencyMs, spec.MaxLatencyMs)))
		}
	}
	if spec.MaxCostUsd > 0 {
		if s.CostUsd <= spec.MaxCostUsd {
			out = append(out, pass("cost"))
		} else {
			out = append(out, fail("cost", fmt.Sprintf("$%.4f > budget $%.4f", s.CostUsd, spec.MaxCostUsd)))
		}
	}
	return out
}

// gradeTrajectory checks the recorded tool calls against expectations.
func gradeTrajectory(t *trajectorySpec, calls []evalToolCall) assertionResult {
	const kind = "trajectory"
	for _, f := range t.Forbid {
		for _, c := range calls {
			if c.Tool == f {
				return fail(kind, fmt.Sprintf("forbidden tool %q was called", f))
			}
		}
	}
	if t.MaxCalls > 0 && len(calls) > t.MaxCalls {
		return fail(kind, fmt.Sprintf("%d tool calls > maxCalls %d", len(calls), t.MaxCalls))
	}
	matches := func(e toolExpectation, c evalToolCall) bool {
		return e.Tool == c.Tool && matchArgs(e.Args, c.Args)
	}
	switch t.Order {
	case "exact":
		if len(calls) != len(t.Expect) {
			return fail(kind, fmt.Sprintf("expected exactly %d calls, got %d (%s)", len(t.Expect), len(calls), callNames(calls)))
		}
		for i, e := range t.Expect {
			if !matches(e, calls[i]) {
				return fail(kind, fmt.Sprintf("call %d: expected %s, got %s", i+1, e.Tool, calls[i].Tool))
			}
		}
	case "in_order":
		j := 0
		for _, c := range calls {
			if j < len(t.Expect) && matches(t.Expect[j], c) {
				j++
			}
		}
		if j < len(t.Expect) {
			return fail(kind, fmt.Sprintf("expected %s (in order) not satisfied; got %s", t.Expect[j].Tool, callNames(calls)))
		}
	default: // any: each expectation consumes a distinct call
		used := make([]bool, len(calls))
		for _, e := range t.Expect {
			found := false
			for i, c := range calls {
				if !used[i] && matches(e, c) {
					used[i], found = true, true
					break
				}
			}
			if !found {
				return fail(kind, fmt.Sprintf("expected a %s call with matching args; got %s", e.Tool, callNames(calls)))
			}
		}
	}
	return pass(kind)
}

func callNames(calls []evalToolCall) string {
	if len(calls) == 0 {
		return "no tool calls"
	}
	names := make([]string, len(calls))
	for i, c := range calls {
		names[i] = c.Tool
	}
	return strings.Join(names, " → ")
}

// ---------- aggregation + variance ----------

// sampleVerdict folds one sample's assertions: passed iff every non-skipped
// assertion passed; score is their mean. With no gradable assertion the legacy
// rule applies: pass on non-empty output.
func sampleVerdict(as []assertionResult, output string, execErr string) (bool, float64) {
	if execErr != "" {
		return false, 0
	}
	n, sum, ok := 0, 0.0, true
	for _, a := range as {
		if a.Skipped {
			continue
		}
		n++
		sum += a.Score
		ok = ok && a.Passed
	}
	if n == 0 {
		if strings.TrimSpace(output) != "" {
			return true, 1
		}
		return false, 0
	}
	return ok, sum / float64(n)
}

// meanStddev returns the mean and the sample (n-1) standard deviation.
func meanStddev(xs []float64) (float64, float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	mean := sum / float64(len(xs))
	if len(xs) < 2 {
		return mean, 0
	}
	ss := 0.0
	for _, x := range xs {
		ss += (x - mean) * (x - mean)
	}
	return mean, math.Sqrt(ss / float64(len(xs)-1))
}

// historicalFlaky flags cases whose pass/fail flipped at least twice across
// the given run history (oldest first). Two flips = it came back and broke
// again, which a single fix or regression does not produce.
func historicalFlaky(history map[string][]bool) map[string]bool {
	out := map[string]bool{}
	for name, seq := range history {
		flips := 0
		for i := 1; i < len(seq); i++ {
			if seq[i] != seq[i-1] {
				flips++
			}
		}
		if flips >= 2 {
			out[name] = true
		}
	}
	return out
}

type caseDelta struct {
	Name          string  `json:"name"`
	Score         float64 `json:"score"`
	BaselineScore float64 `json:"baselineScore"`
	Delta         float64 `json:"delta"`
	Passed        bool    `json:"passed"`
	BaselinePass  bool    `json:"baselinePassed"`
	Regressed     bool    `json:"regressed"`
	Flaky         bool    `json:"flaky,omitempty"`
}

// caseDeltas compares per-case results to the baseline's. A case regresses
// when it passed in the baseline and now fails, unless it is flaky — a flaky
// case still moves the aggregate score but cannot by itself fail the gate.
func caseDeltas(now, base []evalCaseResult, flaky map[string]bool) []caseDelta {
	bm := make(map[string]evalCaseResult, len(base))
	for _, b := range base {
		bm[b.Name] = b
	}
	var out []caseDelta
	for _, c := range now {
		b, ok := bm[c.Name]
		if !ok {
			continue
		}
		d := caseDelta{
			Name: c.Name, Score: c.Score, BaselineScore: b.Score, Delta: c.Score - b.Score,
			Passed: c.Passed, BaselinePass: b.Passed, Flaky: flaky[c.Name] || c.Flaky,
		}
		d.Regressed = b.Passed && !c.Passed && !d.Flaky
		out = append(out, d)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Delta < out[j].Delta })
	return out
}

// aggregateRegressed is the long-standing run-level rule (kept bit-for-bit):
// the score dropped more than 1 point (on a 0..1 scale, 0.01) below baseline.
func aggregateRegressed(score, baseline float64) bool {
	return score+0.01 < baseline && math.Abs(baseline-score) > 0.01
}
