package handlers

// tls_test.go covers GRPCServerTLS — the server-side TLS credential loader for
// the gateway→control-plane gRPC channel (audit H2). It verifies the three-way
// return contract (configured / unset / misconfigured) and the isProd gating
// that main.go applies on top of it.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeTestCert generates a self-signed cert/key pair and writes them as PEM
// files into dir, returning their paths. Mirrors what an operator would supply
// via LANTERN_CONTROL_PLANE_TLS_CERT / _KEY.
func writeTestCert(t *testing.T, dir string) (certPath, keyPath string) {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "lantern-control-plane-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}

	certPath = filepath.Join(dir, "tls.crt")
	keyPath = filepath.Join(dir, "tls.key")

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath
}

func TestGRPCServerTLS_UnsetReturnsNilNoError(t *testing.T) {
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_CERT", "")
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_KEY", "")

	creds, err := GRPCServerTLS()
	if err != nil {
		t.Fatalf("unset should not error, got %v", err)
	}
	if creds != nil {
		t.Fatalf("unset should return nil creds, got non-nil")
	}
}

func TestGRPCServerTLS_BuildsFromGeneratedCert(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeTestCert(t, dir)

	t.Setenv("LANTERN_CONTROL_PLANE_TLS_CERT", certPath)
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_KEY", keyPath)

	creds, err := GRPCServerTLS()
	if err != nil {
		t.Fatalf("valid cert/key should build creds, got %v", err)
	}
	if creds == nil {
		t.Fatalf("valid cert/key should return non-nil creds")
	}
	if info := creds.Info(); info.SecurityProtocol != "tls" {
		t.Fatalf("expected tls security protocol, got %q", info.SecurityProtocol)
	}
}

func TestGRPCServerTLS_HalfConfiguredErrors(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := writeTestCert(t, dir)

	cases := []struct {
		name string
		cert string
		key  string
	}{
		{"cert without key", certPath, ""},
		{"key without cert", "", keyPath},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("LANTERN_CONTROL_PLANE_TLS_CERT", tc.cert)
			t.Setenv("LANTERN_CONTROL_PLANE_TLS_KEY", tc.key)

			creds, err := GRPCServerTLS()
			if err == nil {
				t.Fatalf("half-configured TLS should error")
			}
			if creds != nil {
				t.Fatalf("half-configured TLS should return nil creds")
			}
		})
	}
}

func TestGRPCServerTLS_UnloadablePathErrors(t *testing.T) {
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_CERT", "/nonexistent/tls.crt")
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_KEY", "/nonexistent/tls.key")

	creds, err := GRPCServerTLS()
	if err == nil {
		t.Fatalf("missing cert files should error")
	}
	if creds != nil {
		t.Fatalf("missing cert files should return nil creds")
	}
}

// TestGRPCServerTLS_ProdGating documents the policy main.go layers on top of the
// loader: in prod an unset pair means the channel cannot be encrypted (main.go
// turns the nil-nil return into a Fatal); in dev the same nil-nil return is the
// plaintext fallback. The loader itself is environment-agnostic — the gating is
// the IsProd() branch this asserts.
func TestGRPCServerTLS_ProdGating(t *testing.T) {
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_CERT", "")
	t.Setenv("LANTERN_CONTROL_PLANE_TLS_KEY", "")

	t.Run("prod unset is fatal-worthy (creds nil)", func(t *testing.T) {
		t.Setenv("LANTERN_ENV", "prod")
		creds, err := GRPCServerTLS()
		if err != nil || creds != nil {
			t.Fatalf("unset returns nil,nil regardless of env; got creds=%v err=%v", creds, err)
		}
		if !IsProd() {
			t.Fatalf("LANTERN_ENV=prod should be prod")
		}
		// main.go: creds==nil && IsProd() → Fatal.
	})

	t.Run("dev unset is plaintext fallback", func(t *testing.T) {
		t.Setenv("LANTERN_ENV", "")
		creds, err := GRPCServerTLS()
		if err != nil || creds != nil {
			t.Fatalf("unset returns nil,nil; got creds=%v err=%v", creds, err)
		}
		if IsProd() {
			t.Fatalf("LANTERN_ENV unset should not be prod")
		}
		// main.go: creds==nil && !IsProd() → WARN + plaintext.
	})
}
