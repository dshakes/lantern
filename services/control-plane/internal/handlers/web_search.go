package handlers

// Built-in `web_search` tool — gives the session tool loop live internet
// access so bridge replies can GROUND on real-world state (flight status,
// news, hours, scores) instead of deflecting with "keep me posted".
//
// Implementation: one-shot Anthropic Messages call using the SERVER-SIDE
// web_search tool — Anthropic executes the searches, we just relay the
// synthesized summary back as the tool result. Works regardless of which
// provider the OUTER tool loop picked (OpenAI or Anthropic), because this
// runs inside dispatch. Requires the tenant to have an Anthropic key
// (DB-configured or ANTHROPIC_API_KEY env fallback).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Package vars so tests can point at a mock server / pin a model.
var (
	anthropicWebSearchURL = "https://api.anthropic.com/v1/messages"
	openaiWebSearchURL    = "https://api.openai.com/v1/chat/completions"
)

func webSearchModel() string {
	if m := os.Getenv("LANTERN_WEBSEARCH_MODEL"); m != "" {
		return m
	}
	// Cheapest CURRENT model documented to support the web_search_20260209
	// server tool (Haiku 3.5 is retired; Haiku 4.5's web-search support is
	// not documented). The outer loop's model does the reply synthesis —
	// this one only summarizes search results, so calls are small.
	return "claude-sonnet-4-6"
}

func webSearchOpenAIModel() string {
	if m := os.Getenv("LANTERN_WEBSEARCH_OPENAI_MODEL"); m != "" {
		return m
	}
	// Cheapest OpenAI model that supports web_search_options.
	return "gpt-4o-mini-search-preview"
}

// webSearchTool returns the OpenAI-format tool definition. The name
// "web_search" passes filterReadOnlyTools (search = read verb), so contacts'
// reply turns get it too — searching the public web is read-only by nature.
func webSearchTool() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        "web_search",
			"description": "Search the live web for current, real-world information: flight status, news, weather, sports scores, business hours, product releases, prices — anything time-sensitive or checkable online that you cannot know from the conversation alone. Returns a concise summary of findings with sources. Prefer this over guessing or asking the user for facts the internet can answer.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Specific search query including identifiers and dates when known (e.g. \"Frontier flight FFT3990 status today\")",
					},
				},
				"required": []string{"query"},
			},
		},
	}
}

var webSearchHTTPClient = &http.Client{Timeout: 60 * time.Second}

// executeWebSearchTool runs one web search and returns a text summary.
// Anthropic's server-side web_search tool is the primary path; tenants
// without an Anthropic key fall back to OpenAI's search-preview models
// (web_search_options). Errors surface to the tool loop as is_error
// results so the model can answer honestly without it.
func executeWebSearchTool(ctx context.Context, pool *pgxpool.Pool, tenantID string, params map[string]any) (any, error) {
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("web_search: query is required")
	}

	prompt := "Search the web and report what you find about: " + query +
		"\nBe concise: key facts first with specific numbers/times/statuses, then source names. If results conflict or look stale, say so. If nothing relevant is found, say that plainly."

	anthropicKey, anthErr := resolveProviderKeyFromPool(ctx, pool, tenantID, "anthropic")
	if anthErr == nil {
		return webSearchViaAnthropic(ctx, anthropicKey, prompt)
	}
	openaiKey, oaiErr := resolveProviderKeyFromPool(ctx, pool, tenantID, "openai")
	if oaiErr == nil {
		return webSearchViaOpenAI(ctx, openaiKey, prompt)
	}
	return nil, fmt.Errorf("web_search unavailable: no anthropic key (%v) and no openai key (%v)", anthErr, oaiErr)
}

// toolUsage accumulates spend by tool executors (web_search makes its own LLM
// call, possibly on a different provider/model than the outer loop) so callers
// can add it to the turn's totals and RecordUsage sees the real spend. Carried
// on ctx to avoid changing the dispatch signature shared by every tool-loop
// caller. Cost is priced per call at the tool's own provider/model.
type toolUsage struct {
	mu                  sync.Mutex
	tokensIn, tokensOut int64
	costUsd             float64
}

type toolUsageKey struct{}

// withToolUsage installs an accumulator on ctx, or returns the one already
// there so nested installs share a single tally.
func withToolUsage(ctx context.Context) (context.Context, *toolUsage) {
	if u, _ := ctx.Value(toolUsageKey{}).(*toolUsage); u != nil {
		return ctx, u
	}
	u := &toolUsage{}
	return context.WithValue(ctx, toolUsageKey{}, u), u
}

// addToolUsage records tool-side spend on the ctx accumulator; no-op without one.
func addToolUsage(ctx context.Context, provider, model string, in, out int64) {
	if u, _ := ctx.Value(toolUsageKey{}).(*toolUsage); u != nil {
		u.mu.Lock()
		u.tokensIn += in
		u.tokensOut += out
		u.costUsd += estimateCost(provider, model, int(in), int(out))
		u.mu.Unlock()
	}
}

func (u *toolUsage) totals() (in, out int64, costUsd float64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.tokensIn, u.tokensOut, u.costUsd
}

// addTo folds tool spend into an outer call's totals: tokens add, the outer
// tokens are priced at the outer provider/model, and tool spend keeps the cost
// computed at its own model.
func (u *toolUsage) addTo(provider, model string, tokensIn, tokensOut int64) (int64, int64, float64) {
	in, out, cost := u.totals()
	return tokensIn + in, tokensOut + out, estimateCost(provider, model, int(tokensIn), int(tokensOut)) + cost
}

func webSearchViaAnthropic(ctx context.Context, apiKey, prompt string) (any, error) {
	reqBody := map[string]any{
		"model":      webSearchModel(),
		"max_tokens": 1024,
		"messages": []map[string]any{{
			"role":    "user",
			"content": prompt,
		}},
		"tools": []map[string]any{{
			// Current server-tool variant (dynamic filtering); requires
			// Opus 4.6+/Sonnet 4.6 — matched to webSearchModel's default.
			"type":     "web_search_20260209",
			"name":     "web_search",
			"max_uses": 3,
		}},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req, err := http.NewRequestWithContext(ctx, "POST", anthropicWebSearchURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := webSearchHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("web_search: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	var antResp struct {
		Content []map[string]any `json:"content"`
		Usage   struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&antResp); err != nil {
		return nil, fmt.Errorf("web_search: decode response: %w", err)
	}
	if antResp.Error != nil {
		return nil, fmt.Errorf("web_search: %s", antResp.Error.Message)
	}

	addToolUsage(ctx, "anthropic", webSearchModel(), antResp.Usage.InputTokens, antResp.Usage.OutputTokens)

	// Concatenate text blocks; server_tool_use / web_search_tool_result
	// blocks are Anthropic-internal plumbing we don't need to relay.
	var sb strings.Builder
	for _, block := range antResp.Content {
		if t, _ := block["type"].(string); t == "text" {
			if s, _ := block["text"].(string); s != "" {
				if sb.Len() > 0 {
					sb.WriteString("\n")
				}
				sb.WriteString(s)
			}
		}
	}
	summary := strings.TrimSpace(sb.String())
	if summary == "" {
		return nil, fmt.Errorf("web_search: empty result")
	}
	return map[string]any{"ok": true, "summary": summary}, nil
}

// webSearchViaOpenAI is the fallback for tenants without an Anthropic key:
// OpenAI's search-preview chat models run the web search server-side when
// web_search_options is present.
func webSearchViaOpenAI(ctx context.Context, apiKey, prompt string) (any, error) {
	reqBody := map[string]any{
		"model":              webSearchOpenAIModel(),
		"web_search_options": map[string]any{},
		"messages": []map[string]any{{
			"role":    "user",
			"content": prompt,
		}},
	}
	bodyBytes, _ := json.Marshal(reqBody)

	req, err := http.NewRequestWithContext(ctx, "POST", openaiWebSearchURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := webSearchHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("web_search: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

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
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&oaiResp); err != nil {
		return nil, fmt.Errorf("web_search: decode response: %w", err)
	}
	if oaiResp.Error != nil {
		return nil, fmt.Errorf("web_search: %s", oaiResp.Error.Message)
	}
	addToolUsage(ctx, "openai", webSearchOpenAIModel(), oaiResp.Usage.PromptTokens, oaiResp.Usage.CompletionTokens)
	if len(oaiResp.Choices) == 0 {
		return nil, fmt.Errorf("web_search: empty result")
	}
	summary := strings.TrimSpace(oaiResp.Choices[0].Message.Content)
	if summary == "" {
		return nil, fmt.Errorf("web_search: empty result")
	}
	return map[string]any{"ok": true, "summary": summary}, nil
}
