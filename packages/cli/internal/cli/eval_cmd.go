package cli

// `pal eval` drives the hermetic, LLM-judged eval endpoints (ADR 0052):
// run a saved suite server-side, have the agent draft a suite for human
// approval, and calibrate the judge against human feedback. `pal test` keeps
// running cases client-side against live runs.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

type evalAssertion struct {
	Kind      string  `json:"kind"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Skipped   bool    `json:"skipped,omitempty"`
	Detail    string  `json:"detail,omitempty"`
	Rationale string  `json:"rationale,omitempty"`
}

type evalRunCase struct {
	Name         string          `json:"name"`
	Passed       bool            `json:"passed"`
	Score        float64         `json:"score"`
	Error        string          `json:"error,omitempty"`
	LatencyMs    int64           `json:"latencyMs"`
	CostUsd      float64         `json:"costUsd"`
	JudgeCostUsd float64         `json:"judgeCostUsd"`
	Stddev       float64         `json:"stddev"`
	Flaky        bool            `json:"flaky"`
	Assertions   []evalAssertion `json:"assertions"`
}

type evalCaseDeltaView struct {
	Name          string  `json:"name"`
	Score         float64 `json:"score"`
	BaselineScore float64 `json:"baselineScore"`
	Delta         float64 `json:"delta"`
	Regressed     bool    `json:"regressed"`
}

type evalRunResp struct {
	ID             string              `json:"id"`
	Passed         bool                `json:"passed"`
	Score          float64             `json:"score"`
	CasesTotal     int                 `json:"casesTotal"`
	CasesPassed    int                 `json:"casesPassed"`
	Regressed      bool                `json:"regressed"`
	BaselineScore  *float64            `json:"baselineScore"`
	CaseDeltas     []evalCaseDeltaView `json:"caseDeltas"`
	RegressedCases []string            `json:"regressedCases"`
	FlakyCases     []string            `json:"flakyCases"`
	CaseResults    []evalRunCase       `json:"caseResults"`
	DurationMs     int64               `json:"durationMs"`
	TotalCostUsd   float64             `json:"totalCostUsd"`
	PinnedBaseline bool                `json:"pinnedBaseline"`
	StoppedEarly   string              `json:"stoppedEarly"`
}

type evalGenResp struct {
	Draft      json.RawMessage `json:"draft"`
	Provenance []struct {
		Case      string   `json:"case"`
		Source    string   `json:"source"`
		Grounding string   `json:"grounding"`
		Notes     []string `json:"notes"`
	} `json:"provenance"`
	Dropped []struct {
		Name   string `json:"name"`
		Reason string `json:"reason"`
	} `json:"dropped"`
	CostUsd float64 `json:"costUsd"`
}

type evalCalResp struct {
	Stats struct {
		N         int     `json:"n"`
		Labeled   int     `json:"labeled"`
		Agreement float64 `json:"agreement"`
		Kappa     float64 `json:"kappa"`
		MAE       float64 `json:"mae"`
	} `json:"stats"`
	Verdict string  `json:"verdict"`
	Rubric  string  `json:"rubric"`
	Note    string  `json:"note"`
	CostUsd float64 `json:"costUsd"`
}

func newEvalCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "eval",
		Short: "Hermetic LLM-judged evals: run, generate, approve, calibrate",
	}
	cmd.AddCommand(newEvalRunCommand(), newEvalGenerateCommand(), newEvalApproveCommand(), newEvalCalibrateCommand())
	return cmd
}

// evalAuth returns the REST base URL and token, or an error when logged out.
func evalAuth() (string, string, error) {
	token := resolveToken()
	if token == "" {
		return "", "", fmt.Errorf("not authenticated — run `pal login` or set PAL_API_KEY")
	}
	return deriveRESTURL(flags.apiURL), token, nil
}

// evalPost POSTs a JSON body and returns the status and raw response.
func evalPost(ctx context.Context, base, token, path string, body any) (int, []byte, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(buf))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	return res.StatusCode, raw, err
}

// evalServerError renders a non-success body using the server's error/code text.
func evalServerError(what string, status int, raw []byte) error {
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Error != "" {
		if e.Code != "" {
			return fmt.Errorf("%s: %d %s (%s)", what, status, e.Error, e.Code)
		}
		return fmt.Errorf("%s: %d %s", what, status, e.Error)
	}
	return fmt.Errorf("%s: %d %s", what, status, strings.TrimSpace(string(raw)))
}

type evalRunOpts struct {
	agent, suite, judgeModel, branch string
	samples, judgeSamples            int
	maxCost                          float64
	cases                            []string
	setBaseline, jsonOut             bool
}

func newEvalRunCommand() *cobra.Command {
	var o evalRunOpts
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run a suite hermetically on the server (mocked tools, LLM judge)",
		Long: `Runs a saved eval suite server-side with mocked tools and optional
LLM-judge assertions (ADR 0052). Exits non-zero when any case fails or the
run regressed vs. the branch baseline.

Example:
  pal eval run --agent=support --suite=core --samples=3 --set-baseline`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if o.agent == "" || o.suite == "" {
				return fmt.Errorf("--agent and --suite are required")
			}
			base, token, err := evalAuth()
			if err != nil {
				return err
			}
			return runEval(cmd.Context(), base, token, o, cmd.OutOrStdout())
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.agent, "agent", "", "Agent name")
	f.StringVar(&o.suite, "suite", "", "Eval suite name")
	f.IntVar(&o.samples, "samples", 0, "Agent samples per case (overrides the suite, 1..5)")
	f.IntVar(&o.judgeSamples, "judge-samples", 0, "Judge samples per judged assertion")
	f.StringVar(&o.judgeModel, "judge-model", "", "Judge model capability (e.g. reasoning-large)")
	f.Float64Var(&o.maxCost, "max-cost", 0, "Hard cost ceiling in USD (server default 1.00)")
	f.StringArrayVar(&o.cases, "case", nil, "Run only this case (repeatable)")
	f.BoolVar(&o.setBaseline, "set-baseline", false, "Pin this run as the branch baseline (all-pass, non-regressed only)")
	f.StringVar(&o.branch, "branch", "", "Branch for baseline comparison (default: git branch)")
	f.BoolVar(&o.jsonOut, "json", false, "Emit JSON")
	return cmd
}

// execEvalRun runs the suite server-side and returns the decoded result plus
// the raw body. A 422 (regression) is a result, not an error.
func execEvalRun(ctx context.Context, base, token string, o evalRunOpts) (*evalRunResp, []byte, string, error) {
	s, err := fetchSuite(ctx, base, token, o.agent, o.suite)
	if err != nil {
		return nil, nil, "", err
	}
	branch := o.branch
	if branch == "" {
		branch = gitBranch()
	}
	body := map[string]any{
		"branch": branch, "commitSha": gitSha(), "samples": o.samples, "judgeSamples": o.judgeSamples,
		"judgeModel": o.judgeModel, "maxCostUsd": o.maxCost, "cases": o.cases, "setBaseline": o.setBaseline,
	}
	for k, v := range body { // omit zero values so server defaults apply
		switch x := v.(type) {
		case int:
			if x == 0 {
				delete(body, k)
			}
		case float64:
			if x == 0 {
				delete(body, k)
			}
		case string:
			if x == "" {
				delete(body, k)
			}
		case []string:
			if len(x) == 0 {
				delete(body, k)
			}
		}
	}
	status, raw, err := evalPost(ctx, base, token, "/v1/eval-suites/"+url.PathEscape(s.ID)+"/run", body)
	if err != nil {
		return nil, nil, branch, fmt.Errorf("eval run: %w", err)
	}
	if status != http.StatusOK && status != http.StatusUnprocessableEntity {
		return nil, nil, branch, evalServerError("eval run", status, raw) // 400/402/503: server text
	}
	var r evalRunResp
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, nil, branch, fmt.Errorf("eval run: decode response: %w", err)
	}
	if status == http.StatusUnprocessableEntity {
		r.Regressed = true
	}
	return &r, raw, branch, nil
}

func runEval(ctx context.Context, base, token string, o evalRunOpts, out io.Writer) error {
	r, raw, branch, err := execEvalRun(ctx, base, token, o)
	if err != nil {
		return err
	}
	if o.jsonOut {
		_, _ = out.Write(append(bytes.TrimSpace(raw), '\n'))
	} else {
		printEvalRun(out, r, o.agent, branch)
	}
	if r.Regressed {
		return fmt.Errorf("regression vs. baseline on %s", branch)
	}
	if !r.Passed {
		return fmt.Errorf("eval failed: %d/%d cases passed", r.CasesPassed, r.CasesTotal)
	}
	return nil
}

func printEvalRun(w io.Writer, r *evalRunResp, agent, branch string) {
	for _, c := range r.CaseResults {
		mark := "FAIL"
		switch {
		case c.Passed:
			mark = "PASS"
		case c.Flaky:
			mark = "FLAKY"
		}
		fmt.Fprintf(w, "  [%s] %s  score=%.2f±%.2f  %dms  $%.4f\n", mark, c.Name, c.Score, c.Stddev, c.LatencyMs, c.CostUsd+c.JudgeCostUsd)
		if c.Error != "" {
			fmt.Fprintf(w, "         error: %s\n", c.Error)
		}
		if c.Passed {
			continue
		}
		for _, a := range c.Assertions {
			if a.Passed || a.Skipped {
				continue
			}
			fmt.Fprintf(w, "         x %s: %s\n", a.Kind, a.Detail)
			if a.Rationale != "" {
				fmt.Fprintf(w, "           judge: %s\n", a.Rationale)
			}
		}
	}
	fmt.Fprintf(w, "\nScore: %.2f  (%d/%d cases)  cost $%.4f\n", r.Score, r.CasesPassed, r.CasesTotal, r.TotalCostUsd)
	if r.StoppedEarly != "" {
		fmt.Fprintf(w, "Stopped early: %s\n", r.StoppedEarly)
	}
	if r.BaselineScore != nil {
		fmt.Fprintf(w, "Baseline (%s): %.2f  delta %+.2f\n", branch, *r.BaselineScore, r.Score-*r.BaselineScore)
	}
	for _, d := range r.CaseDeltas {
		if d.Regressed {
			fmt.Fprintf(w, "  regressed: %s  %.2f -> %.2f (%+.2f)\n", d.Name, d.BaselineScore, d.Score, d.Delta)
		}
	}
	if len(r.FlakyCases) > 0 {
		fmt.Fprintf(w, "Flaky: %s\n", strings.Join(r.FlakyCases, ", "))
	}
	if r.PinnedBaseline {
		fmt.Fprintf(w, "Pinned baseline for %s @ %s\n", agent, branch)
	}
}

func newEvalGenerateCommand() *cobra.Command {
	var (
		agent, goal, outFile string
		maxCases             int
		approve, yes, asJSON bool
	)
	cmd := &cobra.Command{
		Use:   "generate",
		Short: "Have the agent draft an eval suite (never saved without approval)",
		Long: `Asks the control plane to draft a suite grounded in the agent's
instructions, recent runs and feedback. The draft is printed (and written
with --out) for review; nothing is saved unless you pass --approve or later
run 'pal eval approve --file FILE'.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if agent == "" {
				return fmt.Errorf("--agent is required")
			}
			base, token, err := evalAuth()
			if err != nil {
				return err
			}
			body := map[string]any{"agentName": agent}
			if goal != "" {
				body["goal"] = goal
			}
			if maxCases > 0 {
				body["maxCases"] = maxCases
			}
			status, raw, err := evalPost(cmd.Context(), base, token, "/v1/eval-suites/generate", body)
			if err != nil {
				return fmt.Errorf("eval generate: %w", err)
			}
			if status != http.StatusOK {
				return evalServerError("eval generate", status, raw)
			}
			var g evalGenResp
			if err := json.Unmarshal(raw, &g); err != nil {
				return fmt.Errorf("eval generate: decode response: %w", err)
			}
			out := cmd.OutOrStdout()
			if asJSON {
				_, _ = out.Write(append(bytes.TrimSpace(raw), '\n'))
			} else {
				printEvalDraft(out, &g)
			}
			if outFile != "" {
				var pretty bytes.Buffer
				if err := json.Indent(&pretty, g.Draft, "", "  "); err != nil {
					return fmt.Errorf("format draft: %w", err)
				}
				pretty.WriteByte('\n')
				if err := os.WriteFile(outFile, pretty.Bytes(), 0o600); err != nil {
					return fmt.Errorf("write %s: %w", outFile, err)
				}
				if !asJSON {
					fmt.Fprintf(out, "Draft written to %s (review, then `pal eval approve --file %s`)\n", outFile, outFile)
				}
			}
			if !approve {
				return nil
			}
			if !yes {
				ok, err := confirm(cmd.InOrStdin(), out, "Save this suite?")
				if err != nil {
					return err
				}
				if !ok {
					return fmt.Errorf("not approved; draft not saved")
				}
			}
			return saveEvalSuite(cmd.Context(), base, token, g.Draft, out)
		},
	}
	f := cmd.Flags()
	f.StringVar(&agent, "agent", "", "Agent name")
	f.StringVar(&goal, "goal", "", "What the suite should verify")
	f.IntVar(&maxCases, "max-cases", 0, "Maximum cases (server cap 12)")
	f.StringVar(&outFile, "out", "", "Write the draft JSON to this file for review")
	f.BoolVar(&approve, "approve", false, "Save the draft after confirmation")
	f.BoolVarP(&yes, "yes", "y", false, "Skip the confirmation prompt for --approve")
	f.BoolVar(&asJSON, "json", false, "Emit JSON")
	return cmd
}

func printEvalDraft(w io.Writer, g *evalGenResp) {
	var d struct {
		Name  string `json:"name"`
		Cases []struct {
			Name      string `json:"name"`
			Input     string `json:"input"`
			Rationale string `json:"rationale"`
		} `json:"cases"`
	}
	_ = json.Unmarshal(g.Draft, &d)
	fmt.Fprintf(w, "Draft suite %q (%d cases, generator cost $%.4f) — NOT saved\n", d.Name, len(d.Cases), g.CostUsd)
	prov := map[string]int{}
	for i, p := range g.Provenance {
		prov[p.Case] = i
	}
	for _, c := range d.Cases {
		fmt.Fprintf(w, "  - %s: %s\n", c.Name, oneLine(c.Input, 100))
		if i, ok := prov[c.Name]; ok {
			p := g.Provenance[i]
			fmt.Fprintf(w, "      grounding: %s (source %s)\n", p.Grounding, p.Source)
			for _, n := range p.Notes {
				fmt.Fprintf(w, "      note: %s\n", n)
			}
		}
	}
	for _, x := range g.Dropped {
		fmt.Fprintf(w, "  dropped %s: %s\n", x.Name, x.Reason)
	}
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

func confirm(in io.Reader, out io.Writer, q string) (bool, error) {
	if f, ok := in.(*os.File); ok {
		if st, err := f.Stat(); err != nil || st.Mode()&os.ModeCharDevice == 0 {
			return false, fmt.Errorf("stdin is not a terminal; pass --yes to approve non-interactively")
		}
	}
	fmt.Fprintf(out, "%s [y/N] ", q)
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return false, fmt.Errorf("read confirmation: %w", err)
	}
	a := strings.ToLower(strings.TrimSpace(line))
	return a == "y" || a == "yes", nil
}

// saveEvalSuite persists a reviewed draft through the normal upsert endpoint.
func saveEvalSuite(ctx context.Context, base, token string, draft json.RawMessage, out io.Writer) error {
	status, raw, err := evalPost(ctx, base, token, "/v1/eval-suites", json.RawMessage(draft))
	if err != nil {
		return fmt.Errorf("save suite: %w", err)
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return evalServerError("save suite", status, raw)
	}
	var r struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &r)
	fmt.Fprintf(out, "Saved suite (id %s)\n", r.ID)
	return nil
}

func newEvalApproveCommand() *cobra.Command {
	var file string
	cmd := &cobra.Command{
		Use:   "approve",
		Short: "Save a reviewed draft suite file (from `pal eval generate --out`)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if file == "" {
				return fmt.Errorf("--file is required")
			}
			raw, err := os.ReadFile(file)
			if err != nil {
				return fmt.Errorf("read draft: %w", err)
			}
			var probe struct {
				AgentName string `json:"agentName"`
				Name      string `json:"name"`
			}
			if err := json.Unmarshal(raw, &probe); err != nil || probe.AgentName == "" || probe.Name == "" {
				return fmt.Errorf("%s is not a draft suite (need agentName and name)", file)
			}
			base, token, err := evalAuth()
			if err != nil {
				return err
			}
			return saveEvalSuite(cmd.Context(), base, token, raw, cmd.OutOrStdout())
		},
	}
	cmd.Flags().StringVar(&file, "file", "", "Draft suite JSON file")
	return cmd
}

func newEvalCalibrateCommand() *cobra.Command {
	var (
		agent, rubric string
		limit         int
		asJSON        bool
	)
	cmd := &cobra.Command{
		Use:   "calibrate",
		Short: "Measure how well the LLM judge agrees with human feedback",
		RunE: func(cmd *cobra.Command, args []string) error {
			if agent == "" {
				return fmt.Errorf("--agent is required")
			}
			base, token, err := evalAuth()
			if err != nil {
				return err
			}
			body := map[string]any{"agentName": agent}
			if rubric != "" {
				body["rubric"] = rubric
			}
			if limit > 0 {
				body["limit"] = limit
			}
			status, raw, err := evalPost(cmd.Context(), base, token, "/v1/eval-judge/calibrate", body)
			if err != nil {
				return fmt.Errorf("eval calibrate: %w", err)
			}
			if status != http.StatusOK {
				return evalServerError("eval calibrate", status, raw)
			}
			out := cmd.OutOrStdout()
			if asJSON {
				_, _ = out.Write(append(bytes.TrimSpace(raw), '\n'))
				return nil
			}
			var c evalCalResp
			if err := json.Unmarshal(raw, &c); err != nil {
				return fmt.Errorf("eval calibrate: decode response: %w", err)
			}
			if c.Note != "" {
				fmt.Fprintln(out, c.Note)
				return nil
			}
			fmt.Fprintf(out, "n=%d labeled=%d agreement=%.2f kappa=%.2f mae=%.2f  cost $%.4f\n%s\n",
				c.Stats.N, c.Stats.Labeled, c.Stats.Agreement, c.Stats.Kappa, c.Stats.MAE, c.CostUsd, c.Verdict)
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&agent, "agent", "", "Agent name")
	f.StringVar(&rubric, "rubric", "", "Rubric to calibrate (default: generic helpfulness rubric)")
	f.IntVar(&limit, "limit", 0, "Runs with feedback to re-judge (max 20)")
	f.BoolVar(&asJSON, "json", false, "Emit JSON")
	return cmd
}
