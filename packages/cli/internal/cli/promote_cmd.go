package cli

// `pal promote | approve | reject | rollback | canary | sandbox | promotions`
// (ADR 0054). Thin clients over the control-plane's promotion API; every verdict
// (gates, approval, rollback idempotency) is decided server-side.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// promoHTTP returns the status and decoded JSON object (or {"items": [...]} for arrays).
func promoHTTP(method, path string, body any) (int, map[string]any, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, apiBase()+path, rd)
	if err != nil {
		return 0, nil, err
	}
	if a := apiAuthHeader(); a != "" {
		req.Header.Set("Authorization", a)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	var arr []any
	if json.Unmarshal(raw, &out) != nil {
		if json.Unmarshal(raw, &arr) == nil {
			out = map[string]any{"items": arr}
		}
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return resp.StatusCode, out, fmt.Errorf("unauthorized%s", authHint())
	}
	return resp.StatusCode, out, nil
}

// formatGates renders the gate list one line per gate.
func formatGates(v any) string {
	gs, _ := v.([]any)
	var b strings.Builder
	for _, g := range gs {
		m, _ := g.(map[string]any)
		mark := "ok  "
		if m["status"] != "pass" {
			mark = "FAIL"
		}
		fmt.Fprintf(&b, "  [%s] %-11v %v\n", mark, m["name"], m["detail"])
	}
	return b.String()
}

// reportResponse prints a promotion API response and returns a non-nil error
// (so the exit code is non-zero) for anything other than success. A gate
// failure exits non-zero: CI and agents must not treat "blocked" as success.
func reportResponse(cmd *cobra.Command, code int, out map[string]any, asJSON bool) error {
	w := cmd.OutOrStdout()
	if asJSON {
		b, _ := json.MarshalIndent(out, "", "  ")
		fmt.Fprintln(w, string(b))
	}
	switch {
	case code == http.StatusUnprocessableEntity:
		if !asJSON {
			fmt.Fprintf(w, "BLOCKED by gates:\n%s", formatGates(out["gates"]))
		}
		return fmt.Errorf("promotion blocked: %v", out["error"])
	case code >= 400:
		return fmt.Errorf("%d: %v", code, firstStr(out["error"], out["code"]))
	}
	return nil
}

func firstStr(vs ...any) string {
	for _, v := range vs {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func newPromoteCommand() *cobra.Command {
	var (
		to, version, reason, evalSuite string
		canary                         int
		requireApproval, asJSON        bool
		maxErr, maxCost, minEval       float64
		minRuns                        int
	)
	cmd := &cobra.Command{
		Use:   "promote <agent> --to sandbox|staging|prod",
		Short: "Promote an agent version to an environment (gated; prod needs human approval)",
		Long: `Promotes an agent version to sandbox, staging or prod.

Gates (deterministic, server-side): the version exists; it is already active in
an earlier environment; a fresh hermetic eval passed (and has not regressed vs
that environment's baseline); the agent is within budget. Sandbox needs no eval.

Prod always needs explicit approval by a human owner/admin: this command only
files the request ("pending_approval"); run 'pal approve <id>' as a human.
--canary N sends N% of prod runs to the new version and rolls back automatically
if a guard trips.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"env": to, "version": version, "canaryPct": canary,
				"requireApproval": requireApproval, "reason": reason}
			if canary > 0 {
				body["guards"] = map[string]any{"maxErrorRate": maxErr, "maxCostRatio": maxCost, "minEvalScore": minEval, "minRuns": minRuns}
			}
			path := "/v1/agents/" + url.PathEscape(args[0]) + "/promote"
			code, out, err := promoHTTP("POST", path, body)
			if err != nil {
				return err
			}
			if code == http.StatusUnprocessableEntity && evalSuite != "" && failedEval(out) {
				fmt.Fprintf(cmd.ErrOrStderr(), "eval gate failed; running hermetic eval suite %s against baseline %q\n", evalSuite, to)
				evalBody := map[string]any{"branch": to}
				if version != "" {
					evalBody["agentVersion"] = version // evaluate the frozen version being promoted, not the draft
				}
				ec, eo, err := promoHTTP("POST", "/v1/eval-suites/"+url.PathEscape(evalSuite)+"/run", evalBody)
				if err != nil {
					return err
				}
				if ec >= 400 {
					return fmt.Errorf("eval run: %d %v (regressions return 422)", ec, firstStr(eo["error"], eo["code"]))
				}
				code, out, err = promoHTTP("POST", path, body)
				if err != nil {
					return err
				}
			}
			if err := reportResponse(cmd, code, out, asJSON); err != nil {
				return err
			}
			if !asJSON {
				p, _ := out["promotion"].(map[string]any)
				fmt.Fprintf(cmd.OutOrStdout(), "%v %v@%v -> %v   id=%v\n", p["status"], args[0], p["version"], p["env"], p["id"])
				if p["status"] == "pending_approval" {
					fmt.Fprintf(cmd.OutOrStdout(), "waiting for a human: pal approve %v\n", p["id"])
				}
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&to, "to", "", "target environment: sandbox, staging or prod (required)")
	f.StringVar(&version, "version", "", "frozen agent version (default: the newest; see `pal freeze`)")
	f.IntVar(&canary, "canary", 0, "prod only: percent of runs (1-99) to send to the new version first")
	f.Float64Var(&maxErr, "max-error-rate", 0.10, "canary guard: max failed/terminal runs")
	f.Float64Var(&maxCost, "max-cost-ratio", 1.5, "canary guard: max candidate/stable cost per run")
	f.Float64Var(&minEval, "min-eval-score", 0, "canary guard: floor for a newer hermetic eval score")
	f.IntVar(&minRuns, "min-runs", 20, "canary guard: terminal runs needed before the canary can complete")
	f.StringVar(&reason, "reason", "", "why (recorded in the audit trail)")
	f.StringVar(&evalSuite, "run-eval", "", "eval suite id: if the eval gate fails, run it hermetically (branch = env) and retry once")
	f.BoolVar(&requireApproval, "require-approval", false, "require human approval even for sandbox/staging")
	f.BoolVar(&asJSON, "json", false, "print the raw response")
	_ = cmd.MarkFlagRequired("to")
	cmd.AddCommand(newPromoteContractCommand())
	return cmd
}

func failedEval(out map[string]any) bool {
	gs, _ := out["gates"].([]any)
	for _, g := range gs {
		if m, _ := g.(map[string]any); m["name"] == "eval" && m["status"] != "pass" {
			return true
		}
	}
	return false
}

func decisionCmd(use, short, verb string) *cobra.Command {
	var note string
	var asJSON bool
	c := &cobra.Command{
		Use: use + " <promotion-id>", Short: short, Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("POST", "/v1/promotions/"+url.PathEscape(args[0])+"/"+verb, map[string]any{"note": note})
			if err != nil {
				return err
			}
			if err := reportResponse(cmd, code, out, asJSON); err != nil {
				return err
			}
			if !asJSON {
				p, _ := out["promotion"].(map[string]any)
				fmt.Fprintf(cmd.OutOrStdout(), "%v: %v@%v -> %v (approver %v)\n", p["status"], p["agentName"], p["version"], p["env"], firstStr(p["approver"], "-"))
			}
			return nil
		},
	}
	c.Flags().StringVar(&note, "note", "", "recorded with the decision")
	c.Flags().BoolVar(&asJSON, "json", false, "print the raw response")
	return c
}

func newFreezeCommand() *cobra.Command {
	var label string
	c := &cobra.Command{
		Use:   "freeze <agent>",
		Short: "Freeze the agent's current definition as an immutable version (does not change what serves traffic)",
		Long: `'pal deploy' updates the agent's working copy. 'pal freeze' snapshots it (prompt, model,
workflow) into an immutable, content-addressed version that can be evaluated and promoted.
Freezing identical content again returns the existing version.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("POST", "/v1/agents/"+url.PathEscape(args[0])+"/versions", map[string]any{"label": label})
			if err != nil {
				return err
			}
			if err := reportResponse(cmd, code, out, false); err != nil {
				return err
			}
			verb := "already frozen as"
			if out["created"] == true {
				verb = "frozen as"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s %v@%v\n", verb, args[0], out["version"])
			return nil
		},
	}
	c.Flags().StringVar(&label, "label", "", "version label (default v<N>)")
	return c
}

func newRollbackCommand() *cobra.Command {
	var env, note string
	var asJSON bool
	c := &cobra.Command{
		Use:   "rollback <agent> [--env prod]",
		Short: "Roll an environment back (aborts a canary, or restores the previous version). Idempotent",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("POST", "/v1/agents/"+url.PathEscape(args[0])+"/environments/"+url.PathEscape(env)+"/rollback", map[string]any{"note": note})
			if err != nil {
				return err
			}
			if err := reportResponse(cmd, code, out, asJSON); err != nil {
				return err
			}
			if !asJSON {
				if out["alreadyRolledBack"] == true {
					fmt.Fprintf(cmd.OutOrStdout(), "already rolled back; %s serves %v (no change)\n", env, out["version"])
				} else {
					fmt.Fprintf(cmd.OutOrStdout(), "%v: %s now serves %v\n", out["mode"], env, out["version"])
				}
			}
			return nil
		},
	}
	c.Flags().StringVar(&env, "env", "prod", "environment")
	c.Flags().StringVar(&note, "note", "", "reason (audited)")
	c.Flags().BoolVar(&asJSON, "json", false, "print the raw response")
	return c
}

func newCanaryCommand() *cobra.Command {
	c := &cobra.Command{Use: "canary", Short: "Inspect and drive a prod canary"}
	var asJSON bool
	ev := &cobra.Command{
		Use: "evaluate <agent>", Short: "Run the canary guards now; rolls back on a trip, completes on a pass", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("POST", "/v1/agents/"+url.PathEscape(args[0])+"/environments/prod/canary/evaluate", nil)
			if err != nil {
				return err
			}
			if err := reportResponse(cmd, code, out, asJSON); err != nil {
				return err
			}
			if !asJSON {
				v, _ := out["verdict"].(map[string]any)
				fmt.Fprintf(cmd.OutOrStdout(), "verdict=%v action=%v reasons=%v\n", v["verdict"], out["action"], v["reasons"])
			}
			return nil
		},
	}
	ev.Flags().BoolVar(&asJSON, "json", false, "print the raw response")
	c.AddCommand(ev)
	return c
}

func newPromotionsCommand() *cobra.Command {
	c := &cobra.Command{Use: "promotions", Short: "List promotions, environments and the audit trail"}
	var status, agent string
	ls := &cobra.Command{
		Use: "list", Short: "List promotions (e.g. --status pending_approval)",
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("GET", "/v1/promotions?status="+url.QueryEscape(status)+"&agentName="+url.QueryEscape(agent), nil)
			if err != nil || code >= 400 {
				return fmt.Errorf("list: %d %v", code, err)
			}
			items, _ := out["items"].([]any)
			for _, it := range items {
				p, _ := it.(map[string]any)
				fmt.Fprintf(cmd.OutOrStdout(), "%v  %-16v %v@%v -> %v  by %v (%v)\n", p["id"], p["status"], p["agentName"], p["version"], p["env"], p["requestedBy"], p["requestedByKind"])
			}
			return nil
		},
	}
	ls.Flags().StringVar(&status, "status", "", "filter by status")
	ls.Flags().StringVar(&agent, "agent", "", "filter by agent")
	au := &cobra.Command{
		Use: "audit", Short: "Show the append-only promotion audit trail",
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("GET", "/v1/promotions/audit?agentName="+url.QueryEscape(agent), nil)
			if err != nil || code >= 400 {
				return fmt.Errorf("audit: %d %v", code, err)
			}
			items, _ := out["items"].([]any)
			for _, it := range items {
				a, _ := it.(map[string]any)
				d, _ := json.Marshal(a["detail"])
				fmt.Fprintf(cmd.OutOrStdout(), "%v  %-16v %-8v %-12v %v(%v) %s\n", a["createdAt"], a["action"], a["env"], a["agentName"], a["actor"], a["actorKind"], d)
			}
			return nil
		},
	}
	au.Flags().StringVar(&agent, "agent", "", "filter by agent")
	envs := &cobra.Command{
		Use: "envs <agent>", Short: "Show what each environment serves", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			code, out, err := promoHTTP("GET", "/v1/agents/"+url.PathEscape(args[0])+"/environments", nil)
			if err != nil || code >= 400 {
				return fmt.Errorf("envs: %d %v", code, err)
			}
			es, _ := out["environments"].([]any)
			for _, it := range es {
				e, _ := it.(map[string]any)
				fmt.Fprintf(cmd.OutOrStdout(), "%-8v %-8v %-8v canary=%v%% previous=%v\n", e["env"], e["version"], e["status"], e["canaryPct"], e["previousVersion"])
			}
			return nil
		},
	}
	c.AddCommand(ls, au, envs, newPromoteContractCommand())
	return c
}

// ---------- tool contract for the onboarding agent ----------

const promoteContract = `{
  "tool": "propose_promotion",
  "description": "PROPOSE promoting an agent version. This never changes production: prod promotions stay pending_approval until a human owner/admin runs 'pal approve'. Deterministic gates (hermetic eval, budget, environment order) decide whether the proposal is even accepted.",
  "command": "pal promote <agent> --to <env> --json",
  "input_schema": {
    "type": "object",
    "required": ["agent", "env"],
    "properties": {
      "agent":   {"type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$"},
      "env":     {"type": "string", "enum": ["sandbox", "staging", "prod"]},
      "version": {"type": "string", "maxLength": 64},
      "canaryPct": {"type": "integer", "minimum": 0, "maximum": 99, "description": "prod only"},
      "reason":  {"type": "string", "maxLength": 500}
    },
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "promotion": {"type": "object", "description": "status is pending_approval for prod; the agent cannot approve"},
      "gates": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "status": {"enum": ["pass", "fail"]}, "detail": {"type": "string"}}}}
    }
  },
  "not_available_to_the_model": ["approve", "reject", "force", "skip-gates"]
}`

func newPromoteContractCommand() *cobra.Command {
	return &cobra.Command{
		Use: "contract", Short: "Print the tool contract (JSON) the onboarding agent calls to propose a promotion",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintln(cmd.OutOrStdout(), strings.TrimSpace(promoteContract))
		},
	}
}

// ---------- sandbox e2e ----------

func newSandboxCommand() *cobra.Command {
	c := &cobra.Command{Use: "sandbox", Short: "Run an agent end-to-end in a microVM sandbox"}
	var (
		specPath, version, input, execCmd string
		wait                              time.Duration
		keep, asJSON                      bool
	)
	run := &cobra.Command{
		Use:   "run <agent> --spec agent.yaml",
		Short: "Promote to sandbox, execute the agent's workload inside a microVM, record the evidence",
		Long: `1) promotes <agent>@version to the sandbox environment (gates apply),
2) schedules the AgentSpec in a microVM via /v1/runtime/schedule (invariant #5),
3) waits for it to run, executes the command inside it via /v1/runtime/vms/{id}/exec,
4) records the VM id, exit code and output hash as sandbox evidence (audited),
5) terminates the VM unless --keep.
Exits non-zero if the VM never ran or the command failed. A stub scheduler is
refused: nothing would have run.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			agent := args[0]
			raw, err := os.ReadFile(specPath)
			if err != nil {
				return fmt.Errorf("read spec: %w", err)
			}
			var doc map[string]any
			if err := yaml.Unmarshal(raw, &doc); err != nil {
				return fmt.Errorf("parse spec: %w", err)
			}
			spec, ok := doc["spec"].(map[string]any)
			if !ok {
				spec = doc
			}
			if err := validateRuntimeSpec(spec, doc, specPath); err != nil {
				return err
			}
			out := cmd.ErrOrStderr()

			pb := map[string]any{"env": "sandbox", "version": version, "reason": "sandbox e2e"}
			code, resp, err := promoHTTP("POST", "/v1/agents/"+url.PathEscape(agent)+"/promote", pb)
			if err != nil {
				return err
			}
			if err := reportResponse(cmd, code, resp, false); err != nil {
				return err
			}
			p, _ := resp["promotion"].(map[string]any)
			ver, _ := p["version"].(string)
			fmt.Fprintf(out, "sandbox now serves %s@%s\n", agent, ver)

			if input != "" {
				var parsed any
				if err := json.Unmarshal([]byte(input), &parsed); err != nil {
					return fmt.Errorf("--input must be valid JSON: %w", err)
				}
				spec["stdin_input"] = parsed
			}
			start := time.Now()
			sb, _ := json.Marshal(spec)
			body, err := apiRaw("POST", "/v1/runtime/schedule", sb)
			if err != nil {
				return err
			}
			var sch map[string]any
			_ = json.Unmarshal(body, &sch)
			vmID, _ := sch["vmId"].(string)
			if stub, _ := sch["stub"].(bool); stub || vmID == "" {
				return fmt.Errorf("NOT SCHEDULED: no real scheduler is wired (stub=%v); nothing ran", stub)
			}
			fmt.Fprintf(out, "scheduled vm %s\n", vmID)
			terminate := func() {
				if !keep {
					_, _ = apiRaw("DELETE", "/v1/runtime/vms/"+vmID+"?grace=5s", nil)
				}
			}
			defer terminate()

			deadline := time.Now().Add(wait)
			state := ""
			for time.Now().Before(deadline) {
				v, err := apiGet("/v1/runtime/vms/" + vmID)
				if err == nil {
					if vm, ok := v["vm"].(map[string]any); ok {
						v = vm
					}
					state, _ = v["state"].(string)
				}
				if state == "running" {
					break
				}
				if state == "failed" || state == "terminated" {
					return fmt.Errorf("vm %s ended in state %q before it could run the agent", vmID, state)
				}
				time.Sleep(time.Second)
			}
			if state != "running" {
				return fmt.Errorf("vm %s not running after %s (state %q)", vmID, wait, state)
			}
			fmt.Fprintf(out, "vm running after %s\n", time.Since(start).Round(time.Millisecond))

			argv := strings.Fields(execCmd)
			if len(argv) == 0 {
				return fmt.Errorf("--exec is required")
			}
			eb, _ := json.Marshal(map[string]any{"command": argv[0], "argv": argv[1:]})
			er, err := apiRaw("POST", "/v1/runtime/vms/"+vmID+"/exec", eb)
			if err != nil {
				return fmt.Errorf("exec in vm: %w", err)
			}
			var ex struct {
				Stdout   string `json:"stdout"`
				Stderr   string `json:"stderr"`
				ExitCode int    `json:"exitCode"`
			}
			_ = json.Unmarshal(er, &ex)
			sum := sha256.Sum256([]byte(ex.Stdout))
			ev := map[string]any{"version": ver, "vmId": vmID, "ok": ex.ExitCode == 0, "exitCode": ex.ExitCode,
				"durationMs": time.Since(start).Milliseconds(), "outputSha256": hex.EncodeToString(sum[:])}
			if _, err := apiRaw("POST", "/v1/agents/"+url.PathEscape(agent)+"/environments/sandbox/runs", mustJSON(ev)); err != nil {
				return fmt.Errorf("record evidence: %w", err)
			}
			result := map[string]any{"agent": agent, "version": ver, "vmId": vmID, "exitCode": ex.ExitCode,
				"stdout": ex.Stdout, "stderr": ex.Stderr, "durationMs": ev["durationMs"], "outputSha256": ev["outputSha256"]}
			if asJSON {
				fmt.Fprintln(cmd.OutOrStdout(), string(mustJSON(result)))
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "exit=%d in %dms, output sha256=%s\n%s", ex.ExitCode, ev["durationMs"], ev["outputSha256"], ex.Stdout)
			}
			if ex.ExitCode != 0 {
				return fmt.Errorf("agent command exited %d inside the microVM: %s", ex.ExitCode, strings.TrimSpace(ex.Stderr))
			}
			return nil
		},
	}
	f := run.Flags()
	f.StringVar(&specPath, "spec", "", "AgentSpec yaml for the microVM (see examples/headless-agents) (required)")
	f.StringVar(&version, "version", "", "agent version (default: current)")
	f.StringVar(&input, "input", "", "JSON piped to the workload's stdin")
	f.StringVar(&execCmd, "exec", "echo pal-sandbox-ok", "command executed inside the VM (split on spaces; execve-style, no shell)")
	f.DurationVar(&wait, "wait", 120*time.Second, "how long to wait for the VM to reach running")
	f.BoolVar(&keep, "keep", false, "leave the VM running")
	f.BoolVar(&asJSON, "json", false, "print the result as JSON")
	_ = run.MarkFlagRequired("spec")
	c.AddCommand(run)
	return c
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
