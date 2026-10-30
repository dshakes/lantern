package dialer

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// writeSelfSigned writes a self-signed cert + key PEM pair into dir.
func writeSelfSigned(t *testing.T, dir string) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath = filepath.Join(dir, "c.pem"), filepath.Join(dir, "k.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath
}

func TestManagerTransportCreds(t *testing.T) {
	dir := t.TempDir()
	cert, key := writeSelfSigned(t, dir)
	junk := filepath.Join(dir, "junk.pem")
	if err := os.WriteFile(junk, []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name         string
		prod         bool
		ca, crt, key string
		wantErr      bool
		wantProto    string
	}{
		{"dev unset → insecure", false, "", "", "", false, "insecure"},
		{"prod unset → error", true, "", "", "", true, ""},
		{"half cert/key → error", false, cert, cert, "", true, ""},
		{"prod CA without client cert → error", true, cert, "", "", true, ""},
		{"unparseable CA → error", false, junk, "", "", true, ""},
		{"missing CA file → error", false, filepath.Join(dir, "nope"), "", "", true, ""},
		{"dev CA only → tls", false, cert, "", "", false, "tls"},
		{"prod full mTLS → tls", true, cert, cert, key, false, "tls"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_CA", tc.ca)
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_CERT", tc.crt)
			t.Setenv("PAL_RUNTIME_MANAGER_TLS_KEY", tc.key)
			creds, err := ManagerTransportCreds(tc.prod)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if err == nil && creds.Info().SecurityProtocol != tc.wantProto {
				t.Errorf("protocol = %q, want %q", creds.Info().SecurityProtocol, tc.wantProto)
			}
		})
	}
}

// TestGRPCDialer_AttachesServiceToken proves every manager RPC carries
// x-pal-service-token (required by the manager when the token is set).
func TestGRPCDialer_AttachesServiceToken(t *testing.T) {
	got := make(chan string, 1)
	srv := grpc.NewServer(grpc.UnaryInterceptor(func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		got <- firstOrEmpty(md.Get("x-lantern-service-token"))
		return h(ctx, req)
	}))
	lanternv1.RegisterRuntimeManagerServer(srv, lanternv1.UnimplementedRuntimeManagerServer{})
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	for _, tc := range []struct{ token, want string }{{"s3cret", "s3cret"}, {"", ""}} {
		d := NewGRPCDialer(zap.NewNop(), nil, tc.token)
		_, _ = d.Stop(context.Background(), lis.Addr().String(), &lanternv1.StopRequest{VmId: "vm-1"})
		d.Close()
		if v := <-got; v != tc.want {
			t.Errorf("token %q: server saw %q", tc.token, v)
		}
	}
}

func firstOrEmpty(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}
