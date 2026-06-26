package cli

// onboard.go — `lantern onboard` first-run wizard.
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
	restURL  string        // override for testing
	reader   onboardReader // override for testing
	provider string        // --provider flag (bypasses interactive)
	apiKey   string        // --api-key flag (bypasses interactive prompt)
}

// quickstartAgentName is the durable agent created by onboard.
const quickstartAgentName = "quickstart-assistant"

// quickstartSystemPrompt is the system prompt for the starter agent.
// It is intentionally useful, not a placeholder.
const quickstartSystemPrompt = `You are a helpful general-purpose assistant powered by Lantern.
You can answer questions, summarize text, draft messages, explain code, and help with
day-to-day tasks. Be concise, accurate, and honest about what you do and don't know.`

// quickstartRunInput is the first run payload sent to prove the agent works.
var quickstartRunInput = json.RawMessage(`{"prompt":"Say hi and name one thing you can help me with."}`)

// newOnboardCommand builds the `lantern onboard` cobra.Command.
func newOnboardCommand() *cobra.Command {
	var (
		providerFlag string
		apiKeyFlag   string
	)

	cmd := &cobra.Command{
		Use:   "onboard",
		Short: "First-run wizard: health → auth → provider → agent → run",
		Long: `Walks you through the five steps needed to go from a running Lantern
stack to a working AI agent in under a minute.

Each step performs a real action against the REST API on :8080 and stops
loudly if something is wrong — no silent failures, no mocked output.

Flags --provider and --api-key bypass the interactive provider prompt,
which is useful for scripted / CI onboarding.`,
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg := &onboardConfig{
				restURL:  deriveRESTURL(flags.apiURL),
				provider: providerFlag,
				apiKey:   apiKeyFlag,
			}
			return runOnboard(cfg)
		},
	}

	cmd.Flags().StringVar(&providerFlag, "provider", "", "LLM provider to configure if none exists (openai|anthropic) — skips interactive prompt")
	cmd.Flags().StringVar(&apiKeyFlag, "api-key", "", "API key for the provider (used with --provider, never echoed)")

	return cmd
}

// runOnboard executes the five-step onboard wizard.
func runOnboard(cfg *onboardConfig) error {
	restURL := cfg.restURL
	if restURL == "" {
		restURL = deriveRESTURL(flags.apiURL)
	}

	fmt.Fprintln(os.Stderr, "Lantern onboard — let's get you set up.")
	fmt.Fprintln(os.Stderr, strings.Repeat("─", 48))

	// ── Step 1: Health ──────────────────────────────────────────────────────
	fmt.Fprint(os.Stderr, "1. Health check ... ")
	if err := onboardHealth(restURL); err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		fmt.Fprintf(os.Stderr, "\n%s\n", err)
		fmt.Fprintln(os.Stderr, "\nBoot the stack first:")
		fmt.Fprintln(os.Stderr, "  lantern dev")
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
		fmt.Fprintln(os.Stderr, "\nRun: lantern login")
		return fmt.Errorf("onboard: auth failed")
	}
	fmt.Fprintf(os.Stderr, "%s✓%s  %s%s%s\n", colorGreen, colorReset, colorDim, authDetail, colorReset)

	// ── Step 3: Provider ────────────────────────────────────────────────────
	// onboardEnsureProvider prints the full "3. LLM provider ... ✓/✗" line(s)
	// itself because the no-provider path needs to interleave prompts.
	client := internal.NewRESTClient(restURL, "", token)
	if err := onboardEnsureProvider(cfg, client, restURL, token); err != nil {
		return err
	}

	// ── Step 4: Agent ───────────────────────────────────────────────────────
	fmt.Fprint(os.Stderr, "4. Quickstart agent ... ")
	if _, err := client.GetAgent(quickstartAgentName); err != nil {
		// Does not exist — create it.
		if _, cerr := client.CreateAgentWithSystemPrompt(
			quickstartAgentName,
			"General-purpose starter agent created by `lantern onboard`.",
			quickstartSystemPrompt,
		); cerr != nil {
			fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
			return fmt.Errorf("onboard: create agent %q: %w", quickstartAgentName, cerr)
		}
		fmt.Fprintf(os.Stderr, "%s✓%s  %screated%s\n", colorGreen, colorReset, colorDim, colorReset)
	} else {
		fmt.Fprintf(os.Stderr, "%s✓%s  %salready exists, reusing%s\n", colorGreen, colorReset, colorDim, colorReset)
	}

	// ── Step 5: Run ─────────────────────────────────────────────────────────
	fmt.Fprint(os.Stderr, "5. First run ... ")
	run, err := client.CreateRun(quickstartAgentName, quickstartRunInput, false)
	if err != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		return fmt.Errorf("onboard: POST /v1/runs: %w", err)
	}

	finalRun, pollErr := pollRunUntilTerminal(client, run.ID, 90*time.Second)
	if pollErr != nil {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		return fmt.Errorf("onboard: poll run %s: %w", run.ID, pollErr)
	}

	if finalRun.Status == "failed" {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		errMsg := ""
		if finalRun.Error != nil {
			errMsg = finalRun.Error.Message
		}
		return fmt.Errorf("onboard: run %s failed: %s", finalRun.ID, errMsg)
	}
	if finalRun.Status != "succeeded" {
		fmt.Fprintln(os.Stderr, colorRed+"✗"+colorReset)
		return fmt.Errorf("onboard: run %s reached unexpected status %q", finalRun.ID, finalRun.Status)
	}
	fmt.Fprintf(os.Stderr, "%s✓%s  run %s%s%s succeeded\n", colorGreen, colorReset, colorDim, finalRun.ID, colorReset)

	// ── Summary ─────────────────────────────────────────────────────────────
	fmt.Fprintln(os.Stderr, strings.Repeat("─", 48))
	fmt.Fprintf(os.Stderr, "%sYou're set.%s\n\n", colorGreen, colorReset)

	// Print the agent output.
	if finalRun.Output != nil {
		if text, ok := finalRun.Output["text"].(string); ok && text != "" {
			fmt.Fprintf(os.Stderr, "Agent replied:\n  %s\n\n", text)
		} else {
			// Fallback: print the whole output map.
			if b, err := json.MarshalIndent(finalRun.Output, "  ", "  "); err == nil {
				fmt.Fprintf(os.Stderr, "Agent output:\n  %s\n\n", string(b))
			}
		}
	}

	dashURL := "http://localhost:3001"
	if strings.Contains(restURL, "localhost") || strings.Contains(restURL, "127.0.0.1") {
		dashURL = "http://localhost:3001"
	}

	fmt.Fprintf(os.Stderr, "Dashboard:  %s/runs/%s\n", dashURL, finalRun.ID)
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Run it again:")
	fmt.Fprintf(os.Stderr, "  lantern runs create --agent %s --input '{\"prompt\":\"What can you do?\"}'\n", quickstartAgentName)
	fmt.Fprintln(os.Stderr)

	return nil
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
		fmt.Fprintf(os.Stderr, "%s✓%s  %s%s%s\n",
			colorGreen, colorReset, colorDim, providerNames(providers), colorReset)
		return nil
	}

	// No providers — need to configure one. Close the pending line first.
	fmt.Fprintln(os.Stderr, colorYellow+"✗  none configured"+colorReset)

	provider := cfg.provider
	apiKey := cfg.apiKey

	isTTY := term.IsTerminal(int(os.Stdin.Fd()))
	hasFlags := provider != "" && apiKey != ""

	if !hasFlags && !isTTY {
		// CI / piped — stop cleanly with instructions.
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "No LLM provider is configured and stdin is not a terminal.")
		fmt.Fprintln(os.Stderr, "Add a provider with:")
		fmt.Fprintln(os.Stderr, `  curl -s -X POST http://localhost:8080/v1/settings/llm-providers \`)
		fmt.Fprintln(os.Stderr, `    -H 'Authorization: Bearer <token>' \`)
		fmt.Fprintln(os.Stderr, `    -H 'Content-Type: application/json' \`)
		fmt.Fprintln(os.Stderr, `    -d '{"provider":"openai","api_key":"sk-..."}'`)
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Or run again with flags:")
		fmt.Fprintln(os.Stderr, `  lantern onboard --provider openai --api-key sk-...`)
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
		"api_key":  apiKey,
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
