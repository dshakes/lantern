package cli

// agent_dev.go — `lantern agent dev <name>` build-harness inner loop.
//
// Watches the local agent directory for file changes (1-second mtime polling,
// no fsnotify dependency), then on each change:
//   1. Re-publish the agent (upsert from agent.yaml or by name).
//   2. Fire a smoke run (POST /v1/runs).
//   3. Stream run events live via SSE with step-waterfall rendering.
//   4. Optionally run the agent's eval suite (--eval).
//
// Ctrl-C exits cleanly. The watch loop runs until cancelled.

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
)

// agentDevOpts holds all configurable and injectable fields for the dev loop.
// Production uses the zero value for injectables (they default to the REST path).
type agentDevOpts struct {
	dir      string // local directory to watch (default ".")
	input    string // --input JSON for the smoke run
	evalFlag bool   // run eval suite after each publish
	yes      bool   // skip confirmation prompts

	// Injected for testing — nil in production (defaults to real REST).
	restURL  string
	getToken func() string
}

func newAgentDevCommand() *cobra.Command {
	var opts agentDevOpts

	cmd := &cobra.Command{
		Use:   "dev <name>",
		Short: "Watch an agent dir, re-publish on change, and stream run events",
		Long: `Build-harness inner loop for agent development.

Watches the local directory (default: current directory) for changes to
agent.yaml or any *.yaml / *.ts / *.py / *.js / *.json file, then on each
change:

  1. Publishes the agent version to the running Lantern stack.
  2. Fires a smoke run (POST /v1/runs) with --input.
  3. Streams run events live (step_started / step_completed / step_failed /
     confidence_evaluated) as a waterfall to the terminal.
  4. With --eval: runs the agent's eval suite and prints pass/fail vs baseline.

Ctrl-C exits cleanly.

Prerequisites: lantern dev (or make run-api) must be running on :8080.`,
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			opts.getToken = func() string {
				creds, err := internal.LoadCredentials()
				if err == nil && creds != nil {
					return creds.Token
				}
				return ""
			}
			if opts.restURL == "" {
				opts.restURL = deriveRESTURL(flags.apiURL)
			}
			return runAgentDev(cmd.Context(), args[0], opts)
		},
	}

	cmd.Flags().StringVar(&opts.dir, "dir", ".", "Directory to watch (default: current directory)")
	cmd.Flags().StringVar(&opts.input, "input", `{"prompt":"Smoke test: reply with a single sentence."}`, "Input JSON for the smoke run")
	cmd.Flags().BoolVar(&opts.evalFlag, "eval", false, "Run the agent's eval suite after each publish")
	cmd.Flags().BoolVarP(&opts.yes, "yes", "y", false, "Skip confirmation prompts")

	return cmd
}

// runAgentDev is the entry point for the watch loop.
func runAgentDev(ctx context.Context, agentName string, opts agentDevOpts) error {
	restURL := opts.restURL
	token := opts.getToken()

	client := internal.NewRESTClient(restURL, "", token)

	fmt.Fprintf(os.Stderr, "%slantern agent dev%s — watching %s for %s\n",
		colorCyan, colorReset, opts.dir, agentName)
	fmt.Fprintf(os.Stderr, "%s(Ctrl-C to exit)%s\n\n", colorDim, colorReset)

	// Verify the agent exists (or create it if we can).
	if _, err := client.GetAgent(agentName); err != nil {
		if !opts.yes {
			fmt.Fprintf(os.Stderr, "%sAgent %q not found. Create it now? [Y/n]: %s", colorYellow, agentName, colorReset)
			var answer string
			fmt.Scanln(&answer)
			if answer != "" && strings.ToLower(answer) != "y" && strings.ToLower(answer) != "yes" {
				return fmt.Errorf("agent %q not found — run 'lantern agents create --name %s' first", agentName, agentName)
			}
		}
		if _, cerr := client.CreateAgentWithSystemPrompt(agentName,
			"Dev agent created by `lantern agent dev`.",
			"You are a helpful AI assistant."); cerr != nil {
			return fmt.Errorf("create agent %q: %w", agentName, cerr)
		}
		fmt.Fprintf(os.Stderr, "%s✓ created agent %q%s\n", colorGreen, agentName, colorReset)
	}

	// Run once immediately, then watch.
	if err := devIteration(ctx, client, agentName, opts); err != nil && ctx.Err() == nil {
		printError(fmt.Sprintf("iteration failed: %v", err))
	}

	// Watch loop: check mtime every second.
	var mu sync.Mutex
	lastMtime := latestMtime(opts.dir)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "\nexiting.")
			return nil
		case <-ticker.C:
			mu.Lock()
			cur := latestMtime(opts.dir)
			changed := cur.After(lastMtime)
			if changed {
				lastMtime = cur
			}
			mu.Unlock()

			if changed {
				fmt.Fprintf(os.Stderr, "\n%s↺ change detected — rebuilding%s\n\n", colorYellow, colorReset)
				if err := devIteration(ctx, client, agentName, opts); err != nil && ctx.Err() == nil {
					printError(fmt.Sprintf("iteration failed: %v", err))
				}
			}
		}
	}
}

// devIteration performs one publish → run → stream cycle.
func devIteration(ctx context.Context, client *internal.RESTClient, agentName string, opts agentDevOpts) error {
	// ── Publish ──────────────────────────────────────────────────────────────
	fmt.Fprintf(os.Stderr, "%s→ publishing%s %s\n", colorBlue, colorReset, agentName)
	if err := publishAgent(client, agentName, opts.dir); err != nil {
		return fmt.Errorf("publish: %w", err)
	}
	printSuccess(fmt.Sprintf("published %s", agentName))

	// ── Smoke run ────────────────────────────────────────────────────────────
	fmt.Fprintf(os.Stderr, "%s→ starting smoke run%s\n", colorBlue, colorReset)
	var inputJSON json.RawMessage
	if opts.input != "" {
		inputJSON = json.RawMessage(opts.input)
	}
	run, err := client.CreateRun(agentName, inputJSON, false)
	if err != nil {
		return fmt.Errorf("create run: %w", err)
	}
	fmt.Fprintf(os.Stderr, "  run %s%s%s started\n", colorDim, run.ID, colorReset)

	// ── Stream events ────────────────────────────────────────────────────────
	streamCtx, streamCancel := context.WithTimeout(ctx, 120*time.Second)
	defer streamCancel()

	var finalStatus string
	sseErr := client.StreamRunEventsSSE(streamCtx, run.ID, func(ev *internal.SSEEvent) {
		renderSSEEvent(ev)
		if ev.Kind == "end" || ev.Kind == "stream_end" {
			if ev.Payload != nil {
				if s, ok := ev.Payload["status"].(string); ok {
					finalStatus = s
				}
			}
		}
	})

	// Fall back to polling if SSE is unavailable.
	if sseErr != nil && streamCtx.Err() == nil {
		fmt.Fprintf(os.Stderr, "  %s(SSE unavailable, polling)%s\n", colorDim, colorReset)
		finalRun, pollErr := pollRunUntilTerminal(client, run.ID, 90*time.Second)
		if pollErr != nil {
			return fmt.Errorf("poll run %s: %w", run.ID, pollErr)
		}
		finalStatus = finalRun.Status
	}

	// Report outcome.
	switch finalStatus {
	case "succeeded":
		printSuccess(fmt.Sprintf("run %s succeeded", run.ID))
	case "failed":
		printError(fmt.Sprintf("run %s failed", run.ID))
	case "":
		printWarning(fmt.Sprintf("run %s: unknown final status", run.ID))
	default:
		printWarning(fmt.Sprintf("run %s: status %q", run.ID, finalStatus))
	}

	// ── Eval (optional) ──────────────────────────────────────────────────────
	if opts.evalFlag {
		runDevEval(client, agentName)
	}

	return nil
}

// publishAgent "publishes" the agent by reading agent.yaml from dir (if present)
// and upserting the agent config. If agent.yaml is absent, it's a no-op publish.
func publishAgent(client *internal.RESTClient, agentName, dir string) error {
	yamlPath := filepath.Join(dir, "agent.yaml")
	data, err := os.ReadFile(yamlPath)
	if err != nil {
		if os.IsNotExist(err) {
			// No agent.yaml — agent is already registered, nothing to upsert.
			return nil
		}
		return fmt.Errorf("read agent.yaml: %w", err)
	}

	// Extract description from YAML (simple line scan — no YAML parser dep).
	description := ""
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "description:") {
			description = strings.TrimSpace(strings.TrimPrefix(line, "description:"))
			description = strings.Trim(description, `"'`)
		}
	}

	// Try to create the agent; if it already exists (409), that's fine.
	_, createErr := client.CreateAgentWithSystemPrompt(
		agentName,
		description,
		"You are a helpful AI assistant.",
	)
	if createErr != nil {
		// 409 Conflict means it exists — not an error for the dev loop.
		if !strings.Contains(createErr.Error(), "409") && !strings.Contains(createErr.Error(), "already exists") {
			return fmt.Errorf("upsert agent: %w", createErr)
		}
	}
	return nil
}

// runDevEval lists eval suites for the agent and reports the latest pass/fail.
// Best-effort: any error is printed and swallowed so the dev loop continues.
func runDevEval(client *internal.RESTClient, agentName string) {
	fmt.Fprintf(os.Stderr, "\n%s→ eval suite%s\n", colorBlue, colorReset)

	suites, err := client.ListEvalSuites(agentName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  %s(eval skipped: %v)%s\n", colorDim, err, colorReset)
		return
	}
	if len(suites) == 0 {
		fmt.Fprintf(os.Stderr, "  %sno eval suites found for %q — create one on the dashboard%s\n",
			colorDim, agentName, colorReset)
		return
	}

	suite := suites[0]
	if len(suite.Cases) == 0 {
		fmt.Fprintf(os.Stderr, "  %ssuite %q has no cases%s\n", colorDim, suite.Name, colorReset)
		return
	}

	// Run each case: create a run, poll, compare output to expected.
	passed := 0
	caseResults := make([]map[string]any, 0, len(suite.Cases))
	for i, tc := range suite.Cases {
		var inputJSON json.RawMessage
		if b, merr := json.Marshal(tc.Input); merr == nil {
			inputJSON = b
		}
		run, rerr := client.CreateRun(agentName, inputJSON, false)
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "  case %d/%d: %screate run failed%s\n",
				i+1, len(suite.Cases), colorRed, colorReset)
			caseResults = append(caseResults, map[string]any{"id": tc.ID, "passed": false})
			continue
		}
		finalRun, perr := pollRunUntilTerminal(client, run.ID, 60*time.Second)
		casePassed := false
		if perr == nil && finalRun.Status == "succeeded" {
			if tc.Expected == "" {
				casePassed = true // no expected value — treat success as pass
			} else if finalRun.Output != nil {
				if text, ok := finalRun.Output["text"].(string); ok {
					casePassed = strings.Contains(text, tc.Expected)
				}
			}
		}
		if casePassed {
			passed++
			fmt.Fprintf(os.Stderr, "  case %d/%d: %s✓%s\n", i+1, len(suite.Cases), colorGreen, colorReset)
		} else {
			fmt.Fprintf(os.Stderr, "  case %d/%d: %s✗%s\n", i+1, len(suite.Cases), colorRed, colorReset)
		}
		caseResults = append(caseResults, map[string]any{
			"id":     tc.ID,
			"passed": casePassed,
		})
	}

	score := 0.0
	if len(suite.Cases) > 0 {
		score = float64(passed) / float64(len(suite.Cases))
	}
	totalPassed := passed == len(suite.Cases)

	// POST results to /v1/eval-runs. 422 = regression vs baseline.
	postErr := client.PostEvalRun(suite.ID, agentName, "", totalPassed, score, caseResults)
	if postErr != nil && strings.Contains(postErr.Error(), "422") {
		fmt.Fprintf(os.Stderr, "  %s✗ eval regressed vs baseline (%.0f%% pass rate)%s\n",
			colorRed, score*100, colorReset)
	} else if postErr != nil {
		fmt.Fprintf(os.Stderr, "  %s(eval post failed: %v)%s\n", colorDim, postErr, colorReset)
	} else {
		icon := colorGreen + "✓"
		if !totalPassed {
			icon = colorYellow + "~"
		}
		fmt.Fprintf(os.Stderr, "  %s eval %d/%d cases passed (%.0f%%)%s\n",
			icon, passed, len(suite.Cases), score*100, colorReset)
	}
}

// latestMtime returns the most recent modification time across all watched files
// in dir (agent.yaml and common code file extensions). Returns zero time on error.
func latestMtime(dir string) time.Time {
	var latest time.Time
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		// Only watch relevant file types.
		name := d.Name()
		if !isWatchedFile(name) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if t := info.ModTime(); t.After(latest) {
			latest = t
		}
		return nil
	})
	return latest
}

// isWatchedFile returns true for agent.yaml and common code file extensions.
func isWatchedFile(name string) bool {
	if name == "agent.yaml" || name == "agent.yml" {
		return true
	}
	for _, ext := range []string{".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".json", ".yaml", ".yml"} {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	return false
}
