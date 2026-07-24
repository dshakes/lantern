package cli

// doctor.go — `lantern doctor` readiness check.
//
// Runs a sequence of hard checks against the local dev stack on :8080 and
// prints a ✓/✗ line for each one. Exits non-zero when any hard check fails.
//
// All network calls go through the existing RESTClient + Login helpers (REST on
// :8080, not gRPC :50051) so a first-timer with no service token can run this.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
	"github.com/spf13/cobra"
)

func newDoctorCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check that the Lantern stack is ready for use",
		Long: `Runs a sequence of readiness checks against the local stack and prints
a pass/fail line for each one. Exits non-zero if any hard check fails.

Checks performed:
  (a) HTTP health      — GET /healthz on :8080 returns {"status":"ok"}
  (b) Authentication   — stored credentials or dev default login.
  (c) LLM provider     — at least one provider key is configured.
  (d) End-to-end run   — creates a throwaway agent, runs it, confirms success.
  (e) Service ports    — TCP reachability of all known service ports.
  (f) Peer services    — GET /v1/system/health peer-service states (if available).`,
		SilenceUsage: true,
		RunE:         runDoctor,
	}
}

// checkResult holds the outcome of a single doctor check.
type checkResult struct {
	label  string
	passed bool
	detail string // printed after ✓/✗ when non-empty
	hard   bool   // hard failures cause a non-zero exit
}

// runDoctor executes all checks and prints results grouped by section.
func runDoctor(_ *cobra.Command, _ []string) error {
	restURL := deriveRESTURL(flags.apiURL)

	anyFailed := false
	printSection := func(title string, results []checkResult) {
		fmt.Fprintf(os.Stderr, "\n%s%s%s\n", colorCyan, title, colorReset)
		for _, r := range results {
			icon := colorGreen + "✓" + colorReset
			if !r.passed {
				icon = colorRed + "✗" + colorReset
				if r.hard {
					anyFailed = true
				}
			} else if !r.hard {
				icon = colorYellow + "~" + colorReset
			}
			line := fmt.Sprintf("  %s  %s", icon, r.label)
			if r.detail != "" {
				line += "  " + colorDim + r.detail + colorReset
			}
			fmt.Fprintln(os.Stderr, line)
		}
	}

	// ── Core checks ───────────────────────────────────────────────────────
	healthResult := checkHealth(restURL)
	authResult, token := checkAuth(restURL)
	provResult := checkProviders(restURL, token)

	var runResult checkResult
	if token != "" {
		runResult = checkRun(restURL, token)
	} else {
		runResult = checkResult{
			label:  "end-to-end run",
			passed: false,
			detail: "skipped — no auth token (fix authentication first)",
			hard:   true,
		}
	}
	printSection("Core", []checkResult{healthResult, authResult, provResult, runResult})

	// ── Service ports ─────────────────────────────────────────────────────
	printSection("Service ports", checkPorts())

	// ── Peer-service health ───────────────────────────────────────────────
	if peerResults := checkSystemHealth(restURL, token); len(peerResults) > 0 {
		printSection("Peer services", peerResults)
	}

	fmt.Fprintln(os.Stderr)
	if anyFailed {
		fmt.Fprintln(os.Stderr, colorRed+"doctor: one or more critical checks failed — see details above"+colorReset)
		return fmt.Errorf("doctor: readiness checks failed")
	}
	fmt.Fprintln(os.Stderr, colorGreen+"doctor: all checks passed — stack is ready"+colorReset)
	return nil
}

// checkHealth probes GET /healthz on restURL.
func checkHealth(restURL string) checkResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, restURL+"/healthz", nil)
	if err != nil {
		return checkResult{
			label:  "HTTP health (:8080/healthz)",
			passed: false,
			detail: fmt.Sprintf("build request: %v", err),
			hard:   true,
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return checkResult{
			label:  "HTTP health (:8080/healthz)",
			passed: false,
			detail: fmt.Sprintf("unreachable — is `lantern dev` (or `make run-api`) running? (%v)", err),
			hard:   true,
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return checkResult{
			label:  "HTTP health (:8080/healthz)",
			passed: false,
			detail: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body))),
			hard:   true,
		}
	}

	// Parse JSON response to extract llmMode for informational detail.
	var healthResp struct {
		Status  string `json:"status"`
		LLMMode string `json:"llmMode"`
	}
	detail := "ok"
	if err := json.Unmarshal(body, &healthResp); err == nil && healthResp.LLMMode != "" {
		detail = fmt.Sprintf("ok  llmMode=%s", healthResp.LLMMode)
	}

	return checkResult{
		label:  "HTTP health (:8080/healthz)",
		passed: true,
		detail: detail,
		hard:   true,
	}
}

// checkAuth verifies credentials or falls back to the seeded dev login.
// Returns the check result and the token to use for subsequent calls.
func checkAuth(restURL string) (checkResult, string) {
	client := internal.NewRESTClient(restURL, "", "")

	// Try stored credentials first.
	creds, _ := internal.LoadCredentials()
	if creds != nil && creds.Token != "" {
		client.Token = creds.Token
		if _, err := client.GetMe(); err == nil {
			return checkResult{
				label:  "authentication",
				passed: true,
				detail: fmt.Sprintf("stored credentials valid (%s)", creds.Email),
				hard:   true,
			}, creds.Token
		}
	}

	// Fall back to seeded dev credentials.
	loginResp, err := client.Login("admin@lantern.dev", "lantern")
	if err != nil {
		return checkResult{
			label:  "authentication",
			passed: false,
			detail: fmt.Sprintf("stored credentials absent/stale and dev login failed: %v — run `lantern login`", err),
			hard:   true,
		}, ""
	}

	// Persist so subsequent calls work.
	_ = internal.SaveCredentials(&internal.Credentials{
		Token:    loginResp.Token,
		Email:    loginResp.User.Email,
		Name:     loginResp.User.Name,
		TenantID: loginResp.User.TenantID,
		UserID:   loginResp.User.ID,
	})

	return checkResult{
		label:  "authentication",
		passed: true,
		detail: fmt.Sprintf("dev default login succeeded (%s)", loginResp.User.Email),
		hard:   true,
	}, loginResp.Token
}

// checkProviders calls GET /v1/settings/llm-providers and confirms ≥1 is configured.
func checkProviders(restURL, token string) checkResult {
	if token == "" {
		return checkResult{
			label:  "LLM provider configured",
			passed: false,
			detail: "skipped — no auth token",
			hard:   true,
		}
	}

	client := internal.NewRESTClient(restURL, "", token)
	req, err := client.NewGETRequest("/v1/settings/llm-providers")
	if err != nil {
		return checkResult{
			label:  "LLM provider configured",
			passed: false,
			detail: fmt.Sprintf("build request: %v", err),
			hard:   true,
		}
	}

	var providers []map[string]any
	if err := client.DoJSON(req, &providers); err != nil {
		return checkResult{
			label:  "LLM provider configured",
			passed: false,
			detail: fmt.Sprintf("GET /v1/settings/llm-providers: %v", err),
			hard:   true,
		}
	}

	if len(providers) == 0 {
		return checkResult{
			label:  "LLM provider configured",
			passed: false,
			detail: "no provider found — add one: " +
				`POST /v1/settings/llm-providers -d '{"provider":"openai","api_key":"sk-..."}'` +
				" or set OPENAI_API_KEY / ANTHROPIC_API_KEY",
			hard: true,
		}
	}

	names := make([]string, 0, len(providers))
	for _, p := range providers {
		if name, ok := p["provider"].(string); ok {
			names = append(names, name)
		}
	}

	return checkResult{
		label:  "LLM provider configured",
		passed: true,
		detail: strings.Join(names, ", "),
		hard:   true,
	}
}

// doctorAgentName is the throwaway agent created by checkRun.
const doctorAgentName = "lantern-doctor-probe"

// checkRun creates a throwaway agent, fires a trivial run, polls until terminal,
// reports the result, and deletes the agent.
func checkRun(restURL, token string) checkResult {
	client := internal.NewRESTClient(restURL, "", token)

	// Ensure the probe agent exists (create or reuse).
	created := false
	if _, err := client.GetAgent(doctorAgentName); err != nil {
		if _, cerr := client.CreateAgentWithSystemPrompt(
			doctorAgentName,
			"Lantern doctor probe agent — safe to delete.",
			"Reply with exactly one word: ready",
		); cerr != nil {
			return checkResult{
				label:  "end-to-end run",
				passed: false,
				detail: fmt.Sprintf("create probe agent: %v", cerr),
				hard:   true,
			}
		}
		created = true
	}

	// Clean up the agent when done (best effort).
	if created {
		defer func() { _ = client.DeleteAgent(doctorAgentName) }()
	}

	// Fire a trivial run.
	run, err := client.CreateRun(doctorAgentName, nil, false)
	if err != nil {
		return checkResult{
			label:  "end-to-end run",
			passed: false,
			detail: fmt.Sprintf("POST /v1/runs: %v", err),
			hard:   true,
		}
	}

	// Poll until terminal (up to 60 s).
	finalRun, pollErr := pollRunUntilTerminal(client, run.ID, 60*time.Second)
	if pollErr != nil {
		return checkResult{
			label:  "end-to-end run",
			passed: false,
			detail: fmt.Sprintf("poll run %s: %v", run.ID, pollErr),
			hard:   true,
		}
	}

	switch finalRun.Status {
	case "succeeded":
		return checkResult{
			label:  "end-to-end run",
			passed: true,
			detail: fmt.Sprintf("run %s succeeded", finalRun.ID),
			hard:   true,
		}
	case "failed":
		errMsg := ""
		if finalRun.Error != nil {
			errMsg = finalRun.Error.Message
		}
		return checkResult{
			label:  "end-to-end run",
			passed: false,
			detail: fmt.Sprintf("run %s failed: %s", finalRun.ID, errMsg),
			hard:   true,
		}
	default:
		return checkResult{
			label:  "end-to-end run",
			passed: false,
			detail: fmt.Sprintf("run %s reached unexpected status %q", finalRun.ID, finalRun.Status),
			hard:   true,
		}
	}
}

// servicePort describes a known Lantern service port.
type servicePort struct {
	port string
	name string
	hard bool // true = critical failure; false = soft warning
}

// knownPorts lists all service ports from the CLAUDE.md port table.
var knownPorts = []servicePort{
	{"8080", "control-plane HTTP", true},
	{"50051", "control-plane gRPC", false},
	{"50052", "workflow-engine gRPC", false},
	{"50053", "model-router gRPC", false},
	{"50054", "runtime-manager gRPC", false},
	{"50055", "runtime-scheduler gRPC", false},
	{"3001", "dashboard", false},
}

// checkPorts dials each known service port and returns one checkResult per port.
func checkPorts() []checkResult {
	results := make([]checkResult, 0, len(knownPorts))
	for _, sp := range knownPorts {
		addr := "localhost:" + sp.port
		conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err != nil {
			remedy := ""
			if sp.port == "8080" {
				remedy = " — run: lantern dev (or make run-api)"
			} else if sp.port == "3001" {
				remedy = " — run: make dashboard-dev"
			}
			results = append(results, checkResult{
				label:  fmt.Sprintf("%s (:%s)", sp.name, sp.port),
				passed: false,
				detail: "unreachable" + remedy,
				hard:   sp.hard,
			})
			continue
		}
		_ = conn.Close()
		results = append(results, checkResult{
			label:  fmt.Sprintf("%s (:%s)", sp.name, sp.port),
			passed: true,
			hard:   sp.hard,
		})
	}
	return results
}

// checkSystemHealth calls GET /v1/system/health and returns one checkResult per
// peer service reported. Returns nil when the endpoint is not yet wired (404).
func checkSystemHealth(restURL, token string) []checkResult {
	if token == "" {
		return nil
	}
	client := internal.NewRESTClient(restURL, "", token)
	health, err := client.SystemHealth()
	if err != nil {
		return []checkResult{{
			label:  "peer services (GET /v1/system/health)",
			passed: false,
			detail: err.Error(),
			hard:   false,
		}}
	}
	if health == nil {
		return nil // endpoint not yet wired — skip section silently
	}

	// health map is expected to have a "services" key with per-service state.
	services, _ := health["services"].(map[string]any)
	if len(services) == 0 {
		// Flat format: treat every key as a service name with a status string.
		results := make([]checkResult, 0, len(health))
		for name, val := range health {
			status := fmt.Sprintf("%v", val)
			passed := strings.EqualFold(status, "ok") || strings.EqualFold(status, "healthy") || strings.EqualFold(status, "up")
			results = append(results, checkResult{
				label:  name,
				passed: passed,
				detail: status,
				hard:   false,
			})
		}
		return results
	}

	results := make([]checkResult, 0, len(services))
	for name, val := range services {
		var status string
		switch v := val.(type) {
		case string:
			status = v
		case map[string]any:
			if s, ok := v["status"].(string); ok {
				status = s
			} else {
				status = fmt.Sprintf("%v", v)
			}
		default:
			status = fmt.Sprintf("%v", v)
		}
		passed := strings.EqualFold(status, "ok") || strings.EqualFold(status, "healthy") || strings.EqualFold(status, "up")
		results = append(results, checkResult{
			label:  name,
			passed: passed,
			detail: status,
			hard:   false,
		})
	}
	return results
}

// pollRunUntilTerminal polls GET /v1/runs/{id} every 1 s until the run is in a
// terminal state (succeeded / failed / canceled) or deadline is exceeded.
func pollRunUntilTerminal(client *internal.RESTClient, runID string, timeout time.Duration) (*internal.RESTRun, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := client.NewGETRequest("/v1/runs/" + runID)
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		var run internal.RESTRun
		if err := client.DoJSON(req, &run); err != nil {
			return nil, fmt.Errorf("GET /v1/runs/%s: %w", runID, err)
		}
		switch run.Status {
		case "succeeded", "failed", "canceled":
			return &run, nil
		}
		time.Sleep(1 * time.Second)
	}
	return nil, fmt.Errorf("timed out after %v waiting for run %s to reach terminal state", timeout, runID)
}
