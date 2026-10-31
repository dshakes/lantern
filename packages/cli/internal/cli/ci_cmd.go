package cli

// `pal ci` -- shift-left gates for an agent repo (ADR 0053).
//
//	pal ci init      generate the GitHub Actions workflow + a generic shell entrypoint
//	pal ci check     run the four gates, write a JSON report and a PR summary
//	pal ci lint      the two offline gates only (manifest + policy)
//	pal ci contract  print the tool contract the onboarding agent calls
//
// Generation is the only agentic part (a model may choose the parameters);
// every pass/fail decision is deterministic code in ci_gates.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const (
	ciWorkflowPath = ".github/workflows/pal-agent-ci.yml"
	ciScriptPath   = ".pal/ci.sh"
)

var (
	ciAgentRe    = kebabName
	ciSuiteRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	ciBranchRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$`)
	ciManifestRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,200}$`)
)

type ciInitParams struct {
	Agent, Suite, Manifest, Branch string
}

// validate rejects anything that could break out of YAML or shell: the values
// are interpolated into generated files, and a model may have chosen them.
func (p ciInitParams) validate() error {
	switch {
	case !ciAgentRe.MatchString(p.Agent):
		return fmt.Errorf("agent %q must be kebab-case (a-z, 0-9, '-')", p.Agent)
	case !ciSuiteRe.MatchString(p.Suite):
		return fmt.Errorf("suite %q may only contain letters, digits, '.', '_' and '-'", p.Suite)
	case !ciBranchRe.MatchString(p.Branch) || strings.Contains(p.Branch, ".."):
		return fmt.Errorf("branch %q is not a plain branch name", p.Branch)
	case !ciManifestRe.MatchString(p.Manifest) || strings.HasPrefix(p.Manifest, "/") || strings.Contains(p.Manifest, ".."):
		return fmt.Errorf("manifest %q must be a relative path inside the repo", p.Manifest)
	}
	return nil
}

type ciFile struct {
	Path    string `json:"path"`
	Mode    uint32 `json:"mode"`
	Content string `json:"content"`
}

// renderCIFiles is pure and deterministic: same params, same bytes.
func renderCIFiles(p ciInitParams) []ciFile {
	r := strings.NewReplacer("@AGENT@", p.Agent, "@SUITE@", p.Suite, "@MANIFEST@", p.Manifest, "@BRANCH@", p.Branch)
	return []ciFile{
		{ciWorkflowPath, 0o644, r.Replace(ciWorkflowTmpl)},
		{ciScriptPath, 0o755, r.Replace(ciScriptTmpl)},
	}
}

func newCICommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ci",
		Short: "Shift-left CI gates for an agent repo: init, check, lint",
	}
	cmd.AddCommand(newCIInitCommand(), newCICheckCommand(), newCILintCommand(), newCIContractCommand())
	return cmd
}

func newCIInitCommand() *cobra.Command {
	var (
		p                         ciInitParams
		dir                       string
		force, dryRun, check, asJ bool
	)
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Write the agent CI workflow and a generic shell entrypoint",
		Long: `Writes ` + ciWorkflowPath + ` (GitHub Actions) and ` + ciScriptPath + ` (any CI) that run,
in order: manifest lint, policy lint, the hermetic eval suite with the baseline
regression gate, and the budget/cost-forecast check.

Existing files are never overwritten without --force. --dry-run prints the
files without writing (what the onboarding agent calls, so a human approves
before anything lands). --check exits non-zero if the files on disk differ from
what would be generated (hand-edited gate).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if p.Agent == "" {
				if m, err := loadManifest(filepath.Join(dir, p.Manifest)); err == nil {
					p.Agent = str(m["name"])
				}
			}
			if err := p.validate(); err != nil {
				return err
			}
			files := renderCIFiles(p)
			out := cmd.OutOrStdout()
			written := false
			switch {
			case check:
				for _, f := range files {
					got, err := os.ReadFile(filepath.Join(dir, f.Path))
					if err != nil || string(got) != f.Content {
						return fmt.Errorf("%s is missing or differs from the generated gate; run `pal ci init --force`", f.Path)
					}
				}
			case !dryRun:
				for _, f := range files {
					if err := writeCIFile(dir, f, force); err != nil {
						return err
					}
				}
				written = true
			}
			if asJ {
				return json.NewEncoder(out).Encode(map[string]any{"files": files, "written": written})
			}
			for _, f := range files {
				verb := "would write"
				if written {
					verb = "wrote"
				}
				if check {
					verb = "ok"
				}
				fmt.Fprintf(out, "%s %s\n", verb, f.Path)
			}
			if written {
				fmt.Fprintln(out, "\nNext: set repo secret PAL_API_KEY and variables PAL_API_URL, PAL_CI_STAGING_ACK=1 (a STAGING workspace; see ADR 0053), then commit.")
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&p.Agent, "agent", "", "Agent name (default: name in the manifest)")
	f.StringVar(&p.Suite, "suite", "ci", "Eval suite the gate runs")
	f.StringVar(&p.Manifest, "manifest", "agent.yaml", "Agent manifest path, relative to the repo root")
	f.StringVar(&p.Branch, "branch", "main", "Default branch (baseline is pinned on pushes to it)")
	f.StringVar(&dir, "dir", ".", "Repo root")
	f.BoolVar(&force, "force", false, "Overwrite existing files")
	f.BoolVar(&dryRun, "dry-run", false, "Print the files; write nothing")
	f.BoolVar(&check, "check", false, "Verify files on disk match the generated output")
	f.BoolVar(&asJ, "json", false, "Emit JSON (the tool contract output)")
	return cmd
}

// writeCIFile writes under dir, never following a pre-existing symlink out of
// the repo and never clobbering without force.
func writeCIFile(dir string, f ciFile, force bool) error {
	dst := filepath.Join(dir, f.Path)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if fi, err := os.Lstat(dst); err == nil {
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink; refusing to write through it", f.Path)
		}
		if !force {
			return fmt.Errorf("%s already exists; pass --force to overwrite", f.Path)
		}
	}
	if err := os.WriteFile(dst, []byte(f.Content), os.FileMode(f.Mode)); err != nil {
		return fmt.Errorf("write %s: %w", f.Path, err)
	}
	return os.Chmod(dst, os.FileMode(f.Mode))
}

type ciCheckOpts struct {
	agent, suite, manifest, branch string
	report, summary                string
	stage, setBaseline             bool
	maxCost                        float64
	// stageFn deploys the manifest to the CI workspace; nil uses the real deploy.
	stageFn func(ctx context.Context, raw []byte) error
}

func newCICheckCommand() *cobra.Command {
	var o ciCheckOpts
	cmd := &cobra.Command{
		Use:   "check",
		Short: "Run all four gates; exit non-zero unless every one passes",
		Long: `Gates, in order: manifest lint, policy lint, hermetic eval suite (fails on
any failed case, a regression vs. the --branch baseline, or an incomplete run),
budget/cost forecast. If lint or policy fails the network gates are skipped (no
spend on a manifest that cannot ship) and the run still fails.

--stage deploys the manifest to the workspace behind PAL_API_KEY first, so the
eval runs the PR's version. That mutates the workspace: it requires
PAL_CI_STAGING_ACK=1 to confirm the key belongs to a non-production workspace.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCICheck(cmd.Context(), o, cmd.OutOrStdout())
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.agent, "agent", "", "Agent name (default: name in the manifest)")
	f.StringVar(&o.suite, "suite", "ci", "Eval suite name")
	f.StringVar(&o.manifest, "manifest", "agent.yaml", "Agent manifest path")
	f.StringVar(&o.branch, "branch", "", "Baseline branch to compare against (default: git branch)")
	f.StringVar(&o.report, "report", "pal-ci-report.json", "Machine-readable report path")
	f.StringVar(&o.summary, "summary", "pal-ci-summary.md", "Markdown PR summary path")
	f.BoolVar(&o.stage, "stage", false, "Deploy the manifest to the CI (staging) workspace before the eval")
	f.BoolVar(&o.setBaseline, "set-baseline", false, "Pin the passing run as the --branch baseline (default-branch pushes)")
	f.Float64Var(&o.maxCost, "max-cost", 0, "Hard eval cost ceiling in USD (server default 1.00)")
	return cmd
}

func newCILintCommand() *cobra.Command {
	var manifest string
	cmd := &cobra.Command{
		Use:   "lint",
		Short: "Run only the offline gates (manifest + policy); no credentials needed",
		RunE: func(cmd *cobra.Command, args []string) error {
			rep, err := offlineGates(manifest)
			if err != nil {
				return err
			}
			rep.finish()
			fmt.Fprint(cmd.OutOrStdout(), renderMarkdown(rep))
			if !rep.Passed {
				return fmt.Errorf("lint failed")
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&manifest, "manifest", "agent.yaml", "Agent manifest path")
	return cmd
}

func offlineGates(manifest string) (*ciReport, error) {
	m, err := loadManifest(manifest)
	if err != nil {
		return nil, err
	}
	return &ciReport{Agent: str(m["name"]), Gates: []ciGate{
		lintManifest(m, filepath.Dir(manifest)), policyLint(m),
	}}, nil
}

func skipped(id, title, why string) ciGate {
	return ciGate{ID: id, Title: title, Status: gateSkipped, Summary: why}
}

func errGate(id, title string, err error) ciGate {
	return ciGate{ID: id, Title: title, Status: gateError, Summary: err.Error()}
}

func runCICheck(ctx context.Context, o ciCheckOpts, out io.Writer) error {
	const (
		evalTitle   = "Hermetic eval suite"
		budgetTitle = "Budget and cost forecast"
	)
	rep := &ciReport{Suite: o.suite, CommitSha: gitSha()}
	m, err := loadManifest(o.manifest)
	if err != nil {
		rep.Gates = []ciGate{errGate("lint", "Manifest lint", err),
			skipped("policy", "Policy and security lint", "manifest unreadable"),
			skipped("eval", evalTitle, "manifest unreadable"), skipped("budget", budgetTitle, "manifest unreadable")}
		return finishCI(rep, o, out)
	}
	if o.agent == "" {
		o.agent = str(m["name"])
	}
	if o.branch == "" {
		o.branch = gitBranch()
	}
	rep.Agent, rep.Branch = o.agent, o.branch
	rep.Gates = []ciGate{lintManifest(m, filepath.Dir(o.manifest)), policyLint(m)}

	switch {
	case rep.Gates[0].Status != gatePass || rep.Gates[1].Status != gatePass:
		why := "an earlier gate failed; no spend on a manifest that cannot ship"
		rep.Gates = append(rep.Gates, skipped("eval", evalTitle, why), skipped("budget", budgetTitle, why))
	default:
		base, token, aerr := evalAuth()
		if aerr != nil {
			rep.Gates = append(rep.Gates, errGate("eval", evalTitle, aerr), errGate("budget", budgetTitle, aerr))
			break
		}
		rep.Gates = append(rep.Gates, evalStep(ctx, o, base, token), budgetStep(ctx, o, m, base, token))
	}
	return finishCI(rep, o, out)
}

func evalStep(ctx context.Context, o ciCheckOpts, base, token string) ciGate {
	const title = "Hermetic eval suite"
	if o.stage {
		if os.Getenv("PAL_CI_STAGING_ACK") != "1" {
			return errGate("eval", title, fmt.Errorf("--stage deploys to the workspace behind PAL_API_KEY; set PAL_CI_STAGING_ACK=1 to confirm it is NOT production"))
		}
		stage := o.stageFn
		if stage == nil {
			stage = stageManifest
		}
		raw, err := os.ReadFile(o.manifest)
		if err == nil {
			err = stage(ctx, raw)
		}
		if err != nil {
			return errGate("eval", title, fmt.Errorf("stage manifest: %w", err))
		}
	}
	r, _, _, err := execEvalRun(ctx, base, token, evalRunOpts{
		agent: o.agent, suite: o.suite, branch: o.branch, maxCost: o.maxCost, setBaseline: o.setBaseline,
	})
	if err != nil {
		return errGate("eval", title, err)
	}
	return evalGateFrom(r, o.branch)
}

func budgetStep(ctx context.Context, o ciCheckOpts, m map[string]any, base, token string) ciGate {
	const title = "Budget and cost forecast"
	status, raw, err := evalPost(ctx, base, token, "/v1/runs/forecast", map[string]any{"agentName": o.agent})
	if err != nil {
		return errGate("budget", title, fmt.Errorf("forecast: %w", err))
	}
	if status != http.StatusOK {
		return errGate("budget", title, evalServerError("forecast", status, raw))
	}
	var f ciForecast
	if err := json.Unmarshal(raw, &f); err != nil {
		return errGate("budget", title, fmt.Errorf("forecast: decode response: %w", err))
	}
	c, ok := manifestCostCeiling(m)
	return forecastGate(&f, c, ok)
}

// stageManifest upserts + deploys the manifest through the same path as `pal deploy`.
func stageManifest(_ context.Context, raw []byte) error {
	var man agentManifest
	if err := yaml.Unmarshal(raw, &man); err != nil {
		return err
	}
	_, err := runDeploy(restClient(), &man, false)
	return err
}

func finishCI(rep *ciReport, o ciCheckOpts, out io.Writer) error {
	rep.finish()
	js, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	md := renderMarkdown(rep)
	if err := os.WriteFile(o.report, append(js, '\n'), 0o644); err != nil {
		return fmt.Errorf("write report: %w", err)
	}
	if err := os.WriteFile(o.summary, []byte(md), 0o644); err != nil {
		return fmt.Errorf("write summary: %w", err)
	}
	fmt.Fprint(out, md)
	if !rep.Passed {
		return fmt.Errorf("agent CI failed (see %s)", o.report)
	}
	return nil
}

// ciContract is the tool the onboarding agent may call. The model chooses the
// parameters; the CLI validates them and renders the files deterministically.
const ciContract = `{
  "name": "generate_ci_gate",
  "description": "Generate the agent CI gate (GitHub Actions workflow + shell entrypoint). Always call with dry_run=true first and show the files to the user; write only after they approve. The model never decides pass/fail: the generated gates are deterministic code.",
  "command": "pal ci init --json",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "agent":    {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$", "flag": "--agent"},
      "suite":    {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", "default": "ci", "flag": "--suite"},
      "manifest": {"type": "string", "pattern": "^[A-Za-z0-9._/-]{1,200}$", "default": "agent.yaml", "flag": "--manifest"},
      "branch":   {"type": "string", "default": "main", "flag": "--branch"},
      "dry_run":  {"type": "boolean", "default": true, "flag": "--dry-run"}
    }
  },
  "output_schema": {
    "type": "object",
    "required": ["files", "written"],
    "properties": {
      "files": {"type": "array", "items": {"type": "object", "required": ["path", "mode", "content"]}},
      "written": {"type": "boolean"}
    }
  }
}
`

func newCIContractCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "contract",
		Short: "Print the tool contract (JSON) the onboarding agent calls to generate the gate",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintln(cmd.OutOrStdout(), strings.TrimSpace(ciContract))
		},
	}
}
