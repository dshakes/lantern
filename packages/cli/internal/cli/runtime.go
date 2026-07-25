package cli

// `lantern run` + `lantern vm` — drive the headless agent execution layer.
//
//   lantern run    <agent.yaml> --input '<json>' [--follow]
//   lantern vm     list [--state running] [--limit 50]
//   lantern vm     get  <vm-id>
//   lantern vm     logs <vm-id> [--follow]
//   lantern vm     stop <vm-id> [--grace 30s]
//   lantern vm     exec <vm-id> -- <command...>
//   lantern vm     cluster
//   lantern vm     quota [get | set --max-concurrent N --max-cost X]
//
// All endpoints hit the control-plane REST surface at /v1/runtime/*
// (defined in services/control-plane/internal/handlers/runtime.go).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/spf13/cobra"
	"golang.org/x/term"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"gopkg.in/yaml.v3"
)

// --- `lantern run` ---------------------------------------------------------

func newRunCommand() *cobra.Command {
	var (
		inputJSON string
		follow    bool
	)

	cmd := &cobra.Command{
		Use:   "run <agent.yaml>",
		Short: "Schedule a headless agent in a microVM and (optionally) tail its logs",
		Long: `Schedules an AgentSpec for execution in a microVM. The spec is
loaded from the YAML file at the given path and POSTed to /v1/runtime/schedule.
The spawned VM's logs can be streamed in real-time with --follow.

Examples:
  lantern run examples/headless-agents/01-hello/agent.yaml --input '{"name":"Ada"}'
  lantern run my-agent.yaml --follow`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			specPath, err := filepath.Abs(args[0])
			if err != nil {
				return fmt.Errorf("resolve path: %w", err)
			}
			specBytes, err := os.ReadFile(specPath)
			if err != nil {
				return fmt.Errorf("read spec: %w", err)
			}
			// YAML → generic map → JSON for the API.
			var raw map[string]any
			if err := yaml.Unmarshal(specBytes, &raw); err != nil {
				return fmt.Errorf("parse yaml: %w", err)
			}
			// AgentSpec lives under .spec in the kind: AgentSpec envelope.
			spec, ok := raw["spec"].(map[string]any)
			if !ok {
				// Backwards-compat: top-level spec
				spec = raw
			}
			if err := validateRuntimeSpec(spec, raw, specPath); err != nil {
				return err
			}
			if inputJSON != "" {
				// Stash the workload input on the spec — bridge picks it up
				// and pipes it to stdin via the harness.
				var parsed any
				if err := json.Unmarshal([]byte(inputJSON), &parsed); err != nil {
					return fmt.Errorf("--input must be valid JSON: %w", err)
				}
				spec["stdin_input"] = parsed
			}

			body, _ := json.Marshal(spec)
			res, err := apiPost("/v1/runtime/schedule", body)
			if err != nil {
				return err
			}
			// Server returns camelCase vmId; accept snake_case vm_id and
			// handle.vm_id for backward-compat / alternate response shapes.
			vmID, _ := res["vmId"].(string)
			if vmID == "" {
				vmID, _ = res["vm_id"].(string)
			}
			if vmID == "" {
				if h, ok := res["handle"].(map[string]any); ok {
					if vmID, _ = h["vmId"].(string); vmID == "" {
						vmID, _ = h["vm_id"].(string)
					}
				}
			}
			if vmID == "" {
				return fmt.Errorf("schedule response missing vmId: %v", res)
			}
			// A stubbed control-plane synthesizes vmIds and spawns nothing.
			// Printing plain "scheduled" there is worse than an error: the
			// caller believes work is running. Fail loudly instead.
			if stub, _ := res["stub"].(bool); stub {
				warning, _ := res["warning"].(string)
				if warning == "" {
					warning = "no scheduler wired; nothing was spawned"
				}
				fmt.Fprintf(cmd.ErrOrStderr(),
					"\n  ✗ NOT SCHEDULED — %s\n\n"+
						"    vm_id=%s is synthetic. Nothing is running.\n"+
						"    Start the control-plane with LANTERN_SCHEDULER_GRPC_ADDR set, e.g.:\n"+
						"      make run-api-runtime\n\n", warning, vmID)
				return fmt.Errorf("scheduler not wired: no workload was spawned")
			}
			fmt.Fprintf(cmd.OutOrStdout(), "scheduled vm_id=%s\n", vmID)

			if follow {
				return streamLogs(cmd.OutOrStdout(), vmID)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "follow with: lantern vm logs %s --follow\n", vmID)
			return nil
		},
	}
	cmd.Flags().StringVar(&inputJSON, "input", "", `JSON payload piped to the workload's stdin (e.g. '{"name":"X"}')`)
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "Stream logs in real-time after scheduling")
	return cmd
}

// --- `lantern vm ...` ------------------------------------------------------

func newVmCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "vm",
		Aliases: []string{"vms", "runtime"},
		Short:   "Inspect + manage headless agent VMs",
	}
	cmd.AddCommand(newVmListCommand())
	cmd.AddCommand(newVmGetCommand())
	cmd.AddCommand(newVmLogsCommand())
	cmd.AddCommand(newVmStopCommand())
	cmd.AddCommand(newVmExecCommand())
	cmd.AddCommand(newVmClusterCommand())
	cmd.AddCommand(newVmQuotaCommand())
	cmd.AddCommand(newVmValidateCommand())
	return cmd
}

// newVmValidateCommand — `lantern vm validate`
//
// Shells scripts/validate-cluster.sh to run the gVisor/Kata cluster validation
// harness. Requires kubectl and a KUBECONFIG pointing at a real cluster; exits
// non-zero if any runnable leg fails; SKIPPED legs (RuntimeClass absent) are
// not treated as failures.
func newVmValidateCommand() *cobra.Command {
	var (
		kubeconfig string
		context    string
		report     string
	)

	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Validate gVisor/Kata isolation on a real cluster (operator harness)",
		Long: `Runs the cluster validation harness against an operator-provided Kubernetes
cluster. Performs preflight checks, runs the always-on isolation legs
(egress default-deny, securityContext, PSA, fail-closed RuntimeClass refusal),
then runs the gVisor execution leg (g) and Kata execution legs (h/i) — each
leg is SKIPPED (not failed) when the required RuntimeClass is absent, so an
operator can validate incrementally as they provision sandbox node pools.

Requires: kubectl in PATH, KUBECONFIG pointing at the target cluster.

Examples:
  lantern vm validate --kubeconfig ~/.kube/gke-sandbox.yaml
  KUBECONFIG=~/.kube/gke-sandbox.yaml lantern vm validate
  lantern vm validate --kubeconfig ./k.yaml --context gke_project_us-central1_cluster
  lantern vm validate --report /tmp/validation-$(date +%Y%m%d).md

Setup (GKE Agent Sandbox + Kata):
  infra/k8s/gke-agent-sandbox-setup.sh

See also: docs/runbooks/cluster-validation.md`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			repoRoot, err := findRepoRoot()
			if err != nil {
				return fmt.Errorf("locate repo root: %w (run from inside the Lantern repo)", err)
			}

			scriptPath := filepath.Join(repoRoot, "scripts", "validate-cluster.sh")
			if _, err := os.Stat(scriptPath); err != nil {
				return fmt.Errorf("validate-cluster.sh not found at %s: %w", scriptPath, err)
			}

			argv := []string{scriptPath}
			if kubeconfig != "" {
				argv = append(argv, "--kubeconfig", kubeconfig)
			}
			if context != "" {
				argv = append(argv, "--context", context)
			}
			if report != "" {
				argv = append(argv, "--report", report)
			}

			c := exec.Command("bash", argv...)
			c.Stdout = cmd.OutOrStdout()
			c.Stderr = cmd.ErrOrStderr()
			c.Dir = repoRoot

			// Pass the caller's environment so KUBECONFIG, LANTERN_*, etc. are visible.
			c.Env = os.Environ()

			if err := c.Run(); err != nil {
				// exec.ExitError carries the script's exit code; surface it cleanly.
				if exitErr, ok := err.(*exec.ExitError); ok {
					return fmt.Errorf("cluster validation failed (exit %d) — see output above",
						exitErr.ExitCode())
				}
				return fmt.Errorf("run validate-cluster.sh: %w", err)
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&kubeconfig, "kubeconfig", "",
		"Path to kubeconfig file (default: $KUBECONFIG env or current context)")
	cmd.Flags().StringVar(&context, "context", "",
		"Kubernetes context to use (default: current-context in kubeconfig)")
	cmd.Flags().StringVar(&report, "report", "",
		"Path for the markdown report (default: cluster-validation-report.md in cwd)")

	return cmd
}

func newVmListCommand() *cobra.Command {
	var (
		stateFilter string
		limit       int
	)
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List recent VMs",
		RunE: func(cmd *cobra.Command, args []string) error {
			q := "/v1/runtime/vms"
			params := []string{}
			if stateFilter != "" {
				params = append(params, "state="+stateFilter)
			}
			if limit > 0 {
				params = append(params, fmt.Sprintf("limit=%d", limit))
			}
			if len(params) > 0 {
				q += "?" + strings.Join(params, "&")
			}
			items, err := apiGetArray(q)
			if err != nil {
				return err
			}
			if len(items) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "(no VMs)")
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%-22s  %-10s  %-12s  %-22s  %s\n", "VM ID", "STATE", "ISOLATION", "NODE", "AGE")
			for _, it := range items {
				m, _ := it.(map[string]any)
				id, _ := m["vmId"].(string)
				st, _ := m["state"].(string)
				iso, _ := m["isolationClass"].(string)
				node, _ := m["node"].(string)
				if node == "" {
					node = "(unassigned)"
				}
				createdAt, _ := m["createdAt"].(string)
				age := "?"
				if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
					age = humanDuration(time.Since(t))
				}
				if len(id) > 20 {
					id = id[:20] + "…"
				}
				fmt.Fprintf(cmd.OutOrStdout(), "%-22s  %-10s  %-12s  %-22s  %s\n", id, st, iso, node, age)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&stateFilter, "state", "", "filter by state (running, pending, terminated, failed)")
	cmd.Flags().IntVar(&limit, "limit", 50, "max rows to return")
	return cmd
}

func newVmGetCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "get <vm-id>",
		Short: "Show full VM detail (spec, state, recent audit events)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			res, err := apiGet("/v1/runtime/vms/" + args[0])
			if err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(res, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(pretty))
			return nil
		},
	}
	return cmd
}

func newVmLogsCommand() *cobra.Command {
	var follow bool
	cmd := &cobra.Command{
		Use:   "logs <vm-id>",
		Short: "Tail logs for a VM",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return streamLogs(cmd.OutOrStdout(), args[0])
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", true, "follow the log stream (default true)")
	return cmd
}

func newVmStopCommand() *cobra.Command {
	var graceSeconds int
	cmd := &cobra.Command{
		Use:   "stop <vm-id>",
		Short: "Terminate a VM",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := fmt.Sprintf("/v1/runtime/vms/%s?grace=%ds", args[0], graceSeconds)
			res, err := apiDelete(path)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%v\n", res)
			return nil
		},
	}
	cmd.Flags().IntVar(&graceSeconds, "grace", 30, "seconds to wait for graceful drain before SIGKILL")
	return cmd
}

// --- `lantern vm exec` -------------------------------------------------------
//
// Exec speaks the RuntimeManager.Exec gRPC bidi stream directly (the
// control-plane REST surface has no streaming exec channel). The first
// frame carries the command + tty parameters; with --tty subsequent frames
// stream this terminal's raw stdin into the guest PTY and everything the
// PTY emits comes back as stdout chunks. The final frame carries the exit
// code.

// defaultManagerAddr is where the runtime-manager serves gRPC locally
// (see the service-ports table in the repo CLAUDE.md).
const defaultManagerAddr = "localhost:50054"

// resolveManagerAddr picks the runtime-manager gRPC address: explicit flag,
// then $LANTERN_MANAGER_ADDR, then the local default.
func resolveManagerAddr(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if v := os.Getenv("LANTERN_MANAGER_ADDR"); v != "" {
		return v
	}
	return defaultManagerAddr
}

// execFirstFrame builds the stream-opening ExecRequest. rows/cols <= 0 are
// omitted (the guest falls back to 24x80); termName is only sent for tty
// execs.
func execFirstFrame(vmID, command string, argv []string, tty bool, rows, cols int, termName string) *lanternv1.ExecRequest {
	req := &lanternv1.ExecRequest{
		VmId:    vmID,
		Command: command,
		Argv:    argv,
		Tty:     tty,
	}
	if tty {
		if rows > 0 {
			req.TermRows = uint32(rows)
		}
		if cols > 0 {
			req.TermCols = uint32(cols)
		}
		req.Term = termName
	}
	return req
}

// enterRawMode puts fd into raw mode when it is a terminal and returns the
// restore func. When fd is NOT a terminal (CI, piped stdin) it is a no-op:
// the guest still gets its PTY, there is just no local raw mode to manage.
func enterRawMode(fd int) (restore func(), err error) {
	if !term.IsTerminal(fd) {
		return func() {}, nil
	}
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, fmt.Errorf("enter raw mode: %w", err)
	}
	return func() { _ = term.Restore(fd, state) }, nil
}

func newVmExecCommand() *cobra.Command {
	var (
		tty         bool
		interactive bool
		managerAddr string
	)
	cmd := &cobra.Command{
		Use:   "exec <vm-id> -- <command> [args...]",
		Short: "Run a command inside a running VM",
		Long: `Runs a command inside a running VM over the runtime-manager's Exec stream.

With -t/--tty a PTY is allocated in the guest and wired to this terminal:
stdin streams into the guest, output streams back, and stdout/stderr arrive
merged (terminal semantics). -i/--interactive implies --tty. Without a tty
the exec is one-shot: no stdin, stdout/stderr kept separate.

Examples:
  lantern vm exec vm-1234 -- ls -la /tmp
  lantern vm exec -it vm-1234 -- /bin/sh`,
		Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runVmExec(cmd, args[0], args[1], args[2:],
				tty || interactive, resolveManagerAddr(managerAddr))
		},
	}
	cmd.Flags().BoolVarP(&tty, "tty", "t", false, "allocate a PTY in the guest and wire it to this terminal")
	cmd.Flags().BoolVarP(&interactive, "interactive", "i", false, "keep stdin open (implies --tty)")
	cmd.Flags().StringVar(&managerAddr, "manager-addr", "",
		"runtime-manager gRPC address (default $LANTERN_MANAGER_ADDR or "+defaultManagerAddr+")")
	return cmd
}

func runVmExec(cmd *cobra.Command, vmID, command string, argv []string, tty bool, managerAddr string) error {
	conn, err := grpc.NewClient(managerAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("dial runtime-manager %s: %w", managerAddr, err)
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(cmd.Context())
	defer cancel()

	stream, err := lanternv1.NewRuntimeManagerClient(conn).Exec(ctx)
	if err != nil {
		return fmt.Errorf("open exec stream: %w", err)
	}

	rows, cols := 0, 0
	termName := ""
	if tty {
		termName = os.Getenv("TERM")
		if termName == "" {
			termName = "xterm-256color"
		}
		if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
			cols, rows = w, h
		}
		restore, err := enterRawMode(int(os.Stdin.Fd()))
		if err != nil {
			return err
		}
		// Restore runs before cobra prints any error — the deferred order
		// (restore, then cancel/close) keeps the terminal sane on every path.
		defer restore()
	}

	if err := stream.Send(execFirstFrame(vmID, command, argv, tty, rows, cols, termName)); err != nil {
		return fmt.Errorf("send exec request: %w", err)
	}

	if tty {
		// stdin pump: raw bytes → stdin frames. Ends on local EOF (half-
		// close lets the guest see ^D) or when the RPC is torn down.
		go func() {
			buf := make([]byte, 4096)
			for {
				n, rerr := os.Stdin.Read(buf)
				if n > 0 {
					if serr := stream.Send(&lanternv1.ExecRequest{Stdin: buf[:n]}); serr != nil {
						return
					}
				}
				if rerr != nil {
					_ = stream.CloseSend()
					return
				}
			}
		}()
	} else {
		// One-shot: stdin is not piped — half-close right after the first
		// frame, matching the manager's non-interactive contract.
		if err := stream.CloseSend(); err != nil {
			return fmt.Errorf("close send: %w", err)
		}
	}

	out := cmd.OutOrStdout()
	errOut := cmd.ErrOrStderr()
	exitCode := 0
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("exec stream: %w", err)
		}
		if len(resp.Stdout) > 0 {
			_, _ = out.Write(resp.Stdout)
		}
		if len(resp.Stderr) > 0 {
			_, _ = errOut.Write(resp.Stderr)
		}
		if resp.Done {
			exitCode = int(resp.ExitCode)
		}
	}

	if exitCode != 0 {
		return fmt.Errorf("command exited with code %d", exitCode)
	}
	return nil
}

func newVmClusterCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "cluster",
		Short: "Show cluster capacity + per-node load (owner-only)",
		RunE: func(cmd *cobra.Command, args []string) error {
			res, err := apiGet("/v1/runtime/cluster")
			if err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(res, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(pretty))
			return nil
		},
	}
}

func newVmQuotaCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "quota",
		Short: "View or update this tenant's runtime quota",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "get",
		Short: "Show current quota",
		RunE: func(cmd *cobra.Command, args []string) error {
			res, err := apiGet("/v1/runtime/quota")
			if err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(res, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(pretty))
			return nil
		},
	})

	var (
		maxConcurrent int
		maxCostUSD    float64
	)
	setCmd := &cobra.Command{
		Use:   "set",
		Short: "Update quota (owner-only)",
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if maxConcurrent > 0 {
				body["max_concurrent_vms"] = maxConcurrent
			}
			if maxCostUSD > 0 {
				body["max_cost_usd_per_day"] = maxCostUSD
			}
			b, _ := json.Marshal(body)
			res, err := apiPut("/v1/runtime/quota", b)
			if err != nil {
				return err
			}
			pretty, _ := json.MarshalIndent(res, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(pretty))
			return nil
		},
	}
	setCmd.Flags().IntVar(&maxConcurrent, "max-concurrent", 0, "max concurrent VMs (0 = leave)")
	setCmd.Flags().Float64Var(&maxCostUSD, "max-cost", 0, "max USD/day (0 = leave)")
	cmd.AddCommand(setCmd)
	return cmd
}

// --- shared HTTP helpers ---------------------------------------------------
//
// We reuse restClient() (defined in root.go) for base-URL + token resolution
// so --api-url / --api-key / stored creds all behave consistently with other
// commands. The /v1/runtime/* endpoints aren't on the typed RESTClient surface,
// so we issue raw HTTP requests against RESTClient.BaseURL / Token directly.

func apiBase() string {
	c := restClient()
	if c != nil && c.BaseURL != "" {
		return c.BaseURL
	}
	return "http://localhost:8080"
}

func apiAuthHeader() string {
	c := restClient()
	if c != nil {
		if c.Token != "" {
			return "Bearer " + c.Token
		}
		if c.APIKey != "" {
			return "Bearer " + c.APIKey
		}
	}
	if t := os.Getenv("LANTERN_API_TOKEN"); t != "" {
		return "Bearer " + t
	}
	return ""
}

func apiRaw(method, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequest(method, apiBase()+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if auth := apiAuthHeader(); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	cli := &http.Client{Timeout: 30 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("api %s %s → %d: %s%s",
			method, path, resp.StatusCode, string(respBody), authHint())
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("api %s %s → %d: %s", method, path, resp.StatusCode, string(respBody))
	}
	return respBody, nil
}

// validateRuntimeSpec catches the two agent.yaml shapes being confused.
//
// `lantern init` scaffolds a CONTROL-PLANE agent (deployed with
// `lantern deploy`): name/model/instructions, `isolation.class` nested. The
// microVM runtime wants an AgentSpec: `image_digest` plus a flat `isolation`.
// Feeding the first to `lantern run` used to produce a bare
// "400: invalid body" from the server with no clue that the file was simply
// the wrong kind. Diagnose it here, where the file is in hand.
//
// It also normalizes the nested `isolation: {class: X}` form, which is a
// harmless spelling of the same thing.
func validateRuntimeSpec(spec, raw map[string]any, path string) error {
	// Nested isolation → flat, so the two spellings both work.
	if nested, ok := spec["isolation"].(map[string]any); ok {
		if class, ok := nested["class"].(string); ok && class != "" {
			spec["isolation"] = class
		}
	}

	if s, ok := spec["image_digest"].(string); ok && s != "" {
		return nil
	}
	if s, ok := spec["imageDigest"].(string); ok && s != "" {
		return nil
	}

	// No image. Is this a control-plane agent manifest?
	_, hasModel := raw["model"]
	_, hasName := raw["name"]
	if hasModel || hasName {
		name, _ := raw["name"].(string)
		if name == "" {
			name = "your-agent"
		}
		return fmt.Errorf(
			"%s looks like a control-plane agent manifest, not a microVM AgentSpec\n\n"+
				"  `lantern run` schedules a container image in the microVM runtime and needs:\n"+
				"      spec:\n"+
				"        image_digest: your-registry/%s:latest\n"+
				"        isolation: trusted\n\n"+
				"  To deploy this agent to the control plane instead, use:\n"+
				"      lantern deploy\n\n"+
				"  See examples/headless-agents/01-hello/agent.yaml for a runnable AgentSpec",
			path, name)
	}

	return fmt.Errorf("%s is missing required field `image_digest` "+
		"(the container image to run, e.g. `myorg/agent:latest`)", path)
}

// authHint turns a bare 401/403 into something actionable.
//
// A stored credential takes precedence over LANTERN_API_TOKEN, so a stale
// ~/.lantern/credentials.json silently shadows a perfectly good env token and
// every call fails with an unexplained "unauthorized". Naming which credential
// was actually sent is the difference between a 30-second fix and an hour.
func authHint() string {
	stored := ""
	if c := restClient(); c != nil {
		switch {
		case c.Token != "":
			stored = "session token from ~/.lantern/credentials.json"
		case c.APIKey != "":
			stored = "API key from ~/.lantern/credentials.json"
		}
	}
	envSet := os.Getenv("LANTERN_API_TOKEN") != ""

	switch {
	case stored != "" && envSet:
		return "\n\nhint: sent the " + stored + ", which takes precedence over the " +
			"LANTERN_API_TOKEN you also set. If the stored one is stale, run `lantern login` " +
			"(or delete ~/.lantern/credentials.json to fall back to the env var)."
	case stored != "":
		return "\n\nhint: sent the " + stored + " — it may be expired. Run `lantern login`."
	case envSet:
		return "\n\nhint: sent LANTERN_API_TOKEN — it may be expired or for a different " +
			"control-plane. Check LANTERN_API_URL, or run `lantern login`."
	default:
		return "\n\nhint: no credentials found. Run `lantern login`, or set LANTERN_API_TOKEN."
	}
}

func apiDo(method, path string, body []byte) (map[string]any, error) {
	respBody, err := apiRaw(method, path, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if len(respBody) > 0 {
		_ = json.Unmarshal(respBody, &out)
	}
	return out, nil
}

// apiGetArray fetches an endpoint that returns a bare JSON array (e.g.
// /v1/runtime/vms). apiDo can't be used for these: it unmarshals into a map,
// so an array body silently yields an empty map.
func apiGetArray(path string) ([]any, error) {
	respBody, err := apiRaw("GET", path, nil)
	if err != nil {
		return nil, err
	}
	var out []any
	if len(respBody) > 0 {
		if err := json.Unmarshal(respBody, &out); err != nil {
			return nil, fmt.Errorf("parse response: %w", err)
		}
	}
	return out, nil
}

func apiGet(path string) (map[string]any, error)               { return apiDo("GET", path, nil) }
func apiPost(path string, body []byte) (map[string]any, error) { return apiDo("POST", path, body) }
func apiPut(path string, body []byte) (map[string]any, error)  { return apiDo("PUT", path, body) }
func apiDelete(path string) (map[string]any, error)            { return apiDo("DELETE", path, nil) }

// streamLogs hits the SSE endpoint and forwards each frame to the writer.
func streamLogs(w io.Writer, vmID string) error {
	req, err := http.NewRequest("GET", apiBase()+"/v1/runtime/vms/"+vmID+"/logs?follow=1", nil)
	if err != nil {
		return err
	}
	if auth := apiAuthHeader(); auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.Header.Set("Accept", "text/event-stream")
	cli := &http.Client{Timeout: 0}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("logs stream %d: %s", resp.StatusCode, string(body))
	}
	scan := bufio.NewScanner(resp.Body)
	scan.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scan.Scan() {
		line := scan.Text()
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			fmt.Fprintln(w, payload)
		}
	}
	return scan.Err()
}

func humanDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
