package handlers

// DomainRecordHandler provides the REST surface for the domain-tracker agents'
// encrypted PII store. Records are structured facts extracted from email or
// entered manually: health history, vehicle service logs, career milestones.
//
// The `fields` JSON blob is encrypted at rest via the same AES-256-GCM envelope
// used for connector credentials (internal/secrets). It is never logged and
// never appears in traces (invariant #10). On write the caller supplies plain
// JSON; on read the handler decrypts and returns it.
//
// All queries go through s.srv.WithTenant (RLS-enforced AppPool). Cross-tenant
// rows are invisible — GET/PUT/DELETE return 404, list returns [].

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// DomainRecordHandler handles /v1/domain-records.
type DomainRecordHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

// NewDomainRecordHandler creates a DomainRecordHandler.
func NewDomainRecordHandler(srv *server.Server, auth *AuthHandler) *DomainRecordHandler {
	return &DomainRecordHandler{srv: srv, auth: auth}
}

func (h *DomainRecordHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("domain-records")
}

// valid enum values for domain and source.
var (
	validDomains       = map[string]bool{"health": true, "vehicle": true, "career": true}
	validRecordSources = map[string]bool{"gmail": true, "file": true, "web": true, "manual": true}
)

const (
	domainRecordDefaultLimit = 50
	domainRecordMaxLimit     = 200
)

// domainRecordJSON is the wire representation for create/list/get responses.
// fields is returned as plain JSON (decrypted); it is never logged.
type domainRecordJSON struct {
	ID             string          `json:"id"`
	Domain         string          `json:"domain"`
	Kind           string          `json:"kind"`
	Title          string          `json:"title"`
	Fields         json.RawMessage `json:"fields,omitempty"`
	Source         string          `json:"source,omitempty"`
	SourceRef      string          `json:"sourceRef,omitempty"`
	ValidUntil     string          `json:"validUntil,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

// contextWithTenant extracts the JWT claims and returns a tenant-injected context.
func (h *DomainRecordHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims.TenantID, nil
}

// CreateDomainRecord handles POST /v1/domain-records.
// Body: {domain, kind, title, fields?, source?, sourceRef?, validUntil?, idempotencyKey?}
// `fields` is encrypted at rest. Returns {id}.
func (h *DomainRecordHandler) CreateDomainRecord(w http.ResponseWriter, r *http.Request) {
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
		Domain         string          `json:"domain"`
		Kind           string          `json:"kind"`
		Title          string          `json:"title"`
		Fields         json.RawMessage `json:"fields"`
		Source         string          `json:"source"`
		SourceRef      string          `json:"sourceRef"`
		ValidUntil     string          `json:"validUntil"`
		IdempotencyKey string          `json:"idempotencyKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if !validDomains[body.Domain] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "domain must be one of health, vehicle, career"})
		return
	}
	if body.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind is required"})
		return
	}
	if body.Title == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title is required"})
		return
	}
	if body.Source != "" && !validRecordSources[body.Source] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source must be one of gmail, file, web, manual"})
		return
	}
	body.Title = clampRunes(body.Title, 500)
	body.Kind = clampRunes(body.Kind, 100)

	// Encrypt fields blob (invariant #10: PII, never log decrypted content).
	var fieldsEnc *string
	if len(body.Fields) > 0 && string(body.Fields) != "null" {
		enc, encErr := secrets.EncryptString(string(body.Fields))
		if encErr != nil {
			h.logger().Error("domain-records: encrypt fields failed", zap.Error(encErr))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		fieldsEnc = &enc
	}

	var idemKey, source, sourceRef *string
	if body.IdempotencyKey != "" {
		k := clampRunes(body.IdempotencyKey, 500)
		idemKey = &k
	}
	if body.Source != "" {
		source = &body.Source
	}
	if body.SourceRef != "" {
		sr := clampRunes(body.SourceRef, 500)
		sourceRef = &sr
	}

	var validUntil *time.Time
	if body.ValidUntil != "" {
		t, parseErr := time.Parse(time.RFC3339, body.ValidUntil)
		if parseErr != nil {
			// Try date-only format too.
			t, parseErr = time.Parse("2006-01-02", body.ValidUntil)
			if parseErr != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "validUntil must be RFC3339 or YYYY-MM-DD"})
				return
			}
		}
		validUntil = &t
	}

	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if idemKey != nil {
			return tx.QueryRow(ctx, `
				INSERT INTO domain_records
					(tenant_id, domain, kind, title, fields_encrypted, source, source_ref, valid_until, idempotency_key)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
				DO UPDATE SET
					title             = EXCLUDED.title,
					fields_encrypted  = EXCLUDED.fields_encrypted,
					valid_until       = EXCLUDED.valid_until,
					updated_at        = now()
				RETURNING id
			`, tenantID, body.Domain, body.Kind, body.Title, fieldsEnc,
				source, sourceRef, validUntil, idemKey).Scan(&id)
		}
		return tx.QueryRow(ctx, `
			INSERT INTO domain_records
				(tenant_id, domain, kind, title, fields_encrypted, source, source_ref, valid_until)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id
		`, tenantID, body.Domain, body.Kind, body.Title, fieldsEnc,
			source, sourceRef, validUntil).Scan(&id)
	})
	if err != nil {
		h.logger().Error("create domain-record failed", zap.String("tenant", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create domain record"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

// ListDomainRecords handles GET /v1/domain-records?domain=&kind=&limit=.
// Newest-first. Decrypts fields for each row before returning.
func (h *DomainRecordHandler) ListDomainRecords(w http.ResponseWriter, r *http.Request) {
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
	domainFilter := q.Get("domain")
	kindFilter := q.Get("kind")
	limit := domainRecordDefaultLimit
	if v := q.Get("limit"); v != "" {
		if n, convErr := strconv.Atoi(v); convErr == nil && n > 0 {
			limit = n
		}
	}
	if limit > domainRecordMaxLimit {
		limit = domainRecordMaxLimit
	}

	items := make([]domainRecordJSON, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id, domain, kind, title, fields_encrypted, source, source_ref,
			       valid_until, idempotency_key, created_at, updated_at
			FROM domain_records
			WHERE tenant_id = $1
			  AND ($2 = '' OR domain = $2)
			  AND ($3 = '' OR kind   = $3)
			ORDER BY created_at DESC
			LIMIT $4
		`, tenantID, domainFilter, kindFilter, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			rec, scanErr := scanDomainRecord(rows)
			if scanErr != nil {
				return scanErr
			}
			items = append(items, rec)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list domain-records failed", zap.String("tenant", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, items)
}

// UpdateDomainRecord handles PUT /v1/domain-records/{id}.
// Only updates fields present in the body. 404 on cross-tenant.
func (h *DomainRecordHandler) UpdateDomainRecord(w http.ResponseWriter, r *http.Request) {
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

	var body map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	type colVal struct {
		col string
		val any
	}
	var cols []colVal

	if v, ok := body["title"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil || s == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title must be a non-empty string"})
			return
		}
		cols = append(cols, colVal{"title", clampRunes(s, 500)})
	}
	if v, ok := body["kind"]; ok {
		var s string
		_ = json.Unmarshal(v, &s)
		cols = append(cols, colVal{"kind", clampRunes(s, 100)})
	}
	if v, ok := body["fields"]; ok {
		if string(v) == "null" {
			cols = append(cols, colVal{"fields_encrypted", nil})
		} else {
			enc, encErr := secrets.EncryptString(string(v))
			if encErr != nil {
				h.logger().Error("domain-records: update encrypt fields failed", zap.Error(encErr))
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
				return
			}
			cols = append(cols, colVal{"fields_encrypted", enc})
		}
	}
	if v, ok := body["validUntil"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil || s == "" {
			cols = append(cols, colVal{"valid_until", nil})
		} else {
			t, parseErr := time.Parse(time.RFC3339, s)
			if parseErr != nil {
				t, parseErr = time.Parse("2006-01-02", s)
				if parseErr != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "validUntil must be RFC3339 or YYYY-MM-DD"})
					return
				}
			}
			cols = append(cols, colVal{"valid_until", t})
		}
	}

	if len(cols) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no updatable fields provided"})
		return
	}

	query := "UPDATE domain_records SET "
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
		h.logger().Error("update domain-record failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "domain record not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

// DeleteDomainRecord handles DELETE /v1/domain-records/{id}.
// 404 on cross-tenant (same pattern as commitments).
func (h *DomainRecordHandler) DeleteDomainRecord(w http.ResponseWriter, r *http.Request) {
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
			DELETE FROM domain_records WHERE id = $1 AND tenant_id = $2
		`, id, tenantID)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		h.logger().Error("delete domain-record failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if rowsAffected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "domain record not found"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// scanDomainRecord reads one row from pgx.Rows into a domainRecordJSON,
// decrypting fields_encrypted in-process (never logged, invariant #10).
func scanDomainRecord(rows pgx.Rows) (domainRecordJSON, error) {
	var (
		rec                                   domainRecordJSON
		fieldsEnc, source, sourceRef, idemKey *string
		validUntil                            *time.Time
		createdAt, updatedAt                  time.Time
	)
	if err := rows.Scan(
		&rec.ID, &rec.Domain, &rec.Kind, &rec.Title,
		&fieldsEnc, &source, &sourceRef,
		&validUntil, &idemKey,
		&createdAt, &updatedAt,
	); err != nil {
		return domainRecordJSON{}, err
	}

	// Decrypt fields — pass-through when no key is configured (dev mode).
	// NEVER log the decrypted content.
	if fieldsEnc != nil && *fieldsEnc != "" {
		plain, decErr := secrets.Decrypt([]byte(*fieldsEnc))
		if decErr == nil && len(plain) > 0 {
			rec.Fields = json.RawMessage(plain)
		}
		// Decrypt errors are soft: missing key in dev is expected, corrupt in
		// prod should surface as empty fields rather than a crash.
	}

	if source != nil {
		rec.Source = *source
	}
	if sourceRef != nil {
		rec.SourceRef = *sourceRef
	}
	if validUntil != nil {
		rec.ValidUntil = validUntil.Format(time.RFC3339)
	}
	if idemKey != nil {
		rec.IdempotencyKey = *idemKey
	}
	rec.CreatedAt = createdAt.Format(time.RFC3339)
	rec.UpdatedAt = updatedAt.Format(time.RFC3339)
	return rec, nil
}
