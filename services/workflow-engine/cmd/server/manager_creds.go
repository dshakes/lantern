package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"

	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// managerTransportCreds resolves the transport credentials for dialing the
// runtime-manager, which forces mTLS in prod (it verifies client certs
// against its CA):
//
//   - LANTERN_RUNTIME_MANAGER_TLS_CA set → TLS, verifying the manager against
//     that CA; LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY (both or neither) add the
//     client certificate.
//   - unset in dev → insecure (plaintext), so `make dev` works.
//   - unset in prod, client cert missing in prod, half-set cert/key, or an
//     unreadable file → error; main treats it as fatal at startup.
//
// ponytail: same logic lives in runtime-scheduler/internal/dialer and the
// control-plane handlers — three Go modules, no shared package to host it.
func managerTransportCreds(isProd bool) (credentials.TransportCredentials, error) {
	caPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_CA"))
	certPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_CERT"))
	keyPath := strings.TrimSpace(os.Getenv("LANTERN_RUNTIME_MANAGER_TLS_KEY"))
	if (certPath == "") != (keyPath == "") {
		return nil, fmt.Errorf("runtime-manager client TLS is half-configured: set BOTH LANTERN_RUNTIME_MANAGER_TLS_CERT and LANTERN_RUNTIME_MANAGER_TLS_KEY (or neither)")
	}
	if caPath == "" {
		if isProd {
			return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CA is unset — the runtime-manager requires mTLS in production; set LANTERN_RUNTIME_MANAGER_TLS_CA plus LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY (client cert signed by the manager CA)")
		}
		return insecure.NewCredentials(), nil
	}
	if isProd && certPath == "" {
		return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CERT/KEY are unset — the runtime-manager verifies client certificates in production; set both")
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("read LANTERN_RUNTIME_MANAGER_TLS_CA %s: %w", caPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("LANTERN_RUNTIME_MANAGER_TLS_CA %s contains no PEM certificates", caPath)
	}
	cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if certPath != "" {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load runtime-manager client cert/key (%s, %s): %w", certPath, keyPath, err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return credentials.NewTLS(cfg), nil
}
