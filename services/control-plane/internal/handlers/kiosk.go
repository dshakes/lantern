package handlers

// kiosk.go — ephemeral anonymous demo tenants (ADR 0029).
//
//	POST /v1/kiosk/session   (only when PAL_KIOSK=1; 404 otherwise)
//
// Each call creates a fresh `kiosk-<rand>` tenant seeded with demo agents and
// runs, and returns a short-lived, scope-limited JWT (role "kiosk"). A sweep
// purges expired kiosk tenants through purgeTenantRows — the same erasure path
// DELETE /v1/tenants/{id} uses, which walks every table with a tenant_id column
// from the catalog, so a new tenant table is purged without touching this file.
//
// No provider key is ever created: the kiosk tenant has no llm_provider_configs
// row and the token cannot reach settings:write. LLM calls are served by the
// fixture server (cmd/llm-replay, W2-0) via PAL_LLM_BASEURL_*.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/db"
	"github.com/dshakes/pal/services/control-plane/internal/server"
)

const (
	kioskRole       = "kiosk"
	kioskSlugPrefix = "kiosk-"
)

// kioskScopes is everything a demo visitor may do; settings:write,
// connectors:write, budgets:write and admin are deliberately absent.
var kioskScopes = []string{ScopeRead, ScopeAgentsRead, ScopeAgentsWrite, ScopeRunsRead, ScopeRunsExecute}

func envOn(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "on":
		return true
	}
	return false
}

// KioskEnabled reports whether PAL_KIOSK is on.
func KioskEnabled() bool { return envOn("PAL_KIOSK") }

// CheckKioskConfig is the startup guard. Fatal when kiosk mode is on and: it is a
// production-like env without PAL_KIOSK_ALLOW_PROD=1; RLS or authz enforcement
// is off; or a provider key is set that is not pinned to a fixture base URL.
func CheckKioskConfig(isProdEnv bool, getenv func(string) string) (fatal bool, message string) {
	on := func(k string) bool {
		switch strings.ToLower(strings.TrimSpace(getenv(k))) {
		case "1", "true", "on":
			return true
		}
		return false
	}
	if !on("PAL_KIOSK") {
		return false, ""
	}
	if isProdEnv && !on("PAL_KIOSK_ALLOW_PROD") {
		return true, "PAL_KIOSK=1 in a production-like environment — kiosk mints anonymous tenants; set PAL_KIOSK_ALLOW_PROD=1 only for a dedicated public demo deployment"
	}
	if !on("PAL_RLS_ENFORCE") || !on("PAL_AUTHZ_ENFORCE") {
		return true, "PAL_KIOSK=1 requires PAL_RLS_ENFORCE=1 and PAL_AUTHZ_ENFORCE=1 — anonymous tenants must be isolated by the database, not by handler discipline"
	}
	// A missing or dev-default JWT secret is public, so anyone could mint an
	// owner token for any tenant and step around RLS entirely.
	if secret := strings.TrimSpace(getenv("JWT_SECRET")); secret == "" || secret == devJWTSecret {
		return true, "PAL_KIOSK=1 requires an explicit, non-default JWT_SECRET — the dev default is public and would let anyone forge owner tokens"
	}
	for key, override := range map[string]string{"OPENAI_API_KEY": "PAL_LLM_BASEURL_OPENAI", "ANTHROPIC_API_KEY": "PAL_LLM_BASEURL_ANTHROPIC"} {
		if getenv(key) != "" && getenv(override) == "" {
			return true, key + " is set in kiosk mode without " + override + " — kiosk must never hold a provider key that can reach a real provider"
		}
	}
	return false, ""
}

// KioskHandler serves the kiosk session endpoint and expiry sweep.
type KioskHandler struct {
	srv  *server.Server
	auth *AuthHandler

	ttl           time.Duration
	maxSessions   int
	perIPPerHour  int
	now           func() time.Time
	mu            sync.Mutex
	hitsByIP      map[string][]time.Time
	sweepInterval time.Duration
}

// NewKioskHandler reads tunables from the environment.
func NewKioskHandler(srv *server.Server, auth *AuthHandler) *KioskHandler {
	atoi := func(k string, def int) int {
		if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n > 0 {
			return n
		}
		return def
	}
	return &KioskHandler{
		srv: srv, auth: auth, now: time.Now,
		ttl:           time.Duration(atoi("PAL_KIOSK_TTL_MIN", 30)) * time.Minute,
		maxSessions:   atoi("PAL_KIOSK_MAX_SESSIONS", 20),
		perIPPerHour:  atoi("PAL_KIOSK_IP_PER_HOUR", 3),
		sweepInterval: time.Duration(atoi("PAL_KIOSK_SWEEP_SEC", 60)) * time.Second,
		hitsByIP:      map[string][]time.Time{},
	}
}

func (h *KioskHandler) logger() *zap.Logger { return h.srv.Logger.Named("kiosk") }

// allowIP: sliding one-hour window per client address.
// ponytail: in-memory, per-process; RemoteAddr only (X-Forwarded-For is spoofable).
func (h *KioskHandler) allowIP(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	now := h.now()
	h.mu.Lock()
	defer h.mu.Unlock()
	keep := h.hitsByIP[ip][:0]
	for _, t := range h.hitsByIP[ip] {
		if now.Sub(t) < time.Hour {
			keep = append(keep, t)
		}
	}
	if len(keep) >= h.perIPPerHour {
		h.hitsByIP[ip] = keep
		return false
	}
	h.hitsByIP[ip] = append(keep, now)
	return true
}

// CreateSession handles POST /v1/kiosk/session.
func (h *KioskHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	if !KioskEnabled() {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	if !h.allowIP(r) {
		w.Header().Set("Retry-After", "3600")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many demo sessions from this address"})
		return
	}

	// rls-exempt: tenants is RLS-exempt and the count is a global capacity
	// check before any tenant exists.
	var live int
	if err := h.srv.Pool.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE slug LIKE $1`, kioskSlugPrefix+"%").Scan(&live); err != nil {
		h.logger().Error("count sessions failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if live >= h.maxSessions {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "demo is at capacity, try again shortly"})
		return
	}

	suffix, err := randomHex(5)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	slug := kioskSlugPrefix + suffix
	expires := h.now().Add(h.ttl).UTC()
	settings, _ := json.Marshal(map[string]any{"kiosk": true, "kiosk_expires_at": expires.Format(time.RFC3339)})

	// rls-exempt: pre-auth — creating the tenant + its single user before any
	// tenant context exists (same as Signup).
	var tenantID, userID string
	err = func() error {
		tx, err := h.srv.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx) //nolint:errcheck
		if err = tx.QueryRow(ctx, `
			INSERT INTO tenants (slug, name, tier, k8s_namespace, settings)
			VALUES ($1, 'Demo visitor', 'personal', $2, $3::jsonb) RETURNING id`,
			slug, "pal-t-"+slug, string(settings)).Scan(&tenantID); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `
			INSERT INTO users (tenant_id, email, display_name, auth_provider, auth_subject, role)
			VALUES ($1, $2, 'Demo visitor', 'kiosk', $3, 'member') RETURNING id`,
			tenantID, slug+"@demo.invalid", slug).Scan(&userID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}()
	if err != nil {
		h.logger().Error("create kiosk tenant failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if err := h.seed(ctx, tenantID); err != nil {
		h.logger().Error("seed kiosk tenant failed", zap.String("tenant_id", tenantID), zap.Error(err))
		// Don't leave a half-seeded tenant for the TTL; best-effort purge.
		_, _ = purgeTenantRows(ctx, h.srv.Pool, h.logger(), tenantID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	token, err := h.mintToken(userID, tenantID, slug, expires)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	h.logger().Info("kiosk session created", zap.String("tenant_id", tenantID), zap.Time("expires_at", expires))
	writeJSON(w, http.StatusCreated, map[string]any{
		"token":      token,
		"tenantId":   tenantID,
		"expiresAt":  expires.Format(time.RFC3339),
		"ttlSeconds": int(h.ttl.Seconds()),
		"mode":       "replay", // answers are recorded, not live — the UI must say so
		"agents":     kioskAgentNames(),
	})
}

func (h *KioskHandler) mintToken(userID, tenantID, slug string, expires time.Time) (string, error) {
	claims := PalClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject: userID, IssuedAt: jwt.NewNumericDate(h.now()),
			ExpiresAt: jwt.NewNumericDate(expires), Issuer: "pal",
		},
		TenantID: tenantID, Email: slug + "@demo.invalid", Name: "Demo visitor",
		Role: kioskRole, Scopes: kioskScopes,
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(h.auth.jwtSecret)
}

type kioskAgent struct {
	name, desc, prompt, input, output string
	capped                            bool // seeded already over its daily cap -> the 402 demo
}

var kioskAgents = []kioskAgent{
	{"support-triage", "Classifies inbound support tickets and drafts a first reply.",
		"You triage support tickets. Return category, urgency and a two-sentence draft reply.",
		"Ticket: my invoice shows two charges for October.",
		"Category: billing. Urgency: medium. Draft: Thanks for flagging this - I can see a duplicate October charge and have asked finance to refund it.", false},
	{"research-brief", "Turns a topic into a five-bullet brief.",
		"You write concise five-bullet research briefs.",
		"Topic: microVM isolation for AI agents",
		"- Firecracker boots in ~125ms\n- Egress is allow-listed\n- Secrets are vended, never baked in\n- Snapshots enable fork and pause\n- Every run leaves a signed receipt", false},
	{"budget-capped", "An agent whose daily budget is already spent - runs return HTTP 402.",
		"You answer briefly.", "Say hello.", "Hello.", true},
}

func kioskAgentNames() []string {
	out := make([]string, len(kioskAgents))
	for i, a := range kioskAgents {
		out[i] = a.name
	}
	return out
}

// seed creates the demo agents, one finished run each (with a journal so the
// waterfall renders), and the pre-spent budget — all under the tenant GUC.
func (h *KioskHandler) seed(ctx context.Context, tenantID string) error {
	return db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		for _, a := range kioskAgents {
			var agentID, versionID, runID string
			if err := tx.QueryRow(ctx, `
				INSERT INTO agents (tenant_id, name, description, system_prompt, model)
				VALUES ($1, $2, $3, $4, 'fast') RETURNING id`,
				tenantID, a.name, a.desc, a.prompt).Scan(&agentID); err != nil {
				return fmt.Errorf("agent %s: %w", a.name, err)
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
				VALUES ($1, 'kiosk-v1', decode(md5($2), 'hex'), 'local://kiosk', '{}'::jsonb) RETURNING id`,
				agentID, tenantID+a.name).Scan(&versionID); err != nil {
				return fmt.Errorf("version %s: %w", a.name, err)
			}
			if _, err := tx.Exec(ctx, `UPDATE agents SET current_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
				return err
			}
			in, _ := json.Marshal(map[string]string{"input": a.input})
			out, _ := json.Marshal(map[string]string{"output": a.output})
			if err := tx.QueryRow(ctx, `
				INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, output,
					cost_usd, tokens_in, tokens_out, created_at, started_at, finished_at, labels)
				VALUES ($1, $2, $3, 'succeeded', 'manual', $4::jsonb, $5::jsonb, 0.0004, 120, 60,
					now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes' + interval '1 second', '{"kiosk_seed":"true"}'::jsonb)
				RETURNING id`, tenantID, agentID, versionID, string(in), string(out)).Scan(&runID); err != nil {
				return fmt.Errorf("run %s: %w", a.name, err)
			}
			started, _ := json.Marshal(map[string]string{"name": "llm:main", "type": "llm"})
			done, _ := json.Marshal(llmStepPayload{Result: a.output, TokensIn: 120, TokensOut: 60, CostUSD: 0.0004, Provider: "replay", Model: "fast"})
			if _, err := tx.Exec(ctx, `
				INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload) VALUES
				($1, 1, 'step_started', 'llm:main', 1, $2), ($1, 2, 'step_completed', 'llm:main', 1, $3)`,
				runID, started, done); err != nil {
				return fmt.Errorf("journal %s: %w", a.name, err)
			}
			if a.capped {
				if _, err := tx.Exec(ctx, `
					INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_day, hard_fail)
					VALUES ($1, $2, 0.0001, true)`, tenantID, a.name); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `
					INSERT INTO agent_usage_daily (tenant_id, agent_name, usage_date, runs_count, cost_usd)
					VALUES ($1, $2, $3::date, 1, 0.0004)`, tenantID, a.name, usageDate(h.now())); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// SweepExpired purges every expired kiosk tenant and returns how many it removed.
// A tenant qualifies only if BOTH its slug prefix and its settings marker say
// kiosk, so a real tenant can never be swept by a malformed row.
func (h *KioskHandler) SweepExpired(ctx context.Context) (int, error) {
	// rls-exempt: background sweep across tenants; tenants is RLS-exempt.
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id FROM tenants
		WHERE slug LIKE $1 AND settings->>'kiosk' = 'true'
		  AND (settings->>'kiosk_expires_at')::timestamptz < $2`, kioskSlugPrefix+"%", h.now())
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		if _, err := purgeTenantRows(ctx, h.srv.Pool, h.logger(), id); err != nil {
			h.logger().Error("kiosk purge failed", zap.String("tenant_id", id), zap.Error(err))
			continue
		}
		n++
	}
	return n, nil
}

// RunKioskSweep purges expired sessions every sweepInterval until ctx is done.
func RunKioskSweep(ctx context.Context, h *KioskHandler) {
	t := time.NewTicker(h.sweepInterval)
	defer t.Stop()
	for {
		if n, err := h.SweepExpired(ctx); err != nil {
			h.logger().Error("kiosk sweep failed", zap.Error(err))
		} else if n > 0 {
			h.logger().Info("kiosk sweep purged expired sessions", zap.Int("count", n))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
