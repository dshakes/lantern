package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

const goodManifest = `name: support-bot
version: "0.1.0"
model: auto
system_prompt: Answer politely.
limits:
  timeout: 5m
  max_cost_usd: 0.50
egress:
  - api.example.com
  - "*.example.org"
`

// Credential-shaped fixtures are assembled at runtime so no literal key sits in the repo.
var (
	fakeAWS    = "AKIA" + "ABCDEFGHIJKLMNOP"
	fakeSK     = "sk-" + "abcdefghijklmnopqrstuv"
	fakeDSNPw  = "hunter2" + "pw"
	fakeLitKey = "plainliteral" + "value"
)

func parse(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := yaml.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func rules(g ciGate) string {
	var r []string
	for _, f := range g.Findings {
		r = append(r, f.Rule)
	}
	return strings.Join(r, ",")
}

func TestLintManifest(t *testing.T) {
	dir := t.TempDir()
	if g := lintManifest(parse(t, goodManifest), dir); g.Status != gatePass {
		t.Fatalf("good manifest failed: %v", g.Findings)
	}
	cases := []struct{ name, yaml, want string }{
		{"bad name", "name: Bad_Name\nmodel: auto\nsystem_prompt: x\n", "PAL-LINT-001"},
		{"no model", "name: a\nsystem_prompt: x\n", "PAL-LINT-002"},
		{"no prompt or workflow", "name: a\nmodel: auto\n", "PAL-LINT-003"},
		{"bad timeout", "name: a\nmodel: auto\nsystem_prompt: x\nlimits: {timeout: soon}\n", "PAL-LINT-004"},
		{"zero cost", "name: a\nmodel: auto\nsystem_prompt: x\nlimits: {max_cost_usd: 0}\n", "PAL-LINT-005"},
		{"knowledge escape", "name: a\nmodel: auto\nsystem_prompt: x\nknowledge: [../etc/passwd]\n", "PAL-LINT-007"},
		{"knowledge missing", "name: a\nmodel: auto\nsystem_prompt: x\nknowledge: [docs/nope.md]\n", "PAL-LINT-008"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := lintManifest(parse(t, c.yaml), dir)
			if g.Status != gateFail || !strings.Contains(rules(g), c.want) {
				t.Fatalf("status=%s rules=%s, want %s", g.Status, rules(g), c.want)
			}
		})
	}
	// an unknown key is a warning, not a failure
	g := lintManifest(parse(t, goodManifest+"egres: []\n"), dir)
	if g.Status != gatePass || !strings.Contains(rules(g), "PAL-LINT-009") {
		t.Fatalf("unknown key: %s %v", g.Status, g.Findings)
	}
}

func TestPolicyLint(t *testing.T) {
	if g := policyLint(parse(t, goodManifest)); g.Status != gatePass {
		t.Fatalf("good manifest failed: %v", g.Findings)
	}
	base := "name: a\nmodel: auto\nsystem_prompt: x\negress: [api.example.com]\n"
	cases := []struct{ name, yaml, want string }{
		{"no egress key", "name: a\nmodel: auto\nsystem_prompt: x\n", "PAL-EGR-001"},
		{"wildcard egress", "name: a\nmodel: auto\negress: ['*']\n", "PAL-EGR-002"},
		{"tld wildcard", "name: a\nmodel: auto\negress: ['*.com']\n", "PAL-EGR-002"},
		{"scheme in egress", "name: a\nmodel: auto\negress: ['https://x.example.com']\n", "PAL-EGR-002"},
		{"aws key", base + "notes: " + fakeAWS + "\n", "PAL-SEC-001"},
		{"openai-style key", base + "extra: " + fakeSK + "\n", "PAL-SEC-001"},
		{"url userinfo", base + "dsn: postgres://u:" + fakeDSNPw + "@db.example.com/x\n", "PAL-SEC-001"},
		{"secret-named literal", base + "connectors:\n  - api_key: " + fakeLitKey + "\n", "PAL-SEC-002"},
		{"secret_key literal", base + "secret_key: " + fakeLitKey + "\n", "PAL-SEC-002"},
		{"vendor model", "name: a\nmodel: gpt-4o\negress: []\n", "PAL-MDL-001"},
		{"vendor model in workflow", base + "workflow:\n  nodes:\n    - data: {model: claude-sonnet-4-6}\n", "PAL-MDL-001"},
		{"url off allowlist", base + "webhook: https://evil.example.net/hook\n", "PAL-HST-001"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := policyLint(parse(t, c.yaml))
			if g.Status != gateFail || !strings.Contains(rules(g), c.want) {
				t.Fatalf("status=%s rules=%s, want %s", g.Status, rules(g), c.want)
			}
			for _, f := range g.Findings { // invariant #10: never echo the value
				for _, leak := range []string{fakeAWS, fakeSK, fakeDSNPw, fakeLitKey} {
					if strings.Contains(f.Message+f.Path, leak) {
						t.Fatalf("finding leaks secret value: %+v", f)
					}
				}
			}
		})
	}
	// negatives that must NOT trip
	ok := []string{
		base + "connectors:\n  - api_key: pal.secret/slack\n",
		base + "limits: {max_tokens: 1000}\ntoken_budget: x\n",
		base + "webhook: http://localhost:9191/x\n",
		base + "hook: https://api.example.com/x\n",
		base + "workflow:\n  nodes:\n    - data: {system_prompt: 'see https://docs.vendor.example/x'}\n",
		"name: a\nmodel: fast\nsystem_prompt: see https://docs.example.com\negress: []\n",
	}
	for i, y := range ok {
		if g := policyLint(parse(t, y)); g.Status != gatePass {
			t.Errorf("ok[%d] failed: %v", i, g.Findings)
		}
	}
}

func f64(v float64) *float64 { return &v }

func TestForecastGate(t *testing.T) {
	withCap := func(v float64) *ciForecast {
		f := &ciForecast{}
		f.Budget = &struct {
			MaxCostUsdPerRun float64 `json:"maxCostUsdPerRun"`
			MaxCostUsdPerDay float64 `json:"maxCostUsdPerDay"`
		}{MaxCostUsdPerRun: v}
		return f
	}
	if g := forecastGate(&ciForecast{EstimatedCostUsd: f64(0.1)}, 0.5, true); g.Status != gatePass {
		t.Fatalf("ok case: %v", g.Findings)
	}
	if g := forecastGate(&ciForecast{NoHistoricalData: true}, 0.5, true); g.Status != gatePass {
		t.Fatalf("no history with ceiling should pass: %v", g.Findings)
	}
	if g := forecastGate(&ciForecast{}, 0, false); !strings.Contains(rules(g), "PAL-BUD-001") {
		t.Fatalf("no ceiling anywhere must fail: %v", g.Findings)
	}
	if g := forecastGate(withCap(1), 0, false); g.Status != gatePass {
		t.Fatalf("server per-run budget satisfies the ceiling: %v", g.Findings)
	}
	if g := forecastGate(&ciForecast{WouldExceedBudget: true, BlockReason: "daily cap"}, 0.5, true); !strings.Contains(rules(g), "PAL-BUD-002") {
		t.Fatalf("wouldExceed: %v", g.Findings)
	}
	if g := forecastGate(&ciForecast{EstimatedCostUsd: f64(0.9)}, 0.5, true); !strings.Contains(rules(g), "PAL-BUD-003") {
		t.Fatalf("estimate over ceiling: %v", g.Findings)
	}
	f := withCap(0.2)
	f.EstimatedCostUsd = f64(0.3)
	if g := forecastGate(f, 0, false); !strings.Contains(rules(g), "PAL-BUD-003") {
		t.Fatalf("estimate over server cap: %v", g.Findings)
	}
}

func TestEvalGateFrom(t *testing.T) {
	pass := &evalRunResp{Passed: true, Score: 1, CasesTotal: 1, CasesPassed: 1, CaseResults: []evalRunCase{{Name: "c", Passed: true}}}
	if g := evalGateFrom(pass, "main"); g.Status != gatePass {
		t.Fatalf("pass: %v", g.Findings)
	}
	cases := map[string]*evalRunResp{
		"PAL-EVAL-001": {Passed: true},
		"PAL-EVAL-002": {CasesTotal: 1, CaseResults: []evalRunCase{{Name: "c", Error: "boom"}}},
		"PAL-EVAL-003": {Passed: true, CasesTotal: 1, CasesPassed: 1, Regressed: true, RegressedCases: []string{"c"}, CaseResults: []evalRunCase{{Name: "c", Passed: true}}},
		"PAL-EVAL-006": {Passed: false, CasesTotal: 2, CasesPassed: 1},
		"PAL-EVAL-004": {Passed: true, CasesTotal: 1, CasesPassed: 1, StoppedEarly: "cost ceiling", CaseResults: []evalRunCase{{Name: "c", Passed: true}}},
	}
	for want, r := range cases {
		if g := evalGateFrom(r, "main"); g.Status != gateFail || !strings.Contains(rules(g), want) {
			t.Errorf("%s: status=%s rules=%s", want, g.Status, rules(g))
		}
	}
}

func TestRenderCIFiles(t *testing.T) {
	p := ciInitParams{Agent: "support-bot", Suite: "ci", Manifest: "agent.yaml", Branch: "main"}
	a, b := renderCIFiles(p), renderCIFiles(p)
	for i := range a {
		if a[i] != b[i] {
			t.Fatal("generation is not deterministic")
		}
		c := a[i].Content
		for _, ph := range []string{"@AGENT@", "@SUITE@", "@MANIFEST@", "@BRANCH@"} {
			if strings.Contains(c, ph) {
				t.Fatalf("%s: unsubstituted placeholder %s", a[i].Path, ph)
			}
		}
		// no baked-in hosts: the API address comes only from the repo's own variable
		for _, bad := range []string{"pal." + "run", "pal." + "dev", "lan" + "tern", "sk-", "http://", "go install", "@latest", "setup-go"} {
			if strings.Contains(c, bad) {
				t.Errorf("%s contains %q", a[i].Path, bad)
			}
		}
		// `go install pkg@version` fails for modules with replace directives (packages/cli has one)
		if regexp.MustCompile(`go\s+install\s+\S*@`).MatchString(c) {
			t.Errorf("%s must never `go install pkg@version`", a[i].Path)
		}
		// the only hosts allowed: the GitHub release host (signed CLI, ADR 0044) and its OIDC issuer
		for _, u := range regexp.MustCompile(`https://[^/\s"]+`).FindAllString(c, -1) {
			if u != "https://github.com" && u != "https://token.actions.githubusercontent.com" && u != `https://github\.com` {
				t.Errorf("%s references unexpected host %s", a[i].Path, u)
			}
		}
		// every action is pinned by commit SHA
		for _, m := range regexp.MustCompile(`uses:\s*(\S+)`).FindAllStringSubmatch(c, -1) {
			if !regexp.MustCompile(`@[0-9a-f]{40}$`).MatchString(m[1]) {
				t.Errorf("%s: action %s is not pinned by commit SHA", a[i].Path, m[1])
			}
		}
	}
	var wf struct {
		Jobs map[string]struct {
			Steps []map[string]any `yaml:"steps"`
		} `yaml:"jobs"`
	}
	if err := yaml.Unmarshal([]byte(a[0].Content), &wf); err != nil || len(wf.Jobs["gate"].Steps) < 4 {
		t.Fatalf("workflow is not valid YAML with a gate job: %v", err)
	}
	if !strings.Contains(a[1].Content, `--agent "support-bot" --suite "ci" --manifest "agent.yaml"`) {
		t.Fatal("script lacks the gate invocation")
	}
	dir := t.TempDir()
	sh := filepath.Join(dir, "ci.sh")
	_ = os.WriteFile(sh, []byte(a[1].Content), 0o755)
	if out, err := exec.Command("sh", "-n", sh).CombinedOutput(); err != nil {
		t.Fatalf("sh -n: %v %s", err, out)
	}
	if sc, err := exec.LookPath("shellcheck"); err == nil {
		if out, err := exec.Command(sc, sh).CombinedOutput(); err != nil {
			t.Fatalf("shellcheck: %s", out)
		}
	}
}

func TestInitParamsRejectInjection(t *testing.T) {
	ok := ciInitParams{Agent: "a", Suite: "ci", Manifest: "agent.yaml", Branch: "main"}
	if err := ok.validate(); err != nil {
		t.Fatal(err)
	}
	bad := []ciInitParams{
		{"a; rm -rf /", "ci", "agent.yaml", "main"},
		{"a", "ci\nrun: evil", "agent.yaml", "main"},
		{"a", "ci", "../agent.yaml", "main"},
		{"a", "ci", "/etc/agent.yaml", "main"},
		{"a", "ci", "agent.yaml", "main]\npermissions: write-all"},
		{"a", "ci", "agent.yaml", "a..b"},
		{"a", "$(id)", "agent.yaml", "main"},
		{"A", "ci", "agent.yaml", "main"},
	}
	for _, p := range bad {
		if p.validate() == nil {
			t.Errorf("accepted %+v", p)
		}
	}
}

func runCI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCICommand()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestCIInit(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "agent.yaml"), []byte(goodManifest), 0o644)

	if _, err := runCI(t, "init", "--dir", dir, "--dry-run"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ciWorkflowPath)); err == nil {
		t.Fatal("dry-run wrote a file")
	}
	out, err := runCI(t, "init", "--dir", dir, "--dry-run", "--json")
	var j struct {
		Files   []ciFile `json:"files"`
		Written bool     `json:"written"`
	}
	if err != nil || json.Unmarshal([]byte(out), &j) != nil || len(j.Files) != 2 || j.Written {
		t.Fatalf("dry-run json: %v %s", err, out)
	}
	if !strings.Contains(j.Files[1].Content, `--agent "support-bot"`) {
		t.Fatal("agent not defaulted from the manifest")
	}

	if _, err := runCI(t, "init", "--dir", dir); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(filepath.Join(dir, ciScriptPath)); err != nil || fi.Mode()&0o111 == 0 {
		t.Fatalf("script missing or not executable: %v", err)
	}
	if _, err := runCI(t, "init", "--dir", dir); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("overwrite without --force must fail, got %v", err)
	}
	if _, err := runCI(t, "init", "--dir", dir, "--check"); err != nil {
		t.Fatalf("fresh files must pass --check: %v", err)
	}
	_ = os.WriteFile(filepath.Join(dir, ciWorkflowPath), []byte("hand edited"), 0o644)
	if _, err := runCI(t, "init", "--dir", dir, "--check"); err == nil {
		t.Fatal("--check must detect drift")
	}
	if _, err := runCI(t, "init", "--dir", dir, "--force"); err != nil {
		t.Fatal(err)
	}

	// a symlinked target must never be written through
	d2 := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	_ = os.WriteFile(victim, []byte("keep"), 0o644)
	_ = os.MkdirAll(filepath.Join(d2, ".github/workflows"), 0o755)
	_ = os.Symlink(victim, filepath.Join(d2, ciWorkflowPath))
	if _, err := runCI(t, "init", "--dir", d2, "--agent", "a", "--force"); err == nil {
		t.Fatal("wrote through a symlink")
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep" {
		t.Fatal("symlink target was modified")
	}
}

func TestCIContractIsValidJSON(t *testing.T) {
	out, err := runCI(t, "contract")
	var v map[string]any
	if err != nil || json.Unmarshal([]byte(out), &v) != nil || v["name"] != "generate_ci_gate" {
		t.Fatalf("contract: %v %s", err, out)
	}
}

// ---- check, end to end against a fake control plane ----

type ciServer struct {
	mu           sync.Mutex
	calls        []string
	evalCode     int
	evalBody     string
	forecastCode int
	forecast     string
}

func (s *ciServer) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.calls = append(s.calls, r.Method+" "+r.URL.Path)
		s.mu.Unlock()
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/eval-suites":
			_, _ = w.Write([]byte(`[{"id":"s1","agentName":"support-bot","name":"ci","cases":[{"name":"c","input":"hi"}]}]`))
		case r.URL.Path == "/v1/eval-suites/s1/run":
			w.WriteHeader(s.evalCode)
			_, _ = w.Write([]byte(s.evalBody))
		case r.URL.Path == "/v1/runs/forecast":
			if s.forecastCode != 0 {
				w.WriteHeader(s.forecastCode)
			}
			_, _ = w.Write([]byte(s.forecast))
		default:
			w.WriteHeader(404)
		}
	})
}

func (s *ciServer) called(suffix string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.calls {
		if strings.HasSuffix(c, suffix) {
			return true
		}
	}
	return false
}

const evalOK = `{"id":"r","passed":true,"score":1,"casesTotal":1,"casesPassed":1,"caseResults":[{"name":"c","passed":true,"score":1}]}`
const fcOK = `{"estimatedCostUsd":0.01,"wouldExceedBudget":false}`

func ciFixture(t *testing.T, manifest string, s *ciServer) (ciCheckOpts, func()) {
	t.Helper()
	srv := httptest.NewServer(s.handler())
	dir := t.TempDir()
	mp := filepath.Join(dir, "agent.yaml")
	_ = os.WriteFile(mp, []byte(manifest), 0o644)
	oldURL, oldKey := flags.apiURL, flags.apiKey
	flags.apiURL, flags.apiKey = srv.URL, "tok"
	return ciCheckOpts{suite: "ci", manifest: mp, branch: "main",
			report: filepath.Join(dir, "r.json"), summary: filepath.Join(dir, "s.md")},
		func() { srv.Close(); flags.apiURL, flags.apiKey = oldURL, oldKey }
}

func readReport(t *testing.T, o ciCheckOpts) ciReport {
	t.Helper()
	var r ciReport
	b, err := os.ReadFile(o.report)
	if err != nil || json.Unmarshal(b, &r) != nil {
		t.Fatalf("report: %v", err)
	}
	if _, err := os.Stat(o.summary); err != nil {
		t.Fatal("summary missing")
	}
	return r
}

func gateStatus(r ciReport) string {
	var p []string
	for _, g := range r.Gates {
		p = append(p, g.ID+"="+g.Status)
	}
	return strings.Join(p, " ")
}

func TestCICheck(t *testing.T) {
	cases := []struct {
		name         string
		evalCode     int
		evalBody     string
		forecastCode int
		forecast     string
		wantErr      bool
		want         string
	}{
		{"all green", 200, evalOK, 0, fcOK, false, "lint=pass policy=pass eval=pass budget=pass"},
		{"failing case", 200, `{"id":"r","passed":false,"score":0,"casesTotal":1,"casesPassed":0,"caseResults":[{"name":"c","passed":false}]}`, 0, fcOK, true, "eval=fail budget=pass"},
		{"422 regression", 422, `{"id":"r","passed":true,"score":0.5,"casesTotal":1,"casesPassed":1,"regressed":true,"regressedCases":["c"],"caseResults":[{"name":"c","passed":true}]}`, 0, fcOK, true, "eval=fail"},
		{"402 eval budget", 402, `{"error":"budget exceeded","code":"budget_exceeded"}`, 0, fcOK, true, "eval=error"},
		{"over budget", 200, evalOK, 0, `{"estimatedCostUsd":9,"wouldExceedBudget":false}`, true, "eval=pass budget=fail"},
		{"forecast 500 fails closed", 200, evalOK, 500, `{"error":"boom"}`, true, "eval=pass budget=error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &ciServer{evalCode: c.evalCode, evalBody: c.evalBody, forecastCode: c.forecastCode, forecast: c.forecast}
			o, done := ciFixture(t, goodManifest, s)
			defer done()
			var out bytes.Buffer
			err := runCICheck(context.Background(), o, &out)
			if (err != nil) != c.wantErr {
				t.Fatalf("err=%v wantErr=%v\n%s", err, c.wantErr, out.String())
			}
			r := readReport(t, o)
			if r.Passed == c.wantErr {
				t.Fatalf("report.passed=%v disagrees with exit", r.Passed)
			}
			if !strings.Contains(gateStatus(r), c.want) {
				t.Fatalf("gates = %q, want containing %q", gateStatus(r), c.want)
			}
			if r.Schema != ciReportSchema || !strings.Contains(out.String(), "<!-- pal-ci-report -->") {
				t.Fatal("schema or PR summary marker missing")
			}
		})
	}
}

func TestCICheckPolicyFailureSpendsNothing(t *testing.T) {
	s := &ciServer{evalCode: 200, evalBody: evalOK, forecast: fcOK}
	o, done := ciFixture(t, "name: support-bot\nmodel: gpt-4o\nsystem_prompt: x\negress: []\n", s)
	defer done()
	if err := runCICheck(context.Background(), o, &bytes.Buffer{}); err == nil {
		t.Fatal("vendor-addressed model must fail the gate")
	}
	if s.called("/run") || s.called("/forecast") {
		t.Fatalf("network gates ran after a policy failure: %v", s.calls)
	}
	if r := readReport(t, o); !strings.Contains(gateStatus(r), "eval=skipped budget=skipped") || r.Passed {
		t.Fatalf("gates = %s passed=%v", gateStatus(r), r.Passed)
	}
}

func TestCICheckNoCredentialsFailsClosed(t *testing.T) {
	s := &ciServer{}
	o, done := ciFixture(t, goodManifest, s)
	defer done()
	flags.apiKey = ""
	if err := runCICheck(context.Background(), o, &bytes.Buffer{}); err == nil {
		t.Fatal("missing credentials must fail, not skip")
	}
	if r := readReport(t, o); !strings.Contains(gateStatus(r), "eval=error budget=error") {
		t.Fatalf("gates = %s", gateStatus(r))
	}
}

func TestCICheckStageGuard(t *testing.T) {
	s := &ciServer{evalCode: 200, evalBody: evalOK, forecast: fcOK}
	o, done := ciFixture(t, goodManifest, s)
	defer done()
	staged := 0
	o.stage = true
	o.stageFn = func(context.Context, []byte) error { staged++; return nil }

	t.Setenv("PAL_CI_STAGING_ACK", "")
	if err := runCICheck(context.Background(), o, &bytes.Buffer{}); err == nil || staged != 0 || s.called("/run") {
		t.Fatalf("staging without ack must refuse before any mutation (err=%v staged=%d)", err, staged)
	}
	t.Setenv("PAL_CI_STAGING_ACK", "1")
	if err := runCICheck(context.Background(), o, &bytes.Buffer{}); err != nil || staged != 1 {
		t.Fatalf("with ack: err=%v staged=%d", err, staged)
	}
}

func TestCIManifestUnreadable(t *testing.T) {
	d := t.TempDir()
	o := ciCheckOpts{manifest: filepath.Join(d, "missing.yaml"), report: filepath.Join(d, "r.json"), summary: filepath.Join(d, "s.md")}
	if err := runCICheck(context.Background(), o, &bytes.Buffer{}); err == nil {
		t.Fatal("missing manifest must fail")
	}
	if r := readReport(t, o); r.Passed || !strings.Contains(gateStatus(r), "lint=error") {
		t.Fatalf("gates = %s", gateStatus(r))
	}
}
