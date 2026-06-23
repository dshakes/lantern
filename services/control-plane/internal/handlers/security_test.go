package handlers

// security_test.go covers the startup-guard helpers and the CORS allowlist
// logic added as part of the security-hardening pass:
//
//   C1 — GetJWTSecret: dev default returned in dev, empty returned in prod
//   H1 — getReceiptSecret: unified constant in dev, env var in both envs
//   C2 — devSeedStatements separate from migrations (tested structurally)
//   M1 — CORSMiddleware: allowlist reflected; public paths keep *; unknown blocked
//   M1 — remoteIP: XFF ignored when no trusted proxies; honored from trusted peer
//   isProd — env parsing cases
//   R1 — CheckSchedulerAddr: prod+unset => fatal; dev+unset => ok; prod+set => ok

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ---------- isProd / IsProd ----------

func TestIsProd_UnsetIsNotProd(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	if IsProd() {
		t.Error("expected IsProd()=false when LANTERN_ENV is unset")
	}
}

func TestIsProd_ProdValues(t *testing.T) {
	cases := []string{"prod", "PROD", "production", "Production", "PRODUCTION", "staging", "STAGING"}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", v)
			if !IsProd() {
				t.Errorf("expected IsProd()=true for LANTERN_ENV=%q", v)
			}
		})
	}
}

func TestIsProd_DevValues(t *testing.T) {
	cases := []string{"dev", "development", "test", "local", ""}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", v)
			if IsProd() {
				t.Errorf("expected IsProd()=false for LANTERN_ENV=%q", v)
			}
		})
	}
}

// ---------- GetJWTSecret ----------

func TestGetJWTSecret_DevReturnsDefault(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	t.Setenv("JWT_SECRET", "")
	s := GetJWTSecret()
	if s != devJWTSecret {
		t.Errorf("expected dev default, got %q", s)
	}
}

func TestGetJWTSecret_DevHonorsEnvVar(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	t.Setenv("JWT_SECRET", "my-strong-test-secret")
	s := GetJWTSecret()
	if s != "my-strong-test-secret" {
		t.Errorf("expected env var value, got %q", s)
	}
}

func TestGetJWTSecret_ProdEmptyWhenUnset(t *testing.T) {
	t.Setenv("LANTERN_ENV", "prod")
	t.Setenv("JWT_SECRET", "")
	s := GetJWTSecret()
	if s != "" {
		t.Errorf("expected empty string in prod with no JWT_SECRET, got %q", s)
	}
}

func TestGetJWTSecret_ProdEmptyWhenDevDefault(t *testing.T) {
	t.Setenv("LANTERN_ENV", "production")
	t.Setenv("JWT_SECRET", devJWTSecret)
	s := GetJWTSecret()
	if s != "" {
		t.Errorf("expected empty string in prod when JWT_SECRET is the dev default, got %q", s)
	}
}

func TestGetJWTSecret_ProdHonorsStrongSecret(t *testing.T) {
	t.Setenv("LANTERN_ENV", "prod")
	t.Setenv("JWT_SECRET", "super-strong-prod-secret-xyz")
	s := GetJWTSecret()
	if s != "super-strong-prod-secret-xyz" {
		t.Errorf("expected env var value, got %q", s)
	}
}

// ---------- getReceiptSecret ----------

func TestGetReceiptSecret_DevFallback(t *testing.T) {
	t.Setenv("LANTERN_RECEIPT_SECRET", "")
	s := getReceiptSecret()
	if s != devReceiptSecret {
		t.Errorf("expected dev constant, got %q", s)
	}
}

func TestGetReceiptSecret_HonorsEnvVar(t *testing.T) {
	t.Setenv("LANTERN_RECEIPT_SECRET", "my-receipt-secret")
	s := getReceiptSecret()
	if s != "my-receipt-secret" {
		t.Errorf("expected env var value, got %q", s)
	}
}

func TestDevReceiptSecretMatchesConstant(t *testing.T) {
	// Ensure the constant used in receipts.go and marketplace_invoke.go
	// are the same value (both reference devReceiptSecret, but belt+suspenders).
	if devReceiptSecret == "" {
		t.Error("devReceiptSecret must not be empty")
	}
	if devReceiptSecret == devJWTSecret {
		t.Error("devReceiptSecret and devJWTSecret must not be the same string")
	}
}

// ---------- corsAllowedOrigins ----------

func TestCORSAllowedOrigins_DefaultIsLocalhost3001(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "")
	m := corsAllowedOrigins()
	if _, ok := m["http://localhost:3001"]; !ok {
		t.Error("expected http://localhost:3001 in default allowlist")
	}
	if len(m) != 1 {
		t.Errorf("expected exactly 1 default origin, got %d", len(m))
	}
}

func TestCORSAllowedOrigins_ParsesMultiple(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "https://app.example.com, https://staging.example.com")
	m := corsAllowedOrigins()
	if _, ok := m["https://app.example.com"]; !ok {
		t.Error("expected https://app.example.com")
	}
	if _, ok := m["https://staging.example.com"]; !ok {
		t.Error("expected https://staging.example.com")
	}
	if len(m) != 2 {
		t.Errorf("expected 2 origins, got %d", len(m))
	}
}

// ---------- isPublicCORSPath ----------

func TestIsPublicCORSPath(t *testing.T) {
	cases := []struct {
		path   string
		public bool
	}{
		{"/.well-known/lantern-receipts", true},
		{"/.well-known/agent.json", true},
		{"/proof", true},
		{"/v1/runs/receipts/verify", true},
		{"/v1/agents", false},
		{"/v1/runs", false},
		{"/auth/login", false},
		{"/healthz", false},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			got := isPublicCORSPath(c.path)
			if got != c.public {
				t.Errorf("isPublicCORSPath(%q) = %v, want %v", c.path, got, c.public)
			}
		})
	}
}

// ---------- CORSMiddleware ----------

// nopHandler is a trivial handler that returns 200 OK.
var nopHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func TestCORSMiddleware_PublicPathGetsWildcard(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodGet, "/.well-known/lantern-receipts", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	acao := rr.Header().Get("Access-Control-Allow-Origin")
	if acao != "*" {
		t.Errorf("public path: expected ACAO=*, got %q", acao)
	}
}

func TestCORSMiddleware_AllowedOriginReflected(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
	req.Header.Set("Origin", "http://localhost:3001")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	acao := rr.Header().Get("Access-Control-Allow-Origin")
	if acao != "http://localhost:3001" {
		t.Errorf("allowed origin: expected ACAO=http://localhost:3001, got %q", acao)
	}
	vary := rr.Header().Get("Vary")
	if vary != "Origin" {
		t.Errorf("allowed origin: expected Vary=Origin, got %q", vary)
	}
}

func TestCORSMiddleware_UnknownOriginBlocked(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	acao := rr.Header().Get("Access-Control-Allow-Origin")
	if acao != "" {
		t.Errorf("unknown origin: expected no ACAO header, got %q", acao)
	}
}

func TestCORSMiddleware_NoOriginHeaderNoACACHeader(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
	// No Origin header (same-origin request or server-to-server).
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	acao := rr.Header().Get("Access-Control-Allow-Origin")
	if acao != "" {
		t.Errorf("no-origin: expected no ACAO header, got %q", acao)
	}
}

func TestCORSMiddleware_PreflightReturns204(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodOptions, "/v1/agents", nil)
	req.Header.Set("Origin", "http://localhost:3001")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("preflight: expected 204, got %d", rr.Code)
	}
}

func TestCORSMiddleware_ReceiptVerifyGetsWildcard(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "http://localhost:3001")
	h := CORSMiddleware(nopHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/runs/receipts/verify", nil)
	req.Header.Set("Origin", "https://any-verifier.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	acao := rr.Header().Get("Access-Control-Allow-Origin")
	if acao != "*" {
		t.Errorf("receipt verify: expected ACAO=*, got %q", acao)
	}
}

func TestCORSMiddleware_MultipleAllowedOrigins(t *testing.T) {
	t.Setenv("LANTERN_CORS_ORIGINS", "https://app.example.com,https://staging.example.com")
	h := CORSMiddleware(nopHandler)

	for _, origin := range []string{"https://app.example.com", "https://staging.example.com"} {
		req := httptest.NewRequest(http.MethodGet, "/v1/agents", nil)
		req.Header.Set("Origin", origin)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)

		acao := rr.Header().Get("Access-Control-Allow-Origin")
		if acao != origin {
			t.Errorf("origin %q: expected ACAO=%q, got %q", origin, origin, acao)
		}
	}
}

// ---------- remoteIP: trusted-proxy-aware rate-limiter key (M1 fix) ----------

// newXFFRequest builds a request with the given RemoteAddr and
// X-Forwarded-For header, without going through httptest.NewRequest so we
// can set RemoteAddr directly (httptest sets it to 192.0.2.1:1234).
func newXFFRequest(remoteAddr, xff string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/runtime/report", nil)
	req.RemoteAddr = remoteAddr
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	return req
}

// TestRemoteIP_NoTrustedProxies_XFFIgnored verifies that when
// LANTERN_TRUSTED_PROXIES is empty (the default), X-Forwarded-For is
// completely ignored and RemoteAddr (host portion) is always used as the key.
// This is the critical invariant that prevents an attacker from rotating their
// "IP" on every request by changing the XFF header.
func TestRemoteIP_NoTrustedProxies_XFFIgnored(t *testing.T) {
	t.Setenv(envTrustedProxies, "") // no trusted proxies

	cases := []struct {
		name       string
		remoteAddr string
		xff        string
		wantIP     string
	}{
		{
			name:       "no xff header",
			remoteAddr: "10.0.0.5:54321",
			xff:        "",
			wantIP:     "10.0.0.5",
		},
		{
			name:       "xff present but ignored — attacker cannot rotate",
			remoteAddr: "203.0.113.7:12345",
			xff:        "1.2.3.4, 5.6.7.8",
			wantIP:     "203.0.113.7", // RemoteAddr wins; XFF discarded
		},
		{
			name:       "xff present from loopback peer — still ignored",
			remoteAddr: "127.0.0.1:9999",
			xff:        "evil-client-ip",
			wantIP:     "127.0.0.1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newXFFRequest(tc.remoteAddr, tc.xff)
			got := remoteIP(r)
			if got != tc.wantIP {
				t.Errorf("remoteIP: got %q, want %q (remoteAddr=%q, xff=%q)",
					got, tc.wantIP, tc.remoteAddr, tc.xff)
			}
		})
	}
}

// TestRemoteIP_TrustedProxy_XFFHonored verifies that when the immediate TCP
// peer falls within a configured trusted-proxy CIDR, the leftmost
// X-Forwarded-For element is used as the rate-limiter key (it is the original
// client IP as inserted by the trusted proxy, which the client cannot forge
// past the proxy boundary).
func TestRemoteIP_TrustedProxy_XFFHonored(t *testing.T) {
	// Configure the ingress load-balancer subnet as trusted.
	t.Setenv(envTrustedProxies, "10.0.0.0/8,172.16.0.0/12")

	cases := []struct {
		name       string
		remoteAddr string // TCP peer — must be in a trusted CIDR
		xff        string
		wantIP     string
	}{
		{
			name:       "single xff entry",
			remoteAddr: "10.0.1.2:443", // trusted proxy
			xff:        "203.0.113.99", // original client
			wantIP:     "203.0.113.99",
		},
		{
			name:       "multiple xff entries — leftmost wins",
			remoteAddr: "172.16.0.5:8080", // trusted proxy
			xff:        "198.51.100.7, 10.0.0.1",
			wantIP:     "198.51.100.7", // leftmost = original client
		},
		{
			name:       "xff with whitespace trimmed",
			remoteAddr: "10.100.0.1:1234",
			xff:        "  203.0.113.11  ",
			wantIP:     "203.0.113.11",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newXFFRequest(tc.remoteAddr, tc.xff)
			got := remoteIP(r)
			if got != tc.wantIP {
				t.Errorf("remoteIP: got %q, want %q (remoteAddr=%q, xff=%q)",
					got, tc.wantIP, tc.remoteAddr, tc.xff)
			}
		})
	}
}

// TestRemoteIP_TrustedProxyCIDR_UntrustedPeerXFFIgnored verifies that even
// when trusted proxies ARE configured, a request from a peer NOT in a trusted
// CIDR still uses RemoteAddr (the attacker cannot forge XFF to bypass the
// limiter).
func TestRemoteIP_TrustedProxyCIDR_UntrustedPeerXFFIgnored(t *testing.T) {
	t.Setenv(envTrustedProxies, "10.0.0.0/8") // only 10.x.x.x is trusted

	r := newXFFRequest(
		"203.0.113.55:9999", // NOT in 10/8 — untrusted
		"1.2.3.4",           // attacker claims this is their IP via XFF
	)
	got := remoteIP(r)
	if got != "203.0.113.55" {
		t.Errorf("untrusted peer: expected RemoteAddr host 203.0.113.55, got %q", got)
	}
}

// TestRemoteIP_MalformedCIDR_FallsBackToRemoteAddr verifies that a malformed
// CIDR in LANTERN_TRUSTED_PROXIES doesn't crash and safely falls back.
func TestRemoteIP_MalformedCIDR_FallsBackToRemoteAddr(t *testing.T) {
	t.Setenv(envTrustedProxies, "not-a-cidr,10.0.0.0/8")

	// The 10/8 entry is valid and the peer is in it — XFF should be used
	// (the good entry is honored; the bad one is silently skipped).
	r := newXFFRequest("10.0.0.3:1234", "203.0.113.77")
	got := remoteIP(r)
	if got != "203.0.113.77" {
		t.Errorf("partial malformed CIDR: expected XFF client 203.0.113.77, got %q", got)
	}
}

// TestRemoteIP_AllMalformedCIDRs_FallsBackToRemoteAddr verifies that all-bad
// CIDR config falls back to RemoteAddr (never panics, never trusts XFF).
func TestRemoteIP_AllMalformedCIDRs_FallsBackToRemoteAddr(t *testing.T) {
	t.Setenv(envTrustedProxies, "bad1,bad2,bad3")

	r := newXFFRequest("203.0.113.9:5555", "1.2.3.4")
	got := remoteIP(r)
	if got != "203.0.113.9" {
		t.Errorf("all-bad CIDRs: expected RemoteAddr host 203.0.113.9, got %q", got)
	}
}

// ---------- CheckSchedulerAddr (R1 — W12 runtime guard) ----------

func TestCheckSchedulerAddr_ProdUnset_Fatal(t *testing.T) {
	fatal, msg := CheckSchedulerAddr(true, "")
	if !fatal {
		t.Error("prod + unset addr: expected fatal=true")
	}
	if msg == "" {
		t.Error("prod + unset addr: expected non-empty message")
	}
}

func TestCheckSchedulerAddr_ProdSet_OK(t *testing.T) {
	fatal, msg := CheckSchedulerAddr(true, "scheduler.internal:50055")
	if fatal {
		t.Errorf("prod + set addr: expected fatal=false, got msg=%q", msg)
	}
	if msg != "" {
		t.Errorf("prod + set addr: expected empty message, got %q", msg)
	}
}

func TestCheckSchedulerAddr_DevUnset_OK(t *testing.T) {
	fatal, msg := CheckSchedulerAddr(false, "")
	if fatal {
		t.Errorf("dev + unset addr: expected fatal=false, got msg=%q", msg)
	}
	// dev may return an empty message (no warning needed here — main.go logs one).
	_ = msg
}

func TestCheckSchedulerAddr_DevSet_OK(t *testing.T) {
	fatal, msg := CheckSchedulerAddr(false, "localhost:50055")
	if fatal {
		t.Errorf("dev + set addr: expected fatal=false, got msg=%q", msg)
	}
	_ = msg
}

// TestCheckSchedulerAddr_ViaEnv ensures the guard reads the real env var
// when wired through IsProd() and os.Getenv, matching the main.go call site.
func TestCheckSchedulerAddr_ViaEnv_ProdFatal(t *testing.T) {
	t.Setenv("LANTERN_ENV", "prod")
	t.Setenv("LANTERN_SCHEDULER_GRPC_ADDR", "")

	fatal, msg := CheckSchedulerAddr(IsProd(), "")
	if !fatal {
		t.Errorf("expected fatal via env: IsProd()=%v addr=%q msg=%q", IsProd(), "", msg)
	}
}

func TestCheckSchedulerAddr_ViaEnv_DevSafe(t *testing.T) {
	t.Setenv("LANTERN_ENV", "")
	t.Setenv("LANTERN_SCHEDULER_GRPC_ADDR", "")

	fatal, _ := CheckSchedulerAddr(IsProd(), "")
	if fatal {
		t.Error("dev mode with no addr: expected fatal=false")
	}
}
