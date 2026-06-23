package handlers

// llm_idempotency_test.go — unit tests for the LLM-call idempotency-key
// derivation (invariant #8). No DB or network: these exercise pure functions
// and the ctx-threading, asserting stability across retries and determinism of
// the run-less payload-hash fallback.

import (
	"context"
	"net/http"
	"testing"
)

func TestLLMIdempotencyKey_StableForSameBaseAndProvider(t *testing.T) {
	base := llmIdempotencyBaseFor("run-123", llmStepID, 1)
	ctx := WithLLMIdempotencyBase(context.Background(), base)

	msgs := []map[string]any{{"role": "user", "content": "hi"}}

	first := llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)
	// A rate-limit backoff retry to the SAME provider reuses the SAME ctx and
	// must yield the SAME key so the provider dedups the re-issued call.
	retry := llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)

	if first == "" {
		t.Fatal("expected a non-empty idempotency key when a run base is present")
	}
	if first != retry {
		t.Errorf("same (base, provider) must produce a stable key: %q != %q", first, retry)
	}

	// The key must NOT depend on the message payload when a run base is set —
	// a turn that appends tool results must still dedup as the same logical call.
	moreTurns := []map[string]any{
		{"role": "user", "content": "hi"},
		{"role": "assistant", "content": "tool call"},
		{"role": "tool", "content": "result"},
	}
	if got := llmIdempotencyKey(ctx, "openai", "gpt-x", moreTurns); got != first {
		t.Errorf("key must be stable across turns of one logical call: %q != %q", got, first)
	}
}

func TestLLMIdempotencyKey_DistinctPerProviderOnFailover(t *testing.T) {
	ctx := WithLLMIdempotencyBase(context.Background(), llmIdempotencyBaseFor("run-1", llmStepID, 1))
	msgs := []map[string]any{{"role": "user", "content": "hi"}}

	openai := llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)
	anthropic := llmIdempotencyKey(ctx, "anthropic", "claude-x", msgs)
	finalOpenAI := llmIdempotencyKey(ctx, "openai:final", "gpt-x", msgs)

	if openai == anthropic {
		t.Error("failover to a different provider must use a distinct key (not a duplicate of the first provider's)")
	}
	if openai == finalOpenAI {
		t.Error("the tools-disabled synthesis sub-step must use a distinct key from the main loop")
	}
}

func TestLLMIdempotencyKey_DistinctPerRunStepAttempt(t *testing.T) {
	msgs := []map[string]any{{"role": "user", "content": "hi"}}
	key := func(run, step string, attempt int) string {
		ctx := WithLLMIdempotencyBase(context.Background(), llmIdempotencyBaseFor(run, step, attempt))
		return llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)
	}

	a := key("run-A", llmStepID, 1)
	bRun := key("run-B", llmStepID, 1)
	bStep := key("run-A", "tool:gmail", 1)
	bAttempt := key("run-A", llmStepID, 2)

	for name, other := range map[string]string{
		"different run":     bRun,
		"different step":    bStep,
		"different attempt": bAttempt,
	} {
		if a == other {
			t.Errorf("%s must produce a distinct idempotency key", name)
		}
	}
}

func TestLLMIdempotencyKey_PayloadFallbackDeterministic(t *testing.T) {
	// No run base in ctx → deterministic hash of the request payload, so two
	// byte-identical ad-hoc completions dedup to one key.
	ctx := context.Background()
	msgs := []map[string]any{
		{"role": "system", "content": "you are helpful"},
		{"role": "user", "content": "what time is it"},
	}

	k1 := llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)
	k2 := llmIdempotencyKey(ctx, "openai", "gpt-x", msgs)
	if k1 == "" {
		t.Fatal("payload fallback must produce a non-empty key")
	}
	if k1 != k2 {
		t.Errorf("identical payload must hash to the same key: %q != %q", k1, k2)
	}

	// Different message content → different key.
	other := []map[string]any{
		{"role": "system", "content": "you are helpful"},
		{"role": "user", "content": "different question"},
	}
	if llmIdempotencyKey(ctx, "openai", "gpt-x", other) == k1 {
		t.Error("a different payload must not collide with the original key")
	}

	// Different model → different key.
	if llmIdempotencyKey(ctx, "openai", "gpt-y", msgs) == k1 {
		t.Error("a different model must change the payload-fallback key")
	}

	// Different provider → different key.
	if llmIdempotencyKey(ctx, "anthropic", "gpt-x", msgs) == k1 {
		t.Error("a different provider must change the payload-fallback key")
	}
}

func TestStringMessagesToAnyHashEquivalence(t *testing.T) {
	// The ad-hoc proxy paths widen []map[string]string → []map[string]any
	// before hashing; the widened form must hash identically to a hand-built
	// []map[string]any so the fallback key is stable across call sites.
	strMsgs := []map[string]string{
		{"role": "user", "content": "hello"},
	}
	anyMsgs := []map[string]any{
		{"role": "user", "content": "hello"},
	}
	if a, b := llmPayloadIdempotencyKey("openai", "m", stringMessagesToAny(strMsgs)),
		llmPayloadIdempotencyKey("openai", "m", anyMsgs); a != b {
		t.Errorf("widened string messages must hash identically: %q != %q", a, b)
	}
}

func TestSetLLMIdempotencyHeader(t *testing.T) {
	t.Run("sets header when key is non-empty", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, "https://example.invalid", nil)
		setLLMIdempotencyHeader(req, "abc123")
		if got := req.Header.Get("Idempotency-Key"); got != "abc123" {
			t.Errorf("Idempotency-Key header: got %q, want %q", got, "abc123")
		}
	})
	t.Run("omits header when key is empty", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, "https://example.invalid", nil)
		setLLMIdempotencyHeader(req, "")
		if _, ok := req.Header["Idempotency-Key"]; ok {
			t.Error("Idempotency-Key header must be absent for an empty key")
		}
	})
}

func TestWithLLMIdempotencyBase_EmptyIsNoop(t *testing.T) {
	ctx := WithLLMIdempotencyBase(context.Background(), "")
	if got := llmIdempotencyBase(ctx); got != "" {
		t.Errorf("empty base must not be stamped onto ctx, got %q", got)
	}
	// With no base, the key derivation falls back to the payload hash.
	msgs := []map[string]any{{"role": "user", "content": "x"}}
	if llmIdempotencyKey(ctx, "openai", "m", msgs) != llmPayloadIdempotencyKey("openai", "m", msgs) {
		t.Error("with no base, key must equal the payload-hash fallback")
	}
}
