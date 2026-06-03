package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// LlmProxyHandler proxies completion requests to upstream LLM providers
// (OpenAI, Anthropic). It checks for tenant-specific API keys first,
// then falls back to environment variables.
type LlmProxyHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewLlmProxyHandler creates a new LlmProxyHandler.
func NewLlmProxyHandler(srv *server.Server, auth *AuthHandler) *LlmProxyHandler {
	return &LlmProxyHandler{srv: srv, auth: auth}
}

// maxToolTurnsEnv returns the tool-call budget per LLM turn. Defaults
// to 12 (covers realistic cross-source synthesis: docs + Gmail +
// Calendar + iMessage + WhatsApp + 2-3 follow-up reads + 1 synthesis
// turn). Override via LANTERN_LLM_MAX_TURNS for deployments that need
// more headroom (multi-step research) or less (cost-bounded).
func maxToolTurnsEnv() int {
	v := os.Getenv("LANTERN_LLM_MAX_TURNS")
	if v == "" {
		return 12
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 12
	}
	if n > 40 {
		return 40 // hard ceiling — runaway loops past here are almost certainly bugs
	}
	return n
}

func (h *LlmProxyHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("llm_proxy")
}

func (h *LlmProxyHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return r.Context(), claims.TenantID, nil
}

// ---------- Request / response types ----------

type completionRequest struct {
	Model       string              `json:"model"`
	Messages    []completionMessage `json:"messages"`
	Stream      bool                `json:"stream"`
	Temperature *float64            `json:"temperature,omitempty"`
	MaxTokens   *int                `json:"maxTokens,omitempty"`
	// Optional. When the completion is made on behalf of a specific
	// agent, pass its name so the server can attach the tenant's
	// installed-connector tools and run the same tool-use loop the
	// session API uses. Without this, the call falls through to the
	// classic single-shot completion (no tools).
	AgentName string `json:"agentName,omitempty"`
}

type completionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type completionResponse struct {
	Model        string  `json:"model"`
	Content      string  `json:"content"`
	TokensIn     int     `json:"tokensIn"`
	TokensOut    int     `json:"tokensOut"`
	CostUsd      float64 `json:"costUsd"`
	Provider     string  `json:"provider"`
	FinishReason string  `json:"finishReason"`
}

// ---------- Provider key resolution ----------

type providerConfig struct {
	provider string
	apiKey   string
}

// resolveProviderKey looks up API keys: first in the DB for the tenant,
// then from environment variables.
func (h *LlmProxyHandler) resolveProviderKey(ctx context.Context, tenantID, provider string) (string, error) {
	// 1. Check tenant-specific keys in DB.
	var apiKeyEncrypted string
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT api_key_encrypted FROM llm_provider_configs
		WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
	`, tenantID, provider).Scan(&apiKeyEncrypted)
	if err == nil && apiKeyEncrypted != "" {
		// Decrypt at rest (internal/secrets). Legacy plaintext keys pass
		// through unchanged; encrypted keys are AES-256-GCM enveloped.
		dec, decErr := secrets.Decrypt([]byte(apiKeyEncrypted))
		if decErr != nil {
			return "", fmt.Errorf("decrypt provider key: %w", decErr)
		}
		return string(dec), nil
	}

	// 2. Fall back to environment variables.
	switch provider {
	case "openai":
		if key := os.Getenv("OPENAI_API_KEY"); key != "" {
			return key, nil
		}
	case "anthropic":
		if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
			return key, nil
		}
	}

	return "", fmt.Errorf("no API key configured for provider %q", provider)
}

// providerAvailable reports whether the tenant has an active key for the
// given provider (DB-configured in Settings, or in the process env as fallback).
func (h *LlmProxyHandler) providerAvailable(ctx context.Context, tenantID, provider string) bool {
	var count int
	_ = h.srv.Pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM llm_provider_configs
		WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
	`, tenantID, provider).Scan(&count)
	if count > 0 {
		return true
	}
	switch provider {
	case "openai":
		return os.Getenv("OPENAI_API_KEY") != ""
	case "anthropic":
		return os.Getenv("ANTHROPIC_API_KEY") != ""
	}
	return false
}

// resolveModelForTenant is the tenant-aware version of resolveModel. It maps
// "auto" against the tenant's actually-configured providers so the router
// picks from what the user set up in Settings, not just the process env.
func (h *LlmProxyHandler) resolveModelForTenant(ctx context.Context, tenantID, capability string) (string, string) {
	if capability == "auto" || capability == "" {
		return resolveAutoModel(
			h.providerAvailable(ctx, tenantID, "anthropic"),
			h.providerAvailable(ctx, tenantID, "openai"),
		)
	}
	return resolveModel(capability)
}

// resolveModelForTenantAuto is the complexity-aware variant used by the tool
// loop. When LANTERN_COMPLEXITY_ROUTING=1 it classifies the turn and routes to
// the cheapest model that can handle it; otherwise it falls back to the normal
// balanced scorer. The hint string is the value of X-Lantern-Turn-Hint (empty
// when not provided).
func (h *LlmProxyHandler) resolveModelForTenantAuto(
	ctx context.Context,
	tenantID string,
	messages []map[string]any,
	hasTools bool,
	hint string,
) (string, string) {
	hasAnthropic := h.providerAvailable(ctx, tenantID, "anthropic")
	hasOpenAI := h.providerAvailable(ctx, tenantID, "openai")
	if complexityRoutingEnabled() {
		tier := classifyTurnComplexity(messages, hasTools, hint)
		return resolveModelForComplexity(tier, hasAnthropic, hasOpenAI)
	}
	return resolveAutoModel(hasAnthropic, hasOpenAI)
}

// claudeCodeBinary returns the resolved `claude` binary path when local
// Claude Code routing is enabled, otherwise empty. Gated by an explicit
// env var so prod can't accidentally route through a dev tool.
//
// LANTERN_USE_CLAUDE_CODE=1   → enable; uses the user's Claude Max
//
//	subscription (no API credits burned)
//
// LANTERN_CLAUDE_BINARY=/path → override binary location
func claudeCodeBinary() string {
	if os.Getenv("LANTERN_USE_CLAUDE_CODE") != "1" {
		return ""
	}
	if explicit := os.Getenv("LANTERN_CLAUDE_BINARY"); explicit != "" {
		return explicit
	}
	if path, err := exec.LookPath("claude"); err == nil {
		return path
	}
	return ""
}

// callClaudeCode shells out to `claude -p <prompt>` and returns the
// stdout text. Designed for local dev: lets the developer use their
// Claude Max subscription instead of burning API credits.
//
// Caveats:
//   - Token usage is not reported by the CLI; cost is hard-coded to 0.
//   - No streaming, no tool use — only good for plain summarize/respond.
//   - Falls through to API providers via the failover chain if the CLI
//     errors out, so a missing binary or auth issue isn't fatal.
func callClaudeCode(ctx context.Context, prompt string) (string, error) {
	binary := claudeCodeBinary()
	if binary == "" {
		return "", fmt.Errorf("claude code routing not enabled or binary missing")
	}
	// Cap to 60s — Claude Code occasionally hangs on tool-use prompts we
	// don't want here anyway.
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, binary, "-p", prompt, "--output-format", "text")
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("claude code failed: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// callLLMSync makes a synchronous (non-streaming) LLM call and returns the
// result text along with usage metrics. Used by the inline run executor.
func (h *LlmProxyHandler) callLLMSync(ctx context.Context, provider, model, apiKey, prompt string) (result string, tokensIn, tokensOut int64, costUsd float64, err error) {
	_ = ctx // context for future cancellation support

	// Local Claude Code path. apiKey is ignored — auth is via the user's
	// `claude` CLI session, not a server-side token. Token + cost are
	// not reported by the CLI so we return zeros (caller can still log
	// the model name as 'claude-code/local' for visibility).
	if provider == "claude-code" {
		text, err := callClaudeCode(ctx, prompt)
		return text, 0, 0, 0, err
	}

	switch provider {
	case "openai":
		reqBody := map[string]any{
			"model": model,
			"messages": []map[string]string{
				{"role": "user", "content": prompt},
			},
			"max_tokens": 2048,
		}
		bodyBytes, _ := json.Marshal(reqBody)

		req, _ := http.NewRequest("POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", 0, 0, 0, httpErr
		}
		defer resp.Body.Close()

		var oaiResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
			} `json:"usage"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&oaiResp); decErr != nil {
			return "", 0, 0, 0, decErr
		}
		if len(oaiResp.Choices) == 0 {
			return "", 0, 0, 0, fmt.Errorf("no choices in response")
		}
		tin := oaiResp.Usage.PromptTokens
		tout := oaiResp.Usage.CompletionTokens
		cost := float64(tin)*2.5/1_000_000 + float64(tout)*10.0/1_000_000
		return oaiResp.Choices[0].Message.Content, tin, tout, cost, nil

	case "anthropic":
		reqBody := map[string]any{
			"model":      model,
			"max_tokens": 2048,
			"messages": []map[string]string{
				{"role": "user", "content": prompt},
			},
		}
		bodyBytes, _ := json.Marshal(reqBody)

		req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")

		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", 0, 0, 0, httpErr
		}
		defer resp.Body.Close()

		var antResp struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				InputTokens  int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&antResp); decErr != nil {
			return "", 0, 0, 0, decErr
		}
		if len(antResp.Content) == 0 {
			return "", 0, 0, 0, fmt.Errorf("no content in response")
		}
		tin := antResp.Usage.InputTokens
		tout := antResp.Usage.OutputTokens
		cost := float64(tin)*3.0/1_000_000 + float64(tout)*15.0/1_000_000
		return antResp.Content[0].Text, tin, tout, cost, nil

	default:
		return "", 0, 0, 0, fmt.Errorf("unsupported provider: %s", provider)
	}
}

// resolveModel maps a capability name to a concrete provider + model.
// modelOption represents a model candidate for routing.
type modelOption struct {
	provider     string
	model        string
	costPer1MIn  float64 // $/1M input tokens
	costPer1MOut float64 // $/1M output tokens
	quality      int     // 1-10, higher is better
	speed        int     // 1-10, higher is faster
}

// Live model IDs — kept here so a single env override (e.g.
// LANTERN_OPUS_MODEL=claude-opus-4-8) flips every consumer at once
// without grep-and-replace through the codebase. Defaults track the
// latest Claude 4.X family at time of writing (4.7 for opus / 4.6 for
// sonnet / 4.5 for haiku). If Anthropic releases a newer ID (4.8+),
// set LANTERN_OPUS_MODEL=claude-opus-4-8 and restart — no rebuild.
//
// The multi-provider failover wrapper (newFailoverProvider) catches
// 4xx from an invalid/unauthorised model ID and tries the next
// candidate in the chain, so a misconfigured env doesn't take the
// agent offline.
func envModel(envKey, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(envKey)); v != "" {
		return v
	}
	return fallback
}

// Default to the latest opus (4.8); env override flips to 4-7 / 4-6 /
// older as needed. Failover wrapper catches 4xx if the model isn't
// available on this tenant's API key.
func opusModel() string   { return envModel("LANTERN_OPUS_MODEL", "claude-opus-4-8") }
func sonnetModel() string { return envModel("LANTERN_SONNET_MODEL", "claude-sonnet-4-6") }
func haikuModel() string  { return envModel("LANTERN_HAIKU_MODEL", "claude-haiku-4-5-20251001") }

// All available models with their characteristics. modelCatalog is now
// derived dynamically so envModel overrides are honored at every
// resolveAutoModel call (not just at process startup).
func currentModelCatalog() []modelOption {
	return []modelOption{
		{"anthropic", opusModel(), 15.0, 75.0, 10, 4},
		{"anthropic", sonnetModel(), 3.0, 15.0, 9, 7},
		{"anthropic", haikuModel(), 0.25, 1.25, 6, 10},
		{"openai", "gpt-4o", 2.5, 10.0, 8, 8},
		{"openai", "gpt-4o-mini", 0.15, 0.60, 5, 10},
	}
}

// Compatibility shim — old call sites use modelCatalog directly. Keep
// it pointing at the dynamic catalog so they pick up env overrides.
var modelCatalog = currentModelCatalog()

// resolveModel maps a capability name to a concrete provider + model.
// "auto" requires tenant context so we can consult llm_provider_configs — use
// (*LlmProxyHandler).resolveModelForTenant for that case. This plain form
// handles only named capabilities and delegates "auto" to an env-only default.
func resolveModel(capability string) (provider, model string) {
	switch capability {
	case "auto", "":
		return resolveAutoModel(
			os.Getenv("ANTHROPIC_API_KEY") != "",
			os.Getenv("OPENAI_API_KEY") != "",
		)
	case "chat-large":
		return "openai", "gpt-4o"
	case "reasoning-frontier":
		return "anthropic", opusModel()
	case "reasoning-large":
		return "anthropic", sonnetModel()
	case "reasoning-small":
		return "anthropic", haikuModel()
	case "chat-small":
		return "openai", "gpt-4o-mini"
	case "code-large":
		return "anthropic", sonnetModel()
	case "vision-large":
		return "openai", "gpt-4o"
	default:
		if strings.HasPrefix(capability, "gpt") || strings.HasPrefix(capability, "o1") || strings.HasPrefix(capability, "o3") {
			return "openai", capability
		}
		if strings.HasPrefix(capability, "claude") {
			return "anthropic", capability
		}
		return "openai", "gpt-4o"
	}
}

// resolveAutoModel picks the best model given which providers have a key
// available. Caller is responsible for determining availability (DB +
// env-var fallback) so we can pick from what the specific tenant has
// configured rather than only what's in the control-plane process env.
func resolveAutoModel(hasAnthropic, hasOpenAI bool) (string, string) {
	// Routing strategy: "balanced" — prefer the best quality-to-cost ratio
	// that's available. Anthropic Sonnet 4 is the sweet spot (quality 9, speed 7, $3/$15).
	// OpenAI GPT-4o is close (quality 8, speed 8, $2.5/$10).
	// For cost-sensitive: Haiku or GPT-4o-mini.

	routeStrategy := os.Getenv("LANTERN_ROUTE_STRATEGY") // "balanced" | "cheap" | "quality" | "fast"
	if routeStrategy == "" {
		routeStrategy = "balanced"
	}

	type candidate struct {
		provider, model string
		score           float64
	}

	var candidates []candidate
	for _, m := range modelCatalog {
		if m.provider == "anthropic" && !hasAnthropic {
			continue
		}
		if m.provider == "openai" && !hasOpenAI {
			continue
		}

		var score float64
		switch routeStrategy {
		case "cheap":
			// Lower cost = higher score. Invert cost.
			score = 100.0 / (m.costPer1MIn + m.costPer1MOut + 1)
		case "quality":
			score = float64(m.quality) * 10
		case "fast":
			score = float64(m.speed) * 10
		default: // "balanced"
			// Balanced means "best quality at a reasonable cost", not "cheapest
			// model that runs". The previous formula gave gpt-4o-mini a score
			// of ~222 (mostly from cost-inverse) vs gpt-4o at ~78, so 'balanced'
			// always picked mini — which is tool-shy in practice (the model
			// often refuses to call tools that ARE present in the request).
			//
			// New formula: quality dominates; cost is a tiebreaker with a hard
			// cap so it can't outscore a quality jump.
			costBonus := 30.0 / (m.costPer1MIn + m.costPer1MOut + 1) // capped ~30
			score = float64(m.quality)*20 + float64(m.speed)*3 + costBonus
		}

		candidates = append(candidates, candidate{m.provider, m.model, score})
	}

	if len(candidates) == 0 {
		// No provider configured — fall back to OpenAI as default
		return "openai", "gpt-4o"
	}

	// Pick the highest scoring candidate
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.score > best.score {
			best = c
		}
	}

	return best.provider, best.model
}

// resolveCandidateChain returns the full provider-ranked list (highest
// quality-balanced score first) for callers that want to do their own
// failover. Same scoring as resolveAutoModel but returns ALL candidates.
//
// Used by callLLMWithFailover so that if Claude returns 429 / 402 / 5xx,
// the next request hits GPT-4o automatically. Without this, a single
// provider outage stops every Lantern agent on the tenant.
//
// Local Claude Code: when LANTERN_USE_CLAUDE_CODE=1 and the `claude`
// binary is on PATH, claude-code is PREPENDED as the top candidate.
// That makes local dev free (uses the user's Claude Max subscription
// instead of API credits). If the CLI fails for any reason — binary
// missing, auth not set up, timeout — the failover loop slides down to
// the API providers automatically.
func resolveCandidateChain(hasAnthropic, hasOpenAI bool) []struct{ Provider, Model string } {
	type ranked struct {
		provider, model string
		score           float64
	}
	var all []ranked
	for _, m := range modelCatalog {
		if m.provider == "anthropic" && !hasAnthropic {
			continue
		}
		if m.provider == "openai" && !hasOpenAI {
			continue
		}
		costBonus := 30.0 / (m.costPer1MIn + m.costPer1MOut + 1)
		score := float64(m.quality)*20 + float64(m.speed)*3 + costBonus
		all = append(all, ranked{m.provider, m.model, score})
	}
	// Sort descending by score (small list, n^2 is fine).
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			if all[j].score > all[i].score {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	// Dedupe by provider — within each provider, the top-scoring model
	// is enough. Failover is across providers, not across models of the
	// same provider (a 429 from Anthropic affects all Anthropic models).
	//
	// Exception: also append a cheaper same-provider fallback so a
	// rate-limited large model (e.g. gpt-4o, sonnet) can fall to the
	// smaller/cheaper model (gpt-4o-mini, haiku) — they use a separate
	// quota tier and are far less likely to be TPM-limited.
	seen := map[string]bool{}
	out := make([]struct{ Provider, Model string }, 0, 5)
	// Local Claude Code goes FIRST when enabled. The failover loop will
	// slide down to API providers if the CLI errors. Model name is
	// 'local' purely for log readability.
	if claudeCodeBinary() != "" {
		out = append(out, struct{ Provider, Model string }{"claude-code", "local"})
	}
	for _, c := range all {
		if seen[c.provider] {
			continue
		}
		seen[c.provider] = true
		out = append(out, struct{ Provider, Model string }{c.provider, c.model})
		// Add a cheaper same-provider fallback (separate quota tier).
		switch c.provider {
		case "openai":
			if c.model != "gpt-4o-mini" && hasOpenAI {
				out = append(out, struct{ Provider, Model string }{"openai", "gpt-4o-mini"})
			}
		case "anthropic":
			if c.model != haikuModel() && hasAnthropic {
				out = append(out, struct{ Provider, Model string }{"anthropic", haikuModel()})
			}
		}
	}
	return out
}

// ---------- Complete endpoint ----------

// callLLMStreamingNoTools is the real-token-streaming variant.
// Skips the tool loop entirely (callers that need tools use
// callLLMWithTools instead). Emits text chunks via onDelta as they
// arrive from the provider's SSE stream. Returns the full assembled
// text + token counts when done. Supports OpenAI + Anthropic; for
// other providers falls back to non-streaming callLLMSync and emits
// one final delta.
//
// Designed for the "first-sentence-fast" UX: caller buffers deltas,
// emits a chunk as soon as a sentence terminator + minimum length
// is hit, sends the remainder when stream completes.
func (h *LlmProxyHandler) callLLMStreamingNoTools(
	ctx context.Context,
	provider, model, apiKey string,
	systemPrompt, userPrompt string,
	onDelta func(chunk string),
) (full string, tokensIn, tokensOut int64, err error) {
	if onDelta == nil {
		onDelta = func(string) {}
	}

	switch provider {
	case "openai":
		reqBody := map[string]any{
			"model": model,
			"messages": []map[string]string{
				{"role": "system", "content": systemPrompt},
				{"role": "user", "content": userPrompt},
			},
			"max_tokens": 1024,
			"stream":     true,
			"stream_options": map[string]any{
				"include_usage": true,
			},
		}
		bodyBytes, _ := json.Marshal(reqBody)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
			"https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Accept", "text/event-stream")
		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", 0, 0, httpErr
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(resp.Body)
			return "", 0, 0, fmt.Errorf("openai stream %d: %s", resp.StatusCode, string(body))
		}
		var sb strings.Builder
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
			if payload == "[DONE]" {
				break
			}
			var ev struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
				Usage *struct {
					PromptTokens     int64 `json:"prompt_tokens"`
					CompletionTokens int64 `json:"completion_tokens"`
				} `json:"usage"`
			}
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				continue
			}
			if ev.Usage != nil {
				tokensIn = ev.Usage.PromptTokens
				tokensOut = ev.Usage.CompletionTokens
			}
			for _, c := range ev.Choices {
				if c.Delta.Content != "" {
					sb.WriteString(c.Delta.Content)
					onDelta(c.Delta.Content)
				}
			}
		}
		if scanErr := scanner.Err(); scanErr != nil {
			return sb.String(), tokensIn, tokensOut, scanErr
		}
		return sb.String(), tokensIn, tokensOut, nil

	case "anthropic":
		reqBody := map[string]any{
			"model":      model,
			"max_tokens": 1024,
			"stream":     true,
			"system":     systemPrompt,
			"messages": []map[string]string{
				{"role": "user", "content": userPrompt},
			},
		}
		bodyBytes, _ := json.Marshal(reqBody)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
			"https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("Accept", "text/event-stream")
		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", 0, 0, httpErr
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(resp.Body)
			return "", 0, 0, fmt.Errorf("anthropic stream %d: %s", resp.StatusCode, string(body))
		}
		var sb strings.Builder
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data: "))
			var ev struct {
				Type  string `json:"type"`
				Delta struct {
					Type         string `json:"type"`
					Text         string `json:"text"`
					InputTokens  int64  `json:"input_tokens,omitempty"`
					OutputTokens int64  `json:"output_tokens,omitempty"`
				} `json:"delta"`
				Usage *struct {
					InputTokens  int64 `json:"input_tokens"`
					OutputTokens int64 `json:"output_tokens"`
				} `json:"usage"`
				Message *struct {
					Usage *struct {
						InputTokens  int64 `json:"input_tokens"`
						OutputTokens int64 `json:"output_tokens"`
					} `json:"usage"`
				} `json:"message"`
			}
			if err := json.Unmarshal([]byte(payload), &ev); err != nil {
				continue
			}
			if ev.Type == "content_block_delta" && ev.Delta.Type == "text_delta" && ev.Delta.Text != "" {
				sb.WriteString(ev.Delta.Text)
				onDelta(ev.Delta.Text)
			}
			if ev.Type == "message_start" && ev.Message != nil && ev.Message.Usage != nil {
				tokensIn = ev.Message.Usage.InputTokens
			}
			if ev.Type == "message_delta" && ev.Usage != nil {
				tokensOut = ev.Usage.OutputTokens
			}
		}
		if scanErr := scanner.Err(); scanErr != nil {
			return sb.String(), tokensIn, tokensOut, scanErr
		}
		return sb.String(), tokensIn, tokensOut, nil

	default:
		// Unknown provider — fall back to non-streaming. Emits one
		// final delta with the full text so callers don't see broken
		// streaming contract.
		text, ti, to, _, e := h.callLLMSync(ctx, provider, model, apiKey, userPrompt)
		if text != "" {
			onDelta(text)
		}
		return text, ti, to, e
	}
}

// HandleStreamCompletion serves POST /v1/jarvis/stream-completion —
// a no-tools streaming endpoint optimized for the bridges' fast
// "first-sentence-fast" path. Body: {systemPrompt, userPrompt, model?}.
// Returns text/event-stream with `data: <chunk>\n\n` events per
// LLM delta, and a final `data: [DONE]\n\n` sentinel.
func (h *LlmProxyHandler) HandleStreamCompletion(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		SystemPrompt string `json:"systemPrompt"`
		UserPrompt   string `json:"userPrompt"`
		Model        string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(body.UserPrompt) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userPrompt required"})
		return
	}
	model := body.Model
	if model == "" {
		model = "auto"
	}
	provider, resolved := h.resolveModelForTenant(ctx, tenantID, model)
	apiKey, keyErr := h.resolveProviderKey(ctx, tenantID, provider)
	if keyErr != nil {
		alt := "anthropic"
		if provider == "anthropic" {
			alt = "openai"
		}
		if altKey, altErr := h.resolveProviderKey(ctx, tenantID, alt); altErr == nil {
			provider = alt
			apiKey = altKey
			if provider == "openai" {
				resolved = "gpt-4o"
			} else {
				resolved = sonnetModel()
			}
		} else {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no LLM key configured"})
			return
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)
	emit := func(chunk string) {
		// Escape per SSE: split on \n so multi-line chunks deliver right.
		for _, ln := range strings.Split(chunk, "\n") {
			fmt.Fprintf(w, "data: %s\n", ln)
		}
		fmt.Fprintf(w, "\n")
		if flusher != nil {
			flusher.Flush()
		}
	}

	full, _, _, llmErr := h.callLLMStreamingNoTools(ctx, provider, resolved, apiKey, body.SystemPrompt, body.UserPrompt, emit)
	if llmErr != nil && full == "" {
		// Primary provider died before emitting anything (no-credit, 401,
		// 5xx). Try the OTHER hosted provider, then fall back to local
		// `claude -p` so the bridges never surface a raw API error to the
		// user. Streaming providers don't support claude-code natively,
		// so we emit the whole reply as a single chunk.
		altProv := "openai"
		if provider == "openai" {
			altProv = "anthropic"
		}
		if altKey, err := h.resolveProviderKey(ctx, tenantID, altProv); err == nil {
			altModel := "gpt-4o"
			if altProv == "anthropic" {
				altModel = sonnetModel()
			}
			h.logger().Warn("primary provider stream failed; failing over",
				zap.String("from", provider), zap.String("to", altProv), zap.Error(llmErr))
			altFull, _, _, altErr := h.callLLMStreamingNoTools(ctx, altProv, altModel, altKey, body.SystemPrompt, body.UserPrompt, emit)
			if altErr == nil {
				full = altFull
				llmErr = nil
			} else if altFull == "" {
				llmErr = altErr
			}
		}
	}
	if llmErr != nil && full == "" {
		// Last resort: local `claude -p`. Free, no API key needed.
		// Streams as one chunk since the CLI doesn't expose deltas.
		h.logger().Warn("hosted providers failed; falling back to claude -p", zap.Error(llmErr))
		prompt := strings.TrimSpace(body.SystemPrompt + "\n\n" + body.UserPrompt)
		if local, err := callClaudeCode(ctx, prompt); err == nil && strings.TrimSpace(local) != "" {
			emit(local)
			full = local
			llmErr = nil
		} else if err != nil {
			h.logger().Warn("claude -p fallback failed", zap.Error(err))
		}
	}
	if llmErr != nil && full == "" {
		// All providers exhausted — emit a friendly error, not the raw
		// vendor error string.
		fmt.Fprintf(w, "event: error\ndata: %s\n\n", "agent temporarily unavailable")
		if flusher != nil {
			flusher.Flush()
		}
		return
	}
	fmt.Fprintf(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

// HandleTTS — POST /v1/voice/tts. Body: {text, voice?, format?}.
// Returns audio bytes (mp3 by default) via OpenAI's TTS API using the
// tenant's configured OpenAI key. Used by the bridges' outbound voice
// path when LANTERN_VOICE_OUT=on.
//
// Voices: alloy, echo, fable, onyx, nova, shimmer. Defaults to "nova"
// (warm + clear; pleasant for self-chat consumption).
// Cost: ~$15/1M chars = ~$0.0001/char. A 100-char reply costs ~$0.01.
func (h *LlmProxyHandler) HandleTTS(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		Text   string `json:"text"`
		Voice  string `json:"voice"`
		Format string `json:"format"`
		Model  string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text required"})
		return
	}
	if len(body.Text) > 4000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text > 4000 chars (TTS limit)"})
		return
	}
	voice := body.Voice
	if voice == "" {
		voice = "nova"
	}
	format := body.Format
	if format == "" {
		format = "mp3"
	}
	// "opus" format = Opus codec (good for WhatsApp voice notes which
	// natively use Opus in OGG container). But OpenAI TTS returns raw
	// opus frames; we'd need to wrap. mp3 is universally playable on
	// iMessage/WhatsApp/dashboard with no extra work.
	model := body.Model
	if model == "" {
		model = "tts-1" // tts-1 is faster + cheaper than tts-1-hd
	}

	apiKey, keyErr := h.resolveProviderKey(ctx, tenantID, "openai")
	if keyErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "openai key required for TTS"})
		return
	}

	reqBody := map[string]any{
		"model":           model,
		"input":           body.Text,
		"voice":           voice,
		"response_format": format,
	}
	bodyBytes, _ := json.Marshal(reqBody)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/audio/speech", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, httpErr := http.DefaultClient.Do(req)
	if httpErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": httpErr.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		errBody, _ := io.ReadAll(resp.Body)
		writeJSON(w, resp.StatusCode, map[string]string{"error": fmt.Sprintf("openai tts %d: %s", resp.StatusCode, string(errBody))})
		return
	}
	audio, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": readErr.Error()})
		return
	}
	contentType := "audio/mpeg"
	switch format {
	case "opus":
		contentType = "audio/opus"
	case "aac":
		contentType = "audio/aac"
	case "flac":
		contentType = "audio/flac"
	case "wav":
		contentType = "audio/wav"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(audio)))
	_, _ = w.Write(audio)
}

// Complete handles POST /v1/completions.
func (h *LlmProxyHandler) Complete(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req completionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if len(req.Messages) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "messages are required"})
		return
	}

	provider, model := h.resolveModelForTenant(ctx, tenantID, req.Model)

	// For NON-streaming, NON-agent-scoped completions ('Generate with AI'
	// buttons etc.) route through the failover chain so claude-code is
	// reachable when LANTERN_USE_CLAUDE_CODE=1 is the only thing
	// configured. Without this, users with no API keys + claude-code
	// enabled hit 'No LLM provider API key configured' for any plain
	// completion call — including the agent-detail Generate buttons,
	// AI-spec generation, etc.
	if req.AgentName == "" && !req.Stream {
		text, _, usedProvider, usedModel, tokensIn, tokensOut, llmErr := h.callLLMWithFailover(
			ctx, tenantID,
			messagesToAny(req.Messages), nil, nil, nil, nil, 1,
		)
		if llmErr != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": llmErr.Error()})
			return
		}
		writeJSON(w, http.StatusOK, completionResponse{
			Model:     usedModel,
			Content:   text,
			Provider:  usedProvider,
			TokensIn:  int(tokensIn),
			TokensOut: int(tokensOut),
			CostUsd:   estimateCost(usedProvider, usedModel, int(tokensIn), int(tokensOut)),
		})
		return
	}

	// Try to get key for resolved provider; if not available, try the other one.
	apiKey, err := h.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		// Try alternate provider.
		altProvider := "anthropic"
		if provider == "anthropic" {
			altProvider = "openai"
		}
		altKey, altErr := h.resolveProviderKey(ctx, tenantID, altProvider)
		if altErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "No LLM provider API key configured. Add one in Settings > LLM Providers, or set LANTERN_USE_CLAUDE_CODE=1 for free local routing.",
			})
			return
		}
		provider = altProvider
		apiKey = altKey
		// Re-resolve model for new provider.
		if provider == "openai" {
			model = "gpt-4o"
		} else {
			model = sonnetModel()
		}
	}

	h.logger().Info("proxying completion",
		zap.String("tenant_id", tenantID),
		zap.String("provider", provider),
		zap.String("model", model),
		zap.Bool("stream", req.Stream),
		zap.String("agent", req.AgentName),
	)

	// Agent-scoped completion → run the same tool loop sessions use. This
	// is the fallback path for the chat UI when the session API isn't
	// reachable; without tools here, the model can't actually call
	// connectors and falls back to "no connectors provided" text.
	if req.AgentName != "" {
		h.proxyAgentWithTools(w, ctx, tenantID, provider, model, apiKey, &req)
		return
	}

	switch provider {
	case "openai":
		h.proxyOpenAI(w, ctx, apiKey, model, &req)
	case "anthropic":
		h.proxyAnthropic(w, ctx, apiKey, model, &req)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported provider"})
	}
}

// proxyAgentWithTools runs the tool-use loop for an agent-scoped completion
// (req.AgentName set). Returns either an SSE stream of {type:'tool_call'},
// {type:'delta'}, {type:'done'} events when req.Stream is true, or a final
// JSON payload otherwise. Mirrors what the session API does so the chat
// fallback path produces identical behavior.
func (h *LlmProxyHandler) proxyAgentWithTools(
	w http.ResponseWriter,
	ctx context.Context,
	tenantID, provider, model, apiKey string,
	req *completionRequest,
) {
	// Build messages in the shape the tool loop expects.
	msgs := make([]map[string]any, len(req.Messages))
	for i, m := range req.Messages {
		msgs[i] = map[string]any{"role": m.Role, "content": m.Content}
	}

	tools, _ := toolsForTenant(ctx, h.srv.Pool, tenantID)

	dispatch := func(dispatchCtx context.Context, name string, args map[string]any) (any, error) {
		return dispatchTool(dispatchCtx, h.srv.Pool, tenantID, name, args)
	}

	// For streaming completions we want to surface tool calls inline so
	// the UI can render "Used X" chips while the model thinks. Each
	// invocation pushes an SSE event before/after dispatch.
	if req.Stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		flusher, _ := w.(http.Flusher)
		writeEvt := func(payload map[string]any) {
			b, _ := json.Marshal(payload)
			fmt.Fprintf(w, "data: %s\n\n", b)
			if flusher != nil {
				flusher.Flush()
			}
		}
		onToolCall := func(inv ToolInvocation) {
			argsJSON, _ := json.Marshal(inv.Args)
			evt := map[string]any{
				"type": "tool_call_started",
				"name": inv.Name,
				"args": string(argsJSON),
			}
			switch {
			case inv.Error != "":
				evt["type"] = "tool_call_failed"
				evt["error"] = inv.Error
			case inv.Result != nil:
				evt["type"] = "tool_call_completed"
				resultJSON, _ := json.Marshal(inv.Result)
				s := string(resultJSON)
				if len(s) > 2000 {
					s = s[:2000] + "...(truncated)"
				}
				evt["result"] = s
			}
			writeEvt(evt)
		}
		text, _, _, _, err := h.callLLMWithTools(ctx, provider, model, apiKey, msgs, tools, dispatch, onToolCall, maxToolTurnsEnv())
		if err != nil {
			writeEvt(map[string]any{"type": "error", "message": err.Error()})
			return
		}
		// Emit the final text as a single delta then done so existing UI
		// reassembly (which concatenates delta.content) just works.
		if text != "" {
			writeEvt(map[string]any{"type": "delta", "content": text})
		}
		writeEvt(map[string]any{"type": "done"})
		return
	}

	// Non-streaming: assemble + return JSON.
	text, _, tin, tout, err := h.callLLMWithTools(ctx, provider, model, apiKey, msgs, tools, dispatch, nil, maxToolTurnsEnv())
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"content":   text,
		"model":     model,
		"provider":  provider,
		"tokensIn":  tin,
		"tokensOut": tout,
		"costUsd":   estimateCost(provider, model, int(tin), int(tout)),
	})
}

// ---------- OpenAI proxy ----------

func (h *LlmProxyHandler) proxyOpenAI(w http.ResponseWriter, ctx context.Context, apiKey, model string, req *completionRequest) {
	messages := make([]map[string]string, len(req.Messages))
	for i, m := range req.Messages {
		messages[i] = map[string]string{"role": m.Role, "content": m.Content}
	}

	body := map[string]any{
		"model":    model,
		"messages": messages,
		"stream":   req.Stream,
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.MaxTokens != nil {
		body["max_tokens"] = *req.MaxTokens
	}

	bodyBytes, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create request"})
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		h.logger().Error("OpenAI request failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to reach OpenAI: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		h.logger().Error("OpenAI returned error", zap.Int("status", resp.StatusCode), zap.String("body", string(errBody)))
		writeJSON(w, resp.StatusCode, map[string]string{
			"error":    "OpenAI error",
			"details":  string(errBody),
			"provider": "openai",
		})
		return
	}

	if req.Stream {
		h.streamOpenAIResponse(w, resp, model)
	} else {
		h.handleOpenAISyncResponse(w, resp, model)
	}
}

func (h *LlmProxyHandler) handleOpenAISyncResponse(w http.ResponseWriter, resp *http.Response, model string) {
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to parse OpenAI response"})
		return
	}

	content := ""
	finishReason := ""
	if len(result.Choices) > 0 {
		content = result.Choices[0].Message.Content
		finishReason = result.Choices[0].FinishReason
	}

	costUsd := estimateCost("openai", model, result.Usage.PromptTokens, result.Usage.CompletionTokens)

	writeJSON(w, http.StatusOK, completionResponse{
		Model:        model,
		Content:      content,
		TokensIn:     result.Usage.PromptTokens,
		TokensOut:    result.Usage.CompletionTokens,
		CostUsd:      costUsd,
		Provider:     "openai",
		FinishReason: finishReason,
	})
}

func (h *LlmProxyHandler) streamOpenAIResponse(w http.ResponseWriter, resp *http.Response, model string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	scanner := bufio.NewScanner(resp.Body)
	totalTokensOut := 0

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			continue
		}

		// Forward SSE lines directly. OpenAI sends "data: {...}" lines.
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")

			if data == "[DONE]" {
				// Send our summary event.
				summary := map[string]any{
					"type":      "done",
					"model":     model,
					"provider":  "openai",
					"tokensOut": totalTokensOut,
					"costUsd":   estimateCost("openai", model, 0, totalTokensOut),
				}
				summaryBytes, _ := json.Marshal(summary)
				fmt.Fprintf(w, "data: %s\n\n", summaryBytes)
				flusher.Flush()
				break
			}

			// Parse the chunk to extract delta content.
			var chunk struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(data), &chunk); err == nil {
				if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
					totalTokensOut++
					event := map[string]any{
						"type":    "delta",
						"content": chunk.Choices[0].Delta.Content,
					}
					eventBytes, _ := json.Marshal(event)
					fmt.Fprintf(w, "data: %s\n\n", eventBytes)
					flusher.Flush()
				}
			}
		}
	}
}

// ---------- Anthropic proxy ----------

func (h *LlmProxyHandler) proxyAnthropic(w http.ResponseWriter, ctx context.Context, apiKey, model string, req *completionRequest) {
	// Convert messages: Anthropic requires a separate system field.
	var system string
	anthropicMsgs := make([]map[string]string, 0, len(req.Messages))
	for _, m := range req.Messages {
		if m.Role == "system" {
			system = m.Content
			continue
		}
		anthropicMsgs = append(anthropicMsgs, map[string]string{"role": m.Role, "content": m.Content})
	}

	// Ensure at least one user message.
	if len(anthropicMsgs) == 0 {
		anthropicMsgs = append(anthropicMsgs, map[string]string{"role": "user", "content": "Hello"})
	}

	maxTokens := 4096
	if req.MaxTokens != nil {
		maxTokens = *req.MaxTokens
	}

	body := map[string]any{
		"model":      model,
		"messages":   anthropicMsgs,
		"max_tokens": maxTokens,
		"stream":     req.Stream,
	}
	if system != "" {
		body["system"] = system
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}

	bodyBytes, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create request"})
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		h.logger().Error("Anthropic request failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to reach Anthropic: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		h.logger().Error("Anthropic returned error", zap.Int("status", resp.StatusCode), zap.String("body", string(errBody)))
		writeJSON(w, resp.StatusCode, map[string]string{
			"error":    "Anthropic error",
			"details":  string(errBody),
			"provider": "anthropic",
		})
		return
	}

	if req.Stream {
		h.streamAnthropicResponse(w, resp, model)
	} else {
		h.handleAnthropicSyncResponse(w, resp, model)
	}
}

func (h *LlmProxyHandler) handleAnthropicSyncResponse(w http.ResponseWriter, resp *http.Response, model string) {
	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to parse Anthropic response"})
		return
	}

	content := ""
	for _, c := range result.Content {
		if c.Type == "text" {
			content += c.Text
		}
	}

	costUsd := estimateCost("anthropic", model, result.Usage.InputTokens, result.Usage.OutputTokens)

	writeJSON(w, http.StatusOK, completionResponse{
		Model:        model,
		Content:      content,
		TokensIn:     result.Usage.InputTokens,
		TokensOut:    result.Usage.OutputTokens,
		CostUsd:      costUsd,
		Provider:     "anthropic",
		FinishReason: result.StopReason,
	})
}

func (h *LlmProxyHandler) streamAnthropicResponse(w http.ResponseWriter, resp *http.Response, model string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	scanner := bufio.NewScanner(resp.Body)
	totalTokensIn := 0
	totalTokensOut := 0

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")

			var event struct {
				Type  string `json:"type"`
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
				Usage struct {
					InputTokens  int `json:"input_tokens"`
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			}

			if err := json.Unmarshal([]byte(data), &event); err != nil {
				continue
			}

			switch event.Type {
			case "content_block_delta":
				if event.Delta.Text != "" {
					totalTokensOut++
					out := map[string]any{
						"type":    "delta",
						"content": event.Delta.Text,
					}
					outBytes, _ := json.Marshal(out)
					fmt.Fprintf(w, "data: %s\n\n", outBytes)
					flusher.Flush()
				}
			case "message_start":
				totalTokensIn = event.Usage.InputTokens
			case "message_delta":
				totalTokensOut = event.Usage.OutputTokens
			case "message_stop":
				summary := map[string]any{
					"type":      "done",
					"model":     model,
					"provider":  "anthropic",
					"tokensIn":  totalTokensIn,
					"tokensOut": totalTokensOut,
					"costUsd":   estimateCost("anthropic", model, totalTokensIn, totalTokensOut),
				}
				summaryBytes, _ := json.Marshal(summary)
				fmt.Fprintf(w, "data: %s\n\n", summaryBytes)
				flusher.Flush()
			}
		}
	}
}

// ---------- LLM Provider config endpoints ----------

// SaveLlmProvider handles POST /v1/settings/llm-providers.
func (h *LlmProxyHandler) SaveLlmProvider(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Provider string `json:"provider"`
		ApiKey   string `json:"apiKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if body.Provider == "" || body.ApiKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider and apiKey are required"})
		return
	}

	// Normalize provider names.
	body.Provider = strings.ToLower(body.Provider)

	// Encrypt the key at rest (pass-through plaintext when no key configured).
	encKey, err := secrets.EncryptString(body.ApiKey)
	if err != nil {
		h.logger().Error("encrypt llm provider key failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to secure provider key"})
		return
	}
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO llm_provider_configs (tenant_id, provider, api_key_encrypted, status)
		VALUES ($1, $2, $3, 'active')
		ON CONFLICT (tenant_id, provider)
		DO UPDATE SET api_key_encrypted = $3, status = 'active', updated_at = now()
	`, tenantID, body.Provider, encKey)
	if err != nil {
		h.logger().Error("save llm provider config failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save provider config"})
		return
	}

	h.logger().Info("LLM provider config saved",
		zap.String("tenant_id", tenantID),
		zap.String("provider", body.Provider),
	)

	writeJSON(w, http.StatusOK, map[string]string{
		"status":   "saved",
		"provider": body.Provider,
	})
}

// ListLlmProviders handles GET /v1/settings/llm-providers.
func (h *LlmProxyHandler) ListLlmProviders(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT provider, status, created_at, updated_at
		FROM llm_provider_configs
		WHERE tenant_id = $1
		ORDER BY provider
	`, tenantID)
	if err != nil {
		h.logger().Error("list llm providers failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list providers"})
		return
	}
	defer rows.Close()

	result := make([]map[string]any, 0)
	for rows.Next() {
		var (
			provider  string
			status    string
			createdAt time.Time
			updatedAt time.Time
		)
		if err := rows.Scan(&provider, &status, &createdAt, &updatedAt); err != nil {
			continue
		}
		result = append(result, map[string]any{
			"provider":  provider,
			"status":    status,
			"keyMasked": "****configured****",
			"createdAt": createdAt,
			"updatedAt": updatedAt,
		})
	}

	// Also check for env var fallbacks.
	envProviders := map[string]string{
		"openai":    "OPENAI_API_KEY",
		"anthropic": "ANTHROPIC_API_KEY",
	}
	for prov, envKey := range envProviders {
		if os.Getenv(envKey) != "" {
			// Check if already in result.
			found := false
			for _, r := range result {
				if r["provider"] == prov {
					found = true
					break
				}
			}
			if !found {
				result = append(result, map[string]any{
					"provider":  prov,
					"status":    "active",
					"keyMasked": "****env****",
					"source":    "environment",
				})
			}
		}
	}

	writeJSON(w, http.StatusOK, result)
}

// TestLlmProvider handles POST /v1/settings/llm-providers/{provider}/test.
func (h *LlmProxyHandler) TestLlmProvider(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	provider := r.PathValue("provider")
	if provider == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider is required"})
		return
	}
	provider = strings.ToLower(provider)

	apiKey, err := h.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"success": "false",
			"error":   "No API key found for " + provider,
		})
		return
	}

	// Make a tiny test request.
	var testErr error
	switch provider {
	case "openai":
		testErr = h.testOpenAI(ctx, apiKey)
	case "anthropic":
		testErr = h.testAnthropic(ctx, apiKey)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported provider: " + provider})
		return
	}

	if testErr != nil {
		h.logger().Warn("LLM provider test failed",
			zap.String("provider", provider),
			zap.Error(testErr),
		)
		writeJSON(w, http.StatusOK, map[string]any{
			"success": false,
			"error":   testErr.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"message": provider + " API key is valid",
	})
}

func (h *LlmProxyHandler) testOpenAI(ctx context.Context, apiKey string) error {
	body := map[string]any{
		"model": "gpt-4o-mini",
		"messages": []map[string]string{
			{"role": "user", "content": "Say hi in exactly one word."},
		},
		"max_tokens": 5,
	}
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("OpenAI returned %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}

func (h *LlmProxyHandler) testAnthropic(ctx context.Context, apiKey string) error {
	body := map[string]any{
		"model": sonnetModel(),
		"messages": []map[string]string{
			{"role": "user", "content": "Say hi in exactly one word."},
		},
		"max_tokens": 5,
	}
	bodyBytes, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Anthropic returned %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}

// ---------- Agent spec generation ----------

// agentSpecRequest is the request body for POST /v1/agents/generate-spec.
type agentSpecRequest struct {
	Description string `json:"description"`
}

// GenerateAgentSpec handles POST /v1/agents/generate-spec.
// It takes a natural-language description and generates a structured agent spec via LLM.
func (h *LlmProxyHandler) GenerateAgentSpec(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req agentSpecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if strings.TrimSpace(req.Description) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "description is required"})
		return
	}

	h.logger().Info("generating agent spec",
		zap.String("tenant_id", tenantID),
		zap.String("description", req.Description),
	)

	systemPrompt := `You are Lantern's agent architect. Given a user's description, generate a structured agent specification.

Output ONLY valid JSON with this exact structure (no markdown, no backticks, no explanation):
{
  "name": "kebab-case-name",
  "description": "One sentence description",
  "model": "auto",
  "steps": [
    { "name": "step-name", "type": "llm", "description": "What this step does", "config": {} }
  ],
  "tools": [],
  "connectors": [],
  "surfaces": [],
  "triggers": [{ "type": "manual", "config": {} }],
  "isolation": "standard",
  "limits": { "timeout": "5m", "maxTokens": 100000, "maxCostUsd": 1.0 }
}

Valid step types: llm, tool, connector, condition, loop, approval
Valid tools: web-search, python-exec, fs-read, fs-write, browser, code-interpreter
Valid connectors: gmail, slack, github, linear, notion, stripe, google-calendar, jira, discord
Valid surfaces: whatsapp, slack, discord, telegram, twilio, email, webchat
Valid trigger types: manual, schedule, webhook, surface
Valid isolation levels: trusted, standard, untrusted
Valid models: auto, reasoning-large, reasoning-small, chat-large, chat-small, code-large

Generate a thoughtful, well-structured agent with appropriate steps for the task described. Use descriptive step names in kebab-case.`

	completionReq := &completionRequest{
		Model: "auto",
		Messages: []completionMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: req.Description},
		},
		Stream: false,
	}

	provider, model := h.resolveModelForTenant(ctx, tenantID, completionReq.Model)

	apiKey, err := h.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		altProvider := "anthropic"
		if provider == "anthropic" {
			altProvider = "openai"
		}
		altKey, altErr := h.resolveProviderKey(ctx, tenantID, altProvider)
		if altErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "No LLM provider API key configured. Add one in Settings > LLM Providers.",
			})
			return
		}
		provider = altProvider
		apiKey = altKey
		if provider == "openai" {
			model = "gpt-4o"
		} else {
			model = sonnetModel()
		}
	}

	h.logger().Info("proxying spec generation",
		zap.String("tenant_id", tenantID),
		zap.String("provider", provider),
		zap.String("model", model),
	)

	// Use the existing proxy infrastructure to call the LLM, but capture the response.
	switch provider {
	case "openai":
		h.proxyOpenAI(w, ctx, apiKey, model, completionReq)
	case "anthropic":
		h.proxyAnthropic(w, ctx, apiKey, model, completionReq)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported provider"})
	}
}

// agentCodeRequest is the request body for POST /v1/agents/generate-code.
type agentCodeRequest struct {
	Spec json.RawMessage `json:"spec"`
}

// GenerateAgentCode handles POST /v1/agents/generate-code.
// It takes an agent spec and generates TypeScript agent code + agent.yaml via LLM.
func (h *LlmProxyHandler) GenerateAgentCode(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req agentCodeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if len(req.Spec) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "spec is required"})
		return
	}

	h.logger().Info("generating agent code",
		zap.String("tenant_id", tenantID),
	)

	systemPrompt := `You are Lantern's code generator. Given an agent specification JSON, generate production-ready TypeScript agent code using the @lantern/sdk.

Output ONLY valid JSON with this exact structure (no markdown, no backticks):
{
  "code": "// TypeScript code here",
  "yaml": "// YAML config as a string"
}

The TypeScript code should:
- Import from "@lantern/sdk"
- Use the Agent class with proper typing
- Implement each step using the step() function for durability
- Use ctx.llm.generate() for LLM calls (never call models directly)
- Use ctx.connectors.<name>.<action>() for connector calls
- Use ctx.mcp("<tool>").call() for tool invocations
- Include proper error handling
- Be clean, well-commented, production-quality code

The YAML should be a valid agent.yaml configuration matching the spec.

Ensure the code string and yaml string are properly escaped for JSON (newlines as \n, quotes escaped, etc).`

	completionReq := &completionRequest{
		Model: "auto",
		Messages: []completionMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: string(req.Spec)},
		},
		Stream: false,
	}

	provider, model := h.resolveModelForTenant(ctx, tenantID, completionReq.Model)

	apiKey, err := h.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		altProvider := "anthropic"
		if provider == "anthropic" {
			altProvider = "openai"
		}
		altKey, altErr := h.resolveProviderKey(ctx, tenantID, altProvider)
		if altErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "No LLM provider API key configured. Add one in Settings > LLM Providers.",
			})
			return
		}
		provider = altProvider
		apiKey = altKey
		if provider == "openai" {
			model = "gpt-4o"
		} else {
			model = sonnetModel()
		}
	}

	switch provider {
	case "openai":
		h.proxyOpenAI(w, ctx, apiKey, model, completionReq)
	case "anthropic":
		h.proxyAnthropic(w, ctx, apiKey, model, completionReq)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported provider"})
	}
}

// ---------- Cost estimation ----------

func estimateCost(provider, model string, tokensIn, tokensOut int) float64 {
	// Rough pricing per 1M tokens (as of early 2026).
	var inPer1M, outPer1M float64

	switch {
	case provider == "openai" && strings.Contains(model, "gpt-4o-mini"):
		inPer1M, outPer1M = 0.15, 0.60
	case provider == "openai" && strings.Contains(model, "gpt-4o"):
		inPer1M, outPer1M = 2.50, 10.00
	case provider == "openai" && strings.HasPrefix(model, "o3"):
		inPer1M, outPer1M = 10.00, 40.00
	case provider == "anthropic" && strings.Contains(model, "sonnet"):
		inPer1M, outPer1M = 3.00, 15.00
	case provider == "anthropic" && strings.Contains(model, "opus"):
		inPer1M, outPer1M = 15.00, 75.00
	case provider == "anthropic" && strings.Contains(model, "haiku"):
		inPer1M, outPer1M = 0.25, 1.25
	default:
		inPer1M, outPer1M = 5.00, 15.00
	}

	return (float64(tokensIn) * inPer1M / 1_000_000) + (float64(tokensOut) * outPer1M / 1_000_000)
}

// ---------------------------------------------------------------------------
// Tool-call loop (OpenAI only for now). Used by sessions.processMessage so
// templated agents (Morning Brief, Inbox Concierge, …) can actually invoke
// their connectors. Anthropic uses a different tool schema; once we wire it
// the same way, callers won't need to know the difference.
//
// Returns the final assistant text plus a flattened list of tool calls so
// callers can emit them as journal events or session SSE.
// ---------------------------------------------------------------------------

type ToolInvocation struct {
	Name   string         `json:"name"`
	Args   map[string]any `json:"args"`
	Result any            `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

// callLLMWithTools runs a tool-use loop against OpenAI. Up to maxTurns
// rounds of tool_calls; on each round it dispatches tool calls via the
// provided dispatch function and feeds results back. If tools is empty
// this devolves to a single chat completion.
//
// onToolCall is called once per tool invocation (started + completed) so
// the caller can stream UI events; pass nil to skip.
func (h *LlmProxyHandler) callLLMWithTools(
	ctx context.Context,
	provider, model, apiKey string,
	messages []map[string]any,
	tools []map[string]any,
	dispatch func(ctx context.Context, name string, args map[string]any) (any, error),
	onToolCall func(inv ToolInvocation),
	maxTurns int,
) (finalText string, invocations []ToolInvocation, tokensIn, tokensOut int64, err error) {
	if provider == "anthropic" {
		return h.callAnthropicWithTools(ctx, model, apiKey, messages, tools, dispatch, onToolCall, maxTurns)
	}
	if provider != "openai" {
		// Unknown provider — collapse to text and skip tools.
		txt, ti, to, _, e := h.callLLMSync(ctx, provider, model, apiKey, flattenMessages(messages))
		return txt, nil, ti, to, e
	}
	if maxTurns <= 0 {
		maxTurns = maxToolTurnsEnv()
	}

	// G4: inject planning hint when turn looks multi-step (no-op when flag off).
	messages = injectPlannerIfNeeded(messages)

	// Local working copy of messages; we append assistant + tool messages
	// as we loop.
	msgs := append([]map[string]any{}, messages...)

	for turn := 0; turn < maxTurns; turn++ {
		reqBody := map[string]any{
			"model":      model,
			"messages":   msgs,
			"max_tokens": 4096,
		}
		if len(tools) > 0 {
			reqBody["tools"] = tools
			reqBody["tool_choice"] = "auto"
		}
		bodyBytes, _ := json.Marshal(reqBody)

		req, _ := http.NewRequestWithContext(ctx, "POST",
			"https://api.openai.com/v1/chat/completions", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", invocations, tokensIn, tokensOut, httpErr
		}
		defer resp.Body.Close() //nolint:errcheck

		var oaiResp struct {
			Choices []struct {
				Message struct {
					Role      string `json:"role"`
					Content   string `json:"content"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls,omitempty"`
				} `json:"message"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Usage struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
			} `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&oaiResp); decErr != nil {
			return "", invocations, tokensIn, tokensOut, decErr
		}
		tokensIn += oaiResp.Usage.PromptTokens
		tokensOut += oaiResp.Usage.CompletionTokens

		if oaiResp.Error != nil {
			return "", invocations, tokensIn, tokensOut, fmt.Errorf("openai: %s", oaiResp.Error.Message)
		}
		if len(oaiResp.Choices) == 0 {
			return "", invocations, tokensIn, tokensOut, fmt.Errorf("openai: no choices")
		}
		choice := oaiResp.Choices[0]

		// Terminal: no more tool calls — model gave a final answer.
		if len(choice.Message.ToolCalls) == 0 {
			return choice.Message.Content, invocations, tokensIn, tokensOut, nil
		}

		// Append the assistant message that requested the tool calls.
		// OpenAI requires this exact shape before tool messages.
		assistantMsg := map[string]any{
			"role":       "assistant",
			"content":    choice.Message.Content,
			"tool_calls": choice.Message.ToolCalls,
		}
		msgs = append(msgs, assistantMsg)

		// Dispatch each tool call in order.
		for _, tc := range choice.Message.ToolCalls {
			var args map[string]any
			if tc.Function.Arguments != "" {
				_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
			}
			inv := ToolInvocation{Name: tc.Function.Name, Args: args}
			if onToolCall != nil {
				onToolCall(inv) // started — UI shows spinner
			}

			result, dispErr := dispatch(ctx, tc.Function.Name, args)
			if dispErr != nil {
				inv.Error = dispErr.Error()
				if onToolCall != nil {
					onToolCall(inv)
				}
				invocations = append(invocations, inv)
				// Feed the error back as the tool result; the model can
				// recover (e.g., apologize, try a different approach).
				resultJSON, _ := json.Marshal(map[string]string{"error": dispErr.Error()})
				msgs = append(msgs, map[string]any{
					"role":         "tool",
					"tool_call_id": tc.ID,
					"content":      string(resultJSON),
				})
				continue
			}
			inv.Result = result
			if onToolCall != nil {
				onToolCall(inv) // completed
			}
			invocations = append(invocations, inv)

			resultJSON, _ := json.Marshal(result)
			msgs = append(msgs, map[string]any{
				"role":         "tool",
				"tool_call_id": tc.ID,
				"content":      truncateToolResult(string(resultJSON)),
			})
		}
	}

	// Hit the turn budget without a terminal response. Do ONE final
	// synthesis call with tools DISABLED so the model is forced to
	// produce a real answer from the data it's already pulled — instead
	// of dumping the previous boilerplate "unable to finish synthesizing"
	// message which is useless to the user.
	msgs = append(msgs, map[string]any{
		"role":    "user",
		"content": "Tool-call budget reached. Synthesize the BEST possible answer NOW from what you've already fetched. Be concrete. If you genuinely don't have enough, say so in one short line plus suggest the most useful next step.",
	})
	finalReq := map[string]any{
		"model":      model,
		"messages":   msgs,
		"max_tokens": 1024,
	}
	finalBytes, _ := json.Marshal(finalReq)
	finalHTTPReq, _ := http.NewRequestWithContext(ctx, "POST",
		"https://api.openai.com/v1/chat/completions", bytes.NewReader(finalBytes))
	finalHTTPReq.Header.Set("Content-Type", "application/json")
	finalHTTPReq.Header.Set("Authorization", "Bearer "+apiKey)
	if resp, ferr := http.DefaultClient.Do(finalHTTPReq); ferr == nil {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var parsed struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
			} `json:"usage"`
		}
		if jerr := json.Unmarshal(body, &parsed); jerr == nil && len(parsed.Choices) > 0 {
			tokensIn += parsed.Usage.PromptTokens
			tokensOut += parsed.Usage.CompletionTokens
			if strings.TrimSpace(parsed.Choices[0].Message.Content) != "" {
				return parsed.Choices[0].Message.Content, invocations, tokensIn, tokensOut, nil
			}
		}
	}
	// Final-synthesis call also failed — last-resort short message.
	return "i pulled a bunch of data but ran out of room to wrap up. ask again in a sec — i'll try a tighter angle.", invocations, tokensIn, tokensOut, nil
}

// flattenMessages converts the messages-with-tool-calls shape into a single
// text prompt for the legacy callLLMSync (Anthropic fallback). Drops
// tool_calls / tool roles since they aren't meaningful as text.
// messagesToAny converts the inbound completionMessage list into the
// any-valued shape the tool-loop functions consume. No fields are
// renamed; this is just a type widening so existing helpers can be
// reused for the non-streaming completion path.
func messagesToAny(msgs []completionMessage) []map[string]any {
	out := make([]map[string]any, len(msgs))
	for i, m := range msgs {
		out[i] = map[string]any{"role": m.Role, "content": m.Content}
	}
	return out
}

func flattenMessages(messages []map[string]any) string {
	var b strings.Builder
	for _, m := range messages {
		role, _ := m["role"].(string)
		content, _ := m["content"].(string)
		if role == "tool" || content == "" {
			continue
		}
		switch role {
		case "system":
			b.WriteString("[System]\n")
		case "user":
			b.WriteString("[User]\n")
		case "assistant":
			b.WriteString("[Assistant]\n")
		}
		b.WriteString(content)
		b.WriteString("\n\n")
	}
	b.WriteString("[Assistant]\n")
	return b.String()
}

// callAnthropicWithTools runs the same tool-use loop against Anthropic's
// Messages API, whose shape differs from OpenAI's:
//   - Tools: {name, description, input_schema} (not function/parameters)
//   - Response: content[] with type="tool_use" blocks carrying id/name/input
//   - Tool result is fed back as a user message with content[] containing
//     {type: "tool_result", tool_use_id, content}
//   - System prompt is a top-level field, not a message role
//
// We translate from the OpenAI-shaped messages our callers build (one
// system + alternating user/assistant) into Anthropic's shape, then
// translate the response back into our shared ToolInvocation type so the
// caller doesn't need to know which provider answered.
func (h *LlmProxyHandler) callAnthropicWithTools(
	ctx context.Context,
	model, apiKey string,
	messages []map[string]any,
	tools []map[string]any,
	dispatch func(ctx context.Context, name string, args map[string]any) (any, error),
	onToolCall func(inv ToolInvocation),
	maxTurns int,
) (finalText string, invocations []ToolInvocation, tokensIn, tokensOut int64, err error) {
	if maxTurns <= 0 {
		// Cross-source queries (docs + Gmail + Calendar + WhatsApp
		// history) routinely need 8-10 tool calls before the model has
		// enough to synthesize. 5 was too tight; 12 covers the realistic
		// worst case without inviting runaway loops.
		maxTurns = 12
	}

	// G4: inject planning hint when turn looks multi-step (no-op when flag off).
	messages = injectPlannerIfNeeded(messages)

	// Pull the system message out — Anthropic wants it as a top-level field.
	var systemPrompt string
	var antMessages []map[string]any
	for _, m := range messages {
		role, _ := m["role"].(string)
		if role == "system" {
			if s, ok := m["content"].(string); ok {
				if systemPrompt != "" {
					systemPrompt += "\n\n"
				}
				systemPrompt += s
			}
			continue
		}
		// User/assistant get passed through. Anthropic accepts string OR
		// array content; we keep string for simplicity until tool_use turns.
		if content, ok := m["content"].(string); ok && content != "" {
			antMessages = append(antMessages, map[string]any{
				"role":    role,
				"content": content,
			})
		}
	}

	// Convert tools from OpenAI to Anthropic format.
	antTools := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		fn, _ := t["function"].(map[string]any)
		if fn == nil {
			continue
		}
		antTools = append(antTools, map[string]any{
			"name":         fn["name"],
			"description":  fn["description"],
			"input_schema": fn["parameters"],
		})
	}

	for turn := 0; turn < maxTurns; turn++ {
		reqBody := map[string]any{
			"model":      model,
			"max_tokens": 4096,
			"messages":   antMessages,
		}
		if systemPrompt != "" {
			reqBody["system"] = systemPrompt
		}
		if len(antTools) > 0 {
			reqBody["tools"] = antTools
		}
		bodyBytes, _ := json.Marshal(reqBody)

		req, _ := http.NewRequestWithContext(ctx, "POST",
			"https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")

		resp, httpErr := http.DefaultClient.Do(req)
		if httpErr != nil {
			return "", invocations, tokensIn, tokensOut, httpErr
		}
		defer resp.Body.Close() //nolint:errcheck

		// Anthropic response carries an array of content blocks; each is
		// either {type:"text", text:""} or {type:"tool_use", id, name, input}.
		var antResp struct {
			Content    []map[string]any `json:"content"`
			StopReason string           `json:"stop_reason"`
			Usage      struct {
				InputTokens  int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if decErr := json.NewDecoder(resp.Body).Decode(&antResp); decErr != nil {
			return "", invocations, tokensIn, tokensOut, decErr
		}
		tokensIn += antResp.Usage.InputTokens
		tokensOut += antResp.Usage.OutputTokens

		if antResp.Error != nil {
			return "", invocations, tokensIn, tokensOut, fmt.Errorf("anthropic: %s", antResp.Error.Message)
		}

		// Collect text + tool_use blocks from the response.
		var textParts []string
		type toolUse struct {
			ID    string
			Name  string
			Input map[string]any
		}
		var toolUses []toolUse
		for _, block := range antResp.Content {
			t, _ := block["type"].(string)
			switch t {
			case "text":
				if s, ok := block["text"].(string); ok {
					textParts = append(textParts, s)
				}
			case "tool_use":
				id, _ := block["id"].(string)
				name, _ := block["name"].(string)
				input, _ := block["input"].(map[string]any)
				toolUses = append(toolUses, toolUse{ID: id, Name: name, Input: input})
			}
		}

		// Terminal: no tool calls — model gave a final answer.
		if antResp.StopReason != "tool_use" && len(toolUses) == 0 {
			return strings.Join(textParts, "\n\n"), invocations, tokensIn, tokensOut, nil
		}

		// Append the assistant turn (must include ALL content blocks exactly
		// as Anthropic returned them, otherwise the next request 400s).
		antMessages = append(antMessages, map[string]any{
			"role":    "assistant",
			"content": antResp.Content,
		})

		// Dispatch each tool_use and build a single user message with all
		// tool_results in order. Anthropic requires they appear in one
		// message, not separate turns.
		toolResults := make([]map[string]any, 0, len(toolUses))
		for _, tu := range toolUses {
			inv := ToolInvocation{Name: tu.Name, Args: tu.Input}
			if onToolCall != nil {
				onToolCall(inv)
			}
			result, dispErr := dispatch(ctx, tu.Name, tu.Input)
			tr := map[string]any{
				"type":        "tool_result",
				"tool_use_id": tu.ID,
			}
			if dispErr != nil {
				inv.Error = dispErr.Error()
				tr["is_error"] = true
				tr["content"] = dispErr.Error()
			} else {
				inv.Result = result
				resultJSON, _ := json.Marshal(result)
				tr["content"] = truncateToolResult(string(resultJSON))
			}
			if onToolCall != nil {
				onToolCall(inv) // completed/failed
			}
			invocations = append(invocations, inv)
			toolResults = append(toolResults, tr)
		}
		antMessages = append(antMessages, map[string]any{
			"role":    "user",
			"content": toolResults,
		})
	}

	// Hit the turn budget. Force ONE final synthesis turn with tools
	// disabled so the model produces a real answer from data it's
	// already pulled — instead of dumping the boilerplate.
	antMessages = append(antMessages, map[string]any{
		"role":    "user",
		"content": "Tool-call budget reached. Synthesize the BEST possible answer NOW from what you've already fetched. Be concrete. If you genuinely don't have enough, say so in one short line plus suggest the most useful next step.",
	})
	finalReq := map[string]any{
		"model":      model,
		"max_tokens": 1024,
		"messages":   antMessages,
	}
	if systemPrompt != "" {
		finalReq["system"] = systemPrompt
	}
	finalBytes, _ := json.Marshal(finalReq)
	finalHTTPReq, _ := http.NewRequestWithContext(ctx, "POST",
		"https://api.anthropic.com/v1/messages", bytes.NewReader(finalBytes))
	finalHTTPReq.Header.Set("Content-Type", "application/json")
	finalHTTPReq.Header.Set("x-api-key", apiKey)
	finalHTTPReq.Header.Set("anthropic-version", "2023-06-01")
	if resp, ferr := http.DefaultClient.Do(finalHTTPReq); ferr == nil {
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var parsed struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				InputTokens  int64 `json:"input_tokens"`
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
		}
		if jerr := json.Unmarshal(body, &parsed); jerr == nil {
			tokensIn += parsed.Usage.InputTokens
			tokensOut += parsed.Usage.OutputTokens
			var sb strings.Builder
			for _, c := range parsed.Content {
				if c.Type == "text" {
					sb.WriteString(c.Text)
				}
			}
			if strings.TrimSpace(sb.String()) != "" {
				return sb.String(), invocations, tokensIn, tokensOut, nil
			}
		}
	}
	return "i pulled a bunch of data but ran out of room to wrap up. ask again in a sec — i'll try a tighter angle.", invocations, tokensIn, tokensOut, nil
}

// ---------------------------------------------------------------------------
// Provider-failover layer.
//
// callLLMWithTools picks one provider+model and runs the tool loop against
// it. If that provider returns a retryable error (rate limit, out-of-credits,
// 5xx), the request fails — the caller sees an error and the agent run is
// marked failed. With BOTH OpenAI and Anthropic configured, that's a
// pointless single-provider outage.
//
// callLLMWithFailover layers on top: it walks the ranked candidate chain
// (resolveCandidateChain) and retries on the NEXT provider when the
// current one fails retryably. Hard errors (bad prompt, invalid tools,
// model returned malformed JSON) propagate immediately.
// ---------------------------------------------------------------------------

// isRetryableLLMError classifies an error string as "try a different
// provider" (true) vs "this is a real problem, give up" (false).
//
// truncateToolResult caps a marshalled tool-result string to 4000 chars before
// it is appended to the model's message array for the next turn. Without this
// cap a single tool result (e.g. a large document fetch) can push the prompt
// past the provider's TPM limit, causing a 429 on an otherwise trivial query.
//
// The suffix nudges the model to call the tool again with a narrower query if
// it truly needs more data — better UX than a silent truncation.
const toolResultMaxChars = 4000
const toolResultTruncSuffix = "\n...(truncated — call the tool again with a narrower query if you need more)"

func truncateToolResult(s string) string {
	if len(s) <= toolResultMaxChars {
		return s
	}
	return s[:toolResultMaxChars] + toolResultTruncSuffix
}

// Retryable:
//   - 429 rate limited
//   - 402 / 'credit' / 'quota' (out of credits)
//   - 5xx
//   - network / timeout
//
// Non-retryable:
//   - 400 / 401 / 403 (auth or input issue — same on the other provider)
//   - successful JSON-decode of the response that has an error string
//     about the user's actual prompt
func isRetryableLLMError(errStr string) bool {
	if errStr == "" {
		return false
	}
	s := strings.ToLower(errStr)
	retryableMarkers := []string{
		"429", "rate limit", "rate_limit", "too many requests",
		"402", "out of credit", "credit balance", "quota", "exceed",
		"500", "502", "503", "504", "internal server error", "overloaded",
		"upstream", "timeout", "timed out", "connection reset",
		"no_active_subscription", "billing",
		// Process-kill signals (e.g. claude-code OOM/timeout) — fall over to
		// API providers rather than aborting the whole failover chain.
		"signal: killed", "killed",
		// Context cancellation from the subprocess layer is transient.
		"context deadline exceeded",
	}
	for _, m := range retryableMarkers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// rateLimitBackoff returns how long to wait before retrying the SAME provider
// on a rate-limit (429), parsed from the provider's "try again in Xs" hint
// when present (e.g. OpenAI TPM limits clear in a few seconds), else a small
// default. Returns 0 when the error isn't a rate limit. Capped so a transient
// limit can't stall the bridge's reply loop. This is the difference between
// "Sorry, rate limit" reaching the user vs. a 3-second wait then success.
func rateLimitBackoff(errStr string) time.Duration {
	s := strings.ToLower(errStr)
	if !strings.Contains(s, "429") &&
		!strings.Contains(s, "rate limit") &&
		!strings.Contains(s, "rate_limit") &&
		!strings.Contains(s, "too many requests") {
		return 0
	}
	wait := 2 * time.Second
	for _, kw := range []string{"try again in ", "retry after ", "again in ", "after "} {
		idx := strings.Index(s, kw)
		if idx == -1 {
			continue
		}
		rest := s[idx+len(kw):]
		j := 0
		for j < len(rest) && ((rest[j] >= '0' && rest[j] <= '9') || rest[j] == '.') {
			j++
		}
		if j > 0 {
			if f, err := strconv.ParseFloat(rest[:j], 64); err == nil && f > 0 {
				wait = time.Duration((f + 0.3) * float64(time.Second)) // small cushion
			}
		}
		break
	}
	if wait > 25*time.Second {
		wait = 25 * time.Second
	}
	return wait
}

// candidateAttempt is used by the inline executor + sessions to know which
// provider+model actually answered, so the run-detail waterfall can render
// 'Failed over: anthropic → openai (anthropic returned 429)'.
type candidateAttempt struct {
	Provider string
	Model    string
	Err      error
}

// callLLMWithFailover walks the tenant's ranked provider list and tries
// each one in order until one succeeds OR the list is exhausted. Returns
// the same shape as callLLMWithTools plus the actually-used (provider,
// model) so callers can log the resolution + emit failover steps.
//
// onAttempt is called for every attempt (success OR retryable failure) so
// callers can stream UI events. Pass nil to skip.
func (h *LlmProxyHandler) callLLMWithFailover(
	ctx context.Context,
	tenantID string,
	messages []map[string]any,
	tools []map[string]any,
	dispatch func(ctx context.Context, name string, args map[string]any) (any, error),
	onToolCall func(inv ToolInvocation),
	onAttempt func(att candidateAttempt),
	maxTurns int,
) (
	finalText string,
	invocations []ToolInvocation,
	usedProvider, usedModel string,
	tokensIn, tokensOut int64,
	err error,
) {
	chain := resolveCandidateChain(
		h.providerAvailable(ctx, tenantID, "anthropic"),
		h.providerAvailable(ctx, tenantID, "openai"),
	)
	if len(chain) == 0 {
		return "", nil, "", "", 0, 0, fmt.Errorf("no LLM provider configured for this tenant")
	}
	// The local `claude -p` CLI doesn't support OpenAI-style tools[]. If
	// this run actually needs tool calling, drop claude-code from the
	// chain — otherwise tools silently get dropped, the model never calls
	// gmail/github/etc, and the user sees a hollow response. Prefetch
	// agents (zero tools) keep claude-code as the top candidate for free
	// local runs.
	if len(tools) > 0 {
		filtered := chain[:0]
		for _, c := range chain {
			if c.Provider == "claude-code" {
				continue
			}
			filtered = append(filtered, c)
		}
		chain = filtered
		if len(chain) == 0 {
			return "", nil, "", "", 0, 0, fmt.Errorf("no tool-capable LLM provider configured (claude-code CLI doesn't support tools; set OpenAI or Anthropic API key)")
		}
	}

	var lastErr error
	for _, cand := range chain {
		// claude-code has no API key — auth is via the user's `claude`
		// CLI session. Skip the key lookup for it.
		var apiKey string
		if cand.Provider != "claude-code" {
			key, keyErr := h.resolveProviderKey(ctx, tenantID, cand.Provider)
			if keyErr != nil {
				lastErr = keyErr
				if onAttempt != nil {
					onAttempt(candidateAttempt{Provider: cand.Provider, Model: cand.Model, Err: keyErr})
				}
				continue
			}
			apiKey = key
		}
		text, invs, tin, tout, callErr := h.callLLMWithTools(
			ctx, cand.Provider, cand.Model, apiKey, messages, tools, dispatch, onToolCall, maxTurns,
		)
		// Transient rate-limit: wait the provider-suggested time and retry the
		// SAME provider ONCE before failing over. TPM limits (OpenAI) clear in
		// seconds; this turns "Sorry, rate limit" into a brief pause + success.
		if callErr != nil {
			if backoff := rateLimitBackoff(callErr.Error()); backoff > 0 {
				h.logger().Info("LLM rate limited — backing off then retrying same provider",
					zap.String("provider", cand.Provider),
					zap.String("model", cand.Model),
					zap.Duration("backoff", backoff))
				select {
				case <-time.After(backoff):
				case <-ctx.Done():
				}
				if ctx.Err() == nil {
					text, invs, tin, tout, callErr = h.callLLMWithTools(
						ctx, cand.Provider, cand.Model, apiKey, messages, tools, dispatch, onToolCall, maxTurns,
					)
				}
			}
		}
		if callErr == nil {
			if onAttempt != nil {
				onAttempt(candidateAttempt{Provider: cand.Provider, Model: cand.Model})
			}
			// G3: soften any unbacked completion claims before returning.
			text = rewriteUnbackedClaims(text, invs, h.logger())
			return text, invs, cand.Provider, cand.Model, tin, tout, nil
		}
		lastErr = callErr
		if onAttempt != nil {
			onAttempt(candidateAttempt{Provider: cand.Provider, Model: cand.Model, Err: callErr})
		}
		// Stop early on non-retryable errors — same failure on the next
		// provider is the most likely outcome and we'd waste tokens.
		if !isRetryableLLMError(callErr.Error()) {
			h.logger().Warn("non-retryable LLM error, not failing over",
				zap.String("provider", cand.Provider),
				zap.String("model", cand.Model),
				zap.Error(callErr))
			break
		}
		h.logger().Info("LLM call failed, falling over to next provider",
			zap.String("from_provider", cand.Provider),
			zap.String("from_model", cand.Model),
			zap.Error(callErr))
	}
	return "", nil, "", "", 0, 0, fmt.Errorf("all configured providers failed: %w", lastErr)
}

// CompleteInternal is the in-process entry point for one-shot
// completions issued by other Go handlers (SMS, voice, escalation).
// It reuses callLLMWithFailover so the same provider chain + retry
// behavior the dashboard sees applies here, but bypasses the HTTP
// surface entirely — no loopback, no JWT.
func (h *LlmProxyHandler) CompleteInternal(ctx context.Context, tenantID, system, user string, _ int) (string, error) {
	messages := []map[string]any{
		{"role": "system", "content": system},
		{"role": "user", "content": user},
	}
	text, _, _, _, _, _, err := h.callLLMWithFailover(ctx, tenantID, messages, nil, nil, nil, nil, 1)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(text), nil
}

// ---------- OCR / Vision endpoint ----------

// OCRRequest is the body of POST /v1/vision/ocr. The image is passed as
// a data URL (data:image/png;base64,...) so the client doesn't need to
// upload a binary multipart form. Prompt is optional — defaults to a
// generic OCR system prompt tuned for ID documents, forms, and
// receipts (the personal-docs use case).
type ocrRequest struct {
	ImageDataUrl string `json:"imageDataUrl"`
	Prompt       string `json:"prompt,omitempty"`
	Model        string `json:"model,omitempty"`
}

type ocrResponse struct {
	Text     string `json:"text"`
	Model    string `json:"model"`
	Provider string `json:"provider"`
}

// OCR handles POST /v1/vision/ocr. Uses the tenant's OpenAI key + gpt-4o
// vision to extract text from a base64 image. Returns 400 if no OpenAI
// key is configured (Anthropic vision is a future option; for now OCR
// is OpenAI-only since gpt-4o vision is materially better than Claude
// at dense ID/form extraction).
func (h *LlmProxyHandler) OCR(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req ocrRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.ImageDataUrl == "" || !strings.HasPrefix(req.ImageDataUrl, "data:") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "imageDataUrl must be a data: URL"})
		return
	}

	apiKey, err := h.resolveProviderKey(ctx, tenantID, "openai")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "OCR requires an OpenAI key — add one in Settings > LLM Providers (gpt-4o vision)",
		})
		return
	}

	model := req.Model
	if model == "" {
		model = "gpt-4o-mini"
	}
	prompt := req.Prompt
	if prompt == "" {
		prompt = "OCR this document. Label fields clearly."
	}
	system := "You are an OCR engine. Extract ALL visible text from the image, preserving structure. Include numbers, dates, names exactly as shown. If the image is a form, ID, passport, license, or receipt, LABEL key fields explicitly (e.g., 'Date of Birth: ...', 'Expiration Date: ...', 'Passport Number: ...', 'License #: ...'). Be exhaustive — every visible text element matters. No commentary, just the extracted text."

	body := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "system", "content": system},
			{"role": "user", "content": []map[string]any{
				{"type": "image_url", "image_url": map[string]any{"url": req.ImageDataUrl}},
				{"type": "text", "text": prompt},
			}},
		},
		"max_tokens": 2000,
	}
	bb, _ := json.Marshal(body)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/chat/completions", bytes.NewReader(bb))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to build request"})
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		h.logger().Error("OCR vision request failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to reach OpenAI: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		h.logger().Warn("OCR returned non-200", zap.Int("status", resp.StatusCode), zap.String("body", string(errBody)))
		writeJSON(w, resp.StatusCode, map[string]string{"error": "OpenAI vision error", "details": string(errBody)})
		return
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to parse OpenAI response"})
		return
	}
	text := ""
	if len(result.Choices) > 0 {
		text = result.Choices[0].Message.Content
	}
	writeJSON(w, http.StatusOK, ocrResponse{Text: text, Model: model, Provider: "openai"})
}

// transcribeRequest is the body of POST /v1/audio/transcriptions. Audio is
// passed base64-encoded so the bridge doesn't have to construct a multipart
// upload itself. Filename carries the container hint (WhatsApp voice notes
// are OGG/Opus); Language is an optional ISO-639-1 bias for Whisper.
type transcribeRequest struct {
	AudioBase64 string `json:"audioBase64"`
	Filename    string `json:"filename,omitempty"`
	Language    string `json:"language,omitempty"`
	// Prompt biases Whisper's decoder toward the right script/vocabulary.
	// Used to stop low-resource languages mis-decoding into an adjacent
	// script (e.g. Telangana Telugu → Kannada). Optional.
	Prompt string `json:"prompt,omitempty"`
}

type transcribeResponse struct {
	Text     string `json:"text"`
	Provider string `json:"provider"`
}

// Transcribe handles POST /v1/audio/transcriptions. Uses the tenant's OpenAI
// key + Whisper to transcribe a base64 audio clip. This keeps the bridge from
// calling api.openai.com directly (model-router invariant) and means the key
// lives only in the control-plane. Returns 400 if no OpenAI key is configured.
func (h *LlmProxyHandler) Transcribe(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req transcribeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.AudioBase64 == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audioBase64 required"})
		return
	}
	audio, err := base64.StdEncoding.DecodeString(req.AudioBase64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "audioBase64 is not valid base64"})
		return
	}

	apiKey, err := h.resolveProviderKey(ctx, tenantID, "openai")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "transcription requires an OpenAI key — add one in Settings > LLM Providers (Whisper)",
		})
		return
	}

	filename := req.Filename
	if filename == "" {
		filename = "audio.ogg"
	}

	var form bytes.Buffer
	mw := multipart.NewWriter(&form)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to build multipart form"})
		return
	}
	if _, err := part.Write(audio); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to write audio to form"})
		return
	}
	_ = mw.WriteField("model", "whisper-1")
	if req.Language != "" {
		_ = mw.WriteField("language", req.Language)
	}
	if req.Prompt != "" {
		_ = mw.WriteField("prompt", req.Prompt)
	}
	if err := mw.Close(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to finalize multipart form"})
		return
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.openai.com/v1/audio/transcriptions", &form)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to build request"})
		return
	}
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		h.logger().Error("transcription request failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to reach OpenAI: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		h.logger().Warn("transcription returned non-200", zap.Int("status", resp.StatusCode), zap.String("body", string(errBody)))
		writeJSON(w, resp.StatusCode, map[string]string{"error": "OpenAI transcription error", "details": string(errBody)})
		return
	}

	var result struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to parse OpenAI response"})
		return
	}
	writeJSON(w, http.StatusOK, transcribeResponse{Text: result.Text, Provider: "openai"})
}
