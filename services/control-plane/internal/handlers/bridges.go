package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// BridgeHandler is the device-tenancy surface for PAL (ADR 0047): a signed-in
// user mints a one-time pairing code, a device (the bridge appliance on the
// user's Mac, or an iPhone Shortcuts signal source) redeems it for a per-tenant
// bridge credential, and the user lists / revokes paired devices.
//
// Trust model:
//   - enroll / list / revoke are tenant-scoped (JWT or a scoped API key) and run
//     through s.srv.WithTenant, so RLS admits only the caller's own rows.
//   - pair is UNAUTHENTICATED by construction — the device has no credential
//     yet. The pairing code IS the credential: 50 bits, single-use, 10-minute
//     TTL, stored only as a SHA-256 hash, per-IP + global rate-limited.
//   - A bridge token authenticates ONLY the bridge endpoints (signals, self
//     rotation). It is deliberately NOT accepted by validateRequest, so a stolen
//     device credential cannot drive the rest of the tenant's API.
type BridgeHandler struct {
	srv     *server.Server
	auth    *AuthHandler
	limiter *pairLimiter
	now     func() time.Time
}

// NewBridgeHandler creates a BridgeHandler.
func NewBridgeHandler(srv *server.Server, auth *AuthHandler) *BridgeHandler {
	return &BridgeHandler{srv: srv, auth: auth, limiter: newPairLimiter(10, 300, time.Minute), now: time.Now}
}

func (h *BridgeHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("bridges")
}

// Bridge scopes. A bridge credential carries a subset of these and nothing
// else; they are disjoint from the API-key lattice in auth.go on purpose.
const (
	ScopeBridgeSignalsWrite Scope = "bridge:signals:write"
	ScopeBridgeSignalsRead  Scope = "bridge:signals:read"
)

// bridgeTokenPrefix marks a bridge credential so the signals endpoint can route
// it without a JWT parse. The prefix is not secret.
const bridgeTokenPrefix = "pal_brg_"

const (
	pairingCodeTTL         = 10 * time.Minute
	pairingCodeLen         = 10 // Crockford base32 chars → 50 bits
	maxActivePairingCodes  = 5
	bridgeTokenPrefixShown = 16
)

// bridgePlatformScopes is the scope ceiling (and default) per device platform.
// A Shortcuts source only ever writes signals; the Mac bridge reads them back.
var bridgePlatformScopes = map[string][]Scope{
	"macos":         {ScopeBridgeSignalsWrite, ScopeBridgeSignalsRead},
	"ios-shortcuts": {ScopeBridgeSignalsWrite},
}

// crockford is Crockford base32 (no I, L, O, U) — unambiguous to read off a
// screen and type on a Mac.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newPairingCode returns a fresh code formatted XXXXX-XXXXX.
func newPairingCode() (string, error) {
	b := make([]byte, pairingCodeLen)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 0, pairingCodeLen+1)
	for i, v := range b {
		if i == pairingCodeLen/2 {
			out = append(out, '-')
		}
		out = append(out, crockford[int(v)%len(crockford)]) // 256 % 32 == 0: unbiased
	}
	return string(out), nil
}

// normalizePairingCode canonicalizes user-typed input: case-folds, drops
// separators/whitespace, and maps the Crockford look-alikes (O→0, I/L→1).
// Returns "" when the result is not a well-formed code.
func normalizePairingCode(raw string) string {
	var sb strings.Builder
	for _, r := range strings.ToUpper(raw) {
		switch {
		case r == '-' || r == ' ' || r == '\t':
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		if !strings.ContainsRune(crockford, r) {
			return ""
		}
		sb.WriteRune(r)
	}
	if sb.Len() != pairingCodeLen {
		return ""
	}
	return sb.String()
}

// sha256Hex is the at-rest form of every high-entropy device secret (codes and
// tokens). Same scheme as api_keys.key_hash: the inputs carry ≥50 bits of
// CSPRNG entropy, so a fast hash is the right tool (no password stretching).
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// newBridgeToken mints a bridge credential: prefix + 256 random bits.
func newBridgeToken() (string, error) {
	r, err := randomHex(32)
	if err != nil {
		return "", err
	}
	return bridgeTokenPrefix + r, nil
}

// bridgeIdentity is the authenticated principal behind a bridge token.
type bridgeIdentity struct {
	BridgeID string
	TenantID string
	Scopes   []string
}

func (b *bridgeIdentity) has(s Scope) bool { return slices.Contains(b.Scopes, s) }

var errBridgeUnauthorized = errors.New("invalid bridge credential")

// authenticateBridge resolves a raw bridge token to its tenant. Revoked tokens
// and unknown tokens are indistinguishable to the caller.
func authenticateBridge(ctx context.Context, srv *server.Server, raw string) (*bridgeIdentity, error) {
	if !strings.HasPrefix(raw, bridgeTokenPrefix) || srv.Pool == nil {
		return nil, errBridgeUnauthorized
	}
	id := &bridgeIdentity{}
	// rls-exempt: pre-auth bridge-token validation — resolves the owning tenant
	// from the token hash across all tenants; the tenant is the OUTPUT here
	// (same shape as validateAPIKey).
	err := srv.Pool.QueryRow(ctx, `
		SELECT id, tenant_id, scopes FROM bridges
		WHERE token_hash = $1 AND revoked_at IS NULL
	`, sha256Hex(raw)).Scan(&id.BridgeID, &id.TenantID, &id.Scopes)
	if err != nil {
		return nil, errBridgeUnauthorized
	}
	// Best-effort liveness stamp, throttled to one write a minute per device.
	// rls-exempt: pre-auth bookkeeping by bridge id resolved just above.
	_, _ = srv.Pool.Exec(ctx, `
		UPDATE bridges SET last_seen_at = now()
		WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')
	`, id.BridgeID)
	return id, nil
}

// bearerToken returns the bearer credential from Authorization, or "".
func bearerToken(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// userContext authenticates a tenant user (JWT or API key) for the management
// endpoints and enforces settings:write unconditionally — minting or revoking a
// device credential is a credential-management action, so it is not left to
// the PAL_AUTHZ_ENFORCE staging flag. Kiosk (demo) sessions never qualify.
func (h *BridgeHandler) userContext(w http.ResponseWriter, r *http.Request, required Scope) (context.Context, *PalClaims, bool) {
	if strings.HasPrefix(bearerToken(r), bridgeTokenPrefix) {
		// A device must never manage devices (no lateral re-pairing).
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "bridge credentials cannot manage bridges"})
		return nil, nil, false
	}
	claims := claimsFromCtx(r.Context())
	if claims == nil {
		c, err := h.auth.validateRequest(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return nil, nil, false
		}
		claims = c
	}
	if claims.TenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil, nil, false
	}
	if claims.Role == kioskRole || !HasScope(claims, required) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "missing required scope: " + required})
		return nil, nil, false
	}
	middleware.EnrichSpan(r.Context(), claims.TenantID, claims.Subject, "", "")
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims, true
}

// ---------- wire types ----------

type bridgeJSON struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Platform    string   `json:"platform"`
	TokenPrefix string   `json:"tokenPrefix"`
	Scopes      []string `json:"scopes"`
	CreatedAt   string   `json:"createdAt"`
	RotatedAt   string   `json:"rotatedAt,omitempty"`
	LastSeenAt  string   `json:"lastSeenAt,omitempty"`
	RevokedAt   string   `json:"revokedAt,omitempty"`
}

func fmtTS(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// ---------- handlers ----------

// Enroll handles POST /v1/bridges/enroll: mints a one-time pairing code bound
// to the caller's tenant. Body (all optional): {name, platform, scopes}.
// Returns {id, code, expiresAt, platform, scopes}. The plaintext code is
// returned exactly once and never stored.
func (h *BridgeHandler) Enroll(w http.ResponseWriter, r *http.Request) {
	ctx, claims, ok := h.userContext(w, r, ScopeSettingsWrite)
	if !ok {
		return
	}
	var body struct {
		Name     string   `json:"name"`
		Platform string   `json:"platform"`
		Scopes   []string `json:"scopes"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
			return
		}
	}
	platform := strings.TrimSpace(body.Platform)
	if platform == "" {
		platform = "macos"
	}
	ceiling, known := bridgePlatformScopes[platform]
	if !known {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "platform must be one of: macos, ios-shortcuts"})
		return
	}
	scopes := ceiling
	if len(body.Scopes) > 0 {
		for _, s := range body.Scopes {
			if !slices.Contains(ceiling, s) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "scope not allowed for platform " + platform + ": " + s})
				return
			}
		}
		scopes = slices.Compact(slices.Sorted(slices.Values(body.Scopes)))
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > 100 {
		name = name[:100]
	}

	code, err := newPairingCode()
	if err != nil {
		h.logger().Error("pairing code generation failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create pairing code"})
		return
	}
	expires := h.now().Add(pairingCodeTTL)

	var createdBy *string
	if _, err := uuid.Parse(claims.Subject); err == nil {
		createdBy = &claims.Subject
	}

	var id string
	var tooMany bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var active int
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM bridge_pairing_codes
			WHERE tenant_id = $1 AND consumed_at IS NULL AND expires_at > now()
		`, claims.TenantID).Scan(&active); err != nil {
			return err
		}
		if active >= maxActivePairingCodes {
			tooMany = true
			return nil
		}
		return tx.QueryRow(ctx, `
			INSERT INTO bridge_pairing_codes (tenant_id, code_hash, name, platform, scopes, created_by, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id
		`, claims.TenantID, sha256Hex(normalizePairingCode(code)), name, platform, scopes, createdBy, expires).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create pairing code failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create pairing code"})
		return
	}
	if tooMany {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many unused pairing codes; let one expire or pair a device first"})
		return
	}
	h.logger().Info("bridge pairing code issued",
		zap.String("tenant_id", claims.TenantID), zap.String("code_id", id), zap.String("platform", platform))
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        id,
		"code":      code,
		"expiresAt": expires.UTC().Format(time.RFC3339),
		"platform":  platform,
		"scopes":    scopes,
	})
}

// Pair handles POST /v1/bridges/pair (unauthenticated): redeems a pairing code
// for a per-tenant bridge credential. Body: {code, name?}. Returns
// {bridgeId, tenantId, token, tokenPrefix, platform, scopes, name}. The token
// is returned exactly once; only its SHA-256 is stored.
func (h *BridgeHandler) Pair(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.allow(clientIP(r), h.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many pairing attempts; retry in a minute"})
		return
	}
	var body struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	code := normalizePairingCode(body.Code)
	invalid := func() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or expired pairing code"})
	}
	if code == "" {
		invalid()
		return
	}
	token, err := newBridgeToken()
	if err != nil {
		h.logger().Error("bridge token generation failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}

	ctx := r.Context()
	var (
		codeID, tenantID, name, platform, bridgeID string
		scopes                                     []string
		createdBy                                  *string
	)
	// rls-exempt: pre-auth code redemption — the device has no tenant yet; the
	// code hash resolves it (the tenant is the OUTPUT). The consume is an atomic
	// single-use UPDATE; the insert then runs with app.tenant_id set to the
	// resolved tenant in the SAME transaction, so a failed insert un-consumes.
	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		h.logger().Error("pair: begin tx", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	err = tx.QueryRow(ctx, `
		UPDATE bridge_pairing_codes SET consumed_at = now()
		WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		RETURNING id, tenant_id, name, platform, scopes, created_by
	`, sha256Hex(code)).Scan(&codeID, &tenantID, &name, &platform, &scopes, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		h.logger().Info("bridge pairing rejected", zap.String("from", clientIP(r)))
		invalid()
		return
	}
	if err != nil {
		h.logger().Error("pair: consume code", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	if n := strings.TrimSpace(body.Name); name == "" && n != "" {
		if len(n) > 100 {
			n = n[:100]
		}
		name = n
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		h.logger().Error("pair: set tenant", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	prefix := token[:bridgeTokenPrefixShown]
	if err := tx.QueryRow(ctx, `
		INSERT INTO bridges (tenant_id, name, platform, token_hash, token_prefix, scopes, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id
	`, tenantID, name, platform, sha256Hex(token), prefix, scopes, createdBy).Scan(&bridgeID); err != nil {
		h.logger().Error("pair: insert bridge", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE bridge_pairing_codes SET bridge_id = $1 WHERE id = $2`, bridgeID, codeID); err != nil {
		h.logger().Error("pair: link code", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		h.logger().Error("pair: commit", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "pairing failed"})
		return
	}
	middleware.EnrichSpan(ctx, tenantID, "", "", "")
	h.logger().Info("bridge paired",
		zap.String("tenant_id", tenantID), zap.String("bridge_id", bridgeID), zap.String("platform", platform))
	writeJSON(w, http.StatusCreated, map[string]any{
		"bridgeId":    bridgeID,
		"tenantId":    tenantID,
		"token":       token,
		"tokenPrefix": prefix,
		"platform":    platform,
		"scopes":      scopes,
		"name":        name,
	})
}

// List handles GET /v1/bridges[?includeRevoked=true]: the caller's paired
// devices, newest first. Never returns token material beyond the prefix.
func (h *BridgeHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, claims, ok := h.userContext(w, r, ScopeSettingsRead)
	if !ok {
		return
	}
	includeRevoked := r.URL.Query().Get("includeRevoked") == "true"
	out := make([]bridgeJSON, 0)
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, name, platform, token_prefix, scopes, created_at, rotated_at, last_seen_at, revoked_at
			FROM bridges
			WHERE tenant_id = $1 AND ($2 OR revoked_at IS NULL)
			ORDER BY created_at DESC
			LIMIT 200
		`, claims.TenantID, includeRevoked)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var b bridgeJSON
			var created time.Time
			var rotated, seen, revoked *time.Time
			if err := rows.Scan(&b.ID, &b.Name, &b.Platform, &b.TokenPrefix, &b.Scopes, &created, &rotated, &seen, &revoked); err != nil {
				return err
			}
			b.CreatedAt = fmtTS(&created)
			b.RotatedAt, b.LastSeenAt, b.RevokedAt = fmtTS(rotated), fmtTS(seen), fmtTS(revoked)
			out = append(out, b)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list bridges failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list bridges"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bridges": out})
}

// Revoke handles DELETE /v1/bridges/{id}: the device's credential stops working
// immediately (soft delete; the row stays for audit). Another tenant's id, an
// unknown id, or a malformed id is 404 — existence never leaks. Re-revoking an
// already-revoked device is a 200 no-op.
func (h *BridgeHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	ctx, claims, ok := h.userContext(w, r, ScopeSettingsWrite)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bridge not found"})
		return
	}
	var n int64
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE bridges SET revoked_at = COALESCE(revoked_at, now())
			WHERE id = $1 AND tenant_id = $2
		`, id, claims.TenantID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		h.logger().Error("revoke bridge failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to revoke bridge"})
		return
	}
	if n == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bridge not found"})
		return
	}
	h.logger().Info("bridge revoked", zap.String("tenant_id", claims.TenantID), zap.String("bridge_id", id))
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "revoked": true})
}

// RotateSelf handles POST /v1/bridges/self/rotate, authenticated by the bridge
// token itself: a fresh token replaces the old one atomically and the old one
// stops working at once. Returns {bridgeId, token, tokenPrefix}. A device that
// loses the response recovers by re-pairing (the user mints a new code).
func (h *BridgeHandler) RotateSelf(w http.ResponseWriter, r *http.Request) {
	id, err := authenticateBridge(r.Context(), h.srv, bearerToken(r))
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	token, err := newBridgeToken()
	if err != nil {
		h.logger().Error("bridge token generation failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rotation failed"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), id.TenantID)
	prefix := token[:bridgeTokenPrefixShown]
	var n int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE bridges SET token_hash = $1, token_prefix = $2, rotated_at = now()
			WHERE id = $3 AND tenant_id = $4 AND revoked_at IS NULL
		`, sha256Hex(token), prefix, id.BridgeID, id.TenantID)
		n = tag.RowsAffected()
		return err
	})
	if err != nil {
		h.logger().Error("rotate bridge failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rotation failed"})
		return
	}
	if n == 0 { // revoked between auth and update
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	middleware.EnrichSpan(r.Context(), id.TenantID, "", "", "")
	h.logger().Info("bridge token rotated", zap.String("tenant_id", id.TenantID), zap.String("bridge_id", id.BridgeID))
	writeJSON(w, http.StatusOK, map[string]any{"bridgeId": id.BridgeID, "token": token, "tokenPrefix": prefix})
}

// ---------- pairing rate limit ----------

// pairLimiter is a fixed-window limiter for the unauthenticated pair endpoint:
// perIP attempts per window per client IP, and a global ceiling that blunts a
// distributed guesser. In-memory per replica on purpose — the code's entropy
// and TTL are the real control; this only keeps online guessing far below them.
type pairLimiter struct {
	mu      sync.Mutex
	perIP   int
	global  int
	window  time.Duration
	start   time.Time
	counts  map[string]int
	globalN int
}

func newPairLimiter(perIP, global int, window time.Duration) *pairLimiter {
	return &pairLimiter{perIP: perIP, global: global, window: window, counts: map[string]int{}}
}

func (l *pairLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= l.window {
		l.start, l.counts, l.globalN = now, map[string]int{}, 0
	}
	if l.globalN >= l.global || l.counts[ip] >= l.perIP {
		return false
	}
	l.globalN++
	l.counts[ip]++
	return true
}

// clientIP is the TCP peer address. X-Forwarded-For is deliberately ignored —
// it is client-controlled and would let a guesser mint a fresh bucket per try.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
