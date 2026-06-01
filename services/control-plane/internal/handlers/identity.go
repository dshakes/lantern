package handlers

// Identity graph + unified cross-channel timeline — the keystone of the
// Jarvis memory layer.
//
// Today facts + episodes are keyed by a single channel handle (a
// WhatsApp JID), so anything learned on one channel is invisible on the
// others. This handler introduces a canonical PERSON that unifies all of
// a contact's handles (phone / whatsapp / imessage / sms / voice / email)
// and a single timeline (memory_events) keyed by that person — so a
// conversation that spans WhatsApp + email + a call reads as one history.
//
// Endpoints (tenant-scoped via the standard JWT middleware; the bridges
// call these with their service token the same way they call
// /v1/whatsapp/facts):
//
//   POST /v1/people/resolve     {channel, handle, displayName?} → person + handles + facts
//   GET  /v1/people             list people (most-recently-updated first)
//   POST /v1/memory/events      ingest a timeline event (resolves person from handle)
//   GET  /v1/memory/context     unified context for a person across ALL channels

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// errEmptyHandle is returned when a handle normalizes to nothing.
var errEmptyHandle = errors.New("empty handle after normalization")

// phoneLikeChannelsList is phoneLikeChannels as a slice for SQL ANY().
func phoneLikeChannelsList() []string {
	out := make([]string, 0, len(phoneLikeChannels))
	for c := range phoneLikeChannels {
		out = append(out, c)
	}
	return out
}

type IdentityHandler struct {
	srv  *server.Server
	auth *AuthHandler
	// llm provides text embeddings for semantic recall. Optional — when
	// nil (or no OpenAI key), memory degrades to recency/keyword.
	llm *LlmProxyHandler
}

func NewIdentityHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *IdentityHandler {
	return &IdentityHandler{srv: srv, auth: auth, llm: llm}
}

// embedAsync computes + stores the embedding for a just-inserted event,
// off the request path. Best-effort: any failure is logged and dropped,
// leaving the row searchable by recency/keyword.
func (h *IdentityHandler) embedAsync(tenantID, eventID, text string) {
	if h.llm == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		vec, err := h.llm.EmbedText(ctx, tenantID, text)
		if err != nil {
			h.logger().Debug("embed skipped", zap.Error(err))
			return
		}
		if _, err := h.srv.Pool.Exec(ctx, `
			UPDATE memory_events SET embedding = $2::vector WHERE id = $1
		`, eventID, vectorLiteral(vec)); err != nil {
			h.logger().Warn("embed store failed", zap.Error(err))
		}
	}()
}

func (h *IdentityHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("identity")
}

// phoneLikeChannels are channels addressed by a phone number — they all
// unify to the same person when the normalized digits match.
var phoneLikeChannels = map[string]bool{
	"phone": true, "sms": true, "voice": true,
	"whatsapp": true, "imessage": true, "telegram": true,
}

// canonicalHandle normalizes a (channel, handle) pair for storage and
// matching. Phone-like channels reduce to digits (stripping JID suffixes
// like "@s.whatsapp.net"); email-style handles (incl. iMessage emails)
// normalize to a lowercased "email" channel. isPhone signals the caller
// to match across all phone-like channels by digits.
func canonicalHandle(channel, handle string) (chanOut, handleOut string, isPhone bool) {
	channel = strings.ToLower(strings.TrimSpace(channel))
	handle = strings.TrimSpace(handle)
	if channel == "gmail" {
		channel = "email"
	}
	if channel == "email" {
		return "email", strings.ToLower(handle), false
	}
	if phoneLikeChannels[channel] {
		left := handle
		if i := strings.IndexByte(handle, '@'); i >= 0 {
			left = handle[:i]
		}
		if digits := normalizePhone(left); digits != "" {
			return channel, digits, true
		}
		// Phone-like channel carrying an email address (iMessage email).
		if strings.Contains(handle, "@") {
			return "email", strings.ToLower(handle), false
		}
		return channel, strings.ToLower(handle), false
	}
	return channel, handle, false
}

// phoneHandleVariants returns the legacy jid strings a phone-digits handle
// may have been stored under in whatsapp_contact_facts, so facts written
// before the identity graph still resolve to the person.
func phoneHandleVariants(digits string) []string {
	if digits == "" {
		return nil
	}
	return []string{
		digits,
		digits + "@s.whatsapp.net",
		"+" + digits,
		"+" + digits + "@s.whatsapp.net",
	}
}

// resolvePerson finds or creates the canonical person for a handle and
// ensures the handle is attached. Returns the person id and whether it was
// newly created. Runs in its own transaction.
func (h *IdentityHandler) resolvePerson(ctx context.Context, tenantID, channel, handle, displayName string) (string, bool, error) {
	chn, hdl, isPhone := canonicalHandle(channel, handle)
	if hdl == "" {
		return "", false, errEmptyHandle
	}

	tx, err := h.srv.Pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback(ctx)

	var personID string
	var lookupErr error
	if isPhone {
		// Unify across every phone-like channel by digits.
		lookupErr = tx.QueryRow(ctx, `
			SELECT person_id FROM person_handles
			WHERE tenant_id = $1 AND handle = $2 AND channel = ANY($3)
			LIMIT 1
		`, tenantID, hdl, phoneLikeChannelsList()).Scan(&personID)
	} else {
		lookupErr = tx.QueryRow(ctx, `
			SELECT person_id FROM person_handles
			WHERE tenant_id = $1 AND channel = $2 AND handle = $3
			LIMIT 1
		`, tenantID, chn, hdl).Scan(&personID)
	}

	created := false
	switch {
	case lookupErr == nil:
		// Found — optionally fill a missing display name.
		if displayName != "" {
			_, _ = tx.Exec(ctx, `
				UPDATE people SET display_name = $2, updated_at = now()
				WHERE id = $1 AND (display_name IS NULL OR display_name = '')
			`, personID, displayName)
		}
	case lookupErr == pgx.ErrNoRows:
		if err := tx.QueryRow(ctx, `
			INSERT INTO people (tenant_id, display_name)
			VALUES ($1, NULLIF($2, ''))
			RETURNING id::text
		`, tenantID, displayName).Scan(&personID); err != nil {
			return "", false, err
		}
		created = true
	default:
		return "", false, lookupErr
	}

	// Attach this exact (channel, handle) if not already present.
	if _, err := tx.Exec(ctx, `
		INSERT INTO person_handles (tenant_id, person_id, channel, handle)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, channel, handle) DO NOTHING
	`, tenantID, personID, chn, hdl); err != nil {
		return "", false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return personID, created, nil
}

// ingestExternal inserts an event pulled from an external source (Gmail,
// Calendar) with an external_id for idempotency — re-pulling the same
// item is a no-op via ON CONFLICT. Returns whether a new row was inserted.
func (h *IdentityHandler) ingestExternal(ctx context.Context, tenantID, personID, channel, kind, content, externalID string, occurredAt time.Time, metadata map[string]any) (bool, error) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	metaJSON, _ := json.Marshal(metadata)
	var id string
	err := h.srv.Pool.QueryRow(ctx, `
		INSERT INTO memory_events
			(tenant_id, person_id, channel, kind, content, occurred_at, metadata, external_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULLIF($8, ''))
		ON CONFLICT (tenant_id, kind, external_id) WHERE external_id IS NOT NULL DO NOTHING
		RETURNING id::text
	`, tenantID, personID, channel, kind, content, occurredAt, string(metaJSON), externalID).Scan(&id)
	if err == pgx.ErrNoRows {
		return false, nil // already ingested
	}
	if err != nil {
		return false, err
	}
	h.embedAsync(tenantID, id, content)
	return true, nil
}

// ---- handles + facts loaders (used by resolve + context) -------------------

type personHandle struct {
	Channel string `json:"channel"`
	Handle  string `json:"handle"`
}

func (h *IdentityHandler) loadHandles(ctx context.Context, tenantID, personID string) ([]personHandle, error) {
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT channel, handle FROM person_handles
		WHERE tenant_id = $1 AND person_id = $2
		ORDER BY created_at ASC
	`, tenantID, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []personHandle{}
	for rows.Next() {
		var ph personHandle
		if err := rows.Scan(&ph.Channel, &ph.Handle); err != nil {
			continue
		}
		out = append(out, ph)
	}
	return out, nil
}

// loadFacts returns the contact facts for a person across all channels —
// by person_id (new rows) plus the legacy jid variants of every phone
// handle (rows written before the identity graph existed).
func (h *IdentityHandler) loadFacts(ctx context.Context, tenantID, personID string, handles []personHandle) ([]string, error) {
	jids := []string{}
	for _, ph := range handles {
		jids = append(jids, ph.Handle)
		if phoneLikeChannels[ph.Channel] {
			jids = append(jids, phoneHandleVariants(ph.Handle)...)
		}
	}
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT content FROM whatsapp_contact_facts
		WHERE tenant_id = $1 AND (person_id = $2 OR jid = ANY($3))
		ORDER BY updated_at DESC
		LIMIT 25
	`, tenantID, personID, jids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	seen := map[string]bool{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			continue
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out, nil
}

// ---- HTTP: resolve ---------------------------------------------------------

type resolveBody struct {
	Channel     string `json:"channel"`
	Handle      string `json:"handle"`
	DisplayName string `json:"displayName,omitempty"`
}

func (h *IdentityHandler) ResolvePerson(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body resolveBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(body.Channel) == "" || strings.TrimSpace(body.Handle) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel and handle required"})
		return
	}
	personID, created, err := h.resolvePerson(r.Context(), claims.TenantID, body.Channel, body.Handle, body.DisplayName)
	if err != nil {
		h.logger().Error("resolve person failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve failed"})
		return
	}
	handles, _ := h.loadHandles(r.Context(), claims.TenantID, personID)
	facts, _ := h.loadFacts(r.Context(), claims.TenantID, personID, handles)
	writeJSON(w, http.StatusOK, map[string]any{
		"personId": personID,
		"created":  created,
		"handles":  handles,
		"facts":    facts,
	})
}

// ---- HTTP: list people -----------------------------------------------------

func (h *IdentityHandler) ListPeople(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := h.srv.Pool.Query(r.Context(), `
		SELECT id::text, COALESCE(display_name, ''), COALESCE(relationship, ''),
		       is_owner, updated_at
		FROM people WHERE tenant_id = $1
		ORDER BY updated_at DESC LIMIT 500
	`, claims.TenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, name, rel string
		var isOwner bool
		var updatedAt time.Time
		if err := rows.Scan(&id, &name, &rel, &isOwner, &updatedAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "displayName": name, "relationship": rel,
			"isOwner": isOwner, "updatedAt": updatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": out})
}

// ---- HTTP: ingest event ----------------------------------------------------

type ingestBody struct {
	PersonID    string         `json:"personId,omitempty"`
	Channel     string         `json:"channel"`
	Handle      string         `json:"handle,omitempty"`
	DisplayName string         `json:"displayName,omitempty"`
	Kind        string         `json:"kind"`
	Direction   string         `json:"direction,omitempty"`
	Content     string         `json:"content"`
	OccurredAt  *time.Time     `json:"occurredAt,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

func (h *IdentityHandler) IngestEvent(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body ingestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(body.Channel) == "" || strings.TrimSpace(body.Kind) == "" || strings.TrimSpace(body.Content) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel, kind, content required"})
		return
	}

	personID := strings.TrimSpace(body.PersonID)
	if personID == "" {
		if strings.TrimSpace(body.Handle) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "personId or handle required"})
			return
		}
		pid, _, err := h.resolvePerson(r.Context(), claims.TenantID, body.Channel, body.Handle, body.DisplayName)
		if err != nil {
			h.logger().Error("ingest: resolve failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve failed"})
			return
		}
		personID = pid
	}

	occurred := time.Now()
	if body.OccurredAt != nil {
		occurred = *body.OccurredAt
	}
	meta := body.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	metaJSON, _ := json.Marshal(meta)

	var id string
	err = h.srv.Pool.QueryRow(r.Context(), `
		INSERT INTO memory_events
			(tenant_id, person_id, channel, kind, direction, content, occurred_at, metadata)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8::jsonb)
		RETURNING id::text
	`, claims.TenantID, personID, strings.ToLower(body.Channel), body.Kind, body.Direction,
		body.Content, occurred, string(metaJSON)).Scan(&id)
	if err != nil {
		h.logger().Error("ingest event failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "ingest failed"})
		return
	}
	h.embedAsync(claims.TenantID, id, body.Content)
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "personId": personID})
}

// ---- HTTP: unified context -------------------------------------------------

func (h *IdentityHandler) GetContext(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	q := r.URL.Query()
	personID := strings.TrimSpace(q.Get("personId"))
	if personID == "" {
		channel := q.Get("channel")
		handle := q.Get("handle")
		if channel == "" || handle == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "personId or channel+handle required"})
			return
		}
		pid, _, err := h.resolvePerson(r.Context(), claims.TenantID, channel, handle, "")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve failed"})
			return
		}
		personID = pid
	}

	limit := 20
	if v := strings.TrimSpace(q.Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	keyword := strings.TrimSpace(q.Get("q"))

	handles, _ := h.loadHandles(r.Context(), claims.TenantID, personID)
	facts, _ := h.loadFacts(r.Context(), claims.TenantID, personID, handles)

	// Unified timeline across all channels. With a query we prefer
	// semantic recall (vector similarity over embedded rows); we fall
	// back to keyword (ILIKE) when embeddings are unavailable, and to
	// pure recency when there's no query at all.
	var rows pgx.Rows
	usedVector := false
	if keyword != "" && h.llm != nil {
		if vec, embErr := h.llm.EmbedText(r.Context(), claims.TenantID, keyword); embErr == nil {
			rows, err = h.srv.Pool.Query(r.Context(), `
				SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
				FROM memory_events
				WHERE tenant_id = $1 AND person_id = $2 AND embedding IS NOT NULL
				ORDER BY embedding <=> $3::vector LIMIT $4
			`, claims.TenantID, personID, vectorLiteral(vec), limit)
			usedVector = err == nil
		} else {
			h.logger().Debug("context: embed query failed, using keyword", zap.Error(embErr))
		}
	}
	if !usedVector {
		if keyword != "" {
			rows, err = h.srv.Pool.Query(r.Context(), `
				SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
				FROM memory_events
				WHERE tenant_id = $1 AND person_id = $2 AND content ILIKE '%' || $3 || '%'
				ORDER BY occurred_at DESC LIMIT $4
			`, claims.TenantID, personID, keyword, limit)
		} else {
			rows, err = h.srv.Pool.Query(r.Context(), `
				SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
				FROM memory_events
				WHERE tenant_id = $1 AND person_id = $2
				ORDER BY occurred_at DESC LIMIT $3
			`, claims.TenantID, personID, limit)
		}
	}
	events := []map[string]any{}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var channel, kind, direction, content string
			var occurredAt time.Time
			if err := rows.Scan(&channel, &kind, &direction, &content, &occurredAt); err != nil {
				continue
			}
			events = append(events, map[string]any{
				"channel": channel, "kind": kind, "direction": direction,
				"content": content, "occurredAt": occurredAt,
			})
		}
	}

	var name, rel string
	_ = h.srv.Pool.QueryRow(r.Context(), `
		SELECT COALESCE(display_name, ''), COALESCE(relationship, '')
		FROM people WHERE id = $1 AND tenant_id = $2
	`, personID, claims.TenantID).Scan(&name, &rel)

	writeJSON(w, http.StatusOK, map[string]any{
		"personId":     personID,
		"displayName":  name,
		"relationship": rel,
		"handles":      handles,
		"facts":        facts,
		"events":       events,
	})
}
