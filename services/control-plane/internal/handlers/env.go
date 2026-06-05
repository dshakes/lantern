package handlers

import (
	"os"
	"strings"
)

// IsProd reports whether the server is running in a production-like environment.
// Dev is the default (unset) so the out-of-box `make dev` / `lantern dev`
// experience works without any configuration; operators opt into prod behaviour
// by setting LANTERN_ENV to "prod", "production", or "staging".
//
// Exported so cmd/server/main.go can use it for startup guards without
// creating a circular dependency.
func IsProd() bool {
	e := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_ENV")))
	return e == "prod" || e == "production" || e == "staging"
}

// isProd is the package-internal alias used by handlers that live in this
// package (receipts, auth, cors, etc.) — keeps call sites concise.
func isProd() bool { return IsProd() }

// devReceiptSecret is the single shared default used by both receipts.go and
// marketplace_invoke.go when LANTERN_RECEIPT_SECRET is unset in dev. A single
// constant prevents the two callers from drifting to different fallback strings
// (which would cause signature mismatches between issue and verify).
const devReceiptSecret = "lantern-dev-receipt-secret-do-not-use-in-production"

// devJWTSecret is the well-known dev-only JWT signing key. It is exported only
// so main.go can compare against it at startup.
const devJWTSecret = "lantern-dev-jwt-secret-do-not-use-in-production"

// corsAllowedOrigins returns the set of origins that are allowed on
// authenticated API routes. The caller should reflect the request origin back
// only when it appears in this set.
//
// Public endpoints (receipt verify, /.well-known/*, /proof) keep "Access-Control-Allow-Origin: *"
// and are NOT filtered through this function.
//
// Default dev value: http://localhost:3001 (Next.js dashboard dev server).
// Override in any environment via LANTERN_CORS_ORIGINS (comma-separated list).
func corsAllowedOrigins() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv("LANTERN_CORS_ORIGINS"))
	if raw == "" {
		raw = "http://localhost:3001"
	}
	result := make(map[string]struct{})
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			result[o] = struct{}{}
		}
	}
	return result
}
