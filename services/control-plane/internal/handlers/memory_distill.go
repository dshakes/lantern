package handlers

// memory_distill.go — LLM-distilled long-term memory (Memory Bank equivalent).
//
// Raw timeline events are stored by memory_ingest.go and identity.go.
// This module runs a periodic pass over those events + recent session
// transcripts to extract DURABLE facts, preferences, and relationship notes
// the LLM judges worth keeping long-term — one compact row per (topic, person).
//
// Intelligence, not keyword matching (project rule: "intelligence is mandatory").
// The LLM distils from raw signal; only items with confidence >= 0.60 and a
// non-empty topic+content are kept.  Any error → no writes, never a crash.
//
// Flag-gated: LANTERN_MEMORY_DISTILL (default OFF).
//   - Unset → loop is a no-op, endpoints return empty/disabled response.
//   - Zero behavior change when flag is off.
//
// RLS-safe: all DB writes use db.WithTenantConn; reads use srv.WithTenant.
// The memory_distillates table is RLS-enforced (migration 0013).
//
// Invariants honored:
//
//	#6  — LLM via researchCompleteFn (provider-failover chain), never hardcoded.
//	#7  — every DB write scoped to tenant_id via WithTenant / WithTenantConn.
//	#10 — session/event content is potentially PII; never logged above debug.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// memoryDistillEnabled reports whether distillation is active.
// Default OFF: unset env = zero behavior change.
func memoryDistillEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_MEMORY_DISTILL")))
	return v == "1" || v == "true" || v == "on"
}

// minDistillConfidence is the floor below which LLM-returned items are
// discarded.  Matches the system prompt's own stated minimum (0.60).
const minDistillConfidence = 0.60

// maxDistillEvents caps how many memory_events rows we read per pass
// (cost control: each event contributes to the LLM prompt).
const maxDistillEvents = 80

// maxDistillSessionMsgs caps session message characters fed to the LLM.
const maxDistillSessionChars = 6000

// ---------- public types ----------

// DistillateItem is one durable memory fact extracted by the LLM.
type DistillateItem struct {
	Topic      string  `json:"topic"`
	Content    string  `json:"content"`
	Confidence float64 `json:"confidence"`
	// PersonHint is an optional name/handle the LLM associated with this fact.
	// It is informational only; person_id is resolved separately (future work).
	PersonHint string `json:"personHint,omitempty"`
}

// storedDistillate adds DB fields for list responses.
type storedDistillate struct {
	ID         string    `json:"id"`
	PersonID   *string   `json:"person_id,omitempty"`
	Topic      string    `json:"topic"`
	Content    string    `json:"content"`
	Confidence float64   `json:"confidence"`
	SourceKind string    `json:"source_kind"`
	SourceRef  string    `json:"source_ref,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// ---------- handler ----------

// MemoryDistillHandler handles:
//
//	GET  /v1/memory/distillates — list active (non-superseded) distillates
//	POST /v1/memory/distill     — trigger a distillation pass now
type MemoryDistillHandler struct {
	srv        *server.Server
	auth       *AuthHandler
	completeFn researchCompleteFn
	tenantID   string
	interval   time.Duration
}

// NewMemoryDistillHandler wires up the handler.
// completeFn defaults to CompleteInternalWithUsage (provider-failover chain).
func NewMemoryDistillHandler(srv *server.Server, auth *AuthHandler, llmProxy *LlmProxyHandler) *MemoryDistillHandler {
	interval := 6 * time.Hour
	if v := strings.TrimSpace(os.Getenv("LANTERN_MEMORY_DISTILL_INTERVAL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= time.Minute {
			interval = d
		}
	}
	h := &MemoryDistillHandler{
		srv:      srv,
		auth:     auth,
		tenantID: getEnvOr("LANTERN_DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001"),
		interval: interval,
	}
	h.completeFn = func(ctx context.Context, tenantID, system, user string) (string, error) {
		text, _, _, _, err := llmProxy.CompleteInternalWithUsage(ctx, tenantID, system, user)
		return text, err
	}
	return h
}

func (h *MemoryDistillHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("memory-distill")
}

func (h *MemoryDistillHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	return middleware.InjectTenantID(r.Context(), claims.TenantID), claims.TenantID, nil
}

// List serves GET /v1/memory/distillates.
// Query params: personId (optional UUID), topic (optional text filter),
// q (optional substring), limit (default 50, cap 200).
func (h *MemoryDistillHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !memoryDistillEnabled() {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "distillates": []any{}})
		return
	}

	q := r.URL.Query()
	personID := strings.TrimSpace(q.Get("personId"))
	topicFilter := strings.TrimSpace(q.Get("topic"))
	textFilter := strings.TrimSpace(q.Get("q"))
	limit := 50
	if lv := q.Get("limit"); lv != "" {
		if n, err := parseInt(lv); err == nil && n > 0 {
			if n > 200 {
				n = 200
			}
			limit = n
		}
	}

	var rows []storedDistillate
	dbErr := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		var qErr error
		rows, qErr = queryDistillates(ctx, tx, tenantID, personID, topicFilter, textFilter, limit)
		return qErr
	})
	if dbErr != nil {
		h.logger().Error("memory_distill: list failed",
			zap.String("tenant", tenantID), zap.Error(dbErr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load distillates"})
		return
	}
	if rows == nil {
		rows = []storedDistillate{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "distillates": rows})
}

// Trigger serves POST /v1/memory/distill.
// Runs a distillation pass synchronously and returns {found:N}.
// Returns {enabled:false} when the flag is off.
func (h *MemoryDistillHandler) Trigger(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !memoryDistillEnabled() {
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"message": "memory distillation disabled (set LANTERN_MEMORY_DISTILL=1 to enable)",
			"found":   0,
		})
		return
	}

	// Gather events from the last 24h so a manual trigger doesn't re-distill
	// the entire history.
	since := time.Now().UTC().Add(-24 * time.Hour)
	found, runErr := runDistillPass(ctx, h.srv.Pool, h.logger(), tenantID, h.completeFn, since)
	if runErr != nil {
		h.logger().Warn("memory_distill: manual trigger incomplete",
			zap.String("tenant", tenantID), zap.Error(runErr))
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "found": found})
}

// ---------- background loop ----------

// RunMemoryDistillLoop starts the periodic distillation loop.
// It is started once in main.go alongside the memory ingestor.
// If LANTERN_MEMORY_DISTILL is off it logs once and returns immediately.
func RunMemoryDistillLoop(ctx context.Context, h *MemoryDistillHandler) {
	if !memoryDistillEnabled() {
		h.logger().Info("memory distillation disabled (LANTERN_MEMORY_DISTILL not set)")
		return
	}
	h.logger().Info("memory distillation loop started", zap.Duration("interval", h.interval))

	// Delay first tick so startup noise settles.
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Minute):
	}

	// First pass: look back 24h from now.
	since := time.Now().UTC().Add(-24 * time.Hour)
	h.tick(ctx, since)

	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()
	lastRun := time.Now().UTC()
	for {
		select {
		case <-ctx.Done():
			return
		case fired := <-ticker.C:
			// Distill everything since the previous run.
			since = lastRun
			lastRun = fired.UTC()
			h.tick(ctx, since)
		}
	}
}

func (h *MemoryDistillHandler) tick(ctx context.Context, since time.Time) {
	tctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	tctx = middleware.InjectTenantID(tctx, h.tenantID)

	found, err := runDistillPass(tctx, h.srv.Pool, h.logger(), h.tenantID, h.completeFn, since)
	if err != nil {
		h.logger().Warn("memory_distill: tick incomplete",
			zap.String("tenant", h.tenantID), zap.Error(err))
		return
	}
	if found > 0 {
		h.logger().Info("memory_distill: tick complete",
			zap.String("tenant", h.tenantID), zap.Int("upserted", found))
	}
}

// ---------- core distillation logic (testable, pool-agnostic) ----------

// runDistillPass gathers raw events and session text since `since`, calls the
// LLM, parses the response, and upserts any qualifying distillates.
// Returns (count, nil) on success; (0, err) on any failure.
// Fail-safe: any error returns 0, never crashes or writes partial state.
func runDistillPass(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID string,
	completeFn researchCompleteFn,
	since time.Time,
) (int, error) {
	if completeFn == nil {
		return 0, fmt.Errorf("memory_distill: no LLM configured")
	}

	// Step 1: gather raw evidence.
	events, sessions, gatherErr := gatherDistillMaterial(ctx, pool, tenantID, since)
	if gatherErr != nil {
		logger.Warn("memory_distill: material gather partial — proceeding with what was collected",
			zap.String("tenant", tenantID), zap.Error(gatherErr))
	}
	if len(events) == 0 && sessions == "" {
		logger.Debug("memory_distill: no new material since last run; skipping",
			zap.String("tenant", tenantID), zap.Time("since", since))
		return 0, nil
	}

	// Step 2: build prompt.
	system, user := buildDistillPrompt(events, sessions, since)

	// Step 3: LLM call — provider-failover chain (invariant #6).
	raw, llmErr := completeFn(ctx, tenantID, system, user)
	if llmErr != nil {
		return 0, fmt.Errorf("memory_distill: LLM call: %w", llmErr)
	}

	// Step 4: tolerant parse + confidence floor.
	items := parseDistillResponse(raw)
	if len(items) == 0 {
		logger.Debug("memory_distill: LLM returned no qualifying distillates",
			zap.String("tenant", tenantID))
		return 0, nil
	}

	// Step 5: upsert — tenant-scoped, RLS-enforced via db.WithTenantConn.
	n, upsertErr := upsertDistillates(ctx, pool, logger, tenantID, items)
	if upsertErr != nil {
		return 0, fmt.Errorf("memory_distill: upsert: %w", upsertErr)
	}
	return n, nil
}

// ---------- evidence gathering ----------

type rawEvent struct {
	OccurredAt time.Time
	Channel    string
	Kind       string
	Content    string
}

// gatherDistillMaterial pulls recent memory_events rows and a summary of
// recent session messages for the tenant since `since`.
func gatherDistillMaterial(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID string,
	since time.Time,
) ([]rawEvent, string, error) {
	var events []rawEvent
	var sessionText string
	var lastErr error

	err := db.WithTenantConn(ctx, pool, tenantID, func(tx pgx.Tx) error {
		// memory_events since last run.
		rows, qErr := tx.Query(ctx, `
			SELECT occurred_at, channel, kind, content
			FROM memory_events
			WHERE tenant_id = $1
			  AND occurred_at >= $2
			ORDER BY occurred_at DESC
			LIMIT $3
		`, tenantID, since, maxDistillEvents)
		if qErr != nil {
			return fmt.Errorf("query memory_events: %w", qErr)
		}
		defer rows.Close()
		for rows.Next() {
			var ev rawEvent
			if err := rows.Scan(&ev.OccurredAt, &ev.Channel, &ev.Kind, &ev.Content); err != nil {
				continue
			}
			events = append(events, ev)
		}
		if err := rows.Err(); err != nil {
			lastErr = fmt.Errorf("scan memory_events: %w", err)
		}

		// Recent session messages (owner-only sessions).
		// We collect messages from the most-recent sessions and cap at a
		// char limit so the prompt stays bounded.
		sessionRows, sErr := tx.Query(ctx, `
			SELECT messages
			FROM sessions
			WHERE tenant_id = $1
			  AND updated_at >= $2
			ORDER BY updated_at DESC
			LIMIT 10
		`, tenantID, since)
		if sErr != nil {
			// Non-fatal — sessions table may not have rows.
			return nil
		}
		defer sessionRows.Close()

		var sb strings.Builder
		for sessionRows.Next() && sb.Len() < maxDistillSessionChars {
			var msgsJSON []byte
			if err := sessionRows.Scan(&msgsJSON); err != nil {
				continue
			}
			// messages is a JSONB array of {role, content} objects.
			var msgs []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(msgsJSON, &msgs); err != nil {
				continue
			}
			for _, m := range msgs {
				if m.Role == "system" || strings.TrimSpace(m.Content) == "" {
					continue
				}
				line := fmt.Sprintf("[%s]: %s\n", m.Role, m.Content)
				if sb.Len()+len(line) > maxDistillSessionChars {
					break
				}
				sb.WriteString(line)
			}
		}
		sessionText = sb.String()
		return nil
	})
	if err != nil {
		lastErr = err
	}
	return events, sessionText, lastErr
}

// ---------- prompt builder (pure function) ----------

func buildDistillPrompt(events []rawEvent, sessionText string, since time.Time) (system, user string) {
	system = `You are a long-term memory distillation engine for a personal AI assistant.

Your task: extract DURABLE facts, preferences, and relationship notes from the provided evidence.

Rules:
- Only emit facts that are genuinely durable and useful for future interactions (preferences, important dates, work context, relationship notes, recurring patterns).
- DO NOT emit transient events ("user asked about the weather"), one-off tasks, or ephemeral status.
- "topic" must be a short snake_case key (e.g. "food_preference", "work_role", "relationship_with_raju").
- "content" must be one clear, complete sentence stating the fact.
- "confidence": 0.90-1.0 for explicit stated facts; 0.60-0.89 for inferred from behavior.
- "personHint": the name or handle this fact is ABOUT if not about the owner themselves (omit when about the owner).
- Minimum confidence is 0.60. Below that, omit the item entirely.
- Return ONLY valid JSON, no markdown fences.
- If no durable facts are found, return: {"distillates":[]}

Output shape:
{"distillates":[{"topic":string,"content":string,"confidence":float,"personHint":string}]}`

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Evidence window: %s to %s (UTC)\n\n",
		since.Format("2006-01-02 15:04"),
		time.Now().UTC().Format("2006-01-02 15:04"),
	))

	if len(events) > 0 {
		sb.WriteString("## Timeline events\n\n")
		for _, ev := range events {
			sb.WriteString(fmt.Sprintf("[%s] %s/%s: %s\n",
				ev.OccurredAt.Format("2006-01-02 15:04"),
				ev.Channel, ev.Kind, ev.Content))
		}
		sb.WriteString("\n")
	}

	if strings.TrimSpace(sessionText) != "" {
		sb.WriteString("## Recent conversation transcript\n\n")
		sb.WriteString(sessionText)
		sb.WriteString("\n")
	}

	sb.WriteString("Analyze the above and return only durable memory distillates as JSON.")
	user = sb.String()
	return
}

// ---------- response parser (pure function) ----------

// parseDistillResponse tolerantly extracts DistillateItems from the raw LLM
// string.  Strips markdown fences, finds the first JSON object, validates
// each item: non-empty topic+content, confidence >= minDistillConfidence.
// Returns nil on total failure; never panics.
func parseDistillResponse(raw string) []DistillateItem {
	s := strings.TrimSpace(raw)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return nil
	}
	s = s[start : end+1]

	var payload struct {
		Distillates []DistillateItem `json:"distillates"`
	}
	if err := json.Unmarshal([]byte(s), &payload); err != nil {
		return nil
	}

	out := payload.Distillates[:0]
	for _, d := range payload.Distillates {
		if strings.TrimSpace(d.Topic) == "" || strings.TrimSpace(d.Content) == "" {
			continue
		}
		if d.Confidence < minDistillConfidence {
			continue
		}
		out = append(out, d)
	}
	return out
}

// ---------- DB persistence ----------

// upsertDistillates writes distillate items for a tenant.
// For each item, if an active row already exists with the same (tenant, person, topic),
// it is superseded (superseded_by = new id).  All writes go through
// db.WithTenantConn (RLS-enforced, invariant #7).
func upsertDistillates(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID string,
	items []DistillateItem,
) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	n := 0
	err := db.WithTenantConn(ctx, pool, tenantID, func(tx pgx.Tx) error {
		for _, item := range items {
			written, wErr := upsertOneDistillate(ctx, tx, tenantID, item)
			if wErr != nil {
				logger.Warn("memory_distill: row skipped",
					zap.String("topic", item.Topic), zap.Error(wErr))
				continue // non-fatal; try remaining items
			}
			if written {
				n++
			}
		}
		return nil
	})
	return n, err
}

// upsertOneDistillate inserts a new distillate row and supersedes any existing
// active row for the same (tenant, person_id=NULL, topic).
// person_id is always NULL for now (owner-global); per-person resolution is
// future work once the person graph is stable.
//
// Supersede ordering: we pre-generate the new row's UUID, mark the old row
// superseded BEFORE inserting the new one, then insert.  This avoids a
// partial-unique-index conflict (the index covers only rows WHERE
// superseded_by IS NULL, so once the old row is marked the constraint clears).
// superseded_by has no FK (by design — see migration 0014 comment), so the
// forward-pointer is safe to write before the target row exists.
func upsertOneDistillate(ctx context.Context, tx pgx.Tx, tenantID string, item DistillateItem) (bool, error) {
	// Pre-generate the id for the new row so we can write it into the old row
	// before the INSERT, clearing the partial unique index.
	newID := uuid.NewString()

	// Look up the currently-active row (if any) and mark it superseded.
	var oid string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM memory_distillates
		WHERE tenant_id = $1 AND topic = $2 AND person_id IS NULL AND superseded_by IS NULL
		LIMIT 1
	`, tenantID, item.Topic).Scan(&oid); err == nil {
		// Mark old row superseded now, BEFORE inserting the new one.
		// This removes it from the partial unique index.
		if _, err := tx.Exec(ctx, `
			UPDATE memory_distillates SET superseded_by = $2::uuid, updated_at = now()
			WHERE id = $1::uuid
		`, oid, newID); err != nil {
			return false, fmt.Errorf("supersede old distillate %q (id=%s): %w", item.Topic, oid, err)
		}
	}

	// Insert the new row with the pre-generated id.
	if _, err := tx.Exec(ctx, `
		INSERT INTO memory_distillates
			(id, tenant_id, person_id, topic, content, confidence, source_kind, source_ref)
		VALUES ($1::uuid, $2::uuid, NULL, $3, $4, $5, 'events', '')
	`, newID, tenantID, item.Topic, item.Content, item.Confidence); err != nil {
		return false, fmt.Errorf("insert distillate %q: %w", item.Topic, err)
	}
	return true, nil
}

// ---------- DB read ----------

// queryDistillates returns active (non-superseded) distillate rows for
// the given tenant, with optional filters.
func queryDistillates(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, personID, topicFilter, textFilter string,
	limit int,
) ([]storedDistillate, error) {
	args := []any{tenantID}
	where := []string{"tenant_id = $1", "superseded_by IS NULL"}

	if personID != "" {
		args = append(args, personID)
		where = append(where, fmt.Sprintf("person_id = $%d::uuid", len(args)))
	}
	if topicFilter != "" {
		args = append(args, topicFilter)
		where = append(where, fmt.Sprintf("topic = $%d", len(args)))
	}
	if textFilter != "" {
		args = append(args, "%"+textFilter+"%")
		where = append(where, fmt.Sprintf("content ILIKE $%d", len(args)))
	}
	args = append(args, limit)

	q := fmt.Sprintf(`
		SELECT id::text, person_id::text, topic, content, confidence,
		       source_kind, source_ref, created_at, updated_at
		FROM memory_distillates
		WHERE %s
		ORDER BY updated_at DESC
		LIMIT $%d
	`, strings.Join(where, " AND "), len(args))

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query memory_distillates: %w", err)
	}
	defer rows.Close()

	var result []storedDistillate
	for rows.Next() {
		var d storedDistillate
		var pid *string
		if err := rows.Scan(&d.ID, &pid, &d.Topic, &d.Content, &d.Confidence,
			&d.SourceKind, &d.SourceRef, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan distillate row: %w", err)
		}
		d.PersonID = pid
		result = append(result, d)
	}
	return result, rows.Err()
}
