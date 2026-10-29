package handlers

import (
	"crypto/tls"
	"fmt"
	"os"
	"strings"

	"google.golang.org/grpc/credentials"
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

// authzEnforce reports whether LANTERN_AUTHZ_ENFORCE is active.
//
// Secure-default rule (ADR 0042):
//   - Production (LANTERN_ENV=prod/production/staging): ON by default.
//     Set LANTERN_AUTHZ_ENFORCE=0 to override with a startup WARN.
//   - Dev (LANTERN_ENV unset): OFF by default; set =1/true/on to enable.
//
// This means an operator who forgets to set the flag still gets enforcement
// in prod, while dev stays friction-free.
func authzEnforce() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_AUTHZ_ENFORCE")))
	// Explicit opt-out always wins.
	if v == "0" || v == "false" || v == "off" {
		return false
	}
	// Explicit opt-in.
	if v == "1" || v == "true" || v == "on" {
		return true
	}
	// Unset: secure default ON in prod, OFF in dev.
	return IsProd()
}

// AuthzEnforcing is the exported form of authzEnforce, for the startup log.
func AuthzEnforcing() bool { return authzEnforce() }

// AuthzGuardDecision evaluates whether the authz enforcement env var is
// safely configured for the current environment.
//
// Returns (warnMsg string). An empty string means no warning needed.
// When LANTERN_AUTHZ_ENFORCE=0 in prod, returns a loud WARN message.
// (There is no fatal case — enforcement being off is operationally bad but
// not a crash-worthy startup condition; it is instead surfaced as a WARN so
// an alert can key on it. contrast with LANTERN_RLS_ENFORCE which IS fatal
// in prod when the app DB password is also missing.)
func AuthzGuardDecision(isProdEnv bool, authzEnforceVal string) string {
	if !isProdEnv {
		return ""
	}
	v := strings.ToLower(strings.TrimSpace(authzEnforceVal))
	if v == "0" || v == "false" || v == "off" {
		return "LANTERN_AUTHZ_ENFORCE=0 in production — API-key scope enforcement is OFF; " +
			"a key missing the endpoint's required scope will be allowed through; " +
			"set LANTERN_AUTHZ_ENFORCE=1 (or remove the var) to re-enable the secure default"
	}
	return ""
}

// devReceiptSecret is the single shared default used by both receipts.go and
// marketplace_invoke.go when LANTERN_RECEIPT_SECRET is unset in dev. A single
// constant prevents the two callers from drifting to different fallback strings
// (which would cause signature mismatches between issue and verify).
const devReceiptSecret = "lantern-dev-receipt-secret-do-not-use-in-production"

// devJWTSecret is the well-known dev-only JWT signing key. It is exported only
// so main.go can compare against it at startup.
const devJWTSecret = "lantern-dev-jwt-secret-do-not-use-in-production"

// GRPCServerTLS resolves the server-side TLS credentials for the gRPC server
// from LANTERN_CONTROL_PLANE_TLS_CERT / LANTERN_CONTROL_PLANE_TLS_KEY (PEM file
// paths). The audit-H2 boundary is the gateway→control-plane channel: in
// production we require TLS so that hop is encrypted + authenticated.
//
// Return contract mirrors the env.go/main.go fail-closed pattern so main.go can
// decide Fatal vs WARN without re-reading env:
//
//   - creds != nil, err == nil      → TLS configured; serve with these creds.
//   - creds == nil, err == nil      → TLS not configured (both env vars unset).
//     In prod this is fatal (caller decides); in dev it means plaintext.
//   - creds == nil, err != nil      → TLS misconfigured (one var set, or the
//     cert/key pair failed to load). Always fatal regardless of environment —
//     a half-configured or broken cert is never the intended state.
func GRPCServerTLS() (credentials.TransportCredentials, error) {
	certPath := strings.TrimSpace(os.Getenv("LANTERN_CONTROL_PLANE_TLS_CERT"))
	keyPath := strings.TrimSpace(os.Getenv("LANTERN_CONTROL_PLANE_TLS_KEY"))

	if certPath == "" && keyPath == "" {
		// Not configured. Caller (main.go) applies prod-vs-dev policy.
		return nil, nil
	}
	if certPath == "" || keyPath == "" {
		return nil, fmt.Errorf("control-plane TLS is half-configured: set BOTH LANTERN_CONTROL_PLANE_TLS_CERT and LANTERN_CONTROL_PLANE_TLS_KEY (or neither)")
	}

	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("loading control-plane TLS cert/key (%s, %s): %w", certPath, keyPath, err)
	}

	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}), nil
}

// CheckSchedulerAddr evaluates whether LANTERN_SCHEDULER_GRPC_ADDR is
// correctly configured for the current environment.
//
// It returns (fatal bool, message string). When fatal is true, the caller
// (main.go runStartupGuards) should call logger.Fatal with message. This
// keeps the function pure and testable without triggering os.Exit in tests.
//
// Rules:
//   - prod (LANTERN_ENV=prod/production/staging): FATAL when addr is empty.
//     A prod control-plane that silently falls back to the stub scheduler
//     fabricates fake VM IDs and never actually spawns workloads — that is a
//     silent data-corruption class bug, not a graceful degradation.
//   - dev (LANTERN_ENV unset): stub is fine; returns fatal=false.
func CheckSchedulerAddr(isProdEnv bool, addr string) (fatal bool, message string) {
	if isProdEnv && addr == "" {
		return true, "LANTERN_SCHEDULER_GRPC_ADDR is unset — production refuses to start with the stub scheduler (it fabricates VM IDs and spawns nothing); set LANTERN_SCHEDULER_GRPC_ADDR to the runtime-scheduler gRPC address"
	}
	return false, ""
}

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
