package main

import (
	"crypto/tls"

	"github.com/dshakes/lantern/packages/grpctls"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// managerTransportCreds resolves the transport credentials for dialing the
// runtime-manager (PAL_RUNTIME_MANAGER_TLS_CA/_CERT/_KEY), which forces mTLS
// in prod. Policy lives in packages/grpctls; unset in prod is an error that
// main treats as fatal (no PAL_GRPC_INSECURE escape for the manager).
func managerTransportCreds(isProd bool) (credentials.TransportCredentials, error) {
	cfg, err := grpctls.ClientConfig(grpctls.FromEnv(grpctls.ManagerPrefix), isProd, false)
	return creds(cfg), err
}

// serviceClientCreds is the service-mesh identity (PAL_GRPC_TLS_*) used to
// dial the model-router (ADR 0043).
func serviceClientCreds(isProd bool) (credentials.TransportCredentials, error) {
	cfg, err := grpctls.ClientConfig(grpctls.FromEnv(grpctls.ServicePrefix), isProd, grpctls.InsecureOverride())
	return creds(cfg), err
}

// serviceServerCreds serves :50052 with mTLS (client cert required, peer
// SPIFFE ID checked against PAL_GRPC_TLS_ALLOWED_PEERS). (nil, nil) means
// plaintext: dev, or prod with PAL_GRPC_INSECURE=1.
func serviceServerCreds(isProd bool) (credentials.TransportCredentials, error) {
	cfg, err := grpctls.ServerConfig(grpctls.FromEnv(grpctls.ServicePrefix), isProd,
		grpctls.InsecureOverride(), grpctls.AllowedPeersFromEnv(), false)
	if err != nil || cfg == nil {
		return nil, err
	}
	return credentials.NewTLS(cfg), nil
}

func creds(cfg *tls.Config) credentials.TransportCredentials {
	if cfg == nil {
		return insecure.NewCredentials()
	}
	return credentials.NewTLS(cfg)
}
