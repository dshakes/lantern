package handlers

// mtls_grpc_test.go drives the real :50051 server stack (GRPCServerTLS +
// RequireServiceCert + the service-token interceptor) over loopback with
// real certificates (ADR 0043): mTLS AND the token are both required, the
// customer-VPC DataPlaneService stays reachable without a client cert, and a
// wrong CA / wrong SPIFFE ID never reaches a handler.

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
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	palv1 "github.com/dshakes/pal/gen/go/pal/v1"
	"github.com/dshakes/pal/packages/grpctls"
	"github.com/dshakes/pal/services/control-plane/internal/middleware"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return testCA{c, key}
}

// issue writes ca.crt/tls.crt/tls.key for a localhost leaf with an optional
// SPIFFE ID and returns the triplet.
func (ca testCA) issue(t *testing.T, spiffe string) grpctls.Files {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "svc"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		KeyUsage:    x509.KeyUsageDigitalSignature,
	}
	if spiffe != "" {
		u, _ := url.Parse(spiffe)
		tmpl.URIs = []*url.URL{u}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalECPrivateKey(key)
	d := t.TempDir()
	write := func(name, typ string, b []byte) string {
		p := filepath.Join(d, name)
		if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: b}), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	return grpctls.Files{
		Prefix: grpctls.ServicePrefix,
		CA:     write("ca.crt", "CERTIFICATE", ca.cert.Raw),
		Cert:   write("tls.crt", "CERTIFICATE", der),
		Key:    write("tls.key", "EC PRIVATE KEY", kd),
	}
}

const (
	gatewayID = "spiffe://pal.internal/svc/gateway"
	testToken = "svc-token"
)

func TestControlPlaneGRPC_MTLS(t *testing.T) {
	ca := newTestCA(t)
	srvFiles := ca.issue(t, "spiffe://pal.internal/svc/control-plane")
	t.Setenv("PAL_GRPC_TLS_CA", srvFiles.CA)
	t.Setenv("PAL_GRPC_TLS_CERT", srvFiles.Cert)
	t.Setenv("PAL_GRPC_TLS_KEY", srvFiles.Key)
	t.Setenv("PAL_GRPC_TLS_ALLOWED_PEERS", gatewayID)

	creds, mtls, err := GRPCServerTLS()
	if err != nil || !mtls {
		t.Fatalf("GRPCServerTLS: mtls=%v err=%v", mtls, err)
	}
	log := zap.NewNop()
	srv := grpc.NewServer(
		grpc.Creds(creds),
		grpc.ChainUnaryInterceptor(
			middleware.UnaryRequireServiceCert(log),
			middleware.UnaryServiceAuthInterceptor(log, testToken),
		),
	)
	palv1.RegisterAgentServiceServer(srv, palv1.UnimplementedAgentServiceServer{})
	palv1.RegisterDataPlaneServiceServer(srv, palv1.UnimplementedDataPlaneServiceServer{})
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	dial := func(f grpctls.Files) *grpc.ClientConn {
		cfg, err := grpctls.ClientConfig(f, false, false)
		if err != nil {
			t.Fatal(err)
		}
		conn, err := grpc.NewClient(lis.Addr().String(), grpc.WithTransportCredentials(credentials.NewTLS(cfg)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
	ctx := func(token string) context.Context {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		t.Cleanup(cancel)
		if token != "" {
			c = metadata.AppendToOutgoingContext(c, middleware.ServiceTokenMetadataKey, token)
		}
		return c
	}
	agent := func(conn *grpc.ClientConn, token string) codes.Code {
		_, err := palv1.NewAgentServiceClient(conn).GetAgent(ctx(token), &palv1.GetAgentRequest{})
		return status.Code(err)
	}

	gateway := dial(ca.issue(t, gatewayID))
	noCert := dial(grpctls.Files{Prefix: grpctls.ServicePrefix, CA: srvFiles.CA})
	wrongSAN := dial(ca.issue(t, "spiffe://pal.internal/svc/dashboard"))
	otherCA := newTestCA(t).issue(t, gatewayID)
	otherCA.CA = srvFiles.CA // trust the real server, present a foreign client cert
	foreign := dial(otherCA)

	// Unimplemented == the call passed every gate and reached the handler.
	cases := []struct {
		name string
		got  codes.Code
		want codes.Code
	}{
		{"allowlisted cert + token reaches the handler", agent(gateway, testToken), codes.Unimplemented},
		{"cert without token is refused (defense in depth)", agent(gateway, ""), codes.Unauthenticated},
		{"token without cert is refused", agent(noCert, testToken), codes.Unauthenticated},
		{"wrong SPIFFE ID fails the handshake", agent(wrongSAN, testToken), codes.Unavailable},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	if c := agent(foreign, testToken); c == codes.Unimplemented || c == codes.OK {
		t.Errorf("foreign-CA client cert reached the handler (code %v)", c)
	}
	// The customer-VPC tunnel has no service cert and authenticates itself.
	_, err = palv1.NewDataPlaneServiceClient(noCert).Register(ctx(""), &palv1.DpRegisterRequest{})
	if status.Code(err) != codes.Unimplemented {
		t.Errorf("DataPlaneService without a client cert: got %v, want Unimplemented", status.Code(err))
	}
}
