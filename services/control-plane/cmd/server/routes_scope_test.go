package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// scopeExempt lists the mutating routes that legitimately carry no WithScope,
// each with the reason. WithScope authenticates a Lantern JWT/API key, so a
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
	"POST /v1/signals":                     "LANTERN_SIGNAL_TOKEN",
	"POST /v1/runtime/secrets/resolve":     "LANTERN_RUNTIME_SECRET_TOKEN",
	"POST /v1/runtime/report":              "LANTERN_RUNTIME_SECRET_TOKEN",
	"POST /internal/auth/introspect-key":   "LANTERN_GRPC_SERVICE_TOKEN",
	"POST /internal/dl/stage":              "LANTERN_GRPC_SERVICE_TOKEN",

	// Public by design.
	"POST /v1/runs/receipts/verify": "public receipt verification",
	"POST /v1/kiosk/session":        "anonymous by design; registered only when LANTERN_KIOSK=1 (ADR 0029)",

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

var routeRE = regexp.MustCompile(`HandleFunc\("((?:POST|PUT|PATCH|DELETE) [^"]+)",\s*(.*)$`)

// TestEveryMutatingRouteHasScope fails when a POST/PUT/PATCH/DELETE route is
// registered without WithScope and isn't on the exemption list — so flipping
// LANTERN_AUTHZ_ENFORCE=1 can never leave a mutator unguarded.
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
			if regexp.MustCompile(`\bWithScope\(`).MatchString(rest) {
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
