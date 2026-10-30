package grpctls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// --- test PKI -------------------------------------------------------------

type ca struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newCA(t *testing.T, cn string) ca {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return ca{c, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// leaf issues a serverAuth+clientAuth cert for "localhost" with an optional
// SPIFFE URI SAN and OU.
func (c ca) leaf(t *testing.T, spiffe, ou string) (certPEM, keyPEM []byte) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "svc"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	if spiffe != "" {
		u, _ := url.Parse(spiffe)
		tmpl.URIs = []*url.URL{u}
	}
	if ou != "" {
		tmpl.Subject.OrganizationalUnit = []string{ou}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &key.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalECPrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd})
}

// files writes a triplet to a temp dir.
func files(t *testing.T, caPEM, certPEM, keyPEM []byte) Files {
	t.Helper()
	d := t.TempDir()
	w := func(n string, b []byte) string {
		if b == nil {
			return ""
		}
		p := filepath.Join(d, n)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	return Files{Prefix: ServicePrefix, CA: w("ca.crt", caPEM), Cert: w("tls.crt", certPEM), Key: w("tls.key", keyPEM)}
}

// handshake runs one TLS handshake over loopback TCP (buffered, unlike
// net.Pipe, so alerts never deadlock) and returns the server-side error —
// the side that enforces client auth + identity.
func handshake(t *testing.T, srv, cli *tls.Config) error {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := net.DialTimeout("tcp", ln.Addr().String(), 5*time.Second)
		if err != nil {
			return
		}
		defer conn.Close()
		c := tls.Client(conn, cli)
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		if c.Handshake() == nil {
			// A TLS 1.3 client finishes before the server has checked its
			// cert; write so the server's Read below completes the check.
			_, _ = c.Write([]byte{1})
			_, _ = c.Read(make([]byte, 1))
		}
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	s := tls.Server(conn, srv)
	_ = s.SetDeadline(time.Now().Add(5 * time.Second))
	if err := s.Handshake(); err != nil {
		return err
	}
	_, err = s.Read(make([]byte, 1))
	return err
}

const gw = "spiffe://pal.internal/svc/gateway"

// --- handshake tests ------------------------------------------------------

func TestHandshake(t *testing.T) {
	root := newCA(t, "pal-service-ca")
	other := newCA(t, "attacker-ca")
	srvCert, srvKey := root.leaf(t, "spiffe://pal.internal/svc/control-plane", "")
	srvFiles := files(t, root.pem, srvCert, srvKey)

	client := func(signer ca, spiffe, ou string, withCert bool) *tls.Config {
		f := Files{Prefix: ServicePrefix, CA: srvFiles.CA}
		if withCert {
			c, k := signer.leaf(t, spiffe, ou)
			f = files(t, root.pem, c, k)
		}
		cfg, err := ClientConfig(f, false, false)
		if err != nil {
			t.Fatal(err)
		}
		cfg.ServerName = "localhost"
		if len(cfg.Certificates) == 1 {
			// Go's client withholds a cert whose issuer the server did not
			// list; other stacks send it anyway. Always send, so the
			// server's own verification is what is under test.
			c := cfg.Certificates[0]
			cfg.Certificates = nil
			cfg.GetClientCertificate = func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return &c, nil }
		}
		return cfg
	}

	cases := []struct {
		name     string
		cli      *tls.Config
		optional bool
		peers    []string
		ok       bool
	}{
		{"valid cert, allowlisted SAN", client(root, gw, "", true), false, []string{gw}, true},
		{"valid cert, no allowlist", client(root, gw, "", true), false, nil, true},
		{"no client cert (required)", client(root, "", "", false), false, nil, false},
		{"no client cert (optional mode)", client(root, "", "", false), true, []string{gw}, true},
		{"wrong CA", client(other, gw, "", true), false, nil, false},
		{"wrong CA (optional mode still verifies)", client(other, gw, "", true), true, nil, false},
		{"wrong SAN", client(root, "spiffe://pal.internal/svc/dashboard", "", true), false, []string{gw}, false},
		{"no SAN with allowlist", client(root, "", "", true), false, []string{gw}, false},
		{"VM guest cert refused even without allowlist", client(root, "", VMCertOU, true), false, nil, false},
		{"wrong SAN (optional mode still checks)", client(root, "spiffe://x/svc/y", "", true), true, []string{gw}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, err := ServerConfig(srvFiles, true, false, tc.peers, tc.optional)
			if err != nil || srv == nil {
				t.Fatalf("ServerConfig: %v", err)
			}
			err = handshake(t, srv, tc.cli)
			if tc.ok && err != nil {
				t.Fatalf("want accept, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want reject, handshake succeeded")
			}
		})
	}
}

func TestClientRejectsServerFromWrongCA(t *testing.T) {
	root := newCA(t, "pal-service-ca")
	other := newCA(t, "attacker-ca")
	sc, sk := other.leaf(t, "", "")
	srv, err := ServerConfig(files(t, root.pem, sc, sk), false, false, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	cli, _ := ClientConfig(Files{Prefix: ServicePrefix, CA: files(t, root.pem, nil, nil).CA}, false, false)
	cli.ServerName = "localhost"
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() { _ = tls.Server(a, srv).Handshake(); _ = a.Close() }()
	if err := tls.Client(b, cli).Handshake(); err == nil {
		t.Fatal("client trusted a server cert from a foreign CA")
	}
}

// --- policy tests ---------------------------------------------------------

func TestServerConfigPolicy(t *testing.T) {
	root := newCA(t, "ca")
	c, k := root.leaf(t, "", "")
	full := files(t, root.pem, c, k)

	if cfg, err := ServerConfig(Files{Prefix: ServicePrefix}, false, false, nil, false); err != nil || cfg != nil {
		t.Fatalf("dev unset: want plaintext, got %v %v", cfg, err)
	}
	if _, err := ServerConfig(Files{Prefix: ServicePrefix}, true, false, nil, false); !errors.Is(err, ErrPlaintext) {
		t.Fatalf("prod unset: want ErrPlaintext, got %v", err)
	}
	if cfg, err := ServerConfig(Files{Prefix: ServicePrefix}, true, true, nil, false); err != nil || cfg != nil {
		t.Fatalf("prod + PAL_GRPC_INSECURE: want plaintext, got %v %v", cfg, err)
	}
	for _, half := range []Files{
		{Prefix: ServicePrefix, CA: full.CA},
		{Prefix: ServicePrefix, Cert: full.Cert, Key: full.Key},
		{Prefix: ServicePrefix, CA: full.CA, Cert: full.Cert},
	} {
		if _, err := ServerConfig(half, false, true, nil, false); err == nil || !strings.Contains(err.Error(), "half-configured") {
			t.Fatalf("half config %+v: want half-configured error, got %v", half, err)
		}
	}
	bad := full
	bad.CA = full.Cert + ".missing"
	if _, err := ServerConfig(bad, false, false, nil, false); err == nil {
		t.Fatal("unreadable CA: want error")
	}
	cfg, err := ServerConfig(full, true, false, nil, false)
	if err != nil || cfg.ClientAuth != tls.RequireAndVerifyClientCert || cfg.MinVersion != tls.VersionTLS12 {
		t.Fatalf("full: %+v %v", cfg, err)
	}
}

func TestClientConfigPolicy(t *testing.T) {
	root := newCA(t, "ca")
	c, k := root.leaf(t, "", "")
	full := files(t, root.pem, c, k)
	caOnly := Files{Prefix: ManagerPrefix, CA: full.CA}

	cases := []struct {
		name           string
		f              Files
		prod, insecure bool
		wantNil        bool
		wantErr        bool
	}{
		{"dev unset → plaintext", Files{Prefix: ManagerPrefix}, false, false, true, false},
		{"prod unset → refuse", Files{Prefix: ManagerPrefix}, true, false, true, true},
		{"prod unset + insecure override", Files{Prefix: ServicePrefix}, true, true, true, false},
		{"dev CA only → server-auth TLS", caOnly, false, false, false, false},
		{"prod CA only → refuse (no client cert)", caOnly, true, false, true, true},
		{"cert without key", Files{Prefix: ManagerPrefix, CA: full.CA, Cert: full.Cert}, false, false, true, true},
		{"cert without CA", Files{Prefix: ManagerPrefix, Cert: full.Cert, Key: full.Key}, false, false, true, true},
		{"prod full", full, true, false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := ClientConfig(tc.f, tc.prod, tc.insecure)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if (cfg == nil) != tc.wantNil {
				t.Fatalf("cfg nil = %v, want %v", cfg == nil, tc.wantNil)
			}
		})
	}
	if _, err := ClientConfig(Files{Prefix: ManagerPrefix}, true, false); !strings.Contains(err.Error(), "PAL_RUNTIME_MANAGER_TLS_CA") {
		t.Fatalf("error should name the env var: %v", err)
	}
}

func TestFromEnvAndAllowlist(t *testing.T) {
	t.Setenv("PAL_GRPC_TLS_CA", " /a ")
	t.Setenv("LANTERN_GRPC_TLS_CERT", "/b") // legacy name still served
	t.Setenv("PAL_GRPC_TLS_KEY", "")
	t.Setenv("PAL_GRPC_TLS_ALLOWED_PEERS", " spiffe://x/svc/a ,, spiffe://x/svc/b")
	f := FromEnv(ServicePrefix)
	if f.CA != "/a" || f.Cert != "/b" || f.Key != "" || f.Empty() {
		t.Fatalf("FromEnv = %+v", f)
	}
	if got := AllowedPeersFromEnv(); len(got) != 2 || got[1] != "spiffe://x/svc/b" {
		t.Fatalf("AllowedPeersFromEnv = %v", got)
	}
	for v, want := range map[string]bool{"1": true, "on": true, "TRUE": true, "": false, "0": false, "yes": false} {
		t.Setenv("PAL_GRPC_INSECURE", v)
		if InsecureOverride() != want {
			t.Fatalf("InsecureOverride(%q) != %v", v, want)
		}
	}
}

// A renewed leaf on disk (cert-manager rotation) is served without a restart;
// a broken write keeps the last good pair.
func TestKeypairReloadsRotatedLeaf(t *testing.T) {
	old := reloadEvery
	reloadEvery = 0
	t.Cleanup(func() { reloadEvery = old })

	root := newCA(t, "ca")
	c1, k1 := root.leaf(t, "spiffe://x/svc/one", "")
	f := files(t, root.pem, c1, k1)
	srv, err := ServerConfig(f, false, false, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	serving := func() string {
		c, err := srv.GetCertificate(nil)
		if err != nil {
			t.Fatal(err)
		}
		leaf, _ := x509.ParseCertificate(c.Certificate[0])
		return leaf.URIs[0].String()
	}
	if got := serving(); got != "spiffe://x/svc/one" {
		t.Fatalf("initial: %s", got)
	}
	c2, k2 := root.leaf(t, "spiffe://x/svc/two", "")
	future := time.Now().Add(time.Minute)
	for p, b := range map[string][]byte{f.Cert: c2, f.Key: k2} {
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(p, future, future)
	}
	if got := serving(); got != "spiffe://x/svc/two" {
		t.Fatalf("after rotation: %s", got)
	}
	_ = os.WriteFile(f.Cert, []byte("garbage"), 0o600)
	_ = os.Chtimes(f.Cert, future.Add(time.Minute), future.Add(time.Minute))
	if got := serving(); got != "spiffe://x/svc/two" {
		t.Fatalf("broken write must keep the last good pair, got %s", got)
	}
}
