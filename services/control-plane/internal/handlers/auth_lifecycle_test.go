package handlers

// Tests for ADR 0027: sign-up gating, captcha, verification, password reset,
// /auth/* rate limits and tenant export. Pure tests run anywhere; the DB-backed
// ones skip without DATABASE_URL (they migrate it — point it at a scratch DB).

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/mailer"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// captureMailer records sent mail; sends happen on a goroutine, so wait() polls.
type captureMailer struct {
	mu   sync.Mutex
	msgs []mailer.Message
}

func (c *captureMailer) Send(_ context.Context, m mailer.Message) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, m)
	return nil
}

func (c *captureMailer) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.msgs)
}

// waitFor returns the first message to `to`, failing after 2s.
func (c *captureMailer) waitFor(t *testing.T, to string) mailer.Message {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		for _, m := range c.msgs {
			if m.To == to {
				c.mu.Unlock()
				return m
			}
		}
		c.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no mail to %s within 2s", to)
	return mailer.Message{}
}

var tokenInLink = regexp.MustCompile(`token=([A-Za-z0-9_-]+)`)

func linkToken(t *testing.T, m mailer.Message) string {
	t.Helper()
	sub := tokenInLink.FindStringSubmatch(m.Text)
	if sub == nil {
		t.Fatalf("no token link in mail body %q", m.Text)
	}
	return sub[1]
}

func callJSON(fn http.HandlerFunc, path string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	fn(rr, req)
	return rr
}

func mintInvite(secret, email string, exp time.Time) string {
	e := fmt.Sprint(exp.Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.ToLower(email) + "|" + e))
	return e + "." + hex.EncodeToString(mac.Sum(nil))
}

// setSignupEnv pins every env var the sign-up path reads.
func setSignupEnv(t *testing.T, env, mode, turnstile string) {
	t.Helper()
	t.Setenv("PAL_ENV", env)
	t.Setenv("PAL_SIGNUP_MODE", mode)
	t.Setenv("PAL_TURNSTILE_SECRET", turnstile)
	t.Setenv("PAL_SIGNUP_INVITE_SECRET", "")
	t.Setenv("PAL_MAILER", "")
}

// ---------- pure ----------

func TestInviteCodeValid(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	good := mintInvite("s3cret", "New.User@Example.com", now.Add(time.Hour))
	cases := []struct {
		name, secret, email, code string
		want                      bool
	}{
		{"valid", "s3cret", "New.User@Example.com", good, true},
		{"email case-insensitive", "s3cret", "new.user@example.com", good, true},
		{"other email", "s3cret", "someone@example.com", good, false},
		{"wrong secret", "other", "New.User@Example.com", good, false},
		{"no secret configured", "", "New.User@Example.com", good, false},
		{"expired", "s3cret", "a@b.test", mintInvite("s3cret", "a@b.test", now.Add(-time.Second)), false},
		{"tampered expiry", "s3cret", "New.User@Example.com", "9999999999" + good[strings.Index(good, "."):], false},
		{"malformed", "s3cret", "a@b.test", "not-a-code", false},
		{"bad hex", "s3cret", "a@b.test", fmt.Sprint(now.Unix()+60) + ".zz", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := inviteCodeValid(tc.secret, tc.email, tc.code, now); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSignupModeDefaults(t *testing.T) {
	cases := []struct{ env, mode, want string }{
		{"", "", signupOpen},
		{"production", "", signupClosed},
		{"staging", "", signupClosed},
		{"production", "INVITE", signupInvite},
		{"", "closed", signupClosed},
	}
	for _, tc := range cases {
		t.Setenv("PAL_ENV", tc.env)
		t.Setenv("PAL_SIGNUP_MODE", tc.mode)
		if got := signupMode(); got != tc.want {
			t.Errorf("env=%q mode=%q: got %q, want %q", tc.env, tc.mode, got, tc.want)
		}
	}
}

func TestCheckSignupConfig(t *testing.T) {
	cases := []struct {
		name                                string
		prod                                bool
		mode, invite, turnstile, mailDriver string
		wantFatal                           bool
		wantMsg                             string
	}{
		{name: "dev default open", wantFatal: false},
		{name: "unknown mode", mode: "public", wantFatal: true, wantMsg: "not one of"},
		{name: "invite without secret", mode: "invite", wantFatal: true, wantMsg: "INVITE_SECRET"},
		{name: "invite with secret dev", mode: "invite", invite: "x", wantFatal: false},
		{name: "prod default closed", prod: true, wantFatal: false},
		{name: "prod open no captcha", prod: true, mode: "open", mailDriver: "http", wantFatal: true, wantMsg: "TURNSTILE"},
		{name: "prod open log mailer", prod: true, mode: "open", turnstile: "t", wantFatal: true, wantMsg: "LANTERN_MAILER=log"},
		{name: "prod open ok", prod: true, mode: "open", turnstile: "t", mailDriver: "smtp", wantFatal: false},
		{name: "prod invite log mailer", prod: true, mode: "invite", invite: "x", wantFatal: true, wantMsg: "LANTERN_MAILER=log"},
		{name: "prod invite ok no captcha", prod: true, mode: "invite", invite: "x", mailDriver: "http", wantFatal: false},
		{name: "broken mailer config", mailDriver: "smtp", wantFatal: true, wantMsg: "LANTERN_SMTP_ADDR"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := ""
			if tc.prod {
				env = "production"
			}
			t.Setenv("PAL_ENV", env)
			t.Setenv("PAL_SIGNUP_MODE", tc.mode)
			t.Setenv("PAL_SIGNUP_INVITE_SECRET", tc.invite)
			t.Setenv("PAL_TURNSTILE_SECRET", tc.turnstile)
			t.Setenv("PAL_MAILER", tc.mailDriver)
			smtpAddr := "mx.example.test:587"
			if tc.name == "broken mailer config" {
				smtpAddr = ""
			}
			t.Setenv("PAL_SMTP_ADDR", smtpAddr)
			t.Setenv("PAL_MAIL_HTTP_URL", "https://mail.example.test/emails")
			fatal, msg := CheckSignupConfig(tc.prod)
			if fatal != tc.wantFatal || !strings.Contains(msg, tc.wantMsg) {
				t.Fatalf("got (%v, %q), want (%v, ~%q)", fatal, msg, tc.wantFatal, tc.wantMsg)
			}
		})
	}
}

func TestExportRedacted(t *testing.T) {
	for _, c := range []struct {
		table, col string
		want       bool
	}{
		{"users", "password_hash", true},
		{"api_keys", "key_hash", true},
		{"auth_tokens", "token_hash", true},
		{"llm_provider_configs", "api_key_encrypted", true},
		{"connector_installs", "oauth_token_encrypted", true},
		{"connector_installs", "config", true},
		{"voice_numbers", "provider_config", true},
		{"schedules", "config", false},
		{"users", "email", false},
	} {
		if got := exportRedacted(c.table, c.col); got != c.want {
			t.Errorf("%s.%s: got %v, want %v", c.table, c.col, got, c.want)
		}
	}
}

// TestExportRedacted_Catalog pins the export classification of every
// tenant-table column whose name looks credential-ish. A new such column fails
// here until it is listed — which forces someone to decide, rather than the
// export quietly shipping it.
func TestExportRedacted_Catalog(t *testing.T) {
	h, _ := newLifecycleHandler(t)
	want := map[string]bool{
		"agent_triggers.secret_enc":                true,
		"api_keys.key_hash":                        true,
		"auth_tokens.token_hash":                   true,
		"bridge_pairing_codes.code_hash":           true,
		"bridges.token_hash":                       true,
		"bridges.token_prefix":                     true,
		"connector_installs.config":                true,
		"connector_installs.oauth_token_encrypted": true,
		"data_planes.reg_token_hash":               true,
		"domain_records.fields_encrypted":          true,
		"llm_provider_configs.api_key_encrypted":   true,
		"users.password_hash":                      true,
		"voice_numbers.provider_config":            true,
		"agent_trigger_deliveries.replay_key":      false,
		"agent_mcp_attachments.config":             false,
		"data_planes.config":                       false,
		"schedules.config":                         false,
		"surface_configs.config":                   false,
		"api_keys.key_prefix":                      false,
		"commitments.idempotency_key":              false,
		"domain_records.idempotency_key":           false,
		"errands.idempotency_key":                  false,
		"life_events.idempotency_key":              false,
		"run_receipts.signature":                   false,
		"side_effect_receipts.idem_key":            false,
		"users.auth_provider":                      false,
		"users.auth_subject":                       false,
	}
	rows, err := h.srv.Pool.Query(context.Background(), `
		SELECT c.relname, a.attname
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE n.nspname = 'public' AND c.relkind = 'r'
		  AND EXISTS (SELECT 1 FROM pg_attribute t
			WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
		  AND a.attname ~* '(secret|token(_|$)|key|passw|hash|(^|_)enc(_|$)|encrypted|cred|cipher|signature|auth_|(^|_)config$)'
		  AND a.attname NOT LIKE 'tokens%' AND a.attname NOT LIKE 'max_tokens%' AND a.attname NOT LIKE 'estimated_tokens%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var table, col string
		if err := rows.Scan(&table, &col); err != nil {
			t.Fatal(err)
		}
		name := table + "." + col
		seen[name] = true
		redact, listed := want[name]
		if !listed {
			t.Errorf("%s (redacted=%v) is not classified: add it to this table after deciding whether it may be exported", name, exportRedacted(table, col))
			continue
		}
		if got := exportRedacted(table, col); got != redact {
			t.Errorf("%s: exportRedacted = %v, want %v", name, got, redact)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for name := range want {
		if !seen[name] {
			t.Errorf("%s listed but not in the catalog — drop it from this table", name)
		}
	}
	// A future column the pattern must catch without anyone listing it.
	for _, col := range []string{"webhook_secret", "bot_token", "signing_key", "refresh_token_enc", "client_credentials"} {
		if !exportRedacted("future_table", col) {
			t.Errorf("future_table.%s would be exported", col)
		}
	}
}

// fakeTurnstile answers siteverify with success when the token is "pass".
func fakeTurnstile(t *testing.T) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		ok := r.Form.Get("response") == "pass" && r.Form.Get("secret") == "ts-secret"
		_ = json.NewEncoder(w).Encode(map[string]bool{"success": ok})
	}))
	t.Cleanup(srv.Close)
	old := turnstileVerifyURL
	turnstileVerifyURL = srv.URL
	t.Cleanup(func() { turnstileVerifyURL = old })
}

func noDBAuthHandler() *AuthHandler {
	return NewAuthHandler(&server.Server{Logger: zap.NewNop()}, testJWTSecret)
}

// These requests are refused before any DB access, so a nil pool is fine.
func TestSignup_GatesBeforeDB(t *testing.T) {
	fakeTurnstile(t)
	body := map[string]string{"email": "gate@example.test", "password": "longenough-pass"}
	cases := []struct {
		name, env, mode, turnstile, captcha, invite string
		wantStatus                                  int
		wantErr                                     string
	}{
		{name: "closed", mode: "closed", wantStatus: 403, wantErr: "closed"},
		{name: "prod default is closed", env: "production", wantStatus: 403, wantErr: "closed"},
		{name: "invite without code", mode: "invite", wantStatus: 403, wantErr: "invite"},
		{name: "invite wrong email", mode: "invite", invite: mintInvite("inv", "other@example.test", time.Now().Add(time.Hour)), wantStatus: 403, wantErr: "invite"},
		{name: "prod open without captcha secret", env: "production", mode: "open", wantStatus: 503, wantErr: "not available"},
		{name: "captcha token missing", mode: "open", turnstile: "ts-secret", wantStatus: 400, wantErr: "captcha"},
		{name: "captcha rejected", mode: "open", turnstile: "ts-secret", captcha: "fail", wantStatus: 403, wantErr: "captcha"},
		{name: "prod captcha rejected", env: "production", mode: "open", turnstile: "ts-secret", captcha: "fail", wantStatus: 403, wantErr: "captcha"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setSignupEnv(t, tc.env, tc.mode, tc.turnstile)
			t.Setenv("PAL_SIGNUP_INVITE_SECRET", "inv")
			b := map[string]string{"email": body["email"], "password": body["password"], "captchaToken": tc.captcha, "inviteCode": tc.invite}
			rr := callJSON(noDBAuthHandler().Signup, "/auth/signup", b)
			if rr.Code != tc.wantStatus || !strings.Contains(rr.Body.String(), tc.wantErr) {
				t.Fatalf("got %d %s, want %d ~%q", rr.Code, rr.Body.String(), tc.wantStatus, tc.wantErr)
			}
		})
	}
}

func TestSignup_RejectsHeaderInjectionEmail(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	rr := callJSON(noDBAuthHandler().Signup, "/auth/signup",
		map[string]string{"email": "a@b.test\r\nBcc: x@y.test", "password": "longenough-pass"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rr.Code)
	}
}

func TestAuthRateLimits_429(t *testing.T) {
	setSignupEnv(t, "", "closed", "")
	cases := []struct {
		name  string
		fn    func(h *AuthHandler) http.HandlerFunc
		path  string
		body  map[string]string
		limit int
	}{
		{"signup per IP", func(h *AuthHandler) http.HandlerFunc { return h.Signup }, "/auth/signup",
			map[string]string{"email": "rl@example.test", "password": "longenough-pass"}, signupPerIPHour},
		{"verify per IP", func(h *AuthHandler) http.HandlerFunc { return h.VerifyEmail }, "/auth/verify",
			map[string]string{"token": "x"}, tokenUsePerIPHour},
		{"login per account", func(h *AuthHandler) http.HandlerFunc { return h.Login }, "/auth/login",
			map[string]string{"email": "rl@example.test", "password": "x"}, loginRateLimitMax},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := noDBAuthHandler()
			h.rl = newFakeRedis()
			// Pre-fill the counter to the limit (requests under it would hit the nil DB).
			key := map[string]string{
				"/auth/signup": "auth_rl:signup:ip:192.0.2.1",
				"/auth/verify": "auth_rl:verify_email:ip:192.0.2.1",
				"/auth/login":  "auth_rl:login:email:rl@example.test",
			}[tc.path]
			for i := 0; i < tc.limit; i++ {
				h.rl.Incr(context.Background(), key)
			}
			rr := callJSON(tc.fn(h), tc.path, tc.body)
			if rr.Code != http.StatusTooManyRequests {
				t.Fatalf("got %d %s, want 429", rr.Code, rr.Body.String())
			}
		})
	}
}

// ---------- DB-backed ----------

func newLifecycleHandler(t *testing.T) (*AuthHandler, *captureMailer) {
	t.Helper()
	pool := gdprTestDB(t) // migrates; skips without DATABASE_URL
	h := NewAuthHandler(&server.Server{Pool: pool, Logger: zap.NewNop()}, testJWTSecret)
	m := &captureMailer{}
	h.SetMailer(m)
	return h, m
}

func TestLifecycle_DevSignupVerifyIsSingleUse(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })

	rr := doSignup(h, email, "correct-horse-battery", "")
	if rr.Code != http.StatusCreated || !strings.Contains(rr.Body.String(), `"token"`) {
		t.Fatalf("dev signup: got %d %s", rr.Code, rr.Body.String())
	}
	tok := linkToken(t, m.waitFor(t, email))

	var verified *time.Time
	q := `SELECT email_verified_at FROM users WHERE email = $1`
	_ = h.srv.Pool.QueryRow(context.Background(), q, email).Scan(&verified)
	if verified != nil {
		t.Fatal("password sign-up must start unverified")
	}

	if rr := callJSON(h.VerifyEmail, "/auth/verify", map[string]string{"token": tok}); rr.Code != http.StatusOK {
		t.Fatalf("verify: got %d %s", rr.Code, rr.Body.String())
	}
	_ = h.srv.Pool.QueryRow(context.Background(), q, email).Scan(&verified)
	if verified == nil {
		t.Fatal("email_verified_at not set after verify")
	}
	if rr := callJSON(h.VerifyEmail, "/auth/verify", map[string]string{"token": tok}); rr.Code != http.StatusBadRequest {
		t.Fatalf("token reuse: got %d, want 400", rr.Code)
	}
	// The DB never holds the raw token.
	var n int
	_ = h.srv.Pool.QueryRow(context.Background(), `SELECT count(*) FROM auth_tokens WHERE token_hash = $1`, tok).Scan(&n)
	if n != 0 {
		t.Fatal("raw token stored in auth_tokens")
	}
}

func TestLifecycle_ExpiredAndWrongPurposeTokens(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	doSignup(h, email, "correct-horse-battery", "")
	verifyTok := linkToken(t, m.waitFor(t, email))

	// A verify token can't reset a password.
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": verifyTok, "password": "another-long-password"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("wrong purpose: got %d, want 400", rr.Code)
	}
	// Expire it; then it can't verify either.
	_, err := h.srv.Pool.Exec(context.Background(),
		`UPDATE auth_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, hashAuthToken(verifyTok))
	if err != nil {
		t.Fatal(err)
	}
	rr := callJSON(h.VerifyEmail, "/auth/verify", map[string]string{"token": verifyTok})
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "invalid or expired") {
		t.Fatalf("expired: got %d %s", rr.Code, rr.Body.String())
	}
	if rr := callJSON(h.VerifyEmail, "/auth/verify", map[string]string{"token": "never-issued"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown token: got %d", rr.Code)
	}
}

func TestLifecycle_ProdSignupRequiresVerification(t *testing.T) {
	fakeTurnstile(t)
	setSignupEnv(t, "production", "open", "ts-secret")
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	signup := map[string]string{"email": email, "password": "correct-horse-battery", "captchaToken": "pass"}

	first := callJSON(h.Signup, "/auth/signup", signup)
	if first.Code != http.StatusAccepted || strings.Contains(first.Body.String(), `"token"`) {
		t.Fatalf("prod signup: got %d %s (want 202, no JWT)", first.Code, first.Body.String())
	}
	// Enumeration-safe: a repeat sign-up for the same email looks identical.
	again := callJSON(h.Signup, "/auth/signup", signup)
	if again.Code != first.Code || again.Body.String() != first.Body.String() {
		t.Fatalf("duplicate signup differs: %d %s vs %d %s", again.Code, again.Body.String(), first.Code, first.Body.String())
	}

	rr := doLogin(h, email, "correct-horse-battery")
	if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), "email_unverified") {
		t.Fatalf("unverified login: got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doLogin(h, email, "wrong-password-here"); rr.Code != http.StatusUnauthorized {
		t.Fatalf("bad password must stay 401 (no verification leak), got %d", rr.Code)
	}

	tok := linkToken(t, m.waitFor(t, email))
	if rr := callJSON(h.VerifyEmail, "/auth/verify", map[string]string{"token": tok}); rr.Code != http.StatusOK {
		t.Fatalf("verify: %d", rr.Code)
	}
	if rr := doLogin(h, email, "correct-horse-battery"); rr.Code != http.StatusOK {
		t.Fatalf("verified login: got %d %s", rr.Code, rr.Body.String())
	}
}

func TestLifecycle_ForgotResetIsEnumerationSafeAndSingleUse(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	doSignup(h, email, "correct-horse-battery", "")
	m.waitFor(t, email) // the verification mail

	known := callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": email})
	unknown := callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": "nobody-" + email})
	if known.Code != http.StatusAccepted || known.Code != unknown.Code || known.Body.String() != unknown.Body.String() {
		t.Fatalf("forgot responses differ: %d %s vs %d %s", known.Code, known.Body.String(), unknown.Code, unknown.Body.String())
	}
	resend := callJSON(h.ResendVerification, "/auth/verify/resend", map[string]string{"email": "nobody-" + email})
	if resend.Code != known.Code || resend.Body.String() != known.Body.String() {
		t.Fatalf("resend for unknown email differs: %d %s", resend.Code, resend.Body.String())
	}

	// Two reset mails; using the second must burn the first.
	callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": email})
	deadline := time.Now().Add(2 * time.Second)
	for m.count() < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	m.mu.Lock()
	var resetToks []string
	for _, msg := range m.msgs {
		if msg.To == email && strings.Contains(msg.Subject, "Reset") {
			resetToks = append(resetToks, tokenInLink.FindStringSubmatch(msg.Text)[1])
		}
		if strings.HasPrefix(msg.To, "nobody-") {
			t.Errorf("mail sent to unknown address %s", msg.To)
		}
	}
	m.mu.Unlock()
	if len(resetToks) != 2 {
		t.Fatalf("want 2 reset mails, got %d", len(resetToks))
	}

	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": resetToks[1], "password": "short"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("short password: got %d", rr.Code)
	}
	if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": resetToks[1], "password": "brand-new-password-1"}); rr.Code != http.StatusOK {
		t.Fatalf("reset: got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doLogin(h, email, "brand-new-password-1"); rr.Code != http.StatusOK {
		t.Fatalf("login with new password: %d", rr.Code)
	}
	if rr := doLogin(h, email, "correct-horse-battery"); rr.Code != http.StatusUnauthorized {
		t.Fatalf("old password still works: %d", rr.Code)
	}
	for i, tok := range resetToks {
		if rr := callJSON(h.ResetPassword, "/auth/reset", map[string]string{"token": tok, "password": "yet-another-password"}); rr.Code != http.StatusBadRequest {
			t.Fatalf("reset token %d reusable after reset: got %d", i, rr.Code)
		}
	}
}

func TestLifecycle_ForgotRateLimitedPerEmail(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	h, _ := newLifecycleHandler(t)
	h.rl = newFakeRedis()
	email := "nobody-rl-" + uniqueEmail(t)
	for i := 0; i < mailPerEmailHour; i++ {
		if rr := callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": email}); rr.Code != http.StatusAccepted {
			t.Fatalf("attempt %d: got %d", i+1, rr.Code)
		}
	}
	if rr := callJSON(h.ForgotPassword, "/auth/forgot", map[string]string{"email": email}); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("over limit: got %d, want 429", rr.Code)
	}
}

func TestExportTenant(t *testing.T) {
	setSignupEnv(t, "", "open", "")
	h, m := newLifecycleHandler(t)
	email := uniqueEmail(t)
	t.Cleanup(func() { cleanupUserByEmail(t, h, email) })
	rr := doSignup(h, email, "correct-horse-battery", "")
	var resp authResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	m.waitFor(t, email)
	g := NewGDPRHandler(h.srv, h)
	// A webhook trigger's signing secret (plaintext JSON when
	// LANTERN_CREDENTIAL_KEY is unset) once rode along in the export.
	const triggerSecret = "whsec-export-canary-7f3a"
	if _, err := h.srv.Pool.Exec(context.Background(),
		`INSERT INTO agent_triggers (tenant_id, agent_name, provider, secret_enc) VALUES ($1, 'export-agent', 'generic', to_jsonb($2::text))`,
		resp.User.TenantID, triggerSecret); err != nil {
		t.Fatalf("seed trigger: %v", err)
	}

	export := func(token, id string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+id+"/export", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.SetPathValue("id", id)
		rr := httptest.NewRecorder()
		g.ExportTenant(rr, req)
		return rr
	}

	got := export(resp.Token, resp.User.TenantID)
	if got.Code != http.StatusOK {
		t.Fatalf("export: %d %s", got.Code, got.Body.String())
	}
	var doc struct {
		TenantID string                      `json:"tenantId"`
		Tables   map[string][]map[string]any `json:"tables"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	users := doc.Tables["users"]
	if len(users) != 1 || users[0]["email"] != email {
		t.Fatalf("users export = %v", users)
	}
	if _, leaked := users[0]["password_hash"]; leaked {
		t.Fatal("password_hash exported")
	}
	if toks := doc.Tables["auth_tokens"]; len(toks) != 1 || toks[0]["token_hash"] != nil {
		t.Fatalf("auth_tokens export = %v (want 1 row, token_hash redacted)", toks)
	}
	if len(doc.Tables["tenants"]) != 1 {
		t.Fatal("tenant row missing")
	}
	if trg := doc.Tables["agent_triggers"]; len(trg) != 1 || trg[0]["secret_enc"] != nil {
		t.Fatalf("agent_triggers export = %v (want 1 row, secret_enc redacted)", trg)
	}
	if strings.Contains(got.Body.String(), triggerSecret) {
		t.Fatal("trigger secret present in export")
	}

	if rr := export(resp.Token, "00000000-0000-0000-0000-000000000001"); rr.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant export: got %d, want 404", rr.Code)
	}
	member := mintTestToken(t, resp.User.TenantID, resp.User.ID, "member")
	if rr := export(member, resp.User.TenantID); rr.Code != http.StatusForbidden {
		t.Fatalf("member export: got %d, want 403", rr.Code)
	}
	if rr := export("", resp.User.TenantID); rr.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous export: got %d, want 401", rr.Code)
	}
}

// TestRLSExportTenant runs the export through the lantern_app pool with RLS
// genuinely enforced: every tenant table must be readable (grants) and the
// export must contain this tenant's rows only.
func TestRLSExportTenant(t *testing.T) {
	e := newEnforcedServer(t)
	tenantA := seedEnforcedTenant(t, e, "rls-export-a-"+strings.ToLower(uniqueEmail(t)[9:15]))
	tenantB := seedEnforcedTenant(t, e, "rls-export-b-"+strings.ToLower(uniqueEmail(t)[9:15]))
	ctx := context.Background()
	for _, tid := range []string{tenantA, tenantB} {
		if _, err := e.superPool.Exec(ctx, `
			INSERT INTO life_events (tenant_id, kind, channel, summary) VALUES ($1, 'bill', 'imessage', 'summary')
		`, tid); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = e.superPool.Exec(ctx, `DELETE FROM life_events WHERE tenant_id = ANY($1)`, []string{tenantA, tenantB})
	})

	auth := NewAuthHandler(e.srv, testJWTSecret)
	g := NewGDPRHandler(e.srv, auth)
	req := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+tenantA+"/export", nil)
	req.Header.Set("Authorization", "Bearer "+mintTestToken(t, tenantA, "u", "owner"))
	req.SetPathValue("id", tenantA)
	rr := httptest.NewRecorder()
	g.ExportTenant(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("enforced export: %d %s", rr.Code, rr.Body.String())
	}
	var doc struct {
		Tables map[string][]map[string]any `json:"tables"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	evs := doc.Tables["life_events"]
	if len(evs) != 1 || evs[0]["tenant_id"] != tenantA {
		t.Fatalf("life_events export = %v, want exactly tenant A's row", evs)
	}
}

// TestExportRoute_ReadScopedKeyForbiddenUnderEnforce: the export route is
// registered behind WithScope(admin), so a read-only API key gets the scope
// 403 when LANTERN_AUTHZ_ENFORCE=1.
func TestExportRoute_ReadScopedKeyForbiddenUnderEnforce(t *testing.T) {
	t.Setenv("PAL_AUTHZ_ENFORCE", "1")
	pool := gdprTestDB(t)
	srv := &server.Server{Pool: pool, Logger: zap.NewNop()}
	auth := NewAuthHandler(srv, testJWTSecret)
	mux := http.NewServeMux()
	if err := RegisterAccountLifecycleRoutes(mux, auth, NewGDPRHandler(srv, auth), false); err != nil {
		t.Fatal(err)
	}

	raw := "hlx_live_w1cexport_" + uniqueEmail(t)[9:21]
	sum := sha256.Sum256([]byte(raw))
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES ($1, 'w1c-export-test', $2, $3, $4)`,
		devTenantID, hex.EncodeToString(sum[:]), raw[:8], []string{"read"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM api_keys WHERE name = 'w1c-export-test'`)
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/tenants/"+devTenantID+"/export", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), "missing required scope") {
		t.Fatalf("got %d %s, want 403 missing scope", rr.Code, rr.Body.String())
	}
}
