package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"

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
}

type completionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type completionResponse struct {
	Model       string `json:"model"`
	Content     string `json:"content"`
	TokensIn    int    `json:"tokensIn"`
	TokensOut   int    `json:"tokensOut"`
	CostUsd     float64 `json:"costUsd"`
	Provider    string `json:"provider"`
	FinishReason string `json:"finishReason"`
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
		// In production, decrypt. For spike, stored as plaintext.
		return apiKeyEncrypted, nil
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

// resolveModel maps a capability name to a concrete provider + model.
func resolveModel(capability string) (provider, model string) {
	switch capability {
	case "auto", "chat-large", "":
		return "openai", "gpt-4o"
	case "reasoning-large":
		return "anthropic", "claude-sonnet-4-20250514"
	case "reasoning-small":
		return "openai", "gpt-4o-mini"
	case "chat-small":
		return "openai", "gpt-4o-mini"
	case "code-large":
		return "anthropic", "claude-sonnet-4-20250514"
	default:
		// If it looks like a concrete model name, try to infer provider.
		if strings.HasPrefix(capability, "gpt") || strings.HasPrefix(capability, "o1") || strings.HasPrefix(capability, "o3") {
			return "openai", capability
		}
		if strings.HasPrefix(capability, "claude") {
			return "anthropic", capability
		}
		// Default to OpenAI.
		return "openai", "gpt-4o"
	}
}

// ---------- Complete endpoint ----------

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

	provider, model := resolveModel(req.Model)

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
				"error": "No LLM provider API key configured. Add one in Settings > LLM Providers.",
			})
			return
		}
		provider = altProvider
		apiKey = altKey
		// Re-resolve model for new provider.
		if provider == "openai" {
			model = "gpt-4o"
		} else {
			model = "claude-sonnet-4-20250514"
		}
	}

	h.logger().Info("proxying completion",
		zap.String("tenant_id", tenantID),
		zap.String("provider", provider),
		zap.String("model", model),
		zap.Bool("stream", req.Stream),
	)

	switch provider {
	case "openai":
		h.proxyOpenAI(w, ctx, apiKey, model, &req)
	case "anthropic":
		h.proxyAnthropic(w, ctx, apiKey, model, &req)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported provider"})
	}
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

	// In production, encrypt the key. For spike, store as-is.
	_, err = h.srv.Pool.Exec(ctx, `
		INSERT INTO llm_provider_configs (tenant_id, provider, api_key_encrypted, status)
		VALUES ($1, $2, $3, 'active')
		ON CONFLICT (tenant_id, provider)
		DO UPDATE SET api_key_encrypted = $3, status = 'active', updated_at = now()
	`, tenantID, body.Provider, body.ApiKey)
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
		"model": "claude-sonnet-4-20250514",
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
