package handlers

// run_events.go — GET /v1/runs/{id}/events
//
// Streams a run's journal_events as Server-Sent Events. Late subscribers
// receive the full replay (all rows already in journal_events ordered by seq)
// before tailing for new events. Tailing stops as soon as the run reaches a
// terminal state (succeeded / failed / canceled) or the client disconnects.
//
// SSE mechanics mirror the session-events handler in sessions.go:
//   - Content-Type: text/event-stream, Cache-Control: no-cache
//   - Flush after every event + on heartbeat ticks
//   - Heartbeat comment (": heartbeat") every heartbeatInterval to keep the
//     connection alive through proxies
//
// Security:
//   - JWT auth (Bearer token or ?token= query param for EventSource clients)
//   - Tenant-ownership check before any streaming: run must belong to the
//     caller's tenant (WHERE id=$1 AND tenant_id=$2)

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
)

const (
	// heartbeatInterval is how often a SSE comment is sent to keep the
	// connection alive through HTTP proxies that close idle connections.
	runEventsHeartbeatInterval = 15 * time.Second

	// tailPollInterval is how often we re-query journal_events for new rows
	// while tailing a non-terminal run. Short enough to feel responsive,
	// long enough not to hammer Postgres.
	runEventsTailPollInterval = 500 * time.Millisecond
)

// journalEventRow is the shape returned by the journal_events query and
// emitted as SSE data.
type journalEventRow struct {
	Seq       int64           `json:"seq"`
	Kind      string          `json:"kind"`
	StepID    *string         `json:"stepId,omitempty"`
	Attempt   int             `json:"attempt"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

// GetRunEvents handles GET /v1/runs/{id}/events.
//
// Replays all existing journal_events for the run in seq order, then tails
// for new events until the run is in a terminal state or the client disconnects.
func (h *RESTHandler) GetRunEvents(w http.ResponseWriter, r *http.Request) {
	// Auth — accept Bearer token or ?token= query param (for EventSource which
	// cannot set headers). Same pattern as SessionHandler.GetEvents.
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		tokenParam := r.URL.Query().Get("token")
		if tokenParam != "" {
			claims, err = h.auth.ValidateToken(tokenParam)
		}
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
	}
	tenantID := claims.TenantID

	runID := r.PathValue("id")
	if runID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "run id is required"})
		return
	}

	ctx := r.Context()

	// Ownership check — also fetch current run status so we know when to stop.
	var runStatus string
	// rls-exempt: ownership gate for an SSE stream (no per-row transaction). The
	// explicit `tenant_id = $2` filter is the authoritative tenant gate; a
	// per-iteration WithTenant tx in the tail loop adds no isolation it doesn't.
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT status
		FROM   runs
		WHERE  id = $1 AND tenant_id = $2
	`, runID, tenantID).Scan(&runStatus)
	if err != nil {
		// pgx.ErrNoRows → not found (or belongs to another tenant).
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
		return
	}

	// SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Mirror-origin CORS — same policy as session-events SSE handler.
	if origin := r.Header.Get("Origin"); origin != "" {
		allowed := corsAllowedOrigins()
		if _, ok := allowed[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}

	// -----------------------------------------------------------------------
	// Emit a helper to format and write one SSE event.
	// We use the journal row's kind as the SSE event: field, which lets
	// EventSource clients filter by event type.
	// -----------------------------------------------------------------------
	emitEvent := func(row journalEventRow) {
		data, merr := json.Marshal(row)
		if merr != nil {
			h.logger().Warn("run events: marshal error", zap.String("run_id", runID), zap.Error(merr))
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", row.Kind, data)
		flusher.Flush()
	}

	emitHeartbeat := func() {
		fmt.Fprintf(w, ": heartbeat\n\n")
		flusher.Flush()
	}

	// -----------------------------------------------------------------------
	// Phase 1 — Replay all existing events.
	// We read every journal_events row for this run in seq order. We don't
	// need a WHERE tenant_id check on journal_events because we already
	// confirmed the run belongs to the tenant above; journal_events.run_id is
	// the FK that binds them.
	// -----------------------------------------------------------------------
	var lastSeq int64
	// rls-exempt: journal_events is an RLS-exempt child table (no tenant_id;
	// scoped by run_id). Run ownership was already verified by the tenant-scoped
	// gate above, so run_id is a sufficient filter.
	rows, qerr := h.srv.Pool.Query(ctx, `
		SELECT seq, kind, step_id, attempt, payload, created_at
		FROM   journal_events
		WHERE  run_id = $1
		ORDER  BY seq ASC
	`, runID)
	if qerr != nil {
		h.logger().Error("run events: query journal", zap.String("run_id", runID), zap.Error(qerr))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	func() {
		defer rows.Close()
		for rows.Next() {
			var row journalEventRow
			var rawPayload []byte
			if serr := rows.Scan(&row.Seq, &row.Kind, &row.StepID, &row.Attempt, &rawPayload, &row.CreatedAt); serr != nil {
				h.logger().Warn("run events: scan row", zap.String("run_id", runID), zap.Error(serr))
				continue
			}
			row.Payload = json.RawMessage(rawPayload)
			emitEvent(row)
			if row.Seq > lastSeq {
				lastSeq = row.Seq
			}
		}
	}()

	// If the run was already terminal when we started streaming (or became so
	// while replaying), we're done — no tail needed.
	if isRunTerminal(runStatus) {
		return
	}

	// -----------------------------------------------------------------------
	// Phase 2 — Tail: poll for new rows until the run is terminal or the
	// client disconnects.
	// -----------------------------------------------------------------------
	heartbeat := time.NewTicker(runEventsHeartbeatInterval)
	poll := time.NewTicker(runEventsTailPollInterval)
	defer heartbeat.Stop()
	defer poll.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-heartbeat.C:
			emitHeartbeat()

		case <-poll.C:
			// Fetch any new journal_events rows since lastSeq.
			// rls-exempt: journal_events child table, scoped by run_id (ownership
			// already verified above).
			newRows, perr := h.srv.Pool.Query(ctx, `
				SELECT seq, kind, step_id, attempt, payload, created_at
				FROM   journal_events
				WHERE  run_id = $1 AND seq > $2
				ORDER  BY seq ASC
			`, runID, lastSeq)
			if perr != nil {
				if ctx.Err() != nil {
					return
				}
				h.logger().Warn("run events: poll error", zap.String("run_id", runID), zap.Error(perr))
				continue
			}
			func() {
				defer newRows.Close()
				for newRows.Next() {
					var row journalEventRow
					var rawPayload []byte
					if serr := newRows.Scan(&row.Seq, &row.Kind, &row.StepID, &row.Attempt, &rawPayload, &row.CreatedAt); serr != nil {
						h.logger().Warn("run events: tail scan", zap.String("run_id", runID), zap.Error(serr))
						continue
					}
					row.Payload = json.RawMessage(rawPayload)
					emitEvent(row)
					if row.Seq > lastSeq {
						lastSeq = row.Seq
					}
				}
			}()

			// Re-check run status to detect terminal state.
			var currentStatus string
			// rls-exempt: terminal-status recheck in the SSE tail loop; explicit
			// `tenant_id = $2` filter is the tenant gate (see ownership gate above).
			serr := h.srv.Pool.QueryRow(ctx, `
				SELECT status FROM runs WHERE id = $1 AND tenant_id = $2
			`, runID, tenantID).Scan(&currentStatus)
			if serr != nil {
				// Run disappeared or context cancelled — stop.
				if ctx.Err() != nil {
					return
				}
				h.logger().Warn("run events: status recheck failed",
					zap.String("run_id", runID), zap.Error(serr))
				return
			}
			if isRunTerminal(currentStatus) {
				return
			}
		}
	}
}

// isRunTerminal reports whether the given run status string is a terminal state.
// Terminal runs will never emit new journal_events.
func isRunTerminal(status string) bool {
	switch status {
	case "succeeded", "failed", "canceled":
		return true
	default:
		return false
	}
}
