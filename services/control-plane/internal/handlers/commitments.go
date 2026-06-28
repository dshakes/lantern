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

// CommitmentHandler provides the REST surface for the Concierge agent's
// commitment tracker: tenant-scoped open tasks captured from inbound messages
// (spouse asks, VIP requests, bills, etc.) with lifecycle states, tier
// prioritization, and snooze/done/dismiss transitions.
//
// Every query is tenant-scoped through s.srv.WithTenant so RLS (when enforced)
// admits only the caller's own rows.
type CommitmentHandler struct {
	srv  *server.Server
	auth *AuthHandler
	// llmProxy and completeFn are wired by SetLlmProxy (called from main).
	// completeFn is the injectable LLM seam used by ResearchCommitment; tests
	// set it directly to stub the model call without a real API key.
	llmProxy   *LlmProxyHandler
	completeFn researchCompleteFn
}

// NewCommitmentHandler creates a new CommitmentHandler.
func NewCommitmentHandler(srv *server.Server, auth *AuthHandler) *CommitmentHandler {
	return &CommitmentHandler{srv: srv, auth: auth}
}

func (h *CommitmentHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("commitments")
}

// contextWithTenant extracts the JWT from the request and returns a context
// carrying the tenant_id, plus the tenant ID string itself.
func (h *CommitmentHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

// commitment paging.
const (
	commitmentDefaultLimit = 50
	commitmentMaxLimit     = 200
)

// valid enum values — validated at the handler boundary.
var (
	validTiers     = map[string]bool{"nano": true, "micro": true, "meso": true, "macro": true, "mega": true}
	validUrgencies = map[string]bool{"now": true, "soon": true, "normal": true, "fyi": true}
	validStatuses  = map[string]bool{
		"open": true, "researching": true, "suggested": true,
		"in_progress": true, "snoozed": true, "done": true, "dismissed": true,
	}
	validSources = map[string]bool{
		"spouse": true, "self": true, "vip": true, "bill": true,
		"email": true, "appointment": true, "other": true,
		// Domain-tracker sources (one per life domain).
		"health": true, "vehicle": true, "career": true,
		"travel": true, "home": true,
	}
)

// clampRunes truncates s to at most max runes, never splitting a multi-byte
// UTF-8 codepoint. A naive s[:n] byte-slice corrupts non-ASCII text (Telugu,
// emoji, accented Latin) by cutting mid-codepoint — these fields hold
// user/contact-authored titles, so they are frequently non-ASCII.
func clampRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// ---------- JSON types ----------

// commitmentJSON is the wire shape for both create responses and list/get results.
type commitmentJSON struct {
	ID             string          `json:"id"`
	Title          string          `json:"title"`
	Source         string          `json:"source"`
	AssignedBy     string          `json:"assignedBy,omitempty"`
	Kind           string          `json:"kind,omitempty"`
	Status         string          `json:"status"`
	Tier           string          `json:"tier"`
	Urgency        string          `json:"urgency"`
	Deadline       string          `json:"deadline,omitempty"`
	ActionPlan     json.RawMessage `json:"actionPlan,omitempty"`
	NextNudgeAt    string          `json:"nextNudgeAt,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	SourcePreview  string          `json:"sourcePreview,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

// ---------- Handlers ----------

// CreateCommitment handles POST /v1/commitments.
//
// Body: {title(required), source(required), assignedBy?, kind?, tier?,
// urgency?, deadline?, idempotencyKey?, sourcePreview?}.
// When idempotencyKey is present the insert UPSERTs on (tenant_id,
// idempotency_key) — a re-capture of the same task updates status/updated_at
// rather than duplicating the row. Returns {id}.
func (h *CommitmentHandler) CreateCommitment(w http.ResponseWriter, r *http.Request) {
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
		Title          string `json:"title"`
		Source         string `json:"source"`
		AssignedBy     string `json:"assignedBy"`
		Kind           string `json:"kind"`
		Tier           string `json:"tier"`
		Urgency        string `json:"urgency"`
		Deadline       string `json:"deadline"`
		IdempotencyKey string `json:"idempotencyKey"`
		SourcePreview  string `json:"sourcePreview"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Title == "" || body.Source == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title and source are required"})
		return
	}
	if !validSources[body.Source] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is invalid"})
		return
	}
	// Clamp title to 500 runes (UTF-8 safe).
	body.Title = clampRunes(body.Title, 500)

	// Apply enum defaults and validate.
	if body.Tier == "" {
		body.Tier = "meso"
	}
	if !validTiers[body.Tier] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tier must be one of nano, micro, meso, macro, mega"})
		return
	}
	if body.Urgency == "" {
		body.Urgency = "normal"
	}
	if !validUrgencies[body.Urgency] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "urgency must be one of now, soon, normal, fyi"})
		return
	}

	// Nullable text columns — pass nil so missing keys stay NULL and the partial
	// unique index on idempotency_key only covers real keys.
	var idemKey, assignedBy, kind, sourcePreview *string
	if body.IdempotencyKey != "" {
		idemKey = &body.IdempotencyKey
	}
	if body.AssignedBy != "" {
		assignedBy = &body.AssignedBy
	}
	if body.Kind != "" {
		kind = &body.Kind
	}
	if body.SourcePreview != "" {
		sp := clampRunes(body.SourcePreview, 500)
		sourcePreview = &sp
	}

	// Nullable timestamptz — parse if provided.
	var deadline *time.Time
	if body.Deadline != "" {
		t, parseErr := time.Parse(time.RFC3339, body.Deadline)
		if parseErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "deadline must be RFC3339"})
			return
		}
		deadline = &t
	}

	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if idemKey != nil {
			// UPSERT: re-capture with the same key updates the existing row.
			return tx.QueryRow(ctx, `
				INSERT INTO commitments
					(tenant_id, title, source, assigned_by, kind, tier, urgency,
					 deadline, idempotency_key, source_preview)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				ON CONFLICT (tenant_id, idempotency_key)
				WHERE idempotency_key IS NOT NULL
				DO UPDATE SET
					status     = commitments.status,
					updated_at = now()
				RETURNING id
			`, tenantID, body.Title, body.Source, assignedBy, kind, body.Tier, body.Urgency,
				deadline, idemKey, sourcePreview).Scan(&id)
		}
		return tx.QueryRow(ctx, `
			INSERT INTO commitments
				(tenant_id, title, source, assigned_by, kind, tier, urgency,
				 deadline, source_preview)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id
		`, tenantID, body.Title, body.Source, assignedBy, kind, body.Tier, body.Urgency,
			deadline, sourcePreview).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create commitment failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create commitment"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// ListCommitments handles GET /v1/commitments?status=&tier=&limit=.
// Newest-first, tenant-scoped feed. limit defaults to 50, capped at 200.
func (h *CommitmentHandler) ListCommitments(w http.ResponseWriter, r *http.Request) {
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
	limit := commitmentDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, convErr := strconv.Atoi(v); convErr == nil && n > 0 {
			limit = n
		}
	}
	if limit > commitmentMaxLimit {
		limit = commitmentMaxLimit
	}

	statusFilter := q.Get("status")
	tierFilter := q.Get("tier")

	items := make([]commitmentJSON, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, title, source, assigned_by, kind, status, tier, urgency,
			       deadline, action_plan, next_nudge_at,
			       idempotency_key, source_preview, created_at, updated_at
			FROM commitments
			WHERE tenant_id = $1
			  AND ($2 = '' OR status = $2)
			  AND ($3 = '' OR tier = $3)
			ORDER BY created_at DESC
			LIMIT $4
		`, tenantID, statusFilter, tierFilter, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			c, scanErr := scanCommitment(rows)
			if scanErr != nil {
				return scanErr
			}
			items = append(items, c)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list commitments failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, items)
}

// GetCommitment handles GET /v1/commitments/{id}.
// Returns the row or 404 (cross-tenant rows are invisible).
func (h *CommitmentHandler) GetCommitment(w http.ResponseWriter, r *http.Request) {
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

	var item commitmentJSON
	var found bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, title, source, assigned_by, kind, status, tier, urgency,
			       deadline, action_plan, next_nudge_at,
			       idempotency_key, source_preview, created_at, updated_at
			FROM commitments
			WHERE id = $1 AND tenant_id = $2
			LIMIT 1
		`, id, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		if rows.Next() {
			c, scanErr := scanCommitment(rows)
			if scanErr != nil {
				return scanErr
			}
			item = c
			found = true
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("get commitment failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}

	writeJSON(w, http.StatusOK, item)
}

// UpdateCommitment handles PUT /v1/commitments/{id}.
// Only updates fields that are present in the request body.
// 404 on cross-tenant rows.
func (h *CommitmentHandler) UpdateCommitment(w http.ResponseWriter, r *http.Request) {
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

	// Use raw JSON decode so we can distinguish absent fields from zero values.
	var body map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Validate enums when present.
	if v, ok := body["tier"]; ok {
		var tier string
		if err := json.Unmarshal(v, &tier); err != nil || !validTiers[tier] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tier must be one of nano, micro, meso, macro, mega"})
			return
		}
	}
	if v, ok := body["urgency"]; ok {
		var urgency string
		if err := json.Unmarshal(v, &urgency); err != nil || !validUrgencies[urgency] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "urgency must be one of now, soon, normal, fyi"})
			return
		}
	}
	if v, ok := body["status"]; ok {
		var status string
		if err := json.Unmarshal(v, &status); err != nil || !validStatuses[status] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status must be one of open, researching, suggested, in_progress, snoozed, done, dismissed"})
			return
		}
	}

	// Build the SET clause dynamically from the fields the caller provided.
	// ponytail: simple positional params via a manual accumulator; no query builder dep.
	type colVal struct {
		col string
		val any
	}
	var cols []colVal

	if v, ok := body["status"]; ok {
		var s string
		_ = json.Unmarshal(v, &s)
		cols = append(cols, colVal{"status", s})
	}
	if v, ok := body["tier"]; ok {
		var s string
		_ = json.Unmarshal(v, &s)
		cols = append(cols, colVal{"tier", s})
	}
	if v, ok := body["urgency"]; ok {
		var s string
		_ = json.Unmarshal(v, &s)
		cols = append(cols, colVal{"urgency", s})
	}
	if v, ok := body["kind"]; ok {
		var s string
		_ = json.Unmarshal(v, &s)
		if s == "" {
			cols = append(cols, colVal{"kind", nil})
		} else {
			cols = append(cols, colVal{"kind", s})
		}
	}
	if v, ok := body["deadline"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil || s == "" {
			cols = append(cols, colVal{"deadline", nil})
		} else {
			t, parseErr := time.Parse(time.RFC3339, s)
			if parseErr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "deadline must be RFC3339"})
				return
			}
			cols = append(cols, colVal{"deadline", t})
		}
	}
	if v, ok := body["nextNudgeAt"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil || s == "" {
			cols = append(cols, colVal{"next_nudge_at", nil})
		} else {
			t, parseErr := time.Parse(time.RFC3339, s)
			if parseErr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nextNudgeAt must be RFC3339"})
				return
			}
			cols = append(cols, colVal{"next_nudge_at", t})
		}
	}
	if v, ok := body["actionPlan"]; ok {
		if string(v) == "null" {
			cols = append(cols, colVal{"action_plan", nil})
		} else {
			cols = append(cols, colVal{"action_plan", []byte(v)})
		}
	}

	if len(cols) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no updatable fields provided"})
		return
	}

	// Build: UPDATE commitments SET col1=$1, col2=$2, ..., updated_at=now() WHERE id=$N AND tenant_id=$M
	query := "UPDATE commitments SET "
	args := make([]any, 0, len(cols)+2)
	for i, cv := range cols {
		if i > 0 {
			query += ", "
		}
		args = append(args, cv.val)
		query += cv.col + " = $" + strconv.Itoa(i+1)
	}
	args = append(args, id, tenantID)
	query += ", updated_at = now() WHERE id = $" + strconv.Itoa(len(cols)+1) +
		" AND tenant_id = $" + strconv.Itoa(len(cols)+2)

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, query, args...)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("update commitment failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// SnoozeCommitment handles POST /v1/commitments/{id}/snooze.
// Body: {until: RFC3339}. Sets status='snoozed' and next_nudge_at=until.
func (h *CommitmentHandler) SnoozeCommitment(w http.ResponseWriter, r *http.Request) {
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

	var body struct {
		Until string `json:"until"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Until == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "until (RFC3339) is required"})
		return
	}
	until, parseErr := time.Parse(time.RFC3339, body.Until)
	if parseErr != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "until must be RFC3339"})
		return
	}

	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `
			UPDATE commitments
			SET status = 'snoozed', next_nudge_at = $1, updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, until, id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("snooze commitment failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "snoozed"})
}

// DoneCommitment handles POST /v1/commitments/{id}/done → status='done'.
func (h *CommitmentHandler) DoneCommitment(w http.ResponseWriter, r *http.Request) {
	h.commitmentTransition(w, r, "done")
}

// DismissCommitment handles POST /v1/commitments/{id}/dismiss → status='dismissed'.
func (h *CommitmentHandler) DismissCommitment(w http.ResponseWriter, r *http.Request) {
	h.commitmentTransition(w, r, "dismissed")
}

// commitmentTransition flips a commitment to the given status, tenant-scoped.
// rowsAffected==0 (own-row-missing or cross-tenant) → 404.
func (h *CommitmentHandler) commitmentTransition(w http.ResponseWriter, r *http.Request, status string) {
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
			UPDATE commitments SET status = $1, updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, status, id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("commitment transition failed",
			zap.String("status", status), zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": status})
}

// scanCommitment reads one row from a pgx.Rows into a commitmentJSON.
// The SELECT column order must match exactly.
func scanCommitment(rows pgx.Rows) (commitmentJSON, error) {
	var (
		c                                        commitmentJSON
		assignedBy, kind, idemKey, sourcePreview *string
		deadline, nextNudgeAt                    *time.Time
		actionPlan                               []byte
		createdAt, updatedAt                     time.Time
	)
	err := rows.Scan(
		&c.ID, &c.Title, &c.Source,
		&assignedBy, &kind, &c.Status, &c.Tier, &c.Urgency,
		&deadline, &actionPlan, &nextNudgeAt,
		&idemKey, &sourcePreview,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return commitmentJSON{}, err
	}
	if assignedBy != nil {
		c.AssignedBy = *assignedBy
	}
	if kind != nil {
		c.Kind = *kind
	}
	if idemKey != nil {
		c.IdempotencyKey = *idemKey
	}
	if sourcePreview != nil {
		c.SourcePreview = *sourcePreview
	}
	if deadline != nil {
		c.Deadline = deadline.Format(time.RFC3339)
	}
	if nextNudgeAt != nil {
		c.NextNudgeAt = nextNudgeAt.Format(time.RFC3339)
	}
	if len(actionPlan) > 0 {
		c.ActionPlan = json.RawMessage(actionPlan)
	}
	c.CreatedAt = createdAt.Format(time.RFC3339)
	c.UpdatedAt = updatedAt.Format(time.RFC3339)
	return c, nil
}
