package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// LifeEventHandler provides the REST surface for the bridges' life-event
// engine: a tenant-scoped feed of typed inbound classifications (bill /
// delivery / appointment / fraud_alert / otp / travel / receipt / promo) plus
// their outcomes, and per-kind trust toggles (auto / ask / off).
//
// The bridge POSTs each classified event; the dashboard "Automations" view
// reads the feed and flips the per-category prefs. Every query is tenant-scoped
// through s.srv.WithTenant, so RLS (when enforced) admits only the caller's own
// rows.
type LifeEventHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewLifeEventHandler creates a new LifeEventHandler.
func NewLifeEventHandler(srv *server.Server, auth *AuthHandler) *LifeEventHandler {
	return &LifeEventHandler{srv: srv, auth: auth}
}

func (h *LifeEventHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("life-events")
}

// contextWithTenant extracts the JWT from the request and returns a context
// carrying the tenant_id, plus the tenant ID string itself.
func (h *LifeEventHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

// lifeEventDefaultLimit / lifeEventMaxLimit bound the feed page size.
const (
	lifeEventDefaultLimit = 50
	lifeEventMaxLimit     = 200
)

// lifeEventKinds is the set of categories the bridge classifies into; the prefs
// endpoint synthesizes a default ('ask') for any kind without a stored row.
var lifeEventKinds = []string{
	"bill", "delivery", "appointment", "fraud_alert",
	"otp", "travel", "receipt", "promo",
}

// ---------- JSON types ----------

// lifeEventJSON is the wire shape the dashboard feed renders. Stable: the
// bridge-emit and dashboard layers depend on these field names.
type lifeEventJSON struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	Channel        string          `json:"channel"`
	Status         string          `json:"status"`
	Urgency        string          `json:"urgency,omitempty"`
	Summary        string          `json:"summary"`
	Fields         json.RawMessage `json:"fields"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	ActionTaken    string          `json:"actionTaken,omitempty"`
	SourcePreview  string          `json:"sourcePreview,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

type lifeEventPrefJSON struct {
	Kind string `json:"kind"`
	Mode string `json:"mode"`
}

// ---------- Handlers ----------

// CreateLifeEvent handles POST /v1/life-events.
//
// Body: {kind, channel, status?, urgency?, summary, fields?, idempotencyKey?,
// actionTaken?, sourcePreview?}. When idempotencyKey is present the insert
// UPSERTs on (tenant_id, idempotency_key) — a re-emit of the same classified
// event updates status / action_taken / updated_at instead of duplicating the
// row. Returns {id}.
func (h *LifeEventHandler) CreateLifeEvent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Kind           string          `json:"kind"`
		Channel        string          `json:"channel"`
		Status         string          `json:"status"`
		Urgency        string          `json:"urgency"`
		Summary        string          `json:"summary"`
		Fields         json.RawMessage `json:"fields"`
		IdempotencyKey string          `json:"idempotencyKey"`
		ActionTaken    string          `json:"actionTaken"`
		SourcePreview  string          `json:"sourcePreview"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Kind == "" || body.Channel == "" || body.Summary == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind, channel, and summary are required"})
		return
	}
	if body.Status == "" {
		body.Status = "suggested"
	}
	if len(body.Fields) == 0 {
		body.Fields = json.RawMessage(`{}`)
	}

	// Nullable text columns: pass nil rather than "" so a missing key stays NULL
	// (and the partial unique index on idempotency_key only covers real keys).
	var idemKey, urgency, actionTaken, sourcePreview *string
	if body.IdempotencyKey != "" {
		idemKey = &body.IdempotencyKey
	}
	if body.Urgency != "" {
		urgency = &body.Urgency
	}
	if body.ActionTaken != "" {
		actionTaken = &body.ActionTaken
	}
	if body.SourcePreview != "" {
		sourcePreview = &body.SourcePreview
	}

	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if idemKey != nil {
			// UPSERT: a re-emit with the same key updates the existing row.
			return tx.QueryRow(ctx, `
				INSERT INTO life_events
					(tenant_id, kind, channel, status, urgency, summary, fields,
					 idempotency_key, action_taken, source_preview)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (tenant_id, idempotency_key)
				WHERE idempotency_key IS NOT NULL
				DO UPDATE SET
					status       = EXCLUDED.status,
					action_taken = EXCLUDED.action_taken,
					updated_at   = now()
				RETURNING id
			`, tenantID, body.Kind, body.Channel, body.Status, urgency, body.Summary,
				body.Fields, idemKey, actionTaken, sourcePreview).Scan(&id)
		}
		return tx.QueryRow(ctx, `
			INSERT INTO life_events
				(tenant_id, kind, channel, status, urgency, summary, fields,
				 action_taken, source_preview)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id
		`, tenantID, body.Kind, body.Channel, body.Status, urgency, body.Summary,
			body.Fields, actionTaken, sourcePreview).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create life event failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to record life event"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// ListLifeEvents handles GET /v1/life-events?status=&kind=&limit=.
// Newest-first, tenant-scoped feed. limit defaults to 50, capped at 200.
func (h *LifeEventHandler) ListLifeEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	q := r.URL.Query()
	limit := lifeEventDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, convErr := strconv.Atoi(v); convErr == nil && n > 0 {
			limit = n
		}
	}
	if limit > lifeEventMaxLimit {
		limit = lifeEventMaxLimit
	}

	// Optional filters. Empty string ($N = '') means "no filter" via the
	// ($N = '' OR col = $N) guards below — keeps a single static query.
	statusFilter := q.Get("status")
	kindFilter := q.Get("kind")

	events := make([]lifeEventJSON, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, kind, channel, status, urgency, summary, fields,
			       idempotency_key, action_taken, source_preview, created_at, updated_at
			FROM life_events
			WHERE tenant_id = $1
			  AND ($2 = '' OR status = $2)
			  AND ($3 = '' OR kind = $3)
			ORDER BY created_at DESC
			LIMIT $4
		`, tenantID, statusFilter, kindFilter, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var (
				e                                            lifeEventJSON
				urgency, idemKey, actionTaken, sourcePreview *string
				fields                                       []byte
				createdAt, updatedAt                         time.Time
			)
			if scanErr := rows.Scan(&e.ID, &e.Kind, &e.Channel, &e.Status, &urgency,
				&e.Summary, &fields, &idemKey, &actionTaken, &sourcePreview,
				&createdAt, &updatedAt); scanErr != nil {
				return scanErr
			}
			if urgency != nil {
				e.Urgency = *urgency
			}
			if idemKey != nil {
				e.IdempotencyKey = *idemKey
			}
			if actionTaken != nil {
				e.ActionTaken = *actionTaken
			}
			if sourcePreview != nil {
				e.SourcePreview = *sourcePreview
			}
			e.Fields = json.RawMessage(fields)
			e.CreatedAt = createdAt.Format(time.RFC3339)
			e.UpdatedAt = updatedAt.Format(time.RFC3339)
			events = append(events, e)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list life events failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, events)
}

// UndoLifeEvent handles POST /v1/life-events/{id}/undo. Records the owner's
// intent to revert (status='undone'); the bridge performs the actual calendar /
// note rollback. Cross-tenant rows are invisible → 404.
func (h *LifeEventHandler) UndoLifeEvent(w http.ResponseWriter, r *http.Request) {
	h.transition(w, r, "undone")
}

// DismissLifeEvent handles POST /v1/life-events/{id}/dismiss
// (status='dismissed'). Cross-tenant rows → 404.
func (h *LifeEventHandler) DismissLifeEvent(w http.ResponseWriter, r *http.Request) {
	h.transition(w, r, "dismissed")
}

// transition flips a life event to the given terminal status, tenant-scoped.
// rowsAffected==0 (own-row-missing or cross-tenant) returns 404.
func (h *LifeEventHandler) transition(w http.ResponseWriter, r *http.Request, status string) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE life_events SET status = $1, updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, status, id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("life event transition failed", zap.String("status", status), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "life event not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": status})
}

// ListLifeEventPrefs handles GET /v1/life-events/prefs. Returns the per-kind
// trust mode for every known kind, synthesizing the default ('ask') for kinds
// with no stored row.
func (h *LifeEventHandler) ListLifeEventPrefs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	stored := make(map[string]string, len(lifeEventKinds))
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT kind, mode FROM life_event_prefs WHERE tenant_id = $1
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var kind, mode string
			if scanErr := rows.Scan(&kind, &mode); scanErr != nil {
				return scanErr
			}
			stored[kind] = mode
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list life event prefs failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	prefs := make([]lifeEventPrefJSON, 0, len(lifeEventKinds))
	for _, kind := range lifeEventKinds {
		mode, ok := stored[kind]
		if !ok {
			mode = "ask"
		}
		prefs = append(prefs, lifeEventPrefJSON{Kind: kind, Mode: mode})
	}

	writeJSON(w, http.StatusOK, prefs)
}

// UpsertLifeEventPref handles PUT /v1/life-events/prefs. Body: {kind, mode}.
// Upserts the per-kind trust toggle on (tenant_id, kind).
func (h *LifeEventHandler) UpsertLifeEventPref(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body lifeEventPrefJSON
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind is required"})
		return
	}
	switch body.Mode {
	case "auto", "ask", "off":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be one of auto, ask, off"})
		return
	}

	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			INSERT INTO life_event_prefs (tenant_id, kind, mode)
			VALUES ($1, $2, $3)
			ON CONFLICT (tenant_id, kind)
			DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()
		`, tenantID, body.Kind, body.Mode)
		return e
	})
	if err != nil {
		h.logger().Error("upsert life event pref failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, body)
}
