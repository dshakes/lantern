package handlers

// Text embeddings for semantic recall over the unified timeline.
//
// We piggyback on the tenant's OpenAI key (the same one the LLM proxy
// already resolves) — Anthropic has no embeddings API. Embedding is
// always best-effort: callers store the row first and embed async, and
// retrieval falls back to recency/keyword when embeddings are absent, so
// a missing key or a provider blip never breaks memory.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// embedDim is the vector width stored in memory_events.embedding. Must
// match the migration (1536 = OpenAI text-embedding-3-small). A model
// whose output differs is rejected rather than silently truncated.
const embedDim = 1536

var embedHTTPClient = &http.Client{Timeout: 20 * time.Second}

// EmbedText returns the embedding for text using the tenant's OpenAI key.
// Returns an error (not a panic) on any failure so callers can degrade.
func (h *LlmProxyHandler) EmbedText(ctx context.Context, tenantID, text string) ([]float32, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("embed: empty text")
	}
	apiKey, err := h.resolveProviderKey(ctx, tenantID, "openai")
	if err != nil {
		return nil, fmt.Errorf("embed: no openai key: %w", err)
	}
	model := getEnvOr("LANTERN_EMBED_MODEL", "text-embedding-3-small")

	// Cap input — embeddings models have token limits and timeline rows
	// can be long; the first ~8k chars carry the signal.
	if len(text) > 8000 {
		text = text[:8000]
	}

	reqBody, _ := json.Marshal(map[string]any{"model": model, "input": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/embeddings", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := embedHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed: request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return nil, fmt.Errorf("embed: status %d: %s", resp.StatusCode, strings.TrimSpace(buf.String()))
	}

	var out struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("embed: decode: %w", err)
	}
	if len(out.Data) == 0 || len(out.Data[0].Embedding) == 0 {
		return nil, fmt.Errorf("embed: empty embedding")
	}
	vec := out.Data[0].Embedding
	if len(vec) != embedDim {
		return nil, fmt.Errorf("embed: model %q returned dim %d, expected %d", model, len(vec), embedDim)
	}
	return vec, nil
}

// vectorLiteral renders a float32 slice as a pgvector input literal
// ("[0.1,0.2,...]"). Used for both inserts and the query vector.
func vectorLiteral(vec []float32) string {
	var b strings.Builder
	b.Grow(len(vec) * 8)
	b.WriteByte('[')
	for i, f := range vec {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}
