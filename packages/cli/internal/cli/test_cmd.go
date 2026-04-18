package cli

// `lantern test` runs an agent's eval suite locally and posts results to the
// control plane, which compares them against the branch baseline and returns
// a regression flag. CI uses `--against=last-green` to fail the build if the
// score drops.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type evalCase struct {
	Name     string         `json:"name"`
	Input    string         `json:"input"`
	Expected string         `json:"expected,omitempty"`
	Assert   map[string]any `json:"assert,omitempty"`
	Weight   float64        `json:"weight,omitempty"`
}

type evalSuite struct {
	ID          string     `json:"id"`
	AgentName   string     `json:"agentName"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Cases       []evalCase `json:"cases"`
}

type caseResult struct {
	Name      string  `json:"name"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Actual    string  `json:"actual,omitempty"`
	Expected  string  `json:"expected,omitempty"`
	Error     string  `json:"error,omitempty"`
	LatencyMs int64   `json:"latencyMs"`
	CostUsd   float64 `json:"costUsd"`
}

type recordResp struct {
	ID            string   `json:"id"`
	Passed        bool     `json:"passed"`
	Score         float64  `json:"score"`
	CasesTotal    int      `json:"casesTotal"`
	CasesPassed   int      `json:"casesPassed"`
	Regressed     bool     `json:"regressed"`
	BaselineScore *float64 `json:"baselineScore,omitempty"`
}

func newTestCommand() *cobra.Command {
	var (
		agent    string
		suite    string
		against  string
		setBase  bool
		jsonOut  bool
	)

	cmd := &cobra.Command{
		Use:   "test",
		Short: "Run an agent's eval suite and compare against baseline",
		Long: `Run an eval suite against a Lantern agent and submit the scored
results to the control plane. If --against=last-green is set and the
current score is a regression vs. the branch baseline, the command
exits with a non-zero status so CI can fail the build.

Example:
  lantern test --agent=email-triage --suite=core
  lantern test --agent=email-triage --suite=core --against=last-green
  lantern test --agent=email-triage --suite=core --set-baseline
`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if agent == "" || suite == "" {
				return fmt.Errorf("--agent and --suite are required")
			}
			base := deriveRESTURL(flags.apiURL)
			token := resolveToken()
			if token == "" {
				return fmt.Errorf("not authenticated — run `lantern login` or set LANTERN_API_KEY")
			}

			// 1. Pull the suite definition.
			s, err := fetchSuite(cmd.Context(), base, token, agent, suite)
			if err != nil {
				return err
			}
			if len(s.Cases) == 0 {
				return fmt.Errorf("suite %q has no cases", suite)
			}
			if !jsonOut {
				fmt.Printf("Running %d cases from %q/%q...\n", len(s.Cases), agent, suite)
			}

			// 2. Execute each case against the run API.
			start := time.Now()
			results := make([]caseResult, 0, len(s.Cases))
			totalCost := 0.0
			for _, c := range s.Cases {
				cr := runCase(cmd.Context(), base, token, agent, c)
				results = append(results, cr)
				totalCost += cr.CostUsd
				if !jsonOut {
					mark := "FAIL"
					if cr.Passed {
						mark = "PASS"
					}
					fmt.Printf("  [%s] %s  score=%.2f  %dms  $%.4f\n", mark, cr.Name, cr.Score, cr.LatencyMs, cr.CostUsd)
				}
			}
			dur := time.Since(start)

			// 3. Submit to the control plane for scoring + baseline compare.
			branch := gitBranch()
			sha := gitSha()
			body := map[string]any{
				"suiteId":      s.ID,
				"branch":       branch,
				"commitSha":    sha,
				"durationMs":   dur.Milliseconds(),
				"totalCostUsd": totalCost,
				"caseResults":  results,
			}
			resp, err := submitEvalRun(cmd.Context(), base, token, body)
			if err != nil {
				return err
			}

			// 4. Optionally set this run as the new baseline for this branch.
			if setBase && resp.ID != "" {
				if err := setBaselineAPI(cmd.Context(), base, token, agent, branch, resp.ID); err != nil {
					return fmt.Errorf("set baseline: %w", err)
				}
				if !jsonOut {
					fmt.Printf("Pinned baseline for %s @ %s\n", agent, branch)
				}
			}

			if jsonOut {
				_ = json.NewEncoder(os.Stdout).Encode(resp)
				return nil
			}
			fmt.Printf("\nScore: %.2f  (%d/%d cases)  in %s  cost $%.4f\n",
				resp.Score, resp.CasesPassed, resp.CasesTotal, dur.Round(time.Millisecond), totalCost)
			if resp.BaselineScore != nil {
				fmt.Printf("Baseline (%s): %.2f  delta %+.2f\n", branch, *resp.BaselineScore, resp.Score-*resp.BaselineScore)
			}
			if against == "last-green" && resp.Regressed {
				return fmt.Errorf("regression vs. baseline on %s", branch)
			}
			if !resp.Passed {
				return fmt.Errorf("eval failed: %d/%d cases passed", resp.CasesPassed, resp.CasesTotal)
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&agent, "agent", "", "Agent name")
	cmd.Flags().StringVar(&suite, "suite", "", "Eval suite name")
	cmd.Flags().StringVar(&against, "against", "", "Comparison mode: last-green")
	cmd.Flags().BoolVar(&setBase, "set-baseline", false, "Pin this run as the branch baseline")
	cmd.Flags().BoolVar(&jsonOut, "json", false, "Emit JSON results")
	return cmd
}

func resolveToken() string {
	if flags.apiKey != "" {
		return flags.apiKey
	}
	return ""
}

func fetchSuite(ctx context.Context, base, token, agent, name string) (*evalSuite, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		base+"/v1/eval-suites?agentName="+agent, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch suites: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("fetch suites: %d %s", res.StatusCode, string(b))
	}
	var all []evalSuite
	if err := json.NewDecoder(res.Body).Decode(&all); err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].Name == name {
			return &all[i], nil
		}
	}
	return nil, fmt.Errorf("suite %q not found for agent %q", name, agent)
}

func runCase(ctx context.Context, base, token, agent string, c evalCase) caseResult {
	start := time.Now()
	body := map[string]any{
		"agentName": agent,
		"input":     map[string]string{"prompt": c.Input},
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/runs", bytes.NewReader(buf))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return caseResult{Name: c.Name, Score: 0, Error: err.Error(), LatencyMs: latency, Expected: c.Expected}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		return caseResult{Name: c.Name, Score: 0, Error: fmt.Sprintf("%d: %s", res.StatusCode, string(raw)), LatencyMs: latency, Expected: c.Expected}
	}
	var run struct {
		Output  map[string]any `json:"output"`
		CostUsd float64        `json:"costUsd"`
	}
	_ = json.Unmarshal(raw, &run)
	actual := extractText(run.Output)
	passed, score := scoreCase(c, actual)
	return caseResult{
		Name:      c.Name,
		Passed:    passed,
		Score:     score,
		Actual:    actual,
		Expected:  c.Expected,
		LatencyMs: latency,
		CostUsd:   run.CostUsd,
	}
}

// scoreCase implements a tiny assertion engine:
//   - If `assert.contains` is present, the case passes when `actual` contains it.
//   - Else if `expected` is present, exact substring match.
//   - Else pass on non-empty output.
// Score is 1.0 on pass, 0.0 on fail. (Fractional scoring is for the server side.)
func scoreCase(c evalCase, actual string) (bool, float64) {
	if need, ok := c.Assert["contains"].(string); ok && need != "" {
		if strings.Contains(actual, need) {
			return true, 1.0
		}
		return false, 0.0
	}
	if c.Expected != "" {
		if strings.Contains(actual, c.Expected) {
			return true, 1.0
		}
		return false, 0.0
	}
	if strings.TrimSpace(actual) != "" {
		return true, 1.0
	}
	return false, 0.0
}

func extractText(out map[string]any) string {
	if out == nil {
		return ""
	}
	if s, ok := out["text"].(string); ok {
		return s
	}
	if s, ok := out["output"].(string); ok {
		return s
	}
	buf, _ := json.Marshal(out)
	return string(buf)
}

func submitEvalRun(ctx context.Context, base, token string, body map[string]any) (*recordResp, error) {
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/eval-runs", bytes.NewReader(buf))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	// 422 is "regression" — still parse body.
	if res.StatusCode != 200 && res.StatusCode != 422 {
		return nil, fmt.Errorf("record eval: %d %s", res.StatusCode, string(raw))
	}
	var resp recordResp
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func setBaselineAPI(ctx context.Context, base, token, agent, branch, runID string) error {
	body, _ := json.Marshal(map[string]string{
		"agentName": agent, "branch": branch, "evalRunId": runID,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/eval-baselines", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%d: %s", res.StatusCode, string(b))
	}
	return nil
}

func gitBranch() string {
	if b := os.Getenv("GIT_BRANCH"); b != "" {
		return b
	}
	out, err := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func gitSha() string {
	if s := os.Getenv("GIT_COMMIT"); s != "" {
		return s
	}
	out, err := exec.Command("git", "rev-parse", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
