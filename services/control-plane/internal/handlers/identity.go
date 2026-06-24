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
//   POST /v1/people/resolve       {channel, handle, displayName?} → person + handles + facts
//   GET  /v1/people               list people (most-recently-updated first)
//   POST /v1/people/merge         merge duplicate person rows (transactional, idempotent)
//   GET  /v1/people/duplicates    list candidate duplicate pairs by name similarity
//   POST /v1/people/relationship  stamp relationship label for a resolved person
//   POST /v1/memory/events        ingest a timeline event (resolves person from handle)
//   GET  /v1/memory/context       unified context for a person across ALL channels
//                                 supports ?windowDays=N for recent-first timeline slice

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
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

// embedSem bounds concurrent embedding calls so an ingest burst (100+
// rows in one tick) can't fan out into a thundering herd of OpenAI
// requests and trip rate limits. Cap is small + env-overridable.
var embedSem = make(chan struct{}, embedConcurrency())

func embedConcurrency() int {
	if v := strings.TrimSpace(os.Getenv("LANTERN_EMBED_CONCURRENCY")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 32 {
			return n
		}
	}
	return 4
}

// embedAsync computes + stores the embedding for an event off the request
// path, capped by embedSem. Best-effort: a failed embed leaves the row
// searchable by recency/keyword and is retried later by backfillEmbeddings.
func (h *IdentityHandler) embedAsync(tenantID, eventID, text string) {
	if h.llm == nil {
		return
	}
	go func() {
		embedSem <- struct{}{}
		defer func() { <-embedSem }()
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		// Background goroutine: carry the tenant on the context so WithTenant
		// can scope the UPDATE under RLS.
		ctx = middleware.InjectTenantID(ctx, tenantID)
		vec, err := h.llm.EmbedText(ctx, tenantID, text)
		if err != nil {
			h.logger().Debug("embed skipped", zap.Error(err))
			return
		}
		if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `
				UPDATE memory_events SET embedding = $2::vector WHERE id = $1
			`, eventID, vectorLiteral(vec))
			return e
		}); err != nil {
			h.logger().Warn("embed store failed", zap.Error(err))
		}
	}()
}

// backfillEmbeddings embeds up to `limit` events that still lack an
// embedding (rate-limited or pre-embedding rows), making semantic recall
// eventually consistent. Called periodically by the memory ingestor.
func (h *IdentityHandler) backfillEmbeddings(ctx context.Context, tenantID string, limit int) {
	if h.llm == nil {
		return
	}
	type pending struct{ id, content string }
	var todo []pending
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id::text, content FROM memory_events
			WHERE tenant_id = $1 AND embedding IS NULL
			ORDER BY occurred_at DESC LIMIT $2
		`, tenantID, limit)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var p pending
			if rows.Scan(&p.id, &p.content) == nil {
				todo = append(todo, p)
			}
		}
		return rows.Err()
	}); err != nil {
		return
	}
	for _, p := range todo {
		h.embedAsync(tenantID, p.id, p.content)
	}
	if len(todo) > 0 {
		h.logger().Debug("embedding backfill queued", zap.Int("count", len(todo)))
	}
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

	var personID string
	created := false
	// The whole resolve (lookup → optional insert → handle attach) runs in one
	// WithTenant transaction so it stays atomic and RLS-scoped to the tenant.
	if err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
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
				return err
			}
			created = true
		default:
			return lookupErr
		}

		// Attach this exact (channel, handle) if not already present.
		if _, err := tx.Exec(ctx, `
			INSERT INTO person_handles (tenant_id, person_id, channel, handle)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (tenant_id, channel, handle) DO NOTHING
		`, tenantID, personID, chn, hdl); err != nil {
			return err
		}
		return nil
	}); err != nil {
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
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO memory_events
				(tenant_id, person_id, channel, kind, content, occurred_at, metadata, external_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULLIF($8, ''))
			ON CONFLICT (tenant_id, kind, external_id) WHERE external_id IS NOT NULL DO NOTHING
			RETURNING id::text
		`, tenantID, personID, channel, kind, content, occurredAt, string(metaJSON), externalID).Scan(&id)
	})
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
	out := []personHandle{}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT channel, handle FROM person_handles
			WHERE tenant_id = $1 AND person_id = $2
			ORDER BY created_at ASC
		`, tenantID, personID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var ph personHandle
			if err := rows.Scan(&ph.Channel, &ph.Handle); err != nil {
				continue
			}
			out = append(out, ph)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
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
	out := []string{}
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT content FROM whatsapp_contact_facts
			WHERE tenant_id = $1 AND (person_id = $2 OR jid = ANY($3))
			ORDER BY updated_at DESC
			LIMIT 25
		`, tenantID, personID, jids)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
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
		return rows.Err()
	})
	if err != nil {
		return nil, err
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
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	personID, created, err := h.resolvePerson(ctx, claims.TenantID, body.Channel, body.Handle, body.DisplayName)
	if err != nil {
		h.logger().Error("resolve person failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve failed"})
		return
	}
	handles, _ := h.loadHandles(ctx, claims.TenantID, personID)
	facts, _ := h.loadFacts(ctx, claims.TenantID, personID, handles)
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
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	out := []map[string]any{}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id::text, COALESCE(display_name, ''), COALESCE(relationship, ''),
			       is_owner, updated_at
			FROM people WHERE tenant_id = $1
			ORDER BY updated_at DESC LIMIT 500
		`, claims.TenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
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
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
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

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	personID := strings.TrimSpace(body.PersonID)
	if personID == "" {
		if strings.TrimSpace(body.Handle) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "personId or handle required"})
			return
		}
		pid, _, err := h.resolvePerson(ctx, claims.TenantID, body.Channel, body.Handle, body.DisplayName)
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
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			INSERT INTO memory_events
				(tenant_id, person_id, channel, kind, direction, content, occurred_at, metadata)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8::jsonb)
			RETURNING id::text
		`, claims.TenantID, personID, strings.ToLower(body.Channel), body.Kind, body.Direction,
			body.Content, occurred, string(metaJSON)).Scan(&id)
	})
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
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	q := r.URL.Query()
	personID := strings.TrimSpace(q.Get("personId"))
	if personID == "" {
		channel := q.Get("channel")
		handle := q.Get("handle")
		if channel == "" || handle == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "personId or channel+handle required"})
			return
		}
		pid, _, err := h.resolvePerson(ctx, claims.TenantID, channel, handle, "")
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

	// windowDays restricts the timeline to events within the last N days.
	// Default 0 means no window (all history). Bridge injects "what we
	// discussed recently" by passing ?windowDays=14.
	windowDays := 0
	if v := strings.TrimSpace(q.Get("windowDays")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 3650 {
			windowDays = n
		}
	}

	keyword := strings.TrimSpace(q.Get("q"))

	handles, _ := h.loadHandles(ctx, claims.TenantID, personID)
	facts, _ := h.loadFacts(ctx, claims.TenantID, personID, handles)

	// Unified timeline across all channels. With a query we prefer
	// semantic recall (vector similarity over embedded rows); we fall
	// back to keyword (ILIKE) when embeddings are unavailable, and to
	// pure recency when there's no query at all. windowDays filters both
	// vector and recency paths equally.
	//
	// Build the SQL + args once, then run the chosen query and drain rows
	// inside a single WithTenant tx (rows must be consumed before the tx
	// commits). The embedding lookup happens before the tx since it is an
	// external LLM call, not a DB read.
	var (
		querySQL  string
		queryArgs []any
	)
	usedVector := false
	if keyword != "" && h.llm != nil {
		if vec, embErr := h.llm.EmbedText(ctx, claims.TenantID, keyword); embErr == nil {
			if windowDays > 0 {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2 AND embedding IS NOT NULL
					  AND occurred_at >= now() - ($5 || ' days')::interval
					ORDER BY embedding <=> $3::vector LIMIT $4`
				queryArgs = []any{claims.TenantID, personID, vectorLiteral(vec), limit, strconv.Itoa(windowDays)}
			} else {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2 AND embedding IS NOT NULL
					ORDER BY embedding <=> $3::vector LIMIT $4`
				queryArgs = []any{claims.TenantID, personID, vectorLiteral(vec), limit}
			}
			usedVector = true
		} else {
			h.logger().Debug("context: embed query failed, using keyword", zap.Error(embErr))
		}
	}
	if !usedVector {
		if keyword != "" {
			if windowDays > 0 {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2 AND content ILIKE '%' || $3 || '%'
					  AND occurred_at >= now() - ($5 || ' days')::interval
					ORDER BY occurred_at DESC LIMIT $4`
				queryArgs = []any{claims.TenantID, personID, keyword, limit, strconv.Itoa(windowDays)}
			} else {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2 AND content ILIKE '%' || $3 || '%'
					ORDER BY occurred_at DESC LIMIT $4`
				queryArgs = []any{claims.TenantID, personID, keyword, limit}
			}
		} else {
			if windowDays > 0 {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2
					  AND occurred_at >= now() - ($4 || ' days')::interval
					ORDER BY occurred_at DESC LIMIT $3`
				queryArgs = []any{claims.TenantID, personID, limit, strconv.Itoa(windowDays)}
			} else {
				querySQL = `
					SELECT channel, kind, COALESCE(direction, ''), content, occurred_at
					FROM memory_events
					WHERE tenant_id = $1 AND person_id = $2
					ORDER BY occurred_at DESC LIMIT $3`
				queryArgs = []any{claims.TenantID, personID, limit}
			}
		}
	}
	events := []map[string]any{}
	var name, rel string
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, querySQL, queryArgs...)
		if qErr == nil {
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
			rows.Close()
		}
		// Person display name + relationship (same tx).
		_ = tx.QueryRow(ctx, `
			SELECT COALESCE(display_name, ''), COALESCE(relationship, '')
			FROM people WHERE id = $1 AND tenant_id = $2
		`, personID, claims.TenantID).Scan(&name, &rel)
		return nil
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"personId":     personID,
		"displayName":  name,
		"relationship": rel,
		"handles":      handles,
		"facts":        facts,
		"events":       events,
		"windowDays":   windowDays,
	})
}

// ---- HTTP: merge people ----------------------------------------------------

// mergeBody describes the two persons to merge. primaryId survives; duplicateId
// is deleted after its events, facts, and handles are re-pointed to primary.
// Both IDs must belong to the caller's tenant.
type mergeBody struct {
	PrimaryID   string `json:"primaryId"`
	DuplicateID string `json:"duplicateId"`
}

// MergePeople merges duplicateId into primaryId within a single transaction.
// All memory_events, whatsapp_contact_facts, and person_handles rows that
// reference duplicateId are re-pointed to primaryId, then the duplicate row
// is deleted. The operation is idempotent: if duplicateId is already gone
// (prior merge) the endpoint returns 200 with merged=true and a note.
func (h *IdentityHandler) MergePeople(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body mergeBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	body.PrimaryID = strings.TrimSpace(body.PrimaryID)
	body.DuplicateID = strings.TrimSpace(body.DuplicateID)
	if body.PrimaryID == "" || body.DuplicateID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "primaryId and duplicateId required"})
		return
	}
	if body.PrimaryID == body.DuplicateID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "primaryId and duplicateId must differ"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	merged, note, err := h.mergePeople(ctx, claims.TenantID, body.PrimaryID, body.DuplicateID)
	if err != nil {
		h.logger().Error("merge people failed",
			zap.String("primary", body.PrimaryID),
			zap.String("duplicate", body.DuplicateID),
			zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "merge failed: " + err.Error()})
		return
	}
	resp := map[string]any{
		"merged":    merged,
		"primaryId": body.PrimaryID,
	}
	if note != "" {
		resp["note"] = note
	}
	writeJSON(w, http.StatusOK, resp)
}

// mergePeople is the transactional core of MergePeople. It returns (true, "",
// nil) on a successful merge, (true, "already merged", nil) when duplicateId
// no longer exists (idempotent), and (false, "", err) on any error.
// Tenant isolation is enforced by checking both person IDs belong to tenantID
// before touching any data.
func (h *IdentityHandler) mergePeople(ctx context.Context, tenantID, primaryID, duplicateID string) (bool, string, error) {
	var (
		merged bool
		note   string
	)
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// Idempotency: duplicate already gone from a prior merge is a no-op.
		var dupExists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM people WHERE id = $1 AND tenant_id = $2
			)
		`, duplicateID, tenantID).Scan(&dupExists); err != nil {
			return err
		}
		if !dupExists {
			// Read-only path: signal idempotent success. The tx commits cleanly.
			merged = true
			note = "duplicate already merged or does not exist"
			return nil
		}

		// Verify primary belongs to the same tenant (hard guard: never merge
		// across tenants even if the caller somehow passes a cross-tenant ID).
		var primaryExists bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM people WHERE id = $1 AND tenant_id = $2
			)
		`, primaryID, tenantID).Scan(&primaryExists); err != nil {
			return err
		}
		if !primaryExists {
			return errors.New("primary person not found in tenant")
		}

		// Re-point memory_events. Rows that would create a duplicate external_id
		// (same (tenant_id, kind, external_id) as an existing primary row) are
		// dropped so the unique index is never violated.
		if _, err := tx.Exec(ctx, `
			UPDATE memory_events SET person_id = $1
			WHERE person_id = $2 AND tenant_id = $3
			  AND NOT EXISTS (
				  SELECT 1 FROM memory_events e2
				  WHERE e2.person_id = $1
				    AND e2.tenant_id = $3
				    AND e2.external_id IS NOT NULL
				    AND e2.external_id = memory_events.external_id
				    AND e2.kind = memory_events.kind
			  )
		`, primaryID, duplicateID, tenantID); err != nil {
			return err
		}
		// Delete any remaining duplicate-person events that collided on external_id.
		if _, err := tx.Exec(ctx, `
			DELETE FROM memory_events
			WHERE person_id = $1 AND tenant_id = $2
		`, duplicateID, tenantID); err != nil {
			return err
		}

		// Re-point whatsapp_contact_facts. Handles can't duplicate because the
		// facts table uses (tenant_id, jid) as its natural key — we just
		// update person_id for all remaining rows.
		if _, err := tx.Exec(ctx, `
			UPDATE whatsapp_contact_facts SET person_id = $1
			WHERE person_id = $2 AND tenant_id = $3
		`, primaryID, duplicateID, tenantID); err != nil {
			return err
		}

		// Re-point person_handles. The UNIQUE constraint on (tenant_id, channel,
		// handle) means a duplicate handle can't be re-inserted; skip it so it
		// is dropped with the person row via CASCADE.
		if _, err := tx.Exec(ctx, `
			UPDATE person_handles SET person_id = $1
			WHERE person_id = $2 AND tenant_id = $3
			  AND NOT EXISTS (
				  SELECT 1 FROM person_handles ph2
				  WHERE ph2.person_id = $1
				    AND ph2.tenant_id = $3
				    AND ph2.channel = person_handles.channel
				    AND ph2.handle = person_handles.handle
			  )
		`, primaryID, duplicateID, tenantID); err != nil {
			return err
		}

		// Delete the duplicate person row. Remaining handles + events that
		// couldn't be migrated (exact duplicates) are cleaned up by CASCADE.
		if _, err := tx.Exec(ctx, `
			DELETE FROM people WHERE id = $1 AND tenant_id = $2
		`, duplicateID, tenantID); err != nil {
			return err
		}

		// Touch primary's updated_at so callers can detect the merge.
		if _, err := tx.Exec(ctx, `
			UPDATE people SET updated_at = now() WHERE id = $1 AND tenant_id = $2
		`, primaryID, tenantID); err != nil {
			return err
		}
		merged = true
		return nil
	})
	if err != nil {
		return false, "", err
	}
	if note == "" {
		h.logger().Info("people merged",
			zap.String("tenant", tenantID),
			zap.String("primary", primaryID),
			zap.String("duplicate", duplicateID))
	}
	return merged, note, nil
}

// ---- HTTP: duplicate candidates --------------------------------------------

// duplicateCandidate is a pair of person IDs that share the same display_name
// (case-insensitive, trimmed). The bridge or dashboard surface these to the
// owner for confirmation before calling merge.
type duplicateCandidate struct {
	PersonIDA   string `json:"personIdA"`
	PersonIDB   string `json:"personIDB"`
	DisplayName string `json:"displayName"`
}

// ListDuplicates returns candidate duplicate pairs for the caller's tenant.
// Two people are candidates when they share the same non-empty, non-blank
// display_name (case-insensitive). The query is intentionally conservative:
// only exact-name matches so the list stays short and actionable.
func (h *IdentityHandler) ListDuplicates(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	candidates := []duplicateCandidate{}
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT a.id::text, b.id::text, a.display_name
			FROM people a
			JOIN people b
			  ON  b.tenant_id = a.tenant_id
			  AND b.id > a.id
			  AND lower(trim(b.display_name)) = lower(trim(a.display_name))
			WHERE a.tenant_id = $1
			  AND a.display_name IS NOT NULL
			  AND trim(a.display_name) <> ''
			ORDER BY a.display_name, a.id
			LIMIT 200
		`, claims.TenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var c duplicateCandidate
			if err := rows.Scan(&c.PersonIDA, &c.PersonIDB, &c.DisplayName); err != nil {
				continue
			}
			candidates = append(candidates, c)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("list duplicates failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"duplicates": candidates})
}

// ---- HTTP: stamp relationship ----------------------------------------------

// relationshipBody carries a (name → relationship) mapping so the bridge can
// annotate a person from the owner's profile (e.g. "Srinivas Merugu" →
// "brother-in-law"). Lookup is by personId OR by resolving (channel, handle).
type relationshipBody struct {
	// Exactly one of PersonID or (Channel + Handle) must be supplied.
	PersonID    string `json:"personId,omitempty"`
	Channel     string `json:"channel,omitempty"`
	Handle      string `json:"handle,omitempty"`
	DisplayName string `json:"displayName,omitempty"`

	Relationship string `json:"relationship"`
}

// StampRelationship sets people.relationship for a resolved person. Tenant-
// scoped; idempotent (repeated calls overwrite the previous value). An empty
// relationship string is rejected so callers can't accidentally clear a label.
func (h *IdentityHandler) StampRelationship(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body relationshipBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	body.Relationship = strings.TrimSpace(body.Relationship)
	if body.Relationship == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "relationship required"})
		return
	}

	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	// Resolve the person.
	personID := strings.TrimSpace(body.PersonID)
	if personID == "" {
		if strings.TrimSpace(body.Channel) == "" || strings.TrimSpace(body.Handle) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "personId or channel+handle required"})
			return
		}
		pid, _, err := h.resolvePerson(ctx, claims.TenantID, body.Channel, body.Handle, body.DisplayName)
		if err != nil {
			h.logger().Error("stamp relationship: resolve failed", zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "resolve failed"})
			return
		}
		personID = pid
	}

	// Verify the person belongs to this tenant and stamp the relationship in a
	// single RLS-scoped transaction.
	var exists bool
	var updateErr error
	verifyErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM people WHERE id = $1 AND tenant_id = $2)
		`, personID, claims.TenantID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return nil
		}
		_, updateErr = tx.Exec(ctx, `
			UPDATE people SET relationship = $1, updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, body.Relationship, personID, claims.TenantID)
		return updateErr
	})
	if verifyErr != nil || !exists {
		if verifyErr != nil && exists {
			h.logger().Error("stamp relationship failed", zap.Error(verifyErr))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "person not found"})
		return
	}

	h.logger().Info("relationship stamped",
		zap.String("tenant", claims.TenantID),
		zap.String("person", personID),
		zap.String("relationship", body.Relationship))
	writeJSON(w, http.StatusOK, map[string]any{
		"personId":     personID,
		"relationship": body.Relationship,
	})
}
