package handlers

import (
	"crypto/tls"
	"fmt"
	"os"
	"strings"

	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/dshakes/lantern/packages/grpctls"
	"github.com/dshakes/lantern/packages/palenv"
)

// IsProd reports whether the server is running in a production-like environment.
// Dev is the default (unset) so the out-of-box `make dev` / `lantern dev`
// experience works without any configuration; operators opt into prod behaviour
// by setting PAL_ENV to "prod", "production", or "staging".
//
// Exported so cmd/server/main.go can use it for startup guards without
// creating a circular dependency.
func IsProd() bool {
	e := strings.ToLower(strings.TrimSpace(os.Getenv("PAL_ENV")))
	return e == "prod" || e == "production" || e == "staging"
}

// isProd is the package-internal alias used by handlers that live in this
// package (receipts, auth, cors, etc.) — keeps call sites concise.
func isProd() bool { return IsProd() }

// authzEnforce reports whether PAL_AUTHZ_ENFORCE is active.
//
// Secure-default rule (ADR 0042):
//   - Production (PAL_ENV=prod/production/staging): ON by default.
//     Set PAL_AUTHZ_ENFORCE=0 to override with a startup WARN.
//   - Dev (PAL_ENV unset): OFF by default; set =1/true/on to enable.
//
// This means an operator who forgets to set the flag still gets enforcement
// in prod, while dev stays friction-free.
func authzEnforce() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("PAL_AUTHZ_ENFORCE")))
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
// When PAL_AUTHZ_ENFORCE=0 in prod, returns a loud WARN message.
// (There is no fatal case — enforcement being off is operationally bad but
// not a crash-worthy startup condition; it is instead surfaced as a WARN so
// an alert can key on it. contrast with PAL_RLS_ENFORCE which IS fatal
// in prod when the app DB password is also missing.)
func AuthzGuardDecision(isProdEnv bool, authzEnforceVal string) string {
	if !isProdEnv {
		return ""
	}
	v := strings.ToLower(strings.TrimSpace(authzEnforceVal))
	if v == "0" || v == "false" || v == "off" {
		return "PAL_AUTHZ_ENFORCE=0 in production — API-key scope enforcement is OFF; " +
			"a key missing the endpoint's required scope will be allowed through; " +
			"set PAL_AUTHZ_ENFORCE=1 (or remove the var) to re-enable the secure default"
	}
	return ""
}

// devReceiptSecret is the single shared default used by both receipts.go and
// marketplace_invoke.go when PAL_RECEIPT_SECRET is unset in dev. A single
// constant prevents the two callers from drifting to different fallback strings
// (which would cause signature mismatches between issue and verify).
const devReceiptSecret = "lantern-dev-receipt-secret-do-not-use-in-production"

// devJWTSecret is the well-known dev-only JWT signing key. It is exported only
// so main.go can compare against it at startup.
const devJWTSecret = "lantern-dev-jwt-secret-do-not-use-in-production"

// GRPCServerTLS resolves the server-side TLS credentials for the :50051 gRPC
// server (ADR 0043). In order of preference:
//
//   - PAL_GRPC_TLS_CA/_CERT/_KEY (service mesh) → mTLS, mtls=true. A client
//     cert is VERIFIED whenever presented (CA + PAL_GRPC_TLS_ALLOWED_PEERS),
//     but not demanded at the handshake: the customer-VPC DataPlaneService
//     tunnel shares this port and authenticates with its own bootstrap token
//   - JWT. RequireServiceCert interceptors demand the cert for every other
//     service, so main.go must install them when mtls is true.
//   - PAL_CONTROL_PLANE_TLS_CERT/_KEY (legacy, audit H2) → server-only TLS.
//   - neither → (nil, false, nil); main.go applies the prod-vs-dev policy.
//
// A half-configured or unloadable triplet is always an error.
func GRPCServerTLS() (creds credentials.TransportCredentials, mtls bool, err error) {
	if f := grpctls.FromEnv(grpctls.ServicePrefix); !f.Empty() {
		cfg, err := grpctls.ServerConfig(f, false, false, grpctls.AllowedPeersFromEnv(), true)
		if err != nil {
			return nil, false, err
		}
		return credentials.NewTLS(cfg), true, nil
	}

	certPath := strings.TrimSpace(palenv.Get("CONTROL_PLANE_TLS_CERT"))
	keyPath := strings.TrimSpace(palenv.Get("CONTROL_PLANE_TLS_KEY"))
	if certPath == "" && keyPath == "" {
		return nil, false, nil
	}
	if certPath == "" || keyPath == "" {
		return nil, false, fmt.Errorf("control-plane TLS is half-configured: set BOTH PAL_CONTROL_PLANE_TLS_CERT and PAL_CONTROL_PLANE_TLS_KEY (or neither)")
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, false, fmt.Errorf("loading control-plane TLS cert/key (%s, %s): %w", certPath, keyPath, err)
	}
	return credentials.NewTLS(&tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}), false, nil
}

// ServiceClientCreds is the service-mesh client identity (PAL_GRPC_TLS_*)
// the control-plane presents when dialing the model-router and the
// runtime-scheduler (ADR 0043). Plaintext in dev; in prod an error unless
// configured or PAL_GRPC_INSECURE=1.
func ServiceClientCreds(isProd bool) (credentials.TransportCredentials, error) {
	cfg, err := grpctls.ClientConfig(grpctls.FromEnv(grpctls.ServicePrefix), isProd, grpctls.InsecureOverride())
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return insecure.NewCredentials(), nil
	}
	return credentials.NewTLS(cfg), nil
}

// CheckSchedulerAddr evaluates whether PAL_SCHEDULER_GRPC_ADDR is
// correctly configured for the current environment.
//
// It returns (fatal bool, message string). When fatal is true, the caller
// (main.go runStartupGuards) should call logger.Fatal with message. This
// keeps the function pure and testable without triggering os.Exit in tests.
//
// Rules:
//   - prod (PAL_ENV=prod/production/staging): FATAL when addr is empty.
//     A prod control-plane that silently falls back to the stub scheduler
//     fabricates fake VM IDs and never actually spawns workloads — that is a
//     silent data-corruption class bug, not a graceful degradation.
//   - dev (PAL_ENV unset): stub is fine; returns fatal=false.
func CheckSchedulerAddr(isProdEnv bool, addr string) (fatal bool, message string) {
	if isProdEnv && addr == "" {
		return true, "PAL_SCHEDULER_GRPC_ADDR is unset — production refuses to start with the stub scheduler (it fabricates VM IDs and spawns nothing); set PAL_SCHEDULER_GRPC_ADDR to the runtime-scheduler gRPC address"
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
// Override in any environment via PAL_CORS_ORIGINS (comma-separated list).
func corsAllowedOrigins() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv("PAL_CORS_ORIGINS"))
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
