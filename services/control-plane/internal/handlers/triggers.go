package handlers

// triggers.go — inbound webhook triggers (ADR 0028).
//
// A trigger binds a public endpoint, POST /v1/hooks/{id}, to one agent. The
// sender authenticates with an HMAC-SHA256 signature in its provider's format
// (generic / GitHub / Sentry / PagerDuty); a verified delivery starts a run
// through RESTHandler.CreateRun, so spawn limiting, budgets and routing apply
// exactly as for POST /v1/runs. The delivery id is the idempotency key
// (invariant #8): a redelivery or a replay returns 200 without a second run.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const (
	// hookMaxBody caps an inbound delivery. Larger → 413.
	hookMaxBody = 1 << 20
	// hookTimestampTolerance bounds clock skew/replay for the generic format,
	// the only one whose signature covers a timestamp.
	hookTimestampTolerance = 5 * time.Minute
	// hookMinSecretLen rejects caller-supplied secrets too short to resist guessing.
	hookMinSecretLen = 16
	// hookMaxDeliveryIDLen bounds the sender-supplied delivery id we store.
	hookMaxDeliveryIDLen = 200
)

var hookProviders = map[string]bool{"generic": true, "github": true, "sentry": true, "pagerduty": true}

// errHookSignature is returned for any signature/timestamp failure. The HTTP
// response never says which check failed.
var errHookSignature = errors.New("webhook signature verification failed")

// TriggerHandler serves trigger CRUD (JWT/API-key, tenant-scoped) and the
// public hook receiver.
type TriggerHandler struct {
	srv     *server.Server
	auth    *AuthHandler
	rest    *RESTHandler
	limiter *SpawnRateLimiter
}

// NewTriggerHandler creates a TriggerHandler. Per-trigger delivery rate is
// LANTERN_HOOK_RATE_PER_MIN (default 60) with burst LANTERN_HOOK_BURST (default 10).
func NewTriggerHandler(srv *server.Server, auth *AuthHandler, rest *RESTHandler) *TriggerHandler {
	// ponytail: per-replica in-memory buckets; SetRedis on this limiter if one
	// replica's allowance ever proves too loose.
	rate := envIntOrDefault("LANTERN_HOOK_RATE_PER_MIN", 60)
	burst := envIntOrDefault("LANTERN_HOOK_BURST", 10)
	return &TriggerHandler{
		srv:     srv,
		auth:    auth,
		rest:    rest,
		limiter: newSpawnRateLimiterWithClock(float64(rate), float64(burst), time.Now),
	}
}

// RegisterRoutes wires the trigger routes onto mux.
func (h *TriggerHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/agents/{name}/triggers", h.auth.WithScope(ScopeAgentsWrite, h.CreateTrigger))
	mux.HandleFunc("GET /v1/agents/{name}/triggers", h.ListTriggers)
	mux.HandleFunc("GET /v1/triggers/{id}", h.GetTrigger)
	mux.HandleFunc("PATCH /v1/triggers/{id}", h.auth.WithScope(ScopeAgentsWrite, h.UpdateTrigger))
	mux.HandleFunc("DELETE /v1/triggers/{id}", h.auth.WithScope(ScopeAgentsWrite, h.DeleteTrigger))
	// Public: authenticated by the per-trigger signature, not a token.
	mux.HandleFunc("POST /v1/hooks/{id}", h.ReceiveHook)
}

func (h *TriggerHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("triggers")
}

func (h *TriggerHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims := claimsFromCtx(r.Context())
	if claims == nil {
		var err error
		if claims, err = h.auth.validateRequest(r); err != nil {
			return nil, "", err
		}
	}
	middleware.EnrichSpan(r.Context(), claims.TenantID, claims.Subject, "", "")
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims.TenantID, nil
}

// ---------- JSON ----------

type triggerJSON struct {
	ID             string          `json:"id"`
	AgentName      string          `json:"agentName"`
	Provider       string          `json:"provider"`
	Enabled        bool            `json:"enabled"`
	InputTemplate  json.RawMessage `json:"inputTemplate,omitempty"`
	HookPath       string          `json:"hookPath"`
	LastDeliveryAt string          `json:"lastDeliveryAt,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	// Secret is returned only by create, and only when Lantern generated it
	// or the caller rotated it. Never by list/get.
	Secret string `json:"secret,omitempty"`
}

const triggerCols = `id, agent_name, provider, enabled, input_template, last_delivery_at, created_at`

func scanTrigger(row pgx.Row) (triggerJSON, error) {
	var (
		t         triggerJSON
		tmpl      []byte
		last      *time.Time
		createdAt time.Time
	)
	if err := row.Scan(&t.ID, &t.AgentName, &t.Provider, &t.Enabled, &tmpl, &last, &createdAt); err != nil {
		return t, err
	}
	if len(tmpl) > 0 {
		t.InputTemplate = tmpl
	}
	if last != nil {
		t.LastDeliveryAt = last.Format(time.RFC3339)
	}
	t.CreatedAt = createdAt.Format(time.RFC3339)
	t.HookPath = "/v1/hooks/" + t.ID
	return t, nil
}

// validTemplate reports whether raw is absent or a JSON object.
func validTemplate(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var m map[string]any
	return json.Unmarshal(raw, &m) == nil
}

func encryptHookSecret(s string) ([]byte, error) {
	b, _ := json.Marshal(map[string]string{"secret": s}) // map[string]string cannot fail
	enc, err := secrets.Encrypt(b)
	if err != nil {
		return nil, fmt.Errorf("encrypt hook secret: %w", err)
	}
	return enc, nil
}

func decryptHookSecret(stored []byte) (string, error) {
	dec, err := secrets.Decrypt(stored)
	if err != nil {
		return "", fmt.Errorf("decrypt hook secret: %w", err)
	}
	var v struct {
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(dec, &v); err != nil || v.Secret == "" {
		return "", errors.New("decrypt hook secret: malformed envelope")
	}
	return v.Secret, nil
}

func newHookSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // crypto/rand.Read never returns an error on supported platforms
	return "whsec_" + hex.EncodeToString(b)
}

// ---------- CRUD ----------

// CreateTrigger handles POST /v1/agents/{name}/triggers.
// Body: {provider, secret?, inputTemplate?}. A missing secret is generated and
// returned once.
func (h *TriggerHandler) CreateTrigger(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	agentName := r.PathValue("name")
	var body struct {
		Provider      string          `json:"provider"`
		Secret        string          `json:"secret"`
		InputTemplate json.RawMessage `json:"inputTemplate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if !hookProviders[body.Provider] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "provider must be one of generic, github, sentry, pagerduty"})
		return
	}
	if !validTemplate(body.InputTemplate) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "inputTemplate must be a JSON object"})
		return
	}
	if string(body.InputTemplate) == "null" {
		body.InputTemplate = nil
	}
	if body.Secret != "" && len(body.Secret) < hookMinSecretLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("secret must be at least %d characters", hookMinSecretLen)})
		return
	}
	secret := body.Secret
	if secret == "" {
		secret = newHookSecret()
	}
	enc, err := encryptHookSecret(secret)
	if err != nil {
		h.logger().Error("create trigger: encrypt failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var t triggerJSON
	agentFound := false
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM agents WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL)`,
			tenantID, agentName).Scan(&agentFound); e != nil || !agentFound {
			return e
		}
		var e error
		t, e = scanTrigger(tx.QueryRow(ctx, `
			INSERT INTO agent_triggers (tenant_id, agent_name, provider, secret_enc, input_template)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING `+triggerCols,
			tenantID, agentName, body.Provider, enc, []byte(body.InputTemplate)))
		return e
	})
	if err != nil {
		h.logger().Error("create trigger failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !agentFound {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}
	if body.Secret == "" {
		t.Secret = secret
	}
	writeJSON(w, http.StatusCreated, t)
}

// ListTriggers handles GET /v1/agents/{name}/triggers.
func (h *TriggerHandler) ListTriggers(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	out := make([]triggerJSON, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT `+triggerCols+` FROM agent_triggers
			WHERE tenant_id = $1 AND agent_name = $2 ORDER BY created_at DESC`,
			tenantID, r.PathValue("name"))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			t, e := scanTrigger(rows)
			if e != nil {
				return e
			}
			out = append(out, t)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list triggers failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetTrigger handles GET /v1/triggers/{id}. Cross-tenant → 404.
func (h *TriggerHandler) GetTrigger(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trigger not found"})
		return
	}
	var t triggerJSON
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		t, e = scanTrigger(tx.QueryRow(ctx, `SELECT `+triggerCols+` FROM agent_triggers WHERE id = $1 AND tenant_id = $2`, id, tenantID))
		return e
	})
	h.writeTriggerResult(w, t, err, http.StatusOK)
}

// UpdateTrigger handles PATCH /v1/triggers/{id}.
// Body: {enabled?, inputTemplate? (null clears), secret?}. Cross-tenant → 404.
func (h *TriggerHandler) UpdateTrigger(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trigger not found"})
		return
	}
	var body struct {
		Enabled       *bool           `json:"enabled"`
		InputTemplate json.RawMessage `json:"inputTemplate"`
		Secret        *string         `json:"secret"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if !validTemplate(body.InputTemplate) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "inputTemplate must be a JSON object"})
		return
	}
	setTemplate := len(body.InputTemplate) > 0
	var tmpl []byte
	if setTemplate && string(body.InputTemplate) != "null" {
		tmpl = body.InputTemplate
	}
	var enc []byte
	if body.Secret != nil {
		if len(*body.Secret) < hookMinSecretLen {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("secret must be at least %d characters", hookMinSecretLen)})
			return
		}
		if enc, err = encryptHookSecret(*body.Secret); err != nil {
			h.logger().Error("update trigger: encrypt failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	}
	var t triggerJSON
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var e error
		t, e = scanTrigger(tx.QueryRow(ctx, `
			UPDATE agent_triggers SET
				enabled        = COALESCE($3, enabled),
				input_template = CASE WHEN $4 THEN $5::jsonb ELSE input_template END,
				secret_enc     = COALESCE($6::jsonb, secret_enc),
				updated_at     = now()
			WHERE id = $1 AND tenant_id = $2
			RETURNING `+triggerCols,
			id, tenantID, body.Enabled, setTemplate, tmpl, enc))
		return e
	})
	h.writeTriggerResult(w, t, err, http.StatusOK)
}

// DeleteTrigger handles DELETE /v1/triggers/{id}. Cross-tenant → 404.
func (h *TriggerHandler) DeleteTrigger(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trigger not found"})
		return
	}
	var n int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `DELETE FROM agent_triggers WHERE id = $1 AND tenant_id = $2`, id, tenantID)
		n = tag.RowsAffected()
		return e
	})
	switch {
	case err != nil:
		h.logger().Error("delete trigger failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	case n == 0:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trigger not found"})
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *TriggerHandler) writeTriggerResult(w http.ResponseWriter, t triggerJSON, err error, okStatus int) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "trigger not found"})
	case err != nil:
		h.logger().Error("trigger query failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
	default:
		writeJSON(w, okStatus, t)
	}
}

// ---------- Public receiver ----------

// hookDelivery is what a verified request yields.
type hookDelivery struct {
	ID        string // provider delivery id (idempotency key)
	Event     string // provider event type, "" when the format has none
	ReplayKey string // sha256 of the signed bytes
}

func hookDigest(parts ...[]byte) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// hmacMatches reports whether gotHex is the HMAC-SHA256 of msg under secret.
// Constant-time in the MAC comparison.
func hmacMatches(secret string, msg []byte, gotHex string) bool {
	got, err := hex.DecodeString(strings.TrimSpace(gotHex))
	if err != nil || len(got) != sha256.Size {
		return false
	}
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(msg)
	return hmac.Equal(m.Sum(nil), got)
}

// verifyHookDelivery checks the request signature in the provider's format and
// extracts the delivery id. Pure: unit-tested per provider.
func verifyHookDelivery(provider, secret string, hdr http.Header, body []byte, now time.Time) (hookDelivery, error) {
	d := hookDelivery{}
	switch provider {
	case "generic":
		// X-Lantern-Signature: t=<unix>,v1=<hex>[,v1=<hex>] over "<t>.<body>".
		var ts string
		var sigs []string
		for _, kv := range strings.Split(hdr.Get("X-Lantern-Signature"), ",") {
			k, v, _ := strings.Cut(strings.TrimSpace(kv), "=")
			switch k {
			case "t":
				ts = v
			case "v1":
				sigs = append(sigs, v)
			}
		}
		sec, err := strconv.ParseInt(ts, 10, 64)
		if err != nil {
			return d, errHookSignature
		}
		if skew := now.Sub(time.Unix(sec, 0)); skew > hookTimestampTolerance || skew < -hookTimestampTolerance {
			return d, errHookSignature
		}
		signed := append([]byte(ts+"."), body...)
		if !anyHMAC(secret, signed, sigs) {
			return d, errHookSignature
		}
		d.ReplayKey = hookDigest(signed)
		d.ID = hdr.Get("X-Lantern-Delivery")
		d.Event = hdr.Get("X-Lantern-Event")
	case "github":
		sig, ok := strings.CutPrefix(hdr.Get("X-Hub-Signature-256"), "sha256=")
		if !ok || !hmacMatches(secret, body, sig) {
			return d, errHookSignature
		}
		d.ID = hdr.Get("X-GitHub-Delivery")
		d.Event = hdr.Get("X-GitHub-Event")
	case "sentry":
		if !hmacMatches(secret, body, hdr.Get("Sentry-Hook-Signature")) {
			return d, errHookSignature
		}
		d.ID = hdr.Get("Request-ID")
		d.Event = hdr.Get("Sentry-Hook-Resource")
	case "pagerduty":
		// X-PagerDuty-Signature: v1=<hex>[,v1=<hex>] — several during PD's secret rotation.
		var sigs []string
		for _, s := range strings.Split(hdr.Get("X-PagerDuty-Signature"), ",") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(s), "v1="); ok {
				sigs = append(sigs, v)
			}
		}
		if !anyHMAC(secret, body, sigs) {
			return d, errHookSignature
		}
		var p struct {
			Event struct {
				ID        string `json:"id"`
				EventType string `json:"event_type"`
			} `json:"event"`
		}
		_ = json.Unmarshal(body, &p) // signed but possibly non-JSON: id falls back below
		d.ID, d.Event = p.Event.ID, p.Event.EventType
	default:
		return d, errHookSignature
	}
	if d.ReplayKey == "" {
		d.ReplayKey = hookDigest(body)
	}
	if d.ID == "" {
		d.ID = d.ReplayKey
	}
	if len(d.ID) > hookMaxDeliveryIDLen {
		d.ID = hookDigest([]byte(d.ID))
	}
	return d, nil
}

func anyHMAC(secret string, msg []byte, sigs []string) bool {
	ok := false
	for _, s := range sigs {
		// No early exit: every candidate is checked.
		ok = hmacMatches(secret, msg, s) || ok
	}
	return ok
}

var tmplVarRE = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}`)

// lookupPath resolves a dotted path ("payload.pull_request.number") in root.
func lookupPath(root map[string]any, path string) (any, bool) {
	var cur any = root
	for _, seg := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[seg]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// renderHookTemplate maps a delivery onto run input. A string that is exactly
// "{{path}}" becomes the typed value at path (null when absent); "{{path}}"
// inside a longer string is interpolated as text. Nothing else is evaluated.
func renderHookTemplate(tmpl any, root map[string]any) any {
	switch v := tmpl.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, e := range v {
			out[k] = renderHookTemplate(e, root)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = renderHookTemplate(e, root)
		}
		return out
	case string:
		if m := tmplVarRE.FindStringSubmatch(v); m != nil && m[0] == strings.TrimSpace(v) {
			val, _ := lookupPath(root, m[1])
			return val
		}
		return tmplVarRE.ReplaceAllStringFunc(v, func(match string) string {
			val, ok := lookupPath(root, tmplVarRE.FindStringSubmatch(match)[1])
			if !ok || val == nil {
				return ""
			}
			if s, isStr := val.(string); isStr {
				return s
			}
			b, _ := json.Marshal(val) // decoded JSON values always marshal
			return string(b)
		})
	default:
		return v
	}
}

// hookRunInput builds the run input for a verified delivery.
func hookRunInput(provider, triggerID string, d hookDelivery, body, tmpl []byte) map[string]any {
	var payload any
	if json.Unmarshal(body, &payload) != nil {
		payload = string(body)
	}
	root := map[string]any{
		"payload":    payload,
		"event":      d.Event,
		"provider":   provider,
		"deliveryId": d.ID,
		"triggerId":  triggerID,
	}
	var t map[string]any
	if len(tmpl) == 0 || json.Unmarshal(tmpl, &t) != nil {
		return map[string]any{"provider": provider, "event": d.Event, "deliveryId": d.ID, "payload": payload}
	}
	out, _ := renderHookTemplate(t, root).(map[string]any) // a map renders to a map
	return out
}

// runTriggerKindKey carries a non-API trigger kind into RESTHandler.CreateRun.
type runTriggerKindKey struct{}

// runTriggerKind returns the trigger kind CreateRun should stamp: API unless a
// caller (the hook receiver) set one.
func runTriggerKind(ctx context.Context) lanternv1.TriggerKind {
	if k, ok := ctx.Value(runTriggerKindKey{}).(lanternv1.TriggerKind); ok {
		return k
	}
	return lanternv1.TriggerKind_TRIGGER_KIND_API
}

var hookNotFound = map[string]string{"error": "hook not found"}

// ReceiveHook handles the public POST /v1/hooks/{id}.
//
// Order matters: lookup → signature → rate limit → dedup → run. Nothing beyond
// the id lookup happens for an unsigned request, and the per-trigger rate limit
// is spent only by authenticated senders.
func (h *TriggerHandler) ReceiveHook(w http.ResponseWriter, r *http.Request) {
	triggerID := r.PathValue("id")
	if _, err := uuid.Parse(triggerID); err != nil {
		writeJSON(w, http.StatusNotFound, hookNotFound)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, hookMaxBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "payload too large"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read body"})
		return
	}

	var (
		tenantID, agentName, provider string
		secretEnc, tmpl               []byte
		enabled                       bool
	)
	// rls-exempt: pre-auth tenant resolution. The trigger id is all an
	// unauthenticated sender presents; the tenant is unknown until this row is
	// read, and nothing else runs until the signature over it verifies.
	err = h.srv.Pool.QueryRow(r.Context(), `
		SELECT tenant_id, agent_name, provider, secret_enc, input_template, enabled
		FROM agent_triggers WHERE id = $1`, triggerID,
	).Scan(&tenantID, &agentName, &provider, &secretEnc, &tmpl, &enabled)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !enabled) {
		writeJSON(w, http.StatusNotFound, hookNotFound)
		return
	}
	if err != nil {
		h.logger().Error("hook lookup failed", zap.String("trigger_id", triggerID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	middleware.EnrichSpan(r.Context(), tenantID, "", "", "")
	log := h.logger().With(zap.String("tenant_id", tenantID), zap.String("trigger_id", triggerID), zap.String("provider", provider))

	secret, err := decryptHookSecret(secretEnc)
	if err != nil {
		log.Error("hook secret unusable", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	d, err := verifyHookDelivery(provider, secret, r.Header, body, time.Now())
	if err != nil {
		log.Info("hook signature rejected")
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}
	if !h.limiter.Allow("hook:" + triggerID) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate limited"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), tenantID)
	var (
		agentFound, fresh bool
		priorRunID        *string
	)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM agents WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL)`,
			tenantID, agentName).Scan(&agentFound); e != nil || !agentFound {
			return e
		}
		tag, e := tx.Exec(ctx, `
			INSERT INTO agent_trigger_deliveries (tenant_id, trigger_id, delivery_id, replay_key)
			VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
			tenantID, triggerID, d.ID, d.ReplayKey)
		if e != nil {
			return e
		}
		if fresh = tag.RowsAffected() == 1; fresh {
			return nil
		}
		return tx.QueryRow(ctx, `
			SELECT run_id FROM agent_trigger_deliveries
			WHERE tenant_id = $1 AND trigger_id = $2 AND (delivery_id = $3 OR replay_key = $4)
			LIMIT 1`, tenantID, triggerID, d.ID, d.ReplayKey).Scan(&priorRunID)
	})
	if err != nil {
		log.Error("hook dedup failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !agentFound {
		writeJSON(w, http.StatusNotFound, hookNotFound)
		return
	}
	if !fresh {
		resp := map[string]any{"duplicate": true, "deliveryId": d.ID}
		if priorRunID != nil {
			resp["runId"] = *priorRunID
		}
		log.Info("hook duplicate delivery ignored", zap.String("delivery_id", d.ID))
		writeJSON(w, http.StatusOK, resp)
		return
	}

	status, runResp := h.startRun(ctx, tenantID, agentName, hookRunInput(provider, triggerID, d, body, tmpl))
	runID, _ := runResp["id"].(string)
	if status != http.StatusCreated || runID == "" {
		// Free the delivery id so the provider's own retry can succeed later
		// (e.g. once the daily budget resets).
		if e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `DELETE FROM agent_trigger_deliveries WHERE tenant_id = $1 AND trigger_id = $2 AND delivery_id = $3`,
				tenantID, triggerID, d.ID)
			return e
		}); e != nil {
			log.Error("hook delivery release failed", zap.Error(e))
		}
		log.Warn("hook run not created", zap.Int("status", status), zap.Any("detail", runResp["error"]))
		switch status {
		case http.StatusPaymentRequired, http.StatusTooManyRequests:
			writeJSON(w, status, runResp) // budget / spawn-limit reason is the sender's to see
		default:
			// Internal detail stays in the log, not in a response to an external sender.
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "run creation failed"})
		}
		return
	}
	middleware.EnrichSpan(r.Context(), tenantID, "", runID, "")
	if e := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE agent_trigger_deliveries SET run_id = $1 WHERE tenant_id = $2 AND trigger_id = $3 AND delivery_id = $4`,
			runID, tenantID, triggerID, d.ID); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE agent_triggers SET last_delivery_at = now() WHERE id = $1 AND tenant_id = $2`, triggerID, tenantID)
		return e
	}); e != nil {
		// The run exists and dedup still holds on the delivery row; only the
		// run_id back-reference is missing.
		log.Error("hook delivery bookkeeping failed", zap.String("run_id", runID), zap.Error(e))
	}
	log.Info("hook run created", zap.String("run_id", runID), zap.String("delivery_id", d.ID))
	writeJSON(w, http.StatusAccepted, map[string]any{"runId": runID, "deliveryId": d.ID})
}

// startRun creates the run through RESTHandler.CreateRun — the same path as
// POST /v1/runs — so spawn limiting, CheckBudget (402), routing and inline
// execution apply unchanged. Returns CreateRun's status and decoded body.
func (h *TriggerHandler) startRun(ctx context.Context, tenantID, agentName string, input map[string]any) (int, map[string]any) {
	b, err := json.Marshal(map[string]any{"agentName": agentName, "input": input})
	if err != nil {
		return http.StatusInternalServerError, map[string]any{"error": "internal error"}
	}
	ctx = storeClaimsInCtx(ctx, &LanternClaims{TenantID: tenantID, Role: "service"})
	ctx = context.WithValue(ctx, runTriggerKindKey{}, lanternv1.TriggerKind_TRIGGER_KIND_WEBHOOK)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/v1/runs", bytes.NewReader(b))
	if err != nil {
		return http.StatusInternalServerError, map[string]any{"error": "internal error"}
	}
	// ponytail: in-process call via a recorder instead of extracting CreateRun's
	// body into a shared func — keeps rest.go (owned by other packages) untouched
	// beyond the trigger-kind line.
	rec := httptest.NewRecorder()
	h.rest.CreateRun(rec, req)
	var resp map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &resp) != nil {
		resp = map[string]any{"error": "run creation failed"}
	}
	return rec.Code, resp
}
