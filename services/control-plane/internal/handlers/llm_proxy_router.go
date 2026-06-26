package handlers

// Model-router cutover for the control-plane LLM path (task P2-B5/6).
//
// GOAL (invariant #6 — "models are addressed by capability, not name"): let the
// control-plane route plain provider completions through the model-router
// service instead of calling OpenAI / Anthropic directly. This is gated behind
// a DEFAULT-OFF flag with AUTOMATIC FALLBACK to the existing direct path, so the
// live WhatsApp / iMessage bridges are never at risk.
//
// Why the credential map exists (see models.proto CompleteRequest
// provider_credentials): the model-router builds its providers from PROCESS-ENV
// keys at startup and has no per-tenant key store. The control-plane resolves a
// per-tenant AES-256-GCM-encrypted key per call. So the router cannot carry a
// tenant's traffic until the control-plane hands it that tenant's key in the
// request. provider_credentials is that hand-off (invariant #10: never logged).

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// modelRouterDefaultAddr is the in-cluster address the control-plane dials when
// LANTERN_MODEL_ROUTER_ADDR is unset.
const modelRouterDefaultAddr = "model-router:50053"

// modelRouterTimeout caps a single router Complete call. On expiry tryModelRouter
// reports !ok and the caller falls through to the direct chain — a slow router
// must never stall a bridge reply.
const modelRouterTimeout = 30 * time.Second

// modelRouterClientFactory builds a ModelServiceClient for the given address.
// Production uses dialModelRouter (a real gRPC dial); tests inject a bufconn
// dialer so the cutover + fallback can be verified without a network.
type modelRouterClientFactory func(addr string) (lanternv1.ModelServiceClient, func() error, error)

// modelRouterDeps holds the per-handler router wiring. Split out so tests can
// override the factory and force the flag on/off without touching process env
// or the surrounding LlmProxyHandler.
type modelRouterDeps struct {
	// enabled, when non-nil, overrides the env-flag check (test seam).
	enabled *bool
	// factory builds the gRPC client. nil → dialModelRouter.
	factory modelRouterClientFactory
	// addr overrides LANTERN_MODEL_ROUTER_ADDR (test seam).
	addr string

	mu     sync.Mutex
	client lanternv1.ModelServiceClient
	closer func() error
	// dialCount counts how many times a client was constructed — tests assert
	// this stays 0 when the flag is OFF (router never dialed).
	dialCount int
}

// modelRouterEnabled reports whether the model-router cutover is active.
// Default OFF. ON only when LANTERN_USE_MODEL_ROUTER is a truthy value
// ("1"/"true"/"on", case-insensitive). A test override takes precedence.
func (h *LlmProxyHandler) modelRouterEnabled() bool {
	if h.router.enabled != nil {
		return *h.router.enabled
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_USE_MODEL_ROUTER"))) {
	case "1", "true", "on", "yes":
		return true
	default:
		return false
	}
}

// modelRouterAddr resolves the router address (test override > env > default).
func (h *LlmProxyHandler) modelRouterAddr() string {
	if h.router.addr != "" {
		return h.router.addr
	}
	if v := strings.TrimSpace(os.Getenv("LANTERN_MODEL_ROUTER_ADDR")); v != "" {
		return v
	}
	return modelRouterDefaultAddr
}

// modelRouterClient lazily constructs (and memoizes) the ModelServiceClient.
// Returns !ok on dial failure; the caller then uses the direct path.
func (h *LlmProxyHandler) modelRouterClient() (lanternv1.ModelServiceClient, bool) {
	h.router.mu.Lock()
	defer h.router.mu.Unlock()
	if h.router.client != nil {
		return h.router.client, true
	}
	factory := h.router.factory
	if factory == nil {
		factory = dialModelRouter
	}
	cl, closer, err := factory(h.modelRouterAddr())
	if err != nil {
		h.logger().Warn("model-router dial failed; using direct path",
			zap.String("addr", h.modelRouterAddr()), zap.Error(err))
		return nil, false
	}
	h.router.client = cl
	h.router.closer = closer
	h.router.dialCount++
	return cl, true
}

// dialModelRouter is the production factory: a plain insecure gRPC dial with the
// OTel client handler, matching the scheduler/runtime dial convention. Insecure
// is acceptable in-cluster (TLS terminates at the edge). NOTE: the per-tenant
// credentials this carries are application-layer secrets — for cross-cluster
// deployments this hop must run over mTLS or a service mesh (see ADR).
func dialModelRouter(addr string) (lanternv1.ModelServiceClient, func() error, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	)
	if err != nil {
		return nil, nil, err
	}
	return lanternv1.NewModelServiceClient(conn), conn.Close, nil
}

// tryModelRouter attempts a single plain completion via the model-router for the
// head-of-chain candidate. Returns ok=false on ANY failure (dial, timeout,
// non-OK status, empty body) so the caller falls back to the direct chain.
//
// It resolves the tenant's key via the SAME resolveProviderKey the direct path
// uses and ships it in provider_credentials so the router can build a
// per-request provider for this tenant. The key is NEVER logged (invariant #10).
func (h *LlmProxyHandler) tryModelRouter(
	ctx context.Context,
	tenantID string,
	cand struct{ Provider, Model string },
	messages []map[string]any,
) (text string, used struct{ Provider, Model string }, tokensIn, tokensOut int64, ok bool) {
	cl, ok := h.modelRouterClient()
	if !ok {
		return "", used, 0, 0, false
	}

	apiKey, keyErr := h.resolveProviderKey(ctx, tenantID, cand.Provider)
	if keyErr != nil {
		// No key for the head candidate → let the direct chain handle
		// provider selection + its own alternate-provider logic.
		h.logger().Warn("model-router: no key for head provider; using direct path",
			zap.String("provider", cand.Provider), zap.Error(keyErr))
		return "", used, 0, 0, false
	}

	req := &lanternv1.CompleteRequest{
		TenantId:   tenantID,
		Capability: capabilityForModel(cand.Provider, cand.Model),
		Messages:   protoMessagesFromAny(messages),
		// Per-call tenant credential. Invariant #10: secret — never logged.
		ProviderCredentials: map[string]string{cand.Provider: apiKey},
		// Invariant #8: carry the run-scoped idempotency key when present.
		IdempotencyKey: llmIdempotencyKey(ctx, cand.Provider, cand.Model, messages),
	}

	cctx, cancel := context.WithTimeout(ctx, modelRouterTimeout)
	defer cancel()

	resp, err := cl.Complete(cctx, req)
	if err != nil {
		h.logger().Warn("model-router Complete failed; falling back to direct path",
			zap.String("provider", cand.Provider),
			zap.String("model", cand.Model),
			zap.Error(err)) // status only — credentials are never in the error
		return "", used, 0, 0, false
	}
	out := ""
	if resp.GetMessage() != nil {
		out = resp.GetMessage().GetContent()
	}
	if strings.TrimSpace(out) == "" {
		h.logger().Warn("model-router returned empty body; falling back to direct path",
			zap.String("provider", cand.Provider), zap.String("model", cand.Model))
		return "", used, 0, 0, false
	}

	usedModel := resp.GetModelUsed()
	if usedModel == "" {
		usedModel = cand.Model
	}
	used = struct{ Provider, Model string }{cand.Provider, usedModel}
	h.logger().Info("completion served by model-router",
		zap.String("provider", cand.Provider),
		zap.String("model", usedModel),
		zap.Int64("tokens_in", resp.GetTokensIn()),
		zap.Int64("tokens_out", resp.GetTokensOut()))
	return out, used, resp.GetTokensIn(), resp.GetTokensOut(), true
}

// protoMessagesFromAny converts the control-plane's []map[string]any message
// shape into proto Messages for the router request. Only role + content are
// carried (the offloaded path is plain, no tools / parts).
func protoMessagesFromAny(messages []map[string]any) []*lanternv1.Message {
	out := make([]*lanternv1.Message, 0, len(messages))
	for _, m := range messages {
		role, _ := m["role"].(string)
		content, _ := m["content"].(string)
		out = append(out, &lanternv1.Message{Role: role, Content: content})
	}
	return out
}

// capabilityForModel maps the control-plane's resolved (provider, model) onto a
// router Capability so the router routes within the same tenant-configured tier.
// Mirrors the catalog in resolveModel: opus → reasoning-frontier, sonnet →
// reasoning-large, haiku → reasoning-small, gpt-4o → chat-large, mini →
// chat-small. Unknown models fall back to AUTO (router picks).
func capabilityForModel(provider, model string) lanternv1.Capability {
	m := strings.ToLower(model)
	switch provider {
	case "anthropic":
		switch {
		case strings.Contains(m, "opus"):
			return lanternv1.Capability_CAPABILITY_REASONING_FRONTIER
		case strings.Contains(m, "haiku"):
			return lanternv1.Capability_CAPABILITY_REASONING_SMALL
		case strings.Contains(m, "sonnet"):
			return lanternv1.Capability_CAPABILITY_REASONING_LARGE
		}
	case "openai":
		switch {
		case strings.Contains(m, "mini"):
			return lanternv1.Capability_CAPABILITY_CHAT_SMALL
		case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4"):
			return lanternv1.Capability_CAPABILITY_CHAT_LARGE
		}
	}
	return lanternv1.Capability_CAPABILITY_AUTO
}
