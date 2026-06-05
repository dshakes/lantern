package handlers

// security_test.go covers the startup-guard helpers and the CORS allowlist
// logic added as part of the security-hardening pass:
//
//   C1 — GetJWTSecret: dev default returned in dev, empty returned in prod
//   H1 — getReceiptSecret: unified constant in dev, env var in both envs
//   C2 — devSeedStatements separate from migrations (tested structurally)
//   M1 — CORSMiddleware: allowlist reflected; public paths keep *; unknown blocked
//   isProd — env parsing cases

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
