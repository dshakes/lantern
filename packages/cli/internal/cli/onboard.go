package cli

// onboard.go — `pal onboard` first-run wizard.
//
// A deterministic, fail-loud state machine that takes a new user from
// "stack running" to "first agent ran successfully" with minimal input.
//
// Steps (each performs a REAL action; flow stops loudly on hard failure):
//   1. Health   — GET /healthz
//   2. Auth     — stored creds / dev seed login
//   3. Provider — GET /v1/settings/llm-providers; interactive prompt if empty
//   4. Agent    — create (or reuse) quickstart-assistant
//   5. Run      — fire a real run and print the actual output
//
// REST on :8080 only — no gRPC, no service token required.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// renderSSEEvent pretty-prints a single SSE event to stderr with colors.
// This mirrors the gRPC stream renderer in runs.go but works on the REST
// SSE event format (kind + payload map).
func renderSSEEvent(ev *internal.SSEEvent) {
	if ev == nil {
		return
	}
	p := ev.Payload
	if p == nil {
		p = map[string]any{}
	}
	getString := func(key string) string {
		if v, ok := p[key].(string); ok {
			return v
		}
		return ""
	}
	getFloat := func(key string) float64 {
		switch v := p[key].(type) {
		case float64:
			return v
		case int64:
			return float64(v)
		}
		return 0
	}

	prefix := "   "
	switch ev.Kind {
	case "step_started":
		stepID := getString("step_id")
		if stepID == "" {
			stepID = ev.StepID
		}
		fmt.Fprintf(os.Stderr, "%s%s→ step started: %s (kind: %s)%s\n",
			prefix, colorBlue, stepID, getString("kind"), colorReset)
	case "step_completed":
		stepID := getString("step_id")
		if stepID == "" {
			stepID = ev.StepID
		}
		fmt.Fprintf(os.Stderr, "%s%s✓ step completed: %s (%.0fms)%s\n",
			prefix, colorGreen, stepID, getFloat("duration_ms"), colorReset)
	case "step_failed":
		stepID := getString("step_id")
		if stepID == "" {
			stepID = ev.StepID
		}
		retry := ""
		if r, ok := p["will_retry"].(bool); ok && r {
			retry = " (retrying)"
		}
		fmt.Fprintf(os.Stderr, "%s%s✗ step failed: %s [%s] %s%s%s\n",
			prefix, colorRed, stepID, getString("error_code"), getString("error_message"), retry, colorReset)
	case "confidence_evaluated":
		decision := getString("decision")
		score := getFloat("score")
		fmt.Fprintf(os.Stderr, "%s%sconfidence %.2f → %s%s\n",
			prefix, colorYellow, score, decision, colorReset)
	case "log":
		level := getString("level")
		msg := getString("message")
		if msg == "" {
			msg = getString("msg")
		}
		fmt.Fprintf(os.Stderr, "%s[%s] %s\n", prefix, level, msg)
	case "llm_delta":
		fmt.Fprintf(os.Stderr, "%s%s%s%s", prefix, colorDim, getString("text"), colorReset)
	case "llm_complete":
		fmt.Fprintf(os.Stderr, "\n%s%s✓ llm complete (tokens_in=%d tokens_out=%d)%s\n",
			prefix, colorCyan, int(getFloat("tokens_in")), int(getFloat("tokens_out")), colorReset)
	case "end", "stream_end":
		status := getString("status")
		if status == "" {
			status = getString("reason")
		}
		fmt.Fprintf(os.Stderr, "%s%s▸ stream ended: %s%s\n", prefix, colorGreen, status, colorReset)
	case "heartbeat":
		// intentionally silent
	default:
		if ev.Kind != "" {
			fmt.Fprintf(os.Stderr, "%s%s[%s]%s\n", prefix, colorDim, ev.Kind, colorReset)
		}
	}
}

// onboardReader abstracts stdin so tests can inject a deterministic reader.
type onboardReader interface {
	ReadLine() (string, error)
	ReadMasked() (string, error)
}

// termReader reads from the real terminal (interactive path).
type termReader struct{}

func (termReader) ReadLine() (string, error) {
	var buf strings.Builder
	b := make([]byte, 1)
	for {
		_, err := os.Stdin.Read(b)
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if b[0] == '\n' {
			break
		}
		buf.WriteByte(b[0])
	}
	return strings.TrimSpace(buf.String()), nil
}

func (termReader) ReadMasked() (string, error) {
	pw, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr) // newline after hidden input
	if err != nil {
		return "", err
	}
	return string(pw), nil
}

// stringReader is an injectable reader backed by a fixed sequence of strings.
// Used in tests to exercise the interactive provider-prompt path without a TTY.
type stringReader struct {
	lines []string
	pos   int
}

func newStringReader(lines ...string) *stringReader { return &stringReader{lines: lines} }

func (r *stringReader) ReadLine() (string, error) {
	if r.pos >= len(r.lines) {
		return "", io.EOF
	}
	v := r.lines[r.pos]
	r.pos++
	return v, nil
}

func (r *stringReader) ReadMasked() (string, error) { return r.ReadLine() }

// onboardConfig holds all injectable dependencies for the wizard.
// Production code passes nils (defaults apply); tests inject mocks.
type onboardConfig struct {
	restURL     string        // override for testing
	reader      onboardReader // override for testing
	provider    string        // --provider flag (bypasses interactive)
	apiKey      string        // --api-key flag (bypasses interactive prompt)
	yes         bool          // --yes: accept all defaults non-interactively
	description string        // --description: seed the agent generation prompt
	forceTTY    bool          // tests: treat stdin as a terminal
	steps       bool          // --steps: the step wizard instead of the conversation
}

// chatMode: the conversation is the default on a terminal; any flag that asks
// for unattended behavior keeps the wizard (and --yes never prompts).
func (c *onboardConfig) chatMode() bool {
	return !c.yes && !c.steps && c.description == "" && c.provider == "" && c.apiKey == "" && c.isTTY()
}

// isTTY reports whether prompts may be shown.
func (c *onboardConfig) isTTY() bool {
	return c.forceTTY || term.IsTerminal(int(os.Stdin.Fd()))
}

func (c *onboardConfig) lineReader() onboardReader {
	if c.reader != nil {
		return c.reader
	}
	return termReader{}
}

// errOnboardDeclined: the user said no to the proposed agent. Not a failure.
var errOnboardDeclined = errors.New("onboard: proposal declined")

// defaultAgentDescription is used when --yes is set with no --description.
const defaultAgentDescription = "A helpful general-purpose AI assistant that can answer questions, summarize text, and help with everyday tasks."

// quickstartAgentName is the durable agent created by onboard.
const quickstartAgentName = "quickstart-assistant"

// quickstartSystemPrompt is the system prompt for the starter agent.
// It is intentionally useful, not a placeholder.
const quickstartSystemPrompt = `You are a helpful general-purpose assistant powered by PAL.
You can answer questions, summarize text, draft messages, explain code, and help with
day-to-day tasks. Be concise, accurate, and honest about what you do and don't know.`

// quickstartRunInput is the first run payload sent to prove the agent works.
var quickstartRunInput = json.RawMessage(`{"prompt":"Say hi and name one thing you can help me with."}`)

// guideAgentName is the on-platform guide agent created via the lantern-guide template.
const guideAgentName = "lantern-guide"

// guideSystemPrompt is the fallback prompt used when the template endpoint is unavailable.
const guideSystemPrompt = `You are the PAL onboarding guide. You receive the output (and any error) from the user's very first agent run and must explain it clearly.

Rules:
- Respond in AT MOST 3 sentences: what happened, why it matters, and what to try next.
- End with ONE concrete next command the user can copy-paste. Use EXACTLY the command supplied under "Next command:" verbatim — never invent an agent name or a flag (there is no --prompt flag; input is passed with --input '{"prompt":"..."}').
- Friendly and accurate. No markdown headers. No filler ("Great!", "Certainly!"). If there was an error, say so plainly and tell them how to fix it.`

// newOnboardCommand builds the `pal onboard` cobra.Command.
func newOnboardCommand() *cobra.Command {
	var (
		providerFlag    string
		apiKeyFlag      string
		yesFlag         bool
		descriptionFlag string
		stepsFlag       bool
	)

	cmd := &cobra.Command{
		Use:   "onboard",
		Short: "First-run wizard: health → auth → provider → agent → run",
		Long: `Walks you through the five steps needed to go from a running PAL
stack to a working AI agent in under a minute.

Each step performs a real action against the REST API on :8080 and stops
loudly if something is wrong — no silent failures, no mocked output.

The agent is created agentically: on a terminal, pal asks what you want
the agent to do, has the control plane design it (generate-spec, LLM
reasoning via the model router), shows the proposal, and creates it once you
confirm. The first run uses the design's own first task. If the design call
fails, pal says why and falls back to a general quickstart agent.

On a terminal this is a conversation with PAL's onboarding agent (the same
agent as the dashboard's /onboarding): say what you want in your own words,
and it asks follow-ups, designs, creates and runs the agent with you, explains
failures and fixes. Keys are typed at a hidden prompt, never into the chat.
--steps keeps the step-by-step wizard; if the agent can't reach the model, the
wizard takes over and says so.

Flags --provider and --api-key bypass the interactive provider prompt.
Flag --yes (or a non-terminal stdin) never prompts: CI mode, with
--description seeding the design.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := &onboardConfig{
				restURL:     deriveRESTURL(flags.apiURL),
				provider:    providerFlag,
				apiKey:      apiKeyFlag,
				yes:         yesFlag,
				description: descriptionFlag,
				steps:       stepsFlag,
			}
			return runOnboard(cfg)
		},
	}

	cmd.Flags().StringVar(&providerFlag, "provider", "", "LLM provider to configure if none exists (openai|anthropic) — skips interactive prompt")
	cmd.Flags().StringVar(&apiKeyFlag, "api-key", "", "API key for the provider (used with --provider, never echoed)")
	cmd.Flags().BoolVarP(&yesFlag, "yes", "y", false, "Non-interactive: accept defaults for all prompts")
	cmd.Flags().StringVar(&descriptionFlag, "description", "", "One-line description for the generated agent (implies --yes for this prompt)")
	cmd.Flags().BoolVar(&stepsFlag, "steps", false, "Use the step-by-step wizard instead of the conversation")

	return cmd
}

// runOnboard executes the five-step onboard wizard.
func runOnboard(cfg *onboardConfig) error {
	restURL := cfg.restURL
	if restURL == "" {
		restURL = deriveRESTURL(flags.apiURL)
	}

	fmt.Fprintln(os.Stderr, "PAL onboard — let's get you set up.")
	fmt.Fprintln(os.Stderr, strings.Repeat("─", 48))

	// ── Step 1: Health ──────────────────────────────────────────────────────
	fmt.Fprint(os.Stderr, "1. Health check ... ")
	if err := onboardHealth(restURL); err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		fmt.Fprintf(os.Stderr, "\n%s\n", err)
		fmt.Fprintln(os.Stderr, "\nBoot the stack first:")
		fmt.Fprintln(os.Stderr, "  pal dev")
		fmt.Fprintln(os.Stderr, "  # or: make run-api")
		return fmt.Errorf("onboard: health check failed")
	}
	fmt.Fprintln(os.Stderr, colorGreen+"✓"+colorReset)

	// ── Step 2: Auth ────────────────────────────────────────────────────────
	fmt.Fprint(os.Stderr, "2. Authentication ... ")
	token, authDetail, err := onboardAuth(restURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		fmt.Fprintf(os.Stderr, "\n%s\n", err)
		fmt.Fprintln(os.Stderr, "\nRun: pal login")
		return fmt.Errorf("onboard: auth failed")
	}
	fmt.Fprintf(os.Stderr, "%s✓%s  %s%s%s\n", colorGreen, colorReset, colorDim, authDetail, colorReset)

	// ── Step 3: Provider ────────────────────────────────────────────────────
	// onboardEnsureProvider prints the full "3. LLM provider ... ✓/✗" line(s)
	// itself because the no-provider path needs to interleave prompts.
	client := internal.NewRESTClient(restURL, "", token)

	// ── Conversation (default on a terminal) ────────────────────────────────
	if cfg.chatMode() {
		fmt.Fprintln(os.Stderr, strings.Repeat("─", 48))
		err := runOnboardingChat(&chatSession{
			product: "runtime", client: client, restURL: restURL, token: token,
			reader: cfg.lineReader(), out: os.Stderr,
		})
		if !errors.Is(err, errChatFallback) {
			return err
		}
		fmt.Fprintln(os.Stderr, "Continuing step by step.")
	}

	if err := onboardEnsureProvider(cfg, client, restURL, token); err != nil {
		return err
	}

	// ── Step 4: Agent (agentic creation) ────────────────────────────────────
	agentName, _, firstInput, err := onboardEnsureAgent(cfg, client)
	if errors.Is(err, errOnboardDeclined) {
		fmt.Fprintln(os.Stderr, "   Nothing was created. Run `pal onboard` again and describe it differently.")
		return nil
	}
	if err != nil {
		return err
	}
	if firstInput == nil {
		firstInput = quickstartRunInput
	}

	// ── Step 5: Run + SSE event stream ──────────────────────────────────────
	fmt.Fprint(os.Stderr, "5. First run ... ")
	run, err := client.CreateRun(agentName, firstInput, false)
	if err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		return fmt.Errorf("onboard: POST /v1/runs: %w", err)
	}
	fmt.Fprintf(os.Stderr, "%s✓%s  run %s%s%s started\n", colorGreen, colorReset, colorDim, run.ID, colorReset)

	// Stream events live, then fall back to polling if SSE is unavailable.
	fmt.Fprintln(os.Stderr, "   streaming events:")
	streamCtx, streamCancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer streamCancel()

	var finalStatus string
	sseErr := client.StreamRunEventsSSE(streamCtx, run.ID, func(ev *internal.SSEEvent) {
		renderSSEEvent(ev)
		if ev.Kind == "end" || ev.Kind == "stream_end" {
			if p := ev.Payload; p != nil {
				if s, ok := p["status"].(string); ok {
					finalStatus = s
				}
			}
		}
	})

	// If SSE fails (endpoint not yet live), fall back to polling.
	var finalRun *internal.RESTRun
	if sseErr != nil && streamCtx.Err() == nil {
		fmt.Fprintf(os.Stderr, "   %s(SSE unavailable, polling…)%s\n", colorDim, colorReset)
		finalRun, err = pollRunUntilTerminal(client, run.ID, 90*time.Second)
	} else {
		// Fetch final run to read output.
		req, _ := client.NewGETRequest("/v1/runs/" + run.ID)
		var r internal.RESTRun
		if jerr := client.DoJSON(req, &r); jerr == nil {
			finalRun = &r
		}
		if finalStatus != "" && finalRun == nil {
			finalRun = &internal.RESTRun{ID: run.ID, Status: finalStatus}
		}
	}

	if finalRun == nil {
		finalRun = &internal.RESTRun{ID: run.ID, Status: "unknown"}
	}

	if finalRun.Status == "failed" {
		errMsg := ""
		if finalRun.Error != nil {
			errMsg = finalRun.Error.Message
		}
		return fmt.Errorf("onboard: run %s failed: %s", finalRun.ID, errMsg)
	}
	if finalRun.Status != "succeeded" && finalRun.Status != "" {
		return fmt.Errorf("onboard: run %s reached status %q", finalRun.ID, finalRun.Status)
	}

	// ── Summary ─────────────────────────────────────────────────────────────
	fmt.Fprintln(os.Stderr, strings.Repeat("─", 48))
	fmt.Fprintf(os.Stderr, "%sYou're set.%s\n\n", colorGreen, colorReset)

	// Print the agent output.
	agentOutputText := ""
	if finalRun.Output != nil {
		if text, ok := finalRun.Output["text"].(string); ok && text != "" {
			agentOutputText = text
			fmt.Fprintf(os.Stderr, "Agent replied:\n  %s\n\n", text)
		} else {
			// Fallback: print the whole output map.
			if b, err := json.MarshalIndent(finalRun.Output, "  ", "  "); err == nil {
				agentOutputText = string(b)
				fmt.Fprintf(os.Stderr, "Agent output:\n  %s\n\n", string(b))
			}
		}
	}

	dashURL := "http://localhost:3001"
	fmt.Fprintf(os.Stderr, "Dashboard:  %s/runs/%s\n", dashURL, finalRun.ID)
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Run it again:")
	fmt.Fprintf(os.Stderr, "  pal runs create --agent %s --input '{\"prompt\":\"What can you do?\"}'\n", agentName)
	fmt.Fprintln(os.Stderr)

	// ── Step 6: Guide (BEST-EFFORT / FAIL-SOFT) ─────────────────────────────
	firstRunContext := agentOutputText
	if firstRunContext == "" {
		firstRunContext = "(run produced no text output)"
	}
	runGuideStep(client, firstRunContext, agentName)
	_ = agentName // used above
	fmt.Fprintf(os.Stderr, "\nnext: pal agent dev %s   # edit locally; re-publishes and re-runs on every save\n", agentName)

	return nil
}

// onboardEnsureAgent handles step 4, the agentic part: ask what the agent
// should do, have the control plane design it (POST /v1/agents/generate-spec,
// LLM reasoning through the model router), show the proposal, confirm on a
// TTY, then create it. Deterministic floor: when the design call fails, the
// reason is printed and the static quickstart agent is used instead.
// --yes / non-TTY never prompts (CI mode).
//
// Returns (agentName, created, firstRunInput, error). firstRunInput is nil
// when the quickstart floor was used.
func onboardEnsureAgent(cfg *onboardConfig, client *internal.RESTClient) (string, bool, json.RawMessage, error) {
	interactive := !cfg.yes && cfg.isTTY()

	description := cfg.description
	if description == "" {
		description = defaultAgentDescription
		if interactive {
			fmt.Fprintln(os.Stderr, "4. Agent")
			fmt.Fprintln(os.Stderr, "   What do you want your agent to do? "+colorDim+"(one or two sentences; Enter for a general assistant)"+colorReset)
			fmt.Fprint(os.Stderr, "   > ")
			if line, err := cfg.lineReader().ReadLine(); err == nil && strings.TrimSpace(line) != "" {
				description = strings.TrimSpace(line)
			}
		}
	}
	if !interactive || cfg.description != "" {
		fmt.Fprint(os.Stderr, "4. Agent ... ")
	} else {
		fmt.Fprint(os.Stderr, "   designing ... ")
	}

	spec, specErr := client.GenerateSpec(description)
	if specErr == nil && spec != nil && spec.Name != "" {
		fmt.Fprintf(os.Stderr, "%s✓%s\n", colorGreen, colorReset)
		printSpecProposal(spec)
		if _, err := client.GetAgent(spec.Name); err == nil {
			if !interactive {
				// CI (--yes / non-TTY): reuse, as before — reruns stay idempotent.
				fmt.Fprintf(os.Stderr, "   %s%s already exists — reusing it%s\n", colorDim, spec.Name, colorReset)
				return spec.Name, false, specFirstInput(spec), nil
			}
			// Interactive: an existing agent with this name may be unrelated
			// work — never take it over silently. Default: a new, unique name.
			fmt.Fprintf(os.Stderr, "   An agent named %s already exists. Reuse it as-is? [y/N] ", spec.Name)
			ans, _ := cfg.lineReader().ReadLine()
			if a := strings.ToLower(strings.TrimSpace(ans)); a == "y" || a == "yes" {
				return spec.Name, false, specFirstInput(spec), nil
			}
			free, ferr := uniqueAgentName(client, spec.Name)
			if ferr != nil {
				return "", false, nil, ferr
			}
			fmt.Fprintf(os.Stderr, "   I'll create it as %s instead.\n", free)
			spec.Name = free
		}
		if interactive {
			fmt.Fprint(os.Stderr, "   Create it? [Y/n] ")
			ans, _ := cfg.lineReader().ReadLine()
			if a := strings.ToLower(strings.TrimSpace(ans)); a == "n" || a == "no" {
				return "", false, nil, errOnboardDeclined
			}
		}
		systemPrompt := spec.SystemPrompt
		if systemPrompt == "" {
			systemPrompt = quickstartSystemPrompt
		}
		if _, cerr := client.CreateAgentWithSystemPrompt(spec.Name, spec.Description, systemPrompt); cerr != nil {
			fmt.Fprintf(os.Stderr, "   %s! create failed (%v), using quickstart%s\n", colorYellow, cerr, colorReset)
		} else {
			fmt.Fprintf(os.Stderr, "   %s✓%s created %s\n", colorGreen, colorReset, spec.Name)
			return spec.Name, true, specFirstInput(spec), nil
		}
	} else if specErr != nil {
		// Say why — a silent fallback hid that this path never worked.
		fmt.Fprintf(os.Stderr, "%s! agent design unavailable (%v) — using the quickstart agent%s\n   ", colorYellow, specErr, colorReset)
	}

	// Deterministic floor: quickstart-assistant.
	if _, err := client.GetAgent(quickstartAgentName); err != nil {
		if _, cerr := client.CreateAgentWithSystemPrompt(
			quickstartAgentName,
			"General-purpose starter agent created by `pal onboard`.",
			quickstartSystemPrompt,
		); cerr != nil {
			fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
			return "", false, nil, fmt.Errorf("onboard: create agent %q: %w", quickstartAgentName, cerr)
		}
		fmt.Fprintf(os.Stderr, "%s✓%s  %s%s (quickstart fallback, created)%s\n",
			colorGreen, colorReset, colorDim, quickstartAgentName, colorReset)
	} else {
		fmt.Fprintf(os.Stderr, "%s✓%s  %s%s (reusing existing)%s\n",
			colorGreen, colorReset, colorDim, quickstartAgentName, colorReset)
	}
	return quickstartAgentName, false, nil, nil
}

// uniqueAgentName returns base-2, base-3, … — the first name not taken.
func uniqueAgentName(client *internal.RESTClient, base string) (string, error) {
	for i := 2; i <= 50; i++ {
		name := fmt.Sprintf("%s-%d", base, i)
		if _, err := client.GetAgent(name); err != nil {
			return name, nil
		}
	}
	return "", fmt.Errorf("onboard: no free name for %q after 50 tries — pick a different goal or delete old agents", base)
}

// printSpecProposal shows the designed agent so the user knows what will be created.
func printSpecProposal(spec *internal.GenerateSpecResult) {
	fmt.Fprintf(os.Stderr, "\n   Proposed agent: %s%s%s\n", colorCyan, spec.Name, colorReset)
	if spec.Description != "" {
		fmt.Fprintf(os.Stderr, "   %s\n", spec.Description)
	}
	if spec.Rationale != "" {
		fmt.Fprintf(os.Stderr, "   %sWhy: %s%s\n", colorDim, spec.Rationale, colorReset)
	}
	for i, s := range spec.Steps {
		fmt.Fprintf(os.Stderr, "     %d. %s — %s\n", i+1, s.Name, s.Description)
	}
	if p, ok := spec.FirstInput["prompt"].(string); ok && p != "" {
		fmt.Fprintf(os.Stderr, "   First task: %q\n", p)
	}
	fmt.Fprintln(os.Stderr)
}

// specFirstInput is the spec's suggested first run input, or nil.
func specFirstInput(spec *internal.GenerateSpecResult) json.RawMessage {
	if len(spec.FirstInput) == 0 {
		return nil
	}
	b, err := json.Marshal(spec.FirstInput)
	if err != nil {
		return nil
	}
	return b
}

// onboardHealth probes /healthz with a short timeout.
func onboardHealth(restURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, restURL+"/healthz", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// onboardAuth tries stored creds then falls back to the dev seed login.
// Returns (token, detail, error).
func onboardAuth(restURL string) (string, string, error) {
	client := internal.NewRESTClient(restURL, "", "")

	creds, _ := internal.LoadCredentials()
	if creds != nil && creds.Token != "" {
		client.Token = creds.Token
		if _, err := client.GetMe(); err == nil {
			return creds.Token,
				fmt.Sprintf("stored credentials (%s)", creds.Email),
				nil
		}
	}

	// Fall back to seeded dev credentials.
	loginResp, err := client.Login("admin@lantern.dev", "lantern")
	if err != nil {
		return "", "", fmt.Errorf("stored credentials absent/stale and dev login failed: %w", err)
	}

	_ = internal.SaveCredentials(&internal.Credentials{
		Token:    loginResp.Token,
		Email:    loginResp.User.Email,
		Name:     loginResp.User.Name,
		TenantID: loginResp.User.TenantID,
		UserID:   loginResp.User.ID,
	})

	return loginResp.Token,
		fmt.Sprintf("dev login (%s)", loginResp.User.Email),
		nil
}

// onboardEnsureProvider owns the full "3. LLM provider" output line(s).
// It checks for existing providers and, if none, configures one via flags or
// the interactive TTY prompt. Prints its own ✓/✗ so the caller just returns.
func onboardEnsureProvider(cfg *onboardConfig, client *internal.RESTClient, restURL, token string) error {
	fmt.Fprint(os.Stderr, "3. LLM provider ... ")

	providers, err := fetchProviders(client)
	if err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		return fmt.Errorf("onboard: GET /v1/settings/llm-providers: %w", err)
	}

	if len(providers) > 0 {
		// A saved key is not a working key: make a real test call before the
		// agent and its first run depend on it.
		var lastErr error
		for _, p := range providers {
			name, _ := p["provider"].(string)
			if name == "" {
				continue
			}
			if lastErr = testProvider(restURL, token, name); lastErr == nil {
				fmt.Fprintf(os.Stderr, "%s✓%s  %s%s (test call ok)%s\n",
					colorGreen, colorReset, colorDim, name, colorReset)
				return nil
			}
		}
		fmt.Fprintf(os.Stderr, "%s✗  %s saved, but the test call failed: %v%s\n",
			colorYellow, providerNames(providers), lastErr, colorReset)
	} else {
		// No providers — need to configure one. Close the pending line first.
		fmt.Fprintln(os.Stderr, colorYellow+"✗  none configured"+colorReset)
	}

	provider := cfg.provider
	apiKey := cfg.apiKey

	isTTY := cfg.isTTY()
	hasFlags := provider != "" && apiKey != ""

	if !hasFlags && !isTTY {
		// CI / piped — stop cleanly with instructions.
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "No LLM provider is configured and stdin is not a terminal.")
		fmt.Fprintln(os.Stderr, "Add a provider with:")
		fmt.Fprintln(os.Stderr, `  curl -s -X POST http://localhost:8080/v1/settings/llm-providers \`)
		fmt.Fprintln(os.Stderr, `    -H 'Authorization: Bearer <token>' \`)
		fmt.Fprintln(os.Stderr, `    -H 'Content-Type: application/json' \`)
		fmt.Fprintln(os.Stderr, `    -d '{"provider":"openai","apiKey":"sk-..."}'`)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Or run again with flags:")
		fmt.Fprintln(os.Stderr, `  pal onboard --provider openai --api-key sk-...`)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Alternatively, start the API without a key requirement:")
		fmt.Fprintln(os.Stderr, "  make run-api-free  # see README for the keyless local path")
		return fmt.Errorf("onboard: no LLM provider configured (non-interactive mode)")
	}

	// Interactive prompt when we have a TTY but no flags.
	if !hasFlags {
		reader := cfg.reader
		if reader == nil {
			reader = termReader{}
		}

		fmt.Fprintln(os.Stderr, "  Configure an LLM provider to continue.")
		fmt.Fprint(os.Stderr, "  Provider (openai/anthropic): ")
		provider, err = reader.ReadLine()
		if err != nil || provider == "" {
			return fmt.Errorf("onboard: provider is required")
		}
		provider = strings.TrimSpace(strings.ToLower(provider))
		if provider != "openai" && provider != "anthropic" {
			return fmt.Errorf("onboard: unsupported provider %q (choose openai or anthropic)", provider)
		}

		fmt.Fprint(os.Stderr, "  API key: ")
		apiKey, err = reader.ReadMasked()
		if err != nil || apiKey == "" {
			return fmt.Errorf("onboard: API key is required")
		}
	}

	// POST the provider.
	if err := configureProvider(client, provider, apiKey); err != nil {
		return fmt.Errorf("onboard: save provider %q: %w", provider, err)
	}

	// Test the provider key — one retry on interactive path.
	if testErr := testProvider(restURL, token, provider); testErr != nil {
		if !hasFlags && isTTY {
			fmt.Fprintf(os.Stderr, "  Provider test failed: %v\n", testErr)
			fmt.Fprint(os.Stderr, "  Re-enter API key: ")
			reader := cfg.reader
			if reader == nil {
				reader = termReader{}
			}
			apiKey, err = reader.ReadMasked()
			if err != nil || apiKey == "" {
				return fmt.Errorf("onboard: API key is required on retry")
			}
			if err := configureProvider(client, provider, apiKey); err != nil {
				return fmt.Errorf("onboard: save provider %q (retry): %w", provider, err)
			}
			if testErr2 := testProvider(restURL, token, provider); testErr2 != nil {
				return fmt.Errorf("onboard: provider test failed after retry: %w", testErr2)
			}
		} else {
			return fmt.Errorf("onboard: provider test for %q failed: %w", provider, testErr)
		}
	}

	// Re-fetch to confirm and print the ✓ line.
	providers, err = fetchProviders(client)
	if err != nil {
		return fmt.Errorf("onboard: re-fetch providers after configure: %w", err)
	}
	fmt.Fprintf(os.Stderr, "3. LLM provider ... %s✓%s  %s%s%s\n",
		colorGreen, colorReset, colorDim, providerNames(providers), colorReset)
	return nil
}

// fetchProviders calls GET /v1/settings/llm-providers and returns the raw list.
func fetchProviders(client *internal.RESTClient) ([]map[string]any, error) {
	req, err := client.NewGETRequest("/v1/settings/llm-providers")
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	var providers []map[string]any
	if err := client.DoJSON(req, &providers); err != nil {
		return nil, err
	}
	return providers, nil
}

// configureProvider POSTs a new provider key via POST /v1/settings/llm-providers.
func configureProvider(client *internal.RESTClient, provider, apiKey string) error {
	body := map[string]string{
		"provider": provider,
		"apiKey":   apiKey,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, client.BaseURL+"/v1/settings/llm-providers", bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+client.Token)

	resp, err := client.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("API %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

// testProvider calls POST /v1/settings/llm-providers/{provider}/test.
// Returns nil only when the API reports a successful test.
func testProvider(restURL, token, provider string) error {
	req, err := http.NewRequest(http.MethodPost,
		restURL+"/v1/settings/llm-providers/"+provider+"/test", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	httpClient := &http.Client{Timeout: 15 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("test API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Parse the response — look for an explicit failure indication.
	var testResp struct {
		Success bool   `json:"success"`
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if jsonErr := json.Unmarshal(body, &testResp); jsonErr == nil {
		if testResp.Error != "" {
			return fmt.Errorf("provider test reported error: %s", testResp.Error)
		}
		if !testResp.Success && !testResp.OK {
			return fmt.Errorf("provider test did not report success: %s", strings.TrimSpace(testResp.Message+" "+string(body)))
		}
	}
	return nil
}

// providerNames extracts and joins provider names from the raw provider list.
func providerNames(providers []map[string]any) string {
	names := make([]string, 0, len(providers))
	for _, p := range providers {
		if name, ok := p["provider"].(string); ok {
			names = append(names, name)
		}
	}
	return strings.Join(names, ", ")
}

// runGuideStep is the BEST-EFFORT step 6 of onboard. It spins up the
// on-platform lantern-guide agent (via the from-template endpoint, with
// budget caps) and runs it with the context from the first real run.
//
// FAIL-SOFT CONTRACT: this function NEVER returns an error and NEVER
// prints a ✗ that implies onboard failed. Any failure is swallowed or
// results in a single dim skip line. The deterministic steps 1–5 are
// the authoritative gate; this is a nice-to-have explanation.
func runGuideStep(client *internal.RESTClient, firstRunContext, agentName string) {
	// Create or reuse the guide agent. Prefer the template path so the
	// budget cap applies automatically.
	_, templateErr := client.ApplyTemplate("lantern-guide", guideAgentName)
	if templateErr != nil {
		// Template endpoint may return 409 (already exists) or be unavailable.
		// Either way, check if the agent already exists before falling back.
		if _, getErr := client.GetAgent(guideAgentName); getErr != nil {
			// Agent doesn't exist and template failed — try direct creation.
			if _, createErr := client.CreateAgentWithSystemPrompt(
				guideAgentName,
				"The PAL onboarding guide — explains what your first run did and suggests the next command.",
				guideSystemPrompt,
			); createErr != nil {
				// Cannot create the guide agent at all — skip silently.
				fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — could not create guide agent)%s\n\n", colorDim, colorReset)
				return
			}
		}
		// Agent already exists (409) or was just created via fallback — proceed.
	}

	// Build the guide input from the first run's output context. Hand the
	// guide the EXACT next command so it can't invent an agent name or flag.
	nextCommand := fmt.Sprintf("pal runs create --agent %s --input '{\"prompt\":\"What can you do?\"}'", agentName)
	guideInput, err := json.Marshal(map[string]string{
		"prompt": "Here is the output from the user's first PAL agent run:\n\n" + firstRunContext +
			"\n\nExplain what happened and suggest one next command.\n\nNext command: " + nextCommand,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — could not build input)%s\n\n", colorDim, colorReset)
		return
	}

	guideRun, err := client.CreateRun(guideAgentName, json.RawMessage(guideInput), false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — could not start guide run)%s\n\n", colorDim, colorReset)
		return
	}

	finalGuide, err := pollRunUntilTerminal(client, guideRun.ID, 30*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — guide run timed out)%s\n\n", colorDim, colorReset)
		return
	}

	if finalGuide.Status != "succeeded" {
		fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — guide run did not succeed)%s\n\n", colorDim, colorReset)
		return
	}

	// Extract the explanation text and print it. The inline executor may return
	// the reply under "text", "result", or "output" — try each in order.
	explanation := ""
	if finalGuide.Output != nil {
		for _, key := range []string{"text", "result", "output", "content", "message"} {
			if v, ok := finalGuide.Output[key].(string); ok && v != "" {
				explanation = strings.TrimSpace(v)
				break
			}
		}
		// Last resort: if none of the known keys matched but there is exactly
		// one string value in the map, use it.
		if explanation == "" && len(finalGuide.Output) == 1 {
			for _, v := range finalGuide.Output {
				if s, ok := v.(string); ok && s != "" {
					explanation = strings.TrimSpace(s)
				}
			}
		}
	}
	if explanation == "" {
		fmt.Fprintf(os.Stderr, "%s(skipped guided explanation — guide produced no text)%s\n\n", colorDim, colorReset)
		return
	}

	fmt.Fprintln(os.Stderr, "What just happened:")
	fmt.Fprintf(os.Stderr, "  %s\n\n", strings.ReplaceAll(explanation, "\n", "\n  "))
}
