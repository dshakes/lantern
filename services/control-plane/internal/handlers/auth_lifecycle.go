package handlers

// auth_lifecycle.go — sign-up gating, email verification, password reset and
// /auth/* rate limiting (ADR 0027).
//
//	POST /auth/verify          {token}            → 200 {verified:true}
//	POST /auth/verify/resend   {email}            → 202 (same body for any email)
//	POST /auth/forgot          {email}            → 202 (same body for any email)
//	POST /auth/reset           {token, password}  → 200 {reset:true}
//
// Tokens are 32 random bytes; only their SHA-256 is stored (auth_tokens) and
// consuming one is a single conditional UPDATE, so a token works exactly once
// and never after expiry. Every query here runs before a tenant context exists
// — the same position as login — so they use the privileged pool.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"

	"github.com/dshakes/lantern/services/control-plane/internal/mailer"
)

// Sign-up modes (LANTERN_SIGNUP_MODE).
const (
	signupOpen   = "open"
	signupInvite = "invite"
	signupClosed = "closed"
)

// Token purposes and lifetimes.
const (
	purposeVerifyEmail   = "verify_email"
	purposeResetPassword = "reset_password"
	verifyTokenTTL       = 24 * time.Hour
	resetTokenTTL        = time.Hour
)

// /auth/* rate limits (fixed window). Login keeps its own 10/min in auth.go.
const (
	signupPerIPHour    = 10
	mailPerEmailHour   = 5
	mailPerIPHour      = 20
	tokenUsePerIPHour  = 20
	authRateLimitHour  = time.Hour
	mailSendTimeout    = 30 * time.Second
	turnstileTimeout   = 10 * time.Second
	genericMailMessage = "If that address has an account, we've sent it a link."
)

// turnstileVerifyURL is a var so tests can point it at a fake.
var turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

var errInvalidToken = errors.New("invalid or expired token")

// signupMode returns LANTERN_SIGNUP_MODE, defaulting to closed in prod and open
// in dev. An unrecognised value is returned as-is; the handler treats anything
// but open/invite as closed and the startup guard refuses it.
func signupMode() string {
	if m := strings.ToLower(strings.TrimSpace(os.Getenv("PAL_SIGNUP_MODE"))); m != "" {
		return m
	}
	if isProd() {
		return signupClosed
	}
	return signupOpen
}

// requireEmailVerification gates sign-up tokens and login on a verified email.
// Prod only: dev keeps the one-step sign-up so `make dev` works unchanged.
func requireEmailVerification() bool { return isProd() }

// requireVerifiedEmail is the run-creation gate (defense in depth: login and
// sign-up already withhold tokens from unverified local users). When the
// account mode requires verification and the caller's user has not verified,
// it answers 403 {code:"email_unverified"} and returns false. API-key (service)
// callers pass: keys are minted by a session that was already verified.
func (h *AuthHandler) requireVerifiedEmail(w http.ResponseWriter, r *http.Request) bool {
	if !requireEmailVerification() {
		return true
	}
	claims := claimsFromCtx(r.Context())
	if claims == nil {
		var err error
		if claims, err = h.validateRequest(r); err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return false
		}
	}
	if claims.Role == "service" {
		return true
	}
	var verified bool
	// rls-exempt: users is resolved by the JWT subject + tenant, same as login.
	err := h.srv.Pool.QueryRow(r.Context(), `
		SELECT email_verified_at IS NOT NULL OR auth_provider <> 'local'
		FROM users WHERE id = $1 AND tenant_id = $2`, claims.Subject, claims.TenantID).Scan(&verified)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		h.logger().Error("verify gate: user lookup failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return false
	}
	if !verified { // also covers an unknown user: fail closed
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "verify your email to run agents", "code": "email_unverified"})
		return false
	}
	return true
}

// captchaConfig reports whether sign-up needs a captcha and the secret to
// check it with. Prod open sign-up always needs one, configured or not.
func captchaConfig() (required bool, secret string) {
	secret = os.Getenv("PAL_TURNSTILE_SECRET")
	return secret != "" || (isProd() && signupMode() == signupOpen), secret
}

// CheckSignupConfig is the startup guard for ADR 0027, run by
// RegisterAccountLifecycleRoutes. Same (fatal, message) contract as CheckSchedulerAddr.
func CheckSignupConfig(prod bool) (fatal bool, message string) {
	if _, err := mailer.FromEnv(zap.NewNop(), prod); err != nil {
		return true, err.Error()
	}
	mode := signupMode()
	switch mode {
	case signupOpen, signupInvite, signupClosed:
	default:
		return true, fmt.Sprintf("LANTERN_SIGNUP_MODE=%q is not one of open, invite, closed", mode)
	}
	if mode == signupInvite && os.Getenv("PAL_SIGNUP_INVITE_SECRET") == "" {
		return true, "LANTERN_SIGNUP_MODE=invite needs LANTERN_SIGNUP_INVITE_SECRET to verify invite codes"
	}
	if !prod || mode == signupClosed {
		return false, ""
	}
	if mode == signupOpen && os.Getenv("PAL_TURNSTILE_SECRET") == "" {
		return true, "LANTERN_SIGNUP_MODE=open in production needs LANTERN_TURNSTILE_SECRET (captcha is required for open sign-up)"
	}
	if mailer.Driver() == mailer.DriverLog {
		return true, "sign-up is " + mode + " in production but LANTERN_MAILER=log — new users could never receive their verification link; set LANTERN_MAILER=smtp or http"
	}
	return false, ""
}

// inviteCodeValid checks "<expUnix>.<hex HMAC-SHA256(secret, lower(email)|exp)>".
func inviteCodeValid(secret, email, code string, now time.Time) bool {
	if secret == "" {
		return false
	}
	expStr, sig, ok := strings.Cut(code, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || now.Unix() > exp {
		return false
	}
	want, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.ToLower(email) + "|" + expStr))
	return hmac.Equal(mac.Sum(nil), want)
}

// validEmail accepts a bare address only (no display name, no CR/LF), so the
// value is safe to use as a mail header.
func validEmail(s string) bool {
	a, err := mail.ParseAddress(s)
	return err == nil && a.Address == s
}

// authRateLimited counts one hit on key and reports whether max was exceeded
// within window. Redis fixed window; EXPIRE on every hit so a lost EXPIRE can
// never leave a permanent lockout (see spawn_ratelimit.go). Fails open when
// Redis is absent or erroring — an outage must not lock owners out.
func (h *AuthHandler) authRateLimited(ctx context.Context, key string, max int, window time.Duration) bool {
	if h.rl == nil {
		return false
	}
	redisKey := "auth_rl:" + key
	n, err := h.rl.Incr(ctx, redisKey).Result()
	if err != nil {
		return false
	}
	h.rl.Expire(ctx, redisKey, window) //nolint:errcheck
	return n > int64(max)
}

func writeTooMany(w http.ResponseWriter) {
	writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many requests; please try again later"})
}

// checkCaptcha enforces Turnstile when required. Returns the HTTP status to
// reply with, or 0 when the request may proceed.
func (h *AuthHandler) checkCaptcha(ctx context.Context, token, ip string) (int, string) {
	required, secret := captchaConfig()
	if !required {
		return 0, ""
	}
	if secret == "" {
		h.logger().Error("sign-up refused: captcha required but LANTERN_TURNSTILE_SECRET is unset")
		return http.StatusServiceUnavailable, "sign-up is not available"
	}
	if token == "" {
		return http.StatusBadRequest, "captcha is required"
	}
	ctx, cancel := context.WithTimeout(ctx, turnstileTimeout)
	defer cancel()
	form := url.Values{"secret": {secret}, "response": {token}, "remoteip": {ip}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, turnstileVerifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		h.logger().Error("captcha: build request", zap.Error(err))
		return http.StatusServiceUnavailable, "captcha verification unavailable"
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.logger().Warn("captcha: siteverify call failed", zap.Error(err))
		return http.StatusServiceUnavailable, "captcha verification unavailable"
	}
	defer resp.Body.Close()
	var out struct {
		Success bool `json:"success"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || !out.Success {
		return http.StatusForbidden, "captcha verification failed"
	}
	return 0, ""
}

// newAuthToken returns a random token and the SHA-256 hex stored for it.
func newAuthToken() (raw, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("auth token: read random: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, hashAuthToken(raw), nil
}

func hashAuthToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// insertAuthToken stores a fresh token for (user, purpose) and returns the raw value.
func insertAuthToken(ctx context.Context, tx pgx.Tx, tenantID, userID, purpose string, ttl time.Duration) (string, error) {
	raw, hash, err := newAuthToken()
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO auth_tokens (token_hash, tenant_id, user_id, purpose, expires_at)
		VALUES ($1, $2, $3, $4, now() + $5::interval)
	`, hash, tenantID, userID, purpose, fmt.Sprintf("%d seconds", int(ttl.Seconds()))); err != nil {
		return "", fmt.Errorf("insert %s token for user %s: %w", purpose, userID, err)
	}
	return raw, nil
}

// issueAuthToken is insertAuthToken in its own transaction.
func (h *AuthHandler) issueAuthToken(ctx context.Context, tenantID, userID, purpose string, ttl time.Duration) (string, error) {
	// rls-exempt: pre-auth token issue (verify/reset) — no tenant context yet.
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin token tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	raw, err := insertAuthToken(ctx, tx, tenantID, userID, purpose, ttl)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit token tx: %w", err)
	}
	return raw, nil
}

// consumeAuthToken burns the token inside tx. Unknown, reused, expired and
// wrong-purpose tokens all return errInvalidToken.
func consumeAuthToken(ctx context.Context, tx pgx.Tx, raw, purpose string) (userID, tenantID string, err error) {
	if raw == "" {
		return "", "", errInvalidToken
	}
	err = tx.QueryRow(ctx, `
		UPDATE auth_tokens SET used_at = now()
		WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
		RETURNING user_id, tenant_id
	`, hashAuthToken(raw), purpose).Scan(&userID, &tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", errInvalidToken
	}
	if err != nil {
		return "", "", fmt.Errorf("consume %s token: %w", purpose, err)
	}
	return userID, tenantID, nil
}

// sendMail delivers in the background so response time never depends on
// whether the address exists (enumeration) or on relay latency. The goroutine
// is bounded by mailSendTimeout.
func (h *AuthHandler) sendMail(m mailer.Message) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), mailSendTimeout)
		defer cancel()
		if err := h.mailer.Send(ctx, m); err != nil {
			h.logger().Error("auth mail send failed", zap.String("subject", m.Subject), zap.Error(err))
		}
	}()
}

func dashboardLink(path, token string) string {
	return strings.TrimRight(oauthDashboardURL(), "/") + path + "?token=" + url.QueryEscape(token)
}

func (h *AuthHandler) sendVerifyMail(to, token string) {
	h.sendMail(mailer.Message{
		To:      to,
		Subject: "Verify your Lantern email",
		Text: "Confirm this address to finish setting up your Lantern account:\n\n" +
			dashboardLink("/auth/verify", token) +
			"\n\nThe link works once and expires in 24 hours. If you didn't sign up, ignore this email.\n",
	})
}

func (h *AuthHandler) sendResetMail(to, token string) {
	h.sendMail(mailer.Message{
		To:      to,
		Subject: "Reset your Lantern password",
		Text: "Someone (hopefully you) asked to reset your Lantern password:\n\n" +
			dashboardLink("/auth/reset", token) +
			"\n\nThe link works once and expires in 1 hour. If you didn't ask, ignore this email — your password is unchanged.\n",
	})
}

// lookupLocalUser finds a password (local) user by email, optionally only if
// unverified. ok=false means no such user — callers must not reveal that.
func (h *AuthHandler) lookupLocalUser(ctx context.Context, email string, onlyUnverified bool) (userID, tenantID string, ok bool, err error) {
	// rls-exempt: pre-auth lookup by email across tenants (forgot/resend).
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, tenant_id FROM users
		WHERE email = $1 AND auth_provider = 'local'
		  AND (NOT $2 OR email_verified_at IS NULL)
		LIMIT 1
	`, email, onlyUnverified).Scan(&userID, &tenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, fmt.Errorf("lookup local user: %w", err)
	}
	return userID, tenantID, true, nil
}

type emailRequest struct {
	Email string `json:"email"`
}

type tokenRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// mailLinkHandler is the shared body of /auth/forgot and /auth/verify/resend:
// rate-limit, look up, maybe send — and always answer the same 202.
func (h *AuthHandler) mailLinkHandler(w http.ResponseWriter, r *http.Request, bucket string, onlyUnverified bool, send func(userID, tenantID, email string) error) {
	var req emailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validEmail(req.Email) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a valid email is required"})
		return
	}
	ctx := r.Context()
	if h.authRateLimited(ctx, bucket+":ip:"+remoteIP(r), mailPerIPHour, authRateLimitHour) ||
		h.authRateLimited(ctx, bucket+":email:"+strings.ToLower(req.Email), mailPerEmailHour, authRateLimitHour) {
		writeTooMany(w)
		return
	}
	userID, tenantID, ok, err := h.lookupLocalUser(ctx, req.Email, onlyUnverified)
	if err != nil {
		h.logger().Error(bucket+": lookup failed", zap.Error(err))
	} else if ok {
		if err := send(userID, tenantID, req.Email); err != nil {
			h.logger().Error(bucket+": issue token failed", zap.String("user_id", userID), zap.Error(err))
		}
	}
	// Same answer whether or not the account exists (or a DB error happened).
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "ok", "message": genericMailMessage})
}

// RegisterAccountLifecycleRoutes wires the ADR 0027 routes after checking the
// sign-up/mailer configuration; an error means the server must not start. The
// /auth/* routes are pre-auth (the emailed token or the email itself is the
// input); export is owner-only like the GDPR purge.
func RegisterAccountLifecycleRoutes(mux *http.ServeMux, auth *AuthHandler, gdpr *GDPRHandler, prod bool) error {
	if fatal, msg := CheckSignupConfig(prod); fatal {
		return errors.New(msg)
	}
	mux.HandleFunc("POST /auth/verify", auth.VerifyEmail)
	mux.HandleFunc("POST /auth/verify/resend", auth.ResendVerification)
	mux.HandleFunc("POST /auth/forgot", auth.ForgotPassword)
	mux.HandleFunc("POST /auth/reset", auth.ResetPassword)
	mux.HandleFunc("GET /v1/tenants/{id}/export", auth.WithScope(ScopeAdmin, gdpr.ExportTenant))
	return nil
}

// ForgotPassword handles POST /auth/forgot.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	h.mailLinkHandler(w, r, "forgot", false, func(userID, tenantID, email string) error {
		token, err := h.issueAuthToken(r.Context(), tenantID, userID, purposeResetPassword, resetTokenTTL)
		if err != nil {
			return err
		}
		h.sendResetMail(email, token)
		return nil
	})
}

// ResendVerification handles POST /auth/verify/resend.
func (h *AuthHandler) ResendVerification(w http.ResponseWriter, r *http.Request) {
	h.mailLinkHandler(w, r, "resend", true, func(userID, tenantID, email string) error {
		token, err := h.issueAuthToken(r.Context(), tenantID, userID, purposeVerifyEmail, verifyTokenTTL)
		if err != nil {
			return err
		}
		h.sendVerifyMail(email, token)
		return nil
	})
}

// consumeInTx runs the shared token-use prologue (decode, rate limit, begin,
// consume) and hands the tx to apply. It writes every error response itself
// and returns false when the request is finished.
func (h *AuthHandler) consumeInTx(w http.ResponseWriter, r *http.Request, purpose string, req *tokenRequest, apply func(ctx context.Context, tx pgx.Tx, userID string) error) bool {
	ctx := r.Context()
	if h.authRateLimited(ctx, purpose+":ip:"+remoteIP(r), tokenUsePerIPHour, authRateLimitHour) {
		writeTooMany(w)
		return false
	}
	// rls-exempt: pre-auth token redemption — the token IS the credential and
	// resolves the tenant; there is no tenant context before it is consumed.
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		h.logger().Error(purpose+": begin tx", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return false
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	userID, _, err := consumeAuthToken(ctx, tx, req.Token, purpose)
	if errors.Is(err, errInvalidToken) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errInvalidToken.Error()})
		return false
	}
	if err == nil {
		err = apply(ctx, tx, userID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		h.logger().Error(purpose+": failed", zap.String("user_id", userID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return false
	}
	h.logger().Info(purpose+": token redeemed", zap.String("user_id", userID))
	return true
}

// VerifyEmail handles POST /auth/verify.
func (h *AuthHandler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	ok := h.consumeInTx(w, r, purposeVerifyEmail, &req, func(ctx context.Context, tx pgx.Tx, userID string) error {
		_, err := tx.Exec(ctx, `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, userID)
		return err
	})
	if ok {
		writeJSON(w, http.StatusOK, map[string]bool{"verified": true})
	}
}

// ResetPassword handles POST /auth/reset.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if len(req.Password) < 12 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 12 characters"})
		return
	}
	// Hash before opening the tx so bcrypt's ~100ms never holds a row lock.
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		h.logger().Error("reset: bcrypt failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	ok := h.consumeInTx(w, r, purposeResetPassword, &req, func(ctx context.Context, tx pgx.Tx, userID string) error {
		// Resetting proves inbox ownership, so it also verifies the email.
		if _, err := tx.Exec(ctx, `
			UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now())
			WHERE id = $1
		`, userID, string(hash)); err != nil {
			return fmt.Errorf("update password: %w", err)
		}
		// Burn every other outstanding reset link for this user.
		if _, err := tx.Exec(ctx, `
			UPDATE auth_tokens SET used_at = now()
			WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL
		`, userID, purposeResetPassword); err != nil {
			return fmt.Errorf("burn other reset tokens: %w", err)
		}
		return nil
	})
	if ok {
		writeJSON(w, http.StatusOK, map[string]bool{"reset": true})
	}
}
