package handlers

// batch.go — batch invocation API (ADR 0033).
//
// POST /v1/batches                creates a batch + N child runs
// GET  /v1/batches/{id}           status summary (counts by status, total cost)
// GET  /v1/batches/{id}/results   paginated per-run outputs
// POST /v1/batches/{id}/cancel    cancel all pending/running children
//
// Each item in the batch is a regular run dispatched through CreateRun, so
// budgets, quotas, spawn rate-limits, and routing all apply per-run.
// Optional concurrency cap throttles how many runs are in-flight simultaneously.
// When the last child terminates, the batch itself is marked terminal and its
// completion callback (if any) is fired.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

const (
	// batchDefaultMaxItems is the upper bound on items per batch when
	// PAL_BATCH_MAX_ITEMS (or LANTERN_BATCH_MAX_ITEMS) is not set.
	batchDefaultMaxItems = 1000

	// batchResultsPageSize is the default / max page size for GET /results.
	batchResultsPageSize = 100
)

// BatchHandler serves the /v1/batches/* routes.
type BatchHandler struct {
	srv  *server.Server
	auth *AuthHandler
	rest *RESTHandler
}

// NewBatchHandler constructs a BatchHandler.
func NewBatchHandler(srv *server.Server, auth *AuthHandler, rest *RESTHandler) *BatchHandler {
	return &BatchHandler{srv: srv, auth: auth, rest: rest}
}

// RegisterRoutes wires batch routes onto mux.
func (h *BatchHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/batches", h.auth.WithScope(ScopeRunsExecute, h.CreateBatch))
	mux.HandleFunc("GET /v1/batches/{id}", h.auth.WithScope(ScopeRunsRead, h.GetBatch))
	mux.HandleFunc("GET /v1/batches/{id}/results", h.auth.WithScope(ScopeRunsRead, h.GetBatchResults))
	mux.HandleFunc("POST /v1/batches/{id}/cancel", h.auth.WithScope(ScopeRunsExecute, h.CancelBatch))
}

func (h *BatchHandler) logger() *zap.Logger { return h.srv.Logger.Named("batch") }

// ---------- request/response shapes ----------

type batchItem struct {
	Input          map[string]any `json:"input"`
	IdempotencyKey string         `json:"idempotencyKey,omitempty"`
}

type createBatchReq struct {
	AgentName   string      `json:"agentName"`
	Items       []batchItem `json:"items"`
	Concurrency int         `json:"concurrency,omitempty"`
	CallbackUrl string      `json:"callbackUrl,omitempty"`
}

type batchSummary struct {
	ID             string  `json:"id"`
	AgentName      string  `json:"agentName"`
	Status         string  `json:"status"`
	TotalCount     int     `json:"totalCount"`
	PendingCount   int     `json:"pendingCount"`
	RunningCount   int     `json:"runningCount"`
	SucceededCount int     `json:"succeededCount"`
	FailedCount    int     `json:"failedCount"`
	CancelledCount int     `json:"cancelledCount"`
	CostUSD        float64 `json:"costUsd"`
	CallbackUrl    string  `json:"callbackUrl,omitempty"`
	Concurrency    int     `json:"concurrency,omitempty"`
	CreatedAt      string  `json:"createdAt"`
	FinishedAt     string  `json:"finishedAt,omitempty"`
}

type batchResultItem struct {
	RunID     string  `json:"runId"`
	Status    string  `json:"status"`
	Output    string  `json:"output,omitempty"`
	Error     string  `json:"error,omitempty"`
	CostUSD   float64 `json:"costUsd"`
	TokensIn  int64   `json:"tokensIn"`
	TokensOut int64   `json:"tokensOut"`
	CreatedAt string  `json:"createdAt"`
}

// ---------- CreateBatch ----------

// CreateBatch handles POST /v1/batches.
func (h *BatchHandler) CreateBatch(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body createBatchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.AgentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName is required"})
		return
	}
	maxItems := envIntOrDefault("PAL_BATCH_MAX_ITEMS", envIntOrDefault("LANTERN_BATCH_MAX_ITEMS", batchDefaultMaxItems))
	if len(body.Items) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "items must not be empty"})
		return
	}
	if len(body.Items) > maxItems {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("items exceeds maximum of %d", maxItems),
		})
		return
	}
	if body.CallbackUrl != "" {
		if err := checkSSRF(body.CallbackUrl); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}

	// Idempotency via Idempotency-Key request header.
	idemKey := r.Header.Get("Idempotency-Key")

	var batchID string
	var alreadyExists bool

	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		if idemKey != "" {
			// Check for existing batch with this idempotency key.
			e := tx.QueryRow(ctx, `SELECT id FROM batches WHERE tenant_id = $1 AND idempotency_key = $2`,
				tenantID, idemKey).Scan(&batchID)
			if e == nil {
				alreadyExists = true
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return fmt.Errorf("batch idem check: %w", e)
			}
		}
		var cbURL *string
		if body.CallbackUrl != "" {
			cbURL = &body.CallbackUrl
		}
		var idem *string
		if idemKey != "" {
			idem = &idemKey
		}
		e := tx.QueryRow(ctx, `
			INSERT INTO batches (tenant_id, agent_name, total_count, pending_count, callback_url, concurrency, idempotency_key)
			VALUES ($1, $2, $3, $3, $4, $5, $6)
			RETURNING id
		`, tenantID, body.AgentName, len(body.Items), cbURL, body.Concurrency, idem).Scan(&batchID)
		return e
	})
	if err != nil {
		h.logger().Error("CreateBatch: insert failed", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if alreadyExists {
		// Return the existing batch summary idempotently.
		h.writeBatchByID(w, ctx, tenantID, batchID, http.StatusOK)
		return
	}

	// Dispatch child runs asynchronously so the HTTP request returns fast.
	// Use rest.inFlightRuns (same package) so the graceful-shutdown drain
	// waits for batch goroutines too.
	h.rest.inFlightRuns.Add(1)
	go func() {
		defer h.rest.inFlightRuns.Done()
		h.dispatchBatch(batchID, tenantID, body)
	}()

	h.writeBatchByID(w, ctx, tenantID, batchID, http.StatusCreated)
}

// ---------- GetBatch ----------

// GetBatch handles GET /v1/batches/{id}.
func (h *BatchHandler) GetBatch(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}
	h.writeBatchByID(w, ctx, tenantID, id, http.StatusOK)
}

// ---------- GetBatchResults ----------

// GetBatchResults handles GET /v1/batches/{id}/results.
func (h *BatchHandler) GetBatchResults(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}

	// Verify ownership.
	var exists bool
	if dbErr := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM batches WHERE id = $1 AND tenant_id = $2)`,
			id, tenantID).Scan(&exists)
	}); dbErr != nil || !exists {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}

	// Pagination: offset by last-seen createdAt.
	after := r.URL.Query().Get("after") // ISO timestamp of the last item in prev page

	results := make([]batchResultItem, 0)
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		q := `SELECT r.id, r.status,
		             COALESCE(r.output->>'result', ''),
		             COALESCE(r.error->>'message', ''),
		             COALESCE(r.cost_usd, 0),
		             COALESCE(r.tokens_in, 0),
		             COALESCE(r.tokens_out, 0),
		             r.created_at
		      FROM runs r
		      WHERE r.tenant_id = $1 AND r.batch_id = $2`
		args := []any{tenantID, id}
		if after != "" {
			q += ` AND r.created_at > $3`
			args = append(args, after)
		}
		q += ` ORDER BY r.created_at ASC LIMIT ` + fmt.Sprint(batchResultsPageSize)
		rows, e := tx.Query(ctx, q, args...)
		if e != nil {
			return fmt.Errorf("batch results query: %w", e)
		}
		defer rows.Close()
		for rows.Next() {
			var item batchResultItem
			var createdAt time.Time
			if e := rows.Scan(&item.RunID, &item.Status, &item.Output, &item.Error,
				&item.CostUSD, &item.TokensIn, &item.TokensOut, &createdAt); e != nil {
				return fmt.Errorf("batch results scan: %w", e)
			}
			item.CreatedAt = createdAt.UTC().Format(time.RFC3339)
			results = append(results, item)
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("GetBatchResults failed", zap.String("batch_id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	var nextAfter string
	if len(results) == batchResultsPageSize {
		nextAfter = results[len(results)-1].CreatedAt
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"results":   results,
		"nextAfter": nextAfter,
	})
}

// ---------- CancelBatch ----------

// CancelBatch handles POST /v1/batches/{id}/cancel.
func (h *BatchHandler) CancelBatch(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if _, perr := uuid.Parse(id); perr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}

	var n int64
	err = db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		// Ownership check + mark batch cancelled.
		var batchStatus string
		e := tx.QueryRow(ctx, `SELECT status FROM batches WHERE id = $1 AND tenant_id = $2`,
			id, tenantID).Scan(&batchStatus)
		if errors.Is(e, pgx.ErrNoRows) {
			return pgx.ErrNoRows
		}
		if e != nil {
			return fmt.Errorf("CancelBatch: lookup: %w", e)
		}
		if isRunTerminal(batchStatus) {
			return nil // already terminal — idempotent
		}
		if _, e := tx.Exec(ctx, `
			UPDATE batches SET status = 'cancelled', finished_at = now()
			WHERE id = $1 AND tenant_id = $2`, id, tenantID); e != nil {
			return fmt.Errorf("CancelBatch: mark cancelled: %w", e)
		}
		// Cancel all queued/running child runs.
		tag, e := tx.Exec(ctx, `
			UPDATE runs SET status = 'cancelled', finished_at = now()
			WHERE tenant_id = $1 AND batch_id = $2 AND status IN ('queued', 'running')`,
			tenantID, id)
		if e != nil {
			return fmt.Errorf("CancelBatch: cancel runs: %w", e)
		}
		n = tag.RowsAffected()
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}
	if err != nil {
		h.logger().Error("CancelBatch failed", zap.String("batch_id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	h.logger().Info("batch cancelled", zap.String("batch_id", id), zap.Int64("runs_cancelled", n))
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": true, "runsCancelled": n})
}

// ---------- helpers ----------

// contextWithTenant extracts and validates the JWT/API-key, returning a
// tenant-injected context.
func (h *BatchHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims := claimsFromCtx(r.Context())
	if claims == nil {
		var err error
		if claims, err = h.auth.validateRequest(r); err != nil {
			return nil, "", err
		}
	}
	middleware.EnrichSpan(r.Context(), claims.TenantID, claims.Subject, "", "")
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

func (h *BatchHandler) writeBatchByID(w http.ResponseWriter, ctx context.Context, tenantID, batchID string, status int) {
	var s batchSummary
	var createdAt time.Time
	var finishedAt *time.Time
	var cbURL *string

	err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT id, agent_name, status, total_count, pending_count, running_count,
			       succeeded_count, failed_count, cancelled_count, cost_usd,
			       callback_url, concurrency, created_at, finished_at
			FROM batches WHERE id = $1 AND tenant_id = $2
		`, batchID, tenantID).Scan(
			&s.ID, &s.AgentName, &s.Status,
			&s.TotalCount, &s.PendingCount, &s.RunningCount,
			&s.SucceededCount, &s.FailedCount, &s.CancelledCount,
			&s.CostUSD, &cbURL, &s.Concurrency, &createdAt, &finishedAt,
		)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "batch not found"})
		return
	}
	if err != nil {
		h.logger().Error("GetBatch failed", zap.String("batch_id", batchID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	s.CreatedAt = createdAt.UTC().Format(time.RFC3339)
	if finishedAt != nil {
		s.FinishedAt = finishedAt.UTC().Format(time.RFC3339)
	}
	if cbURL != nil {
		s.CallbackUrl = *cbURL
	}
	writeJSON(w, status, s)
}

// dispatchBatch fans out child runs, honours optional concurrency limit,
// and marks the batch terminal when all children are done.
func (h *BatchHandler) dispatchBatch(batchID, tenantID string, body createBatchReq) {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)
	log := h.logger().With(zap.String("batch_id", batchID), zap.String("tenant_id", tenantID))

	concurrency := body.Concurrency
	if concurrency <= 0 {
		concurrency = len(body.Items) // unlimited — all at once
	}

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for i, item := range body.Items {
		item := item
		_ = i
		// Stop dispatching new runs if the batch was cancelled while in-flight.
		select {
		case <-ctx.Done():
			wg.Add(1)
			go func() {
				defer wg.Done()
				h.incrementBatchCounter(ctx, tenantID, batchID, "cancelled_count", 0, log)
			}()
			continue
		default:
		}
		var batchCancelled bool
		// rls-exempt: keyed by the authorised batch id.
		_ = h.srv.Pool.QueryRow(ctx, `SELECT status = 'cancelled' FROM batches WHERE id = $1`, batchID).Scan(&batchCancelled)
		if batchCancelled {
			// Decrement pending for this item without ever running it.
			if _, e := h.srv.Pool.Exec(ctx,
				`UPDATE batches SET pending_count = GREATEST(0, pending_count - 1),
				 cancelled_count = cancelled_count + 1 WHERE id = $1`, batchID,
			); e != nil {
				log.Warn("dispatchBatch: pending→cancelled failed on cancel", zap.Error(e))
			}
			continue
		}
		wg.Add(1)
		sem <- struct{}{} // acquire slot
		go func() {
			defer wg.Done()
			defer func() { <-sem }() // release slot
			runID := h.spawnBatchRun(ctx, batchID, tenantID, body.AgentName, item, log)
			if runID != "" {
				// Wait for this run to reach terminal state, then update batch counters.
				h.waitAndRecord(ctx, batchID, tenantID, runID, log)
			} else {
				// Run creation failed: decrement pending and count as failed.
				// (spawnBatchRun never incremented running_count on failure, so we
				// only fix pending_count here, not running_count.)
				if _, e := h.srv.Pool.Exec(ctx,
					`UPDATE batches SET pending_count = GREATEST(0, pending_count - 1),
					 failed_count = failed_count + 1 WHERE id = $1`, batchID,
				); e != nil {
					log.Warn("dispatchBatch: pending→failed counter update failed", zap.Error(e))
				}
			}
		}()
	}
	wg.Wait()

	// Refresh batch counters from actual run states and mark terminal.
	h.finalizeBatch(ctx, tenantID, batchID, body.CallbackUrl, log)
}

// spawnBatchRun creates one child run and links it to the batch. Returns the
// run ID on success, "" on failure.
func (h *BatchHandler) spawnBatchRun(ctx context.Context, batchID, tenantID, agentName string, item batchItem, log *zap.Logger) string {
	inputJSON, _ := json.Marshal(map[string]any{
		"agentName": agentName,
		"input":     item.Input,
	})

	// Use rest.CreateRun via an in-process recorder (same pattern as triggers.go
	// startRun) so budget checks, spawn limits, and routing apply identically.
	ctx = storeClaimsInCtx(ctx, &LanternClaims{TenantID: tenantID, Role: "service"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "/v1/runs",
		bytes.NewReader(inputJSON))
	if err != nil {
		log.Warn("spawnBatchRun: build request failed", zap.Error(err))
		return ""
	}
	rec := httptest.NewRecorder()
	h.rest.CreateRun(rec, req)
	var resp map[string]any
	if json.Unmarshal(rec.Body.Bytes(), &resp) != nil || rec.Code != http.StatusCreated {
		log.Warn("spawnBatchRun: CreateRun failed",
			zap.Int("status", rec.Code), zap.Any("resp", resp))
		return ""
	}
	runID, _ := resp["id"].(string)
	if runID == "" {
		log.Warn("spawnBatchRun: no run id in response")
		return ""
	}
	// Link the run to the batch.
	// rls-exempt: run is keyed by the just-created authorized run id.
	if _, e := h.srv.Pool.Exec(ctx,
		`UPDATE runs SET batch_id = $2 WHERE id = $1`, runID, batchID,
	); e != nil {
		log.Warn("spawnBatchRun: link batch_id failed", zap.String("run_id", runID), zap.Error(e))
	}
	// Update the batch's running_count (already decremented pending).
	if _, e := h.srv.Pool.Exec(ctx,
		`UPDATE batches SET pending_count = GREATEST(0, pending_count - 1), running_count = running_count + 1
		 WHERE id = $1`, batchID,
	); e != nil {
		log.Warn("spawnBatchRun: update batch pending→running failed", zap.Error(e))
	}
	return runID
}

// waitAndRecord polls until the run is terminal, then updates batch counters.
func (h *BatchHandler) waitAndRecord(ctx context.Context, batchID, tenantID, runID string, log *zap.Logger) {
	const pollInterval = 2 * time.Second
	const maxWait = 4 * time.Hour // generous; batch items are expected to complete

	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(pollInterval):
		}
		var status string
		var costUSD float64
		// rls-exempt: run keyed by id.
		err := h.srv.Pool.QueryRow(ctx,
			`SELECT status, COALESCE(cost_usd, 0) FROM runs WHERE id = $1`, runID,
		).Scan(&status, &costUSD)
		if err != nil {
			log.Warn("waitAndRecord: run poll failed", zap.String("run_id", runID), zap.Error(err))
			continue
		}
		if !isRunTerminal(status) {
			continue
		}
		h.incrementBatchCounter(ctx, tenantID, batchID, status+"_count", costUSD, log)
		return
	}
	log.Warn("waitAndRecord: timeout waiting for run", zap.String("run_id", runID))
	h.incrementBatchCounter(ctx, tenantID, batchID, "failed_count", 0, log)
}

// incrementBatchCounter updates one terminal-status counter and the cost.
func (h *BatchHandler) incrementBatchCounter(ctx context.Context, tenantID, batchID, counterCol string, costUSD float64, log *zap.Logger) {
	// Only the four terminal counters are valid.
	switch counterCol {
	case "succeeded_count", "failed_count", "cancelled_count":
	default:
		counterCol = "failed_count"
	}
	// rls-exempt: batch keyed by id (authorized batch).
	if _, err := h.srv.Pool.Exec(ctx,
		fmt.Sprintf(`UPDATE batches SET running_count = GREATEST(0, running_count - 1),
		             %s = %s + 1, cost_usd = cost_usd + $2
		             WHERE id = $1`, counterCol, counterCol),
		batchID, costUSD,
	); err != nil {
		log.Warn("incrementBatchCounter failed",
			zap.String("batch_id", batchID), zap.String("col", counterCol), zap.Error(err))
	}
}

// finalizeBatch marks the batch terminal when all child runs are done.
// It does not overwrite an already-cancelled status (CancelBatch may have raced
// us to it).
func (h *BatchHandler) finalizeBatch(ctx context.Context, tenantID, batchID, callbackURL string, log *zap.Logger) {
	var totalCount, succeededCount, failedCount, cancelledCount int
	var existingStatus string
	var costUSD float64
	// rls-exempt: batch keyed by id.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT status, total_count, succeeded_count, failed_count, cancelled_count, cost_usd
		FROM batches WHERE id = $1`, batchID,
	).Scan(&existingStatus, &totalCount, &succeededCount, &failedCount, &cancelledCount, &costUSD)
	if err != nil {
		log.Error("finalizeBatch: read failed", zap.Error(err))
		return
	}
	// If the batch was cancelled externally (CancelBatch), respect that.
	if isRunTerminal(existingStatus) {
		log.Info("finalizeBatch: batch already terminal (no-op)",
			zap.String("batch_id", batchID), zap.String("status", existingStatus))
		return
	}

	terminalCount := succeededCount + failedCount + cancelledCount
	if terminalCount < totalCount {
		log.Warn("finalizeBatch: not all runs are terminal",
			zap.Int("terminal", terminalCount), zap.Int("total", totalCount))
	}

	batchStatus := "succeeded"
	if failedCount > 0 {
		batchStatus = "failed"
	} else if cancelledCount > 0 {
		batchStatus = "cancelled"
	}

	// rls-exempt: batch keyed by id; only transition from non-terminal.
	if _, err := h.srv.Pool.Exec(ctx,
		`UPDATE batches SET status = $2, finished_at = now()
		 WHERE id = $1 AND status NOT IN ('succeeded','failed','cancelled')`,
		batchID, batchStatus,
	); err != nil {
		log.Error("finalizeBatch: mark terminal failed", zap.Error(err))
	}

	log.Info("batch finalized",
		zap.String("batch_id", batchID), zap.String("status", batchStatus),
		zap.Int("succeeded", succeededCount), zap.Int("failed", failedCount))

	// Batch-level callback (ADR 0033).
	// Read callback_url from DB if not passed (survives a restart between spawn and finalize).
	if callbackURL == "" {
		_ = h.srv.Pool.QueryRow(ctx, `SELECT COALESCE(callback_url, '') FROM batches WHERE id = $1`, batchID).Scan(&callbackURL)
	}
	if callbackURL == "" {
		return
	}
	payload := callbackPayload{
		RunID:   batchID, // carries the batch ID for the receiver
		Status:  batchStatus,
		CostUSD: costUSD,
	}
	idemKey := idempotencyKey(batchID, "batch_callback", 1)
	claimed, claimErr := claimSideEffect(ctx, h.srv.Pool, idemKey, batchID, tenantID, "batch_callback")
	if claimErr != nil {
		log.Warn("finalizeBatch: callback claim error", zap.Error(claimErr))
	} else if !claimed {
		return
	}
	if err := deliverCallback(ctx, payload, tenantID, callbackURL); err != nil {
		log.Warn("finalizeBatch: callback delivery failed", zap.Error(err))
	}
}
