package cli

// Deterministic CI gates for an agent repo (ADR 0053). Nothing here calls a
// model: pass/fail is decided by code reading the manifest and the server's
// numeric responses, so the same inputs always give the same verdict.

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const ciReportSchema = "pal.ci.report/v1"

// Gate statuses. Only "pass" counts as green; skipped/error fail the run.
const (
	gatePass    = "pass"
	gateFail    = "fail"
	gateError   = "error" // the gate could not decide (server down, bad config)
	gateSkipped = "skipped"
)

type ciFinding struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"` // error | warn
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

type ciGate struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Status   string         `json:"status"`
	Summary  string         `json:"summary"`
	Findings []ciFinding    `json:"findings,omitempty"`
	Metrics  map[string]any `json:"metrics,omitempty"`
}

type ciReport struct {
	Schema    string   `json:"schema"`
	Agent     string   `json:"agent"`
	Suite     string   `json:"suite,omitempty"`
	Branch    string   `json:"branch,omitempty"`
	CommitSha string   `json:"commitSha,omitempty"`
	Passed    bool     `json:"passed"`
	Gates     []ciGate `json:"gates"`
}

func (r *ciReport) finish() {
	r.Schema = ciReportSchema
	r.Passed = len(r.Gates) > 0
	for _, g := range r.Gates {
		if g.Status != gatePass {
			r.Passed = false
		}
	}
}

// finalize derives a gate's status from its findings: any error finding fails it.
func (g *ciGate) finalize(passMsg string) {
	n := 0
	for _, f := range g.Findings {
		if f.Severity == "error" {
			n++
		}
	}
	g.Status = gatePass
	g.Summary = passMsg
	if n > 0 {
		g.Status = gateFail
		g.Summary = fmt.Sprintf("%d error(s)", n)
	}
}

// loadManifest reads agent.yaml as a generic tree: the policy gate must see
// keys the deploy struct silently ignores (a typo'd `egres:` would otherwise
// read as "no egress configured" only by luck).
func loadManifest(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var m map[string]any
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if m == nil {
		return nil, fmt.Errorf("%s is empty", path)
	}
	return m, nil
}

var (
	kebabName     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	knownTopLevel = map[string]bool{
		"name": true, "version": true, "description": true, "model": true, "system_prompt": true,
		"workflow": true, "labels": true, "limits": true, "isolation": true, "egress": true,
		"knowledge": true, "tools": true, "triggers": true, "memory": true, "connectors": true,
		"kind": true, "metadata": true, "spec": true,
	}
)

func str(v any) string { s, _ := v.(string); return s }

// lintManifest is gate 1: structural validity.
func lintManifest(m map[string]any, dir string) ciGate {
	g := ciGate{ID: "lint", Title: "Manifest lint"}
	add := func(rule, sev, path, msg string) {
		g.Findings = append(g.Findings, ciFinding{Rule: rule, Severity: sev, Path: path, Message: msg})
	}
	if n := str(m["name"]); !kebabName.MatchString(n) {
		add("PAL-LINT-001", "error", "name", "name is required and must be kebab-case (a-z, 0-9, '-', max 63 chars)")
	}
	if strings.TrimSpace(str(m["model"])) == "" {
		add("PAL-LINT-002", "error", "model", "model is required (use a capability such as `auto` or `fast`)")
	}
	_, hasWF := m["workflow"]
	if strings.TrimSpace(str(m["system_prompt"])) == "" && !hasWF {
		add("PAL-LINT-003", "error", "system_prompt", "the agent needs a system_prompt or a workflow")
	}
	if lim, ok := m["limits"].(map[string]any); ok {
		if t := str(lim["timeout"]); t != "" {
			if d, err := time.ParseDuration(t); err != nil || d <= 0 {
				add("PAL-LINT-004", "error", "limits.timeout", "timeout must be a positive duration such as `5m`")
			}
		}
		if c, ok := toFloat(lim["max_cost_usd"]); ok && c <= 0 {
			add("PAL-LINT-005", "error", "limits.max_cost_usd", "max_cost_usd must be greater than 0")
		}
	} else if _, present := m["limits"]; present {
		add("PAL-LINT-006", "error", "limits", "limits must be a mapping")
	}
	if ks, ok := m["knowledge"].([]any); ok {
		for i, k := range ks {
			p := str(k)
			if p == "" {
				continue
			}
			clean := filepath.Clean(p)
			if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
				add("PAL-LINT-007", "error", fmt.Sprintf("knowledge[%d]", i), "knowledge paths must stay inside the repo")
				continue
			}
			if _, err := os.Stat(filepath.Join(dir, clean)); err != nil {
				add("PAL-LINT-008", "error", fmt.Sprintf("knowledge[%d]", i), "file not found: "+clean)
			}
		}
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		if !knownTopLevel[k] {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		add("PAL-LINT-009", "warn", k, "unknown top-level key (ignored by deploy; typo?)")
	}
	g.finalize("manifest is well-formed")
	return g
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

var (
	secretValue = regexp.MustCompile(`AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|pal_brg_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|://[^/\s:@]+:[^/\s@]+@`)
	secretKey   = regexp.MustCompile(`(?i)(^|[_-])((api|secret|private|access|signing|auth)[_-]?key|secret|password|passwd|token|credential)$`)
	vendorModel = regexp.MustCompile(`(?i)^(gpt|chatgpt|o[0-9]|claude|gemini|llama|mistral|mixtral|command|grok|deepseek|qwen|text-embedding)|/`)
	urlInText   = regexp.MustCompile(`https?://[^\s"'<>)\]]+`)
)

func isSecretRef(s string) bool {
	return strings.HasPrefix(s, "pal.secret/") || strings.HasPrefix(s, "${") || strings.HasPrefix(s, "{{") || strings.HasPrefix(s, "$")
}

// walk visits every scalar string with its dotted path.
func walk(v any, path string, fn func(path, key, val string)) {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			p := k
			if path != "" {
				p = path + "." + k
			}
			if s, ok := x[k].(string); ok {
				fn(p, k, s)
				continue
			}
			walk(x[k], p, fn)
		}
	case []any:
		for i, e := range x {
			p := fmt.Sprintf("%s[%d]", path, i)
			if s, ok := e.(string); ok {
				fn(p, "", s)
				continue
			}
			walk(e, p, fn)
		}
	}
}

// egressPatterns extracts the declared allowlist. ok=false means the key is
// absent (a missing decision), distinct from an explicit empty deny-all list.
func egressPatterns(m map[string]any) (pats []string, ok bool) {
	raw, present := m["egress"]
	if !present {
		return nil, false
	}
	list, _ := raw.([]any)
	for _, e := range list {
		switch x := e.(type) {
		case string:
			pats = append(pats, strings.ToLower(strings.TrimSpace(x)))
		case map[string]any:
			p := str(x["pattern"])
			if p == "" {
				p = str(x["host"])
			}
			pats = append(pats, strings.ToLower(strings.TrimSpace(p)))
		}
	}
	return pats, true
}

func hostAllowed(host string, pats []string) bool {
	host = strings.ToLower(host)
	for _, p := range pats {
		if p == host || (strings.HasPrefix(p, "*.") && strings.HasSuffix(host, p[1:])) {
			return true
		}
	}
	return false
}

func isLoopback(h string) bool { return h == "localhost" || h == "127.0.0.1" || h == "::1" }

// policyLint is gate 2: security rules over the manifest. Values are never
// echoed into findings (invariant #10) -- only the path and the rule.
func policyLint(m map[string]any) ciGate {
	g := ciGate{ID: "policy", Title: "Policy and security lint"}
	add := func(rule, path, msg string) {
		g.Findings = append(g.Findings, ciFinding{Rule: rule, Severity: "error", Path: path, Message: msg})
	}

	pats, declared := egressPatterns(m)
	switch {
	case !declared:
		add("PAL-EGR-001", "egress", "no egress allowlist declared; add `egress: []` to deny all or list the hosts the agent may reach")
	default:
		for _, p := range pats {
			if p == "" || p == "*" || p == "*.*" || p == "**" || strings.HasPrefix(p, "*") && !strings.HasPrefix(p, "*.") || strings.Contains(p, "://") || strings.HasPrefix(p, "*.") && strings.Count(p, ".") < 2 {
				add("PAL-EGR-002", "egress", "egress entries must be exact hostnames or `*.domain` (no bare wildcards, no schemes)")
				break
			}
		}
	}

	walk(m, "", func(path, key, val string) {
		if secretValue.MatchString(val) {
			add("PAL-SEC-001", path, "value looks like a credential; use a `pal.secret/...` reference")
		} else if secretKey.MatchString(key) && len(val) >= 8 && !isSecretRef(val) {
			add("PAL-SEC-002", path, "secret-named key holds a literal; use a `pal.secret/...` reference")
		}
		if key == "model" && vendorModel.MatchString(strings.TrimSpace(val)) {
			add("PAL-MDL-001", path, "model must be addressed by capability (`auto`, `fast`, `reasoning-large`), not a vendor model id")
		}
		if strings.HasSuffix(path, "system_prompt") || strings.HasSuffix(path, "description") {
			return
		}
		for _, u := range urlInText.FindAllString(val, -1) {
			pu, err := url.Parse(u)
			if err != nil || pu.Hostname() == "" {
				continue
			}
			if h := pu.Hostname(); !isLoopback(h) && !hostAllowed(h, pats) {
				add("PAL-HST-001", path, "URL host is not in the egress allowlist: "+h)
			}
		}
	})
	g.finalize("no policy violations")
	return g
}

// manifestCostCeiling returns limits.max_cost_usd when set.
func manifestCostCeiling(m map[string]any) (float64, bool) {
	lim, _ := m["limits"].(map[string]any)
	c, ok := toFloat(lim["max_cost_usd"])
	return c, ok && c > 0
}

// forecastGate is gate 4: the run must be bounded and within budget. The
// forecast is numeric (history average), so the decision is plain arithmetic.
func forecastGate(f *ciForecast, manifestCeiling float64, haveCeiling bool) ciGate {
	g := ciGate{ID: "budget", Title: "Budget and cost forecast", Metrics: map[string]any{}}
	add := func(rule, msg string) {
		g.Findings = append(g.Findings, ciFinding{Rule: rule, Severity: "error", Message: msg})
	}
	serverCap := 0.0
	if f.Budget != nil {
		serverCap = f.Budget.MaxCostUsdPerRun
		g.Metrics["maxCostUsdPerRun"] = serverCap
		g.Metrics["maxCostUsdPerDay"] = f.Budget.MaxCostUsdPerDay
	}
	if f.EstimatedCostUsd != nil {
		g.Metrics["estimatedCostUsd"] = *f.EstimatedCostUsd
	}
	g.Metrics["noHistoricalData"] = f.NoHistoricalData
	if !haveCeiling && serverCap <= 0 {
		add("PAL-BUD-001", "no per-run cost ceiling: set `limits.max_cost_usd` in agent.yaml or a per-run budget on the agent")
	}
	if f.WouldExceedBudget {
		add("PAL-BUD-002", "forecast would exceed the budget: "+f.BlockReason)
	}
	if f.EstimatedCostUsd != nil {
		for _, c := range []struct {
			v    float64
			ok   bool
			what string
		}{{manifestCeiling, haveCeiling, "limits.max_cost_usd"}, {serverCap, serverCap > 0, "the agent's per-run budget"}} {
			if c.ok && *f.EstimatedCostUsd > c.v {
				add("PAL-BUD-003", fmt.Sprintf("estimated cost $%.4f exceeds %s ($%.4f)", *f.EstimatedCostUsd, c.what, c.v))
			}
		}
	}
	g.finalize("within budget")
	if g.Status == gatePass && f.NoHistoricalData {
		g.Summary = "within budget (no run history; estimate unavailable, ceiling checked only)"
	}
	return g
}

type ciForecast struct {
	EstimatedCostUsd  *float64 `json:"estimatedCostUsd"`
	NoHistoricalData  bool     `json:"noHistoricalData"`
	WouldExceedBudget bool     `json:"wouldExceedBudget"`
	BlockReason       string   `json:"blockReason"`
	Budget            *struct {
		MaxCostUsdPerRun float64 `json:"maxCostUsdPerRun"`
		MaxCostUsdPerDay float64 `json:"maxCostUsdPerDay"`
	} `json:"budget"`
}

// evalGateFrom is gate 3's verdict over a server eval-run response. An
// incomplete run (stopped early) or an empty suite never counts as a pass.
func evalGateFrom(r *evalRunResp, branch string) ciGate {
	g := ciGate{ID: "eval", Title: "Hermetic eval suite", Metrics: map[string]any{
		"score": r.Score, "casesPassed": r.CasesPassed, "casesTotal": r.CasesTotal,
		"costUsd": r.TotalCostUsd, "regressed": r.Regressed,
	}}
	add := func(rule, path, msg string) {
		g.Findings = append(g.Findings, ciFinding{Rule: rule, Severity: "error", Path: path, Message: msg})
	}
	if r.CasesTotal == 0 {
		add("PAL-EVAL-001", "", "the suite has no cases; an empty suite proves nothing")
	}
	for _, c := range r.CaseResults {
		if !c.Passed {
			msg := "case failed"
			if c.Error != "" {
				msg += ": " + c.Error
			}
			add("PAL-EVAL-002", c.Name, msg)
		}
	}
	// Trust the server's own verdict and counts too, not only the per-case rows:
	// a response with no caseResults must not read as green.
	if !r.Passed || r.CasesPassed != r.CasesTotal {
		add("PAL-EVAL-006", "", fmt.Sprintf("server verdict: passed=%v, %d/%d cases passed", r.Passed, r.CasesPassed, r.CasesTotal))
	}
	if r.Regressed {
		if r.BaselineScore != nil {
			g.Metrics["baselineScore"] = *r.BaselineScore
		}
		msg := "regressed vs. the " + branch + " baseline"
		if len(r.RegressedCases) > 0 {
			msg += ": " + strings.Join(r.RegressedCases, ", ")
		}
		add("PAL-EVAL-003", "", msg)
	}
	if r.StoppedEarly != "" {
		add("PAL-EVAL-004", "", "run stopped early ("+r.StoppedEarly+"); results are incomplete")
	}
	if len(r.FlakyCases) > 0 {
		g.Findings = append(g.Findings, ciFinding{Rule: "PAL-EVAL-005", Severity: "warn", Message: "flaky: " + strings.Join(r.FlakyCases, ", ")})
	}
	g.finalize(fmt.Sprintf("%d/%d cases passed, score %.2f", r.CasesPassed, r.CasesTotal, r.Score))
	return g
}

// renderMarkdown is the PR summary. Findings are paths and rule ids only.
func renderMarkdown(r *ciReport) string {
	var b strings.Builder
	head := "PASSED"
	if !r.Passed {
		head = "FAILED"
	}
	fmt.Fprintf(&b, "<!-- pal-ci-report -->\n### PAL agent CI: %s\n\nAgent `%s`", head, r.Agent)
	if r.Suite != "" {
		fmt.Fprintf(&b, " · suite `%s`", r.Suite)
	}
	if r.CommitSha != "" {
		fmt.Fprintf(&b, " · commit `%.12s`", r.CommitSha)
	}
	b.WriteString("\n\n| Gate | Result | Detail |\n| --- | --- | --- |\n")
	for _, g := range r.Gates {
		fmt.Fprintf(&b, "| %s | %s | %s |\n", g.Title, strings.ToUpper(g.Status), strings.ReplaceAll(g.Summary, "|", "/"))
	}
	for _, g := range r.Gates {
		if len(g.Findings) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n**%s**\n\n", g.Title)
		for _, f := range g.Findings {
			loc := ""
			if f.Path != "" {
				loc = " `" + f.Path + "`"
			}
			fmt.Fprintf(&b, "- %s `%s`%s: %s\n", f.Severity, f.Rule, loc, f.Message)
		}
	}
	return b.String()
}
