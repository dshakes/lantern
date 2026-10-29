// Package grpctls is the one place PAL's Go services build TLS configs for
// internal gRPC hops (ADR 0043). It is stdlib-only (plus palenv) so every
// service module can depend on it without a gRPC version coupling: callers
// wrap the returned *tls.Config with credentials.NewTLS.
//
// Two trust domains use it, each with its own PEM triplet:
//
//   - the SERVICE mesh — PAL_GRPC_TLS_CA / _CERT / _KEY. One identity per
//     process, used both to serve (server cert) and to dial (client cert).
//     Every service-mesh server requires and verifies client certs, and can
//     pin the peer's SPIFFE ID (PAL_GRPC_TLS_ALLOWED_PEERS).
//   - the runtime-manager — PAL_RUNTIME_MANAGER_TLS_CA / _CERT / _KEY, the
//     client side of the manager's own CA (which also signs per-VM certs, so
//     it is deliberately NOT the service CA).
//
// Policy, shared by every caller:
//
//   - configured → TLS 1.2+ with the CA pinned (no system roots).
//   - unset in dev → plaintext.
//   - unset in prod → error, unless PAL_GRPC_INSECURE=1 (service mesh only;
//     the manager forces mTLS itself, so its clients never get the escape).
//   - half-configured or unreadable → always an error.
package grpctls

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/dshakes/lantern/packages/palenv"
)

// Env suffixes, read as PAL_<suffix> with LANTERN_<suffix> fallback.
const (
	ServicePrefix = "GRPC_TLS"            // service-mesh identity
	ManagerPrefix = "RUNTIME_MANAGER_TLS" // client side of the runtime-manager CA

	envAllowedPeers = "GRPC_TLS_ALLOWED_PEERS"
	envInsecure     = "GRPC_INSECURE"
)

// VMCertOU marks a per-VM guest cert minted by the runtime-manager
// (runtime-manager/src/tls.rs VM_CERT_OU). A guest identity is never a
// service, whatever CA signed it.
const VMCertOU = "lantern-vm"

// Files names one PEM triplet. Prefix is the env suffix stem, used in errors.
type Files struct {
	Prefix        string
	CA, Cert, Key string
}

// FromEnv reads PAL_<prefix>_CA/_CERT/_KEY (LANTERN_ fallback).
func FromEnv(prefix string) Files {
	get := func(s string) string { return strings.TrimSpace(palenv.Get(prefix + "_" + s)) }
	return Files{Prefix: prefix, CA: get("CA"), Cert: get("CERT"), Key: get("KEY")}
}

// Empty reports whether nothing is configured.
func (f Files) Empty() bool { return f.CA == "" && f.Cert == "" && f.Key == "" }

func (f Files) name(s string) string { return "PAL_" + f.Prefix + "_" + s }

// IsProd reports a production-like PAL_ENV (prod/production/staging), the
// same rule every service applies. For callers with no env helper of their own.
func IsProd() bool {
	switch strings.ToLower(strings.TrimSpace(palenv.Get("ENV"))) {
	case "prod", "production", "staging":
		return true
	}
	return false
}

// InsecureOverride reports PAL_GRPC_INSECURE=1|true|on: the explicit, loud
// opt-out that lets a prod-like env run service-mesh gRPC in plaintext.
func InsecureOverride() bool {
	v := strings.ToLower(strings.TrimSpace(palenv.Get(envInsecure)))
	return v == "1" || v == "true" || v == "on"
}

// AllowedPeersFromEnv parses PAL_GRPC_TLS_ALLOWED_PEERS (comma-separated
// SPIFFE IDs, e.g. spiffe://pal.internal/svc/gateway). Empty → nil.
func AllowedPeersFromEnv() []string {
	var out []string
	for _, p := range strings.Split(palenv.Get(envAllowedPeers), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ErrPlaintext is returned (wrapped) when a prod-like env would run plaintext.
var ErrPlaintext = errors.New("plaintext gRPC refused in production")

// ServerConfig builds the mTLS server config for f, or (nil, nil) for
// plaintext when f is empty and plaintext is permitted (dev, or prod with
// allowInsecure). optionalClientCert serves callers without a cert (the
// control-plane's customer-VPC DataPlaneService tunnel) and leaves enforcing
// a cert per method to the caller; every presented cert is still verified
// against the CA and the peer allowlist at the handshake.
func ServerConfig(f Files, isProd, allowInsecure bool, allowedPeers []string, optionalClientCert bool) (*tls.Config, error) {
	if f.Empty() {
		if isProd && !allowInsecure {
			return nil, fmt.Errorf("%w: set %s/_CERT/_KEY (or %s=1 to accept plaintext explicitly)",
				ErrPlaintext, f.name("CA"), "PAL_"+envInsecure)
		}
		return nil, nil
	}
	if f.CA == "" || f.Cert == "" || f.Key == "" {
		return nil, fmt.Errorf("gRPC server TLS is half-configured: set all of %s, %s, %s (or none)",
			f.name("CA"), f.name("CERT"), f.name("KEY"))
	}
	pool, err := loadPool(f)
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(f.Cert, f.Key)
	if err != nil {
		return nil, fmt.Errorf("load %s/%s (%s, %s): %w", f.name("CERT"), f.name("KEY"), f.Cert, f.Key, err)
	}
	auth := tls.RequireAndVerifyClientCert
	if optionalClientCert {
		auth = tls.VerifyClientCertIfGiven
	}
	peers := append([]string(nil), allowedPeers...)
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		ClientAuth:   auth,
		// Runs after chain verification; no cert only reaches here in optional mode.
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return nil
			}
			return CheckPeer(cs.PeerCertificates[0], peers)
		},
	}, nil
}

// ClientConfig builds the client config for f, or (nil, nil) for plaintext
// when f is empty and that is permitted. In prod a client cert is mandatory
// (every server it may reach verifies one).
func ClientConfig(f Files, isProd, allowInsecure bool) (*tls.Config, error) {
	if (f.Cert == "") != (f.Key == "") {
		return nil, fmt.Errorf("gRPC client TLS is half-configured: set BOTH %s and %s (or neither)", f.name("CERT"), f.name("KEY"))
	}
	if f.CA == "" {
		if f.Cert != "" {
			return nil, fmt.Errorf("%s is set without %s — refusing to dial without pinning the server CA", f.name("CERT"), f.name("CA"))
		}
		if isProd && !allowInsecure {
			return nil, fmt.Errorf("%w: %s is unset — set %s plus %s/%s (client cert signed by the same CA)",
				ErrPlaintext, f.name("CA"), f.name("CA"), f.name("CERT"), f.name("KEY"))
		}
		return nil, nil
	}
	if isProd && f.Cert == "" {
		return nil, fmt.Errorf("%s/%s are unset — the server verifies client certificates in production; set both", f.name("CERT"), f.name("KEY"))
	}
	pool, err := loadPool(f)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if f.Cert != "" {
		cert, err := tls.LoadX509KeyPair(f.Cert, f.Key)
		if err != nil {
			return nil, fmt.Errorf("load %s/%s (%s, %s): %w", f.name("CERT"), f.name("KEY"), f.Cert, f.Key, err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return cfg, nil
}

// CheckPeer authorizes a CA-verified peer leaf. A per-VM guest cert is always
// refused. With an allowlist the leaf must carry one of its URIs as a URI SAN
// (SPIFFE ID); without one any other CA-signed cert is accepted.
func CheckPeer(leaf *x509.Certificate, allowed []string) error {
	for _, ou := range leaf.Subject.OrganizationalUnit {
		if ou == VMCertOU {
			return errors.New("peer presented a VM guest certificate; services only")
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	for _, u := range leaf.URIs {
		for _, want := range allowed {
			if u.String() == want {
				return nil
			}
		}
	}
	got := make([]string, 0, len(leaf.URIs))
	for _, u := range leaf.URIs {
		got = append(got, u.String())
	}
	return fmt.Errorf("peer identity %v is not in the allowlist", got)
}

func loadPool(f Files) (*x509.CertPool, error) {
	pem, err := os.ReadFile(f.CA)
	if err != nil {
		return nil, fmt.Errorf("read %s %s: %w", f.name("CA"), f.CA, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%s %s contains no PEM certificates", f.name("CA"), f.CA)
	}
	return pool, nil
}
