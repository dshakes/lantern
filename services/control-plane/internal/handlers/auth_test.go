package handlers

// DB-gated handler tests for auth.go: signup, login, and token introspection
// (GET /auth/me). These are the JWT-minting / credential-checking paths that
// gate every other endpoint, so they get real end-to-end coverage against the
// dev Postgres.
//
// Skipped automatically when DATABASE_URL is unset (same convention as the rest
// of this package). Run with:
//
//	DATABASE_URL=postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable \
//	  go test ./internal/handlers/ -run Auth -count=1 -v

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// newAuthTestHandler builds an AuthHandler backed by a real pool, using the
// shared testJWTSecret so mintTestToken-issued JWTs validate against it.
func newAuthTestHandler(t *testing.T) *AuthHandler {
	t.Helper()
	pool := openTestPool(t) // skips if DATABASE_URL unset
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	return NewAuthHandler(srv, testJWTSecret)
}

// uniqueEmail returns a per-test email that won't collide with seeded data or
// other test runs. The local-part is unique; cleanup removes the row + tenant.
func uniqueEmail(t *testing.T) string {
	t.Helper()
	suffix, err := randomHex(6)
	if err != nil {
		t.Fatalf("randomHex: %v", err)
	}
	return "authtest-" + suffix + "@example.test"
}

// cleanupUserByEmail deletes the user and its owning tenant (CASCADE drops the
// user) created by a signup. Registered as a t.Cleanup by the caller.
func cleanupUserByEmail(t *testing.T, h *AuthHandler, email string) {
	t.Helper()
	ctx := context.Background()
	// Delete the tenant the signup created; ON DELETE CASCADE removes the user.
	_, _ = h.srv.Pool.Exec(ctx, `
		DELETE FROM tenants WHERE id IN (
			SELECT tenant_id FROM users WHERE email = $1
		)
	`, email)
	_, _ = h.srv.Pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
}

// doSignup posts a signup request and returns the recorder.
func doSignup(h *AuthHandler, email, password, name string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password, "name": name})
	req := httptest.NewRequest(http.MethodPost, "/auth/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.Signup(rr, req)
	return rr
}

// doLogin posts a login request and returns the recorder.
func doLogin(h *AuthHandler, email, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.Login(rr, req)
	return rr
}

// TestAuth_Signup_IssuesValidJWT registers a brand-new user and asserts the
// returned token is a real JWT that validates and carries the new tenant.
func TestAuth_Signup_IssuesValidJWT(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, "supersecret-pw-123", "Auth Tester")
	if rr.Code != http.StatusCreated {
		t.Fatalf("signup: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}

	var resp authResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal signup response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("signup response has empty token")
	}
	if resp.User.Email != email {
		t.Errorf("user email: got %q, want %q", resp.User.Email, email)
	}
	if resp.User.TenantID == "" {
		t.Error("user tenantId is empty")
	}
	if resp.User.Role != "owner" {
		t.Errorf("role: got %q, want owner", resp.User.Role)
	}

	// The issued token must validate against the same secret and carry the
	// claims that were minted — this is the load-bearing assertion (a token
	// that doesn't validate is useless).
	claims, err := h.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("issued token failed to validate: %v", err)
	}
	if claims.TenantID != resp.User.TenantID {
		t.Errorf("token tenant_id %q != response tenantId %q", claims.TenantID, resp.User.TenantID)
	}
	if claims.Email != email {
		t.Errorf("token email: got %q, want %q", claims.Email, email)
	}
}

// TestAuth_Signup_ShortPasswordRejected proves the 12-char minimum is enforced
// and no token is issued.
func TestAuth_Signup_ShortPasswordRejected(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, "short", "X")
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("short password: got %d, want 400; body: %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"token"`)) {
		t.Error("a token was issued for an under-length password")
	}
}

// TestAuth_Signup_Duplicate_Returns409 proves a second signup with the same
// email is rejected with 409 Conflict.
func TestAuth_Signup_Duplicate_Returns409(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	if rr := doSignup(h, email, "supersecret-pw-123", "First"); rr.Code != http.StatusCreated {
		t.Fatalf("first signup: got %d, want 201; body: %s", rr.Code, rr.Body.String())
	}
	rr := doSignup(h, email, "anothersecret-pw-456", "Second")
	if rr.Code != http.StatusConflict {
		t.Fatalf("duplicate signup: got %d, want 409; body: %s", rr.Code, rr.Body.String())
	}
}

// TestAuth_Login_Success logs in a user created via signup and asserts a fresh
// valid token comes back bound to the same tenant.
func TestAuth_Login_Success(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	const password = "supersecret-pw-123"
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	signupRR := doSignup(h, email, password, "Login Tester")
	if signupRR.Code != http.StatusCreated {
		t.Fatalf("signup precondition failed: %d; body: %s", signupRR.Code, signupRR.Body.String())
	}
	var signup authResponse
	_ = json.Unmarshal(signupRR.Body.Bytes(), &signup)

	rr := doLogin(h, email, password)
	if rr.Code != http.StatusOK {
		t.Fatalf("login: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var resp authResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal login response: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("login returned empty token")
	}
	claims, err := h.ValidateToken(resp.Token)
	if err != nil {
		t.Fatalf("login token failed to validate: %v", err)
	}
	if claims.TenantID != signup.User.TenantID {
		t.Errorf("login tenant %q != signup tenant %q", claims.TenantID, signup.User.TenantID)
	}
	if claims.Email != email {
		t.Errorf("login token email: got %q, want %q", claims.Email, email)
	}
}

// TestAuth_Login_WrongPassword proves a valid user + wrong password returns 401
// and no token. This is the credential-checking path that bcrypt guards.
func TestAuth_Login_WrongPassword(t *testing.T) {
	h := newAuthTestHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	if rr := doSignup(h, email, "supersecret-pw-123", "Pwd Tester"); rr.Code != http.StatusCreated {
		t.Fatalf("signup precondition: %d; body: %s", rr.Code, rr.Body.String())
	}

	rr := doLogin(h, email, "wrong-password-000")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"token"`)) {
		t.Error("a token was issued for a wrong password")
	}
}

// TestAuth_Login_UnknownUser proves an unknown email returns 401 (invalid
// credentials) — and notably the SAME status/shape as a wrong password, so the
// endpoint doesn't leak which emails exist.
func TestAuth_Login_UnknownUser(t *testing.T) {
	h := newAuthTestHandler(t)

	rr := doLogin(h, "no-such-user-"+func() string { s, _ := randomHex(6); return s }()+"@example.test", "supersecret-pw-123")
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user: got %d, want 401; body: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["error"] != "invalid credentials" {
		t.Errorf("unknown-user error: got %q, want 'invalid credentials' (user-existence must not leak)", resp["error"])
	}
}

// TestAuth_GetMe_ValidToken proves /auth/me returns the caller's identity for a
// well-formed JWT.
func TestAuth_GetMe_ValidToken(t *testing.T) {
	h := newAuthTestHandler(t)

	tenantID := devTenantID
	userID := "00000000-0000-0000-0000-000000000002"
	tok := mintTestToken(t, tenantID, userID, "owner")

	req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.Header.Set("Authorization", bearerHeader(tok))
	rr := httptest.NewRecorder()
	h.GetMe(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("GetMe valid: got %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	var u userJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &u); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if u.ID != userID {
		t.Errorf("GetMe id: got %q, want %q", u.ID, userID)
	}
	if u.TenantID != tenantID {
		t.Errorf("GetMe tenantId: got %q, want %q", u.TenantID, tenantID)
	}
}

// TestAuth_GetMe_InvalidToken proves a garbage / missing / expired token is
// rejected with 401 and no identity is disclosed.
func TestAuth_GetMe_InvalidToken(t *testing.T) {
	h := newAuthTestHandler(t)

	cases := []struct {
		name   string
		header string
	}{
		{"missing", ""},
		{"garbage", bearerHeader("not.a.jwt")},
		{"wrong-scheme", "Basic " + "abc"},
		{"expired", bearerHeader(mintExpiredToken(t, devTenantID, "user-x", "owner"))},
		{"wrong-secret", bearerHeader(mintTokenWithSecret(t, devTenantID, "user-x", "owner", "a-different-secret"))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rr := httptest.NewRecorder()
			h.GetMe(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("%s token: got %d, want 401; body: %s", tc.name, rr.Code, rr.Body.String())
			}
		})
	}
}

// mintExpiredToken mints a token whose exp is in the past so validation must
// fail. Used to prove expiry is actually enforced (not a cosmetic claim).
func mintExpiredToken(t *testing.T, tenantID, userID, role string) string {
	t.Helper()
	past := time.Now().Add(-2 * time.Hour)
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(past.Add(-time.Hour)),
			ExpiresAt: jwt.NewNumericDate(past),
			Issuer:    "lantern-test",
		},
		TenantID: tenantID,
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("mintExpiredToken: %v", err)
	}
	return s
}

// mintTokenWithSecret signs a token with a non-matching secret, proving the
// signature is actually verified (a forged token under a different key fails).
func mintTokenWithSecret(t *testing.T, tenantID, userID, role, secret string) string {
	t.Helper()
	claims := LanternClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		TenantID: tenantID,
		Role:     role,
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("mintTokenWithSecret: %v", err)
	}
	return s
}
