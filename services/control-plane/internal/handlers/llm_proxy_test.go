package handlers

// Unit tests for the LLM router.
//
// These cover the *pure* parts of llm_proxy.go — capability → (provider, model)
// resolution and cost estimation. The provider-availability lookup (against
// the llm_provider_configs table) needs a real Postgres and is exercised in
// the integration-test suite instead.
//
// The key invariant we want to pin down is: `resolveAutoModel` MUST only
// return a provider the caller said was available. Otherwise `Complete`
// ends up asking for an Anthropic key when only OpenAI is configured
// and the user sees a confusing 400.

import (
	"os"
	"testing"
)

// ---------------------------------------------------------------------------
// resolveAutoModel — availability gating
// ---------------------------------------------------------------------------

func TestResolveAutoModel_PrefersAvailableProvider(t *testing.T) {
	// Use balanced (the default) so we hit the real scoring path.
	t.Setenv("LANTERN_ROUTE_STRATEGY", "balanced")

	tests := []struct {
		name              string
		hasAnthropic      bool
		hasOpenAI         bool
		wantProviderAmong []string
	}{
		{"only-anthropic", true, false, []string{"anthropic"}},
		{"only-openai", false, true, []string{"openai"}},
		{"both", true, true, []string{"anthropic", "openai"}},
		// When neither is available, we fall back to OpenAI as a safe
		// default — the caller will try to resolve a key and fail,
		// producing a clear "no provider configured" error to the user.
		{"neither", false, false, []string{"openai"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			prov, model := resolveAutoModel(tc.hasAnthropic, tc.hasOpenAI)
			if model == "" {
				t.Fatalf("expected non-empty model, got empty")
			}
			match := false
			for _, p := range tc.wantProviderAmong {
				if prov == p {
					match = true
					break
				}
			}
			if !match {
				t.Errorf("provider=%q not in %v (model=%q)", prov, tc.wantProviderAmong, model)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// resolveAutoModel — strategy behaviours
// ---------------------------------------------------------------------------

func TestResolveAutoModel_StrategyQuality(t *testing.T) {
	t.Setenv("LANTERN_ROUTE_STRATEGY", "quality")
	// When quality is the axis and both providers are available, we expect
	// Claude Opus (quality 10) to win.
	prov, model := resolveAutoModel(true, true)
	if prov != "anthropic" || model != "claude-opus-4-8" {
		t.Errorf("quality strategy should pick Opus, got %s/%s", prov, model)
	}
}

func TestResolveAutoModel_StrategyCheap(t *testing.T) {
	t.Setenv("LANTERN_ROUTE_STRATEGY", "cheap")
	// Cheapest option in catalog: gpt-4o-mini ($0.15/$0.60).
	prov, model := resolveAutoModel(true, true)
	if prov != "openai" || model != "gpt-4o-mini" {
		t.Errorf("cheap strategy should pick gpt-4o-mini, got %s/%s", prov, model)
	}
}

func TestResolveAutoModel_StrategyFast(t *testing.T) {
	t.Setenv("LANTERN_ROUTE_STRATEGY", "fast")
	// Fastest: haiku (10) and gpt-4o-mini (10) tie. Either is acceptable.
	prov, model := resolveAutoModel(true, true)
	if !(model == "claude-haiku-4-5-20251001" || model == "gpt-4o-mini") {
		t.Errorf("fast strategy should pick haiku or gpt-4o-mini, got %s/%s", prov, model)
	}
}

func TestResolveAutoModel_StrategyBalancedDefault(t *testing.T) {
	// Unset strategy → defaults to "balanced".
	t.Setenv("LANTERN_ROUTE_STRATEGY", "")
	prov, model := resolveAutoModel(true, true)
	if prov == "" || model == "" {
		t.Fatalf("balanced default must still pick a model, got %s/%s", prov, model)
	}
}

func TestResolveAutoModel_NeverReturnsUnavailable(t *testing.T) {
	// Regression test: the original bug was that auto-routing returned a
	// provider the tenant had no key for. Sweep every strategy and verify
	// we never pick a provider the caller flagged unavailable.
	for _, strategy := range []string{"balanced", "quality", "cheap", "fast", ""} {
		t.Run("strategy="+strategy, func(t *testing.T) {
			t.Setenv("LANTERN_ROUTE_STRATEGY", strategy)

			// Only Anthropic available.
			if prov, _ := resolveAutoModel(true, false); prov != "anthropic" {
				t.Errorf("(ant only, %s) picked %s — must be anthropic", strategy, prov)
			}
			// Only OpenAI available.
			if prov, _ := resolveAutoModel(false, true); prov != "openai" {
				t.Errorf("(oai only, %s) picked %s — must be openai", strategy, prov)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// resolveModel — capability → (provider, model)
// ---------------------------------------------------------------------------

func TestResolveModel_KnownCapabilities(t *testing.T) {
	// Ensure env doesn't leak into "auto" (resolveModel delegates to
	// resolveAutoModel using env flags).
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "x")

	cases := []struct {
		cap      string
		provider string
		model    string
	}{
		{"chat-large", "openai", "gpt-4o"},
		{"chat-small", "openai", "gpt-4o-mini"},
		{"reasoning-frontier", "anthropic", "claude-opus-4-8"},
		{"reasoning-large", "anthropic", "claude-sonnet-4-6"},
		{"reasoning-small", "anthropic", "claude-haiku-4-5-20251001"},
		{"code-large", "anthropic", "claude-sonnet-4-6"},
		{"vision-large", "openai", "gpt-4o"},
	}
	for _, tc := range cases {
		t.Run(tc.cap, func(t *testing.T) {
			p, m := resolveModel(tc.cap)
			if p != tc.provider || m != tc.model {
				t.Errorf("resolveModel(%q) = (%s, %s), want (%s, %s)", tc.cap, p, m, tc.provider, tc.model)
			}
		})
	}
}

func TestResolveModel_PassthroughClaude(t *testing.T) {
	p, m := resolveModel("claude-sonnet-4-20250514")
	if p != "anthropic" || m != "claude-sonnet-4-20250514" {
		t.Errorf("claude passthrough: got (%s, %s)", p, m)
	}
}

func TestResolveModel_PassthroughGPT(t *testing.T) {
	p, m := resolveModel("gpt-4o")
	if p != "openai" || m != "gpt-4o" {
		t.Errorf("gpt passthrough: got (%s, %s)", p, m)
	}
}

func TestResolveModel_UnknownFallsBack(t *testing.T) {
	p, m := resolveModel("who-knows")
	if p != "openai" || m != "gpt-4o" {
		t.Errorf("unknown capability fallback: got (%s, %s), want (openai, gpt-4o)", p, m)
	}
}

func TestResolveModel_AutoUsesEnv(t *testing.T) {
	// Only env-driven path for "auto" should honour env vars. Clear first.
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "x")
	t.Setenv("LANTERN_ROUTE_STRATEGY", "balanced")

	p, _ := resolveModel("auto")
	if p != "openai" {
		t.Errorf("auto with only OpenAI env should pick openai, got %s", p)
	}

	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "y")

	p, _ = resolveModel("auto")
	if p != "anthropic" {
		t.Errorf("auto with only Anthropic env should pick anthropic, got %s", p)
	}
}

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

func TestEstimateCost(t *testing.T) {
	cases := []struct {
		provider   string
		model      string
		tokensIn   int
		tokensOut  int
		wantApprox float64 // $ cost; tested with a 1e-6 tolerance
	}{
		// gpt-4o @ $2.50 in / $10 out per 1M:  1M in = $2.50
		{"openai", "gpt-4o", 1_000_000, 0, 2.50},
		// gpt-4o-mini @ $0.15 in / $0.60 out
		{"openai", "gpt-4o-mini", 0, 1_000_000, 0.60},
		// Sonnet: 1k in @ $3/1M = $0.003
		{"anthropic", "claude-sonnet-4-20250514", 1_000, 0, 0.003},
		// Opus: 1k out @ $75/1M = $0.075
		{"anthropic", "claude-opus-4-20250514", 0, 1_000, 0.075},
		// Haiku: 10k in @ $0.25/1M = $0.0025
		{"anthropic", "claude-haiku-4-20250414", 10_000, 0, 0.0025},
	}
	for _, tc := range cases {
		t.Run(tc.model, func(t *testing.T) {
			got := estimateCost(tc.provider, tc.model, tc.tokensIn, tc.tokensOut)
			if abs(got-tc.wantApprox) > 1e-6 {
				t.Errorf("estimateCost(%s, %s, %d, %d) = %v, want %v",
					tc.provider, tc.model, tc.tokensIn, tc.tokensOut, got, tc.wantApprox)
			}
		})
	}
}

func TestEstimateCost_UnknownModelFallsBack(t *testing.T) {
	// Unknown models use the $5/$15 default. 100k tokens in = $0.50.
	got := estimateCost("openai", "some-future-model", 100_000, 0)
	if abs(got-0.50) > 1e-6 {
		t.Errorf("unknown fallback: got %v, want 0.50", got)
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

// ---------------------------------------------------------------------------
// modelCatalog sanity
// ---------------------------------------------------------------------------

func TestModelCatalog_NonEmpty(t *testing.T) {
	// Catch a regression where somebody empties the catalog or forgets to
	// include at least one of each provider.
	var anthro, oai int
	for _, m := range modelCatalog {
		switch m.provider {
		case "anthropic":
			anthro++
		case "openai":
			oai++
		default:
			t.Errorf("unexpected provider in catalog: %s", m.provider)
		}
	}
	if anthro == 0 || oai == 0 {
		t.Errorf("catalog missing provider: anthropic=%d openai=%d", anthro, oai)
	}
}

// ---------------------------------------------------------------------------
// Boundary: env var only matters for plain resolveModel("auto") — NOT for
// resolveAutoModel which takes explicit booleans.
// ---------------------------------------------------------------------------

func TestResolveAutoModel_IgnoresEnv(t *testing.T) {
	// Even with env vars set, resolveAutoModel respects only the args.
	os.Setenv("OPENAI_API_KEY", "env-only")
	defer os.Unsetenv("OPENAI_API_KEY")

	// Anthropic-only (from caller's perspective), despite OPENAI_API_KEY set.
	prov, _ := resolveAutoModel(true, false)
	if prov != "anthropic" {
		t.Errorf("resolveAutoModel must honour args, not env: got %s", prov)
	}
}
