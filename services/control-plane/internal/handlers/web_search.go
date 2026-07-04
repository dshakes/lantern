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
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Package vars so tests can point at a mock server / pin a model.
var anthropicWebSearchURL = "https://api.anthropic.com/v1/messages"

func webSearchModel() string {
	if m := os.Getenv("LANTERN_WEBSEARCH_MODEL"); m != "" {
		return m
	}
	// Cheapest web-search-capable model; the outer loop's model does the
	// actual reply synthesis, this one only summarizes search results.
	return "claude-3-5-haiku-latest"
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

// executeWebSearchTool runs one web search via Anthropic's server-side
// web_search tool and returns a text summary. Errors surface to the tool
// loop as is_error results so the model can answer honestly without it.
func executeWebSearchTool(ctx context.Context, pool *pgxpool.Pool, tenantID string, params map[string]any) (any, error) {
	query, _ := params["query"].(string)
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("web_search: query is required")
	}

	apiKey, err := resolveProviderKeyFromPool(ctx, pool, tenantID, "anthropic")
	if err != nil {
		return nil, fmt.Errorf("web_search unavailable: %w", err)
	}

	reqBody := map[string]any{
		"model":      webSearchModel(),
		"max_tokens": 1024,
		"messages": []map[string]any{{
			"role": "user",
			"content": "Search the web and report what you find about: " + query +
				"\nBe concise: key facts first with specific numbers/times/statuses, then source names. If results conflict or look stale, say so. If nothing relevant is found, say that plainly.",
		}},
		"tools": []map[string]any{{
			"type":     "web_search_20250305",
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
		Error   *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&antResp); err != nil {
		return nil, fmt.Errorf("web_search: decode response: %w", err)
	}
	if antResp.Error != nil {
		return nil, fmt.Errorf("web_search: %s", antResp.Error.Message)
	}

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
