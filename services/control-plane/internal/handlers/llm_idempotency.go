package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// LLM call idempotency (invariant #8: every external side-effect carries an
// idempotency key derived from (run_id, step_id, attempt)).
//
// An LLM completion is the single most expensive side-effect in the system.
// On a rate-limit backoff retry to the SAME provider, or a crash-replay, the
// request must carry a STABLE Idempotency-Key so the provider dedups it
// instead of billing (and executing) it twice. OpenAI and Anthropic both
// honor the `Idempotency-Key` request header.
//
// The key is threaded through context.Context rather than every HTTP-builder
// signature: callers that have a run already (the inline executor) stamp the
// ctx via WithLLMIdempotencyBase; the per-provider request builders read it
// back. Call sites without a run (ad-hoc /v1/completions) fall back to a
// deterministic hash of the request payload so two identical requests still
// dedup, rather than a random token.
// ---------------------------------------------------------------------------

type llmIdemBaseKey struct{}

// WithLLMIdempotencyBase returns a child context carrying the stable base
// idempotency token for every LLM call made under it. The inline executor
// derives this from idempotencyKey(runID, llmStepID, attempt) so a
// crash-replay or rate-limit retry of the same logical step reuses it.
//
// An empty base is ignored (the request builders fall back to the payload
// hash), so callers can pass through unconditionally.
func WithLLMIdempotencyBase(ctx context.Context, base string) context.Context {
	if base == "" {
		return ctx
	}
	return context.WithValue(ctx, llmIdemBaseKey{}, base)
}

// llmIdempotencyBase reads the base token stamped by WithLLMIdempotencyBase,
// or "" when none is present.
func llmIdempotencyBase(ctx context.Context) string {
	if v, ok := ctx.Value(llmIdemBaseKey{}).(string); ok {
		return v
	}
	return ""
}

// llmIdempotencyKey derives the per-provider Idempotency-Key for one logical
// LLM call.
//
//   - When a run-scoped base is present in ctx, the key is
//     hex(sha256(base | provider)). The SAME base across a rate-limit backoff
//     retry to the SAME provider yields the SAME key (the provider dedups);
//     a failover to a DIFFERENT provider yields a different key (a genuinely
//     new request, not a duplicate of the first provider's).
//   - Otherwise (ad-hoc completion, no run) the key is a deterministic hash of
//     the request payload — hex(sha256(provider | model | messages)). Two
//     byte-identical requests collapse to one key; distinct requests don't.
//
// Returns "" only when there is neither a base nor a payload to hash, in which
// case the caller omits the header.
func llmIdempotencyKey(ctx context.Context, provider, model string, messages []map[string]any) string {
	if base := llmIdempotencyBase(ctx); base != "" {
		sum := sha256.Sum256([]byte(base + "|" + provider))
		return hex.EncodeToString(sum[:])
	}
	return llmPayloadIdempotencyKey(provider, model, messages)
}

// llmPayloadIdempotencyKey is the run-less fallback: a stable hash over the
// request's identifying fields. json.Marshal of a []map[string]any with string
// keys is deterministic (Go sorts map keys), so identical messages produce an
// identical digest across processes.
func llmPayloadIdempotencyKey(provider, model string, messages []map[string]any) string {
	msgJSON, err := json.Marshal(messages)
	if err != nil {
		// Unmarshalable payload (shouldn't happen for our string/any maps):
		// omit the header rather than emit an unstable key.
		return ""
	}
	h := sha256.New()
	_, _ = h.Write([]byte(strings.Join([]string{provider, model, string(msgJSON)}, "|")))
	return hex.EncodeToString(h.Sum(nil))
}

// stringMessagesToAny widens the []map[string]string message shape used by the
// ad-hoc proxy paths into the []map[string]any the hash helper consumes.
func stringMessagesToAny(messages []map[string]string) []map[string]any {
	out := make([]map[string]any, len(messages))
	for i, m := range messages {
		am := make(map[string]any, len(m))
		for k, v := range m {
			am[k] = v
		}
		out[i] = am
	}
	return out
}

// setLLMIdempotencyHeader sets the provider Idempotency-Key header when a
// non-empty key is available. The key is a one-way hash of identifiers — it
// contains no secret material, so it is safe to send (never the API key).
func setLLMIdempotencyHeader(req *http.Request, key string) {
	if key == "" {
		return
	}
	req.Header.Set("Idempotency-Key", key)
}

// llmIdempotencyBaseFor builds the run-scoped base token from the same
// (run_id, step_id, attempt) form used for every other side-effect
// (idempotencyKey). Kept as a thin wrapper so the inline executor reads
// intent-revealingly at the call site.
func llmIdempotencyBaseFor(runID, stepID string, attempt int) string {
	return strings.Join([]string{runID, stepID, strconv.Itoa(attempt)}, ":")
}
