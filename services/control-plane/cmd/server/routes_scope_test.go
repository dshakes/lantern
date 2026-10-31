package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// scopeExempt lists the mutating routes that legitimately carry no WithScope,
// each with the reason. WithScope authenticates a PAL JWT/API key, so a
// route authenticated some other way cannot use it. Adding a route here is
// fine — writing down why is the point (ADR 0027 §8).
var scopeExempt = map[string]string{
	// Pre-auth: these routes create or exchange the credential.
	"POST /auth/signup":         "pre-auth",
	"POST /auth/login":          "pre-auth",
	"POST /auth/oauth/exchange": "pre-auth (one-time code)",
	"POST /auth/verify":         "pre-auth (emailed single-use token)",
	"POST /auth/verify/resend":  "pre-auth",
	"POST /auth/forgot":         "pre-auth",
	"POST /auth/reset":          "pre-auth (emailed single-use token)",

	// Provider-signed webhooks.
	"POST /v1/sms/twilio/webhook":            "Twilio signature",
	"POST /v1/billing/webhook":               "Stripe signature",
	"POST /v1/messaging/twilio/inbound":      "Twilio signature",
	"POST /v1/voice/twilio/webhook":          "Twilio signature",
	"POST /v1/voice/twilio/turn":             "Twilio signature",
	"POST /v1/voice/errand/turn/{id}":        "Twilio signature",
	"POST /v1/voice/calls/status/{provider}": "provider signature",
	"POST /v1/voice/webhook/{provider}":      "provider signature",
	"POST /v1/surfaces/slack/command":        "Slack signing secret",
	"POST /v1/hooks/{id}":                    "per-trigger HMAC signature (ADR 0028)",

	// Shared-token / service-to-service.
	"POST /v1/surfaces/whatsapp/heartbeat": "bridge shared token",
	"POST /v1/signals":                     "bridge token / JWT scope checked in-handler, or legacy PAL_SIGNAL_TOKEN (ADR 0047)",
	"POST /v1/bridges/pair":                "pre-auth: one-time pairing code is the credential, rate-limited (ADR 0047)",
	"POST /v1/bridges/self/rotate":         "bridge token (ADR 0047)",
	"POST /v1/runtime/secrets/resolve":     "PAL_RUNTIME_SECRET_TOKEN",
	"POST /v1/runtime/report":              "PAL_RUNTIME_SECRET_TOKEN",
	"POST /internal/auth/introspect-key":   "PAL_GRPC_SERVICE_TOKEN",
	"POST /internal/dl/stage":              "PAL_GRPC_SERVICE_TOKEN",

	// Public by design.
	"POST /v1/runs/receipts/verify": "public receipt verification",
	"POST /v1/kiosk/session":        "anonymous by design; registered only when PAL_KIOSK=1 (ADR 0029)",

	// Runtime routes check runtime:* scopes inside the handler (requireRuntimeScope).
	"POST /v1/runtime/schedule":              "in-handler runtime:write",
	"DELETE /v1/runtime/vms/{id}":            "in-handler runtime:write",
	"POST /v1/runtime/vms/{id}/exec":         "in-handler runtime:admin",
	"POST /v1/runtime/vms/{id}/pause":        "in-handler runtime scope",
	"POST /v1/runtime/vms/{id}/resume":       "in-handler runtime scope",
	"POST /v1/runtime/vms/{id}/fork":         "in-handler runtime scope",
	"PUT /v1/runtime/vms/{id}/files/content": "in-handler runtime:admin",
	"PUT /v1/runtime/quota":                  "in-handler owner check",
}

// getExempt lists the GET routes that legitimately carry no WithScope, each
// with the reason (ADR 0042). Public endpoints and special-auth endpoints are
// exempt; every other GET must be scope-annotated.
var getExempt = map[string]string{
	// Auth flow — these ARE the authentication endpoints.
	"GET /auth/me":                        "auth endpoint (returns current user, internal JWT validation)",
	"GET /auth/oauth/{provider}/start":    "OAuth flow start (no credential yet)",
	"GET /auth/providers":                 "pre-auth: sign-in page lists enabled login providers (no credential yet)",
	"GET /auth/oauth/{provider}/callback": "OAuth callback (no credential yet)",
	"GET /v1/connectors/oauth/callback":   "OAuth callback (connector flow, no scope needed)",

	// Shared-token endpoints.
	"GET /v1/signals": "bridge token / JWT scope checked in-handler, or legacy PAL_SIGNAL_TOKEN (ADR 0047)",

	// Public/unauthenticated by design.
	"GET /v1/agents/{name}/card":          "A2A card: public for is_public agents; internal auth for own agents",
	"GET /.well-known/agent.json":         "public A2A directory (is_public agents only)",
	"GET /v1/marketplace":                 "public marketplace listing (no tenant data)",
	"GET /v1/marketplace/{slug}":          "public marketplace entry (no tenant data)",
	"GET /v1/mcp/servers":                 "public MCP server catalog (no tenant data)",
	"GET /v1/mcp/servers/{slug}":          "public MCP server entry (no tenant data)",
	"GET /.well-known/pal-receipts":       "public signing key / algorithm disclosure",
	"GET /.well-known/pal-agent-identity": "public agent identity key fingerprint",

	// Runtime routes check runtime:* scopes inside the handler (requireRuntimeScope).
	"GET /v1/runtime/vms":                    "in-handler runtime:read",
	"GET /v1/runtime/vms/{id}":               "in-handler runtime:read",
	"GET /v1/runtime/vms/{id}/logs":          "in-handler runtime:read",
	"GET /v1/runtime/vms/{id}/files":         "in-handler runtime:read",
	"GET /v1/runtime/vms/{id}/files/content": "in-handler runtime:read",
	"GET /v1/runtime/cluster":                "in-handler runtime:read",
	"GET /v1/runtime/quota":                  "in-handler runtime:read",
	"GET /v1/runtime/audit":                  "in-handler runtime:read",
	"GET /v1/runtime/metrics":                "in-handler runtime:read",

	// SSE endpoints: browser EventSource cannot set custom headers so these
	// handlers accept both Authorization header AND ?token= query param.
	// WithScope calls validateRequest (header-only) and would reject all
	// EventSource connections. Auth + tenant scoping is enforced in-handler.
	"GET /v1/runs/{id}/events":     "in-handler SSE auth: supports ?token= for browser EventSource",
	"GET /v1/sessions/{id}/events": "in-handler SSE auth: supports ?token= for browser EventSource",

	// Capability-URL download: auth is the signed token in the path.
	"GET /dl/{token}": "capability token in URL (not JWT/API key scope)",

	// Public verification key for agent tokens (ADR 0055): a JWKS, like
	// /.well-known/pal-receipts — public by design, only the active key.
	"GET /.well-known/pal-agent-keys/{agentId}": "public JWKS for agent-token verification (ADR 0055)",
}

var routeRE = regexp.MustCompile(`HandleFunc\("((?:POST|PUT|PATCH|DELETE) [^"]+)",\s*(.*)$`)
var getRouteRE = regexp.MustCompile(`HandleFunc\("(GET [^"]+)",\s*(.*)$`)

// WithScopeOrAgent (ADR 0055) is WithScope for user callers; agent callers
// are authorized by their policy inside the handler.
var withScopeRE = regexp.MustCompile(`\bWithScope(OrAgent)?\(`)

// TestEveryMutatingRouteHasScope fails when a POST/PUT/PATCH/DELETE route is
// registered without WithScope and isn't on the exemption list — so flipping
// PAL_AUTHZ_ENFORCE can never leave a mutator unguarded (ADR 0042).
func TestEveryMutatingRouteHasScope(t *testing.T) {
	files := []string{"main.go"}
	more, err := filepath.Glob("../../internal/handlers/*.go")
	if err != nil {
		t.Fatal(err)
	}
	files = append(files, more...)

	seen := map[string]bool{}
	for _, f := range files {
		if matched, _ := filepath.Match("*_test.go", filepath.Base(f)); matched {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range regexp.MustCompile(`(?m)^.*$`).FindAllString(string(src), -1) {
			sub := routeRE.FindStringSubmatch(m)
			if sub == nil {
				continue
			}
			route, rest := sub[1], sub[2]
			seen[route] = true
			if withScopeRE.MatchString(rest) {
				continue
			}
			if _, ok := scopeExempt[route]; !ok {
				t.Errorf("%s: mutating route %q has no WithScope and no exemption reason", f, route)
			}
		}
	}
	if len(seen) < 50 {
		t.Fatalf("parsed only %d mutating routes — the route regexp is broken", len(seen))
	}
	// Stale exemptions hide future regressions; keep the list exact.
	for route := range scopeExempt {
		if !seen[route] {
			t.Errorf("exemption for %q matches no registered route — remove it", route)
		}
	}
}

// TestEveryGetRouteHasScope fails when a GET route is registered without
// WithScope and isn't on the exemption list — extending ADR 0042's coverage to
// read endpoints so an API key cannot read tenant data without the right scope.
func TestEveryGetRouteHasScope(t *testing.T) {
	files := []string{"main.go"}
	more, err := filepath.Glob("../../internal/handlers/*.go")
	if err != nil {
		t.Fatal(err)
	}
	files = append(files, more...)

	seen := map[string]bool{}
	for _, f := range files {
		if matched, _ := filepath.Match("*_test.go", filepath.Base(f)); matched {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range regexp.MustCompile(`(?m)^.*$`).FindAllString(string(src), -1) {
			sub := getRouteRE.FindStringSubmatch(m)
			if sub == nil {
				continue
			}
			route, rest := sub[1], sub[2]
			seen[route] = true
			if withScopeRE.MatchString(rest) {
				continue
			}
			if _, ok := getExempt[route]; !ok {
				t.Errorf("%s: GET route %q has no WithScope and no exemption reason", f, route)
			}
		}
	}
	if len(seen) < 30 {
		t.Fatalf("parsed only %d GET routes — the route regexp is broken", len(seen))
	}
	// Stale exemptions hide future regressions; keep the list exact.
	for route := range getExempt {
		if !seen[route] {
			t.Errorf("GET exemption for %q matches no registered route — remove it", route)
		}
	}
}
