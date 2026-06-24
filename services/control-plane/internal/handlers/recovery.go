package handlers

// RecoverOrphanedRuns is a startup sweep that finds in-flight runs whose
// worker died mid-execution (lock absent or expired) and re-drives them.
//
// Design:
//
//	SELECT runs WHERE status IN ('running','queued') AND (no lock row OR lock
//	expired). For each, try to INSERT/UPDATE run_locks with a fresh TTL — this
//	is the distributed guard: only the replica that wins the upsert proceeds.
//	Winners re-drive via executeRunInlineSync (for plain LLM runs) or
//	runWorkflowIfPresent (for workflow-graph runs); the CompletedStep hook
//	means already-finished nodes are skipped. If an agent can't be resolved
//	the run is marked failed rather than left stuck.
//
// Idempotency: the run_locks upsert is the guard. Two replicas running
// simultaneously will each attempt to upsert the same row; pgx serialises
// them and only one sees rows_affected > 0. The loser skips the run silently.
//
// Called from main.go after pool + handlers are ready; runs in a goroutine
// so it never delays HTTP readiness. When pool is nil (test scaffolding), no-op.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"

	"google.golang.org/grpc/metadata"
)

const (
	// recoverySweepLimit caps the number of orphaned runs processed per pass
	// to bound startup latency and avoid thundering-herd re-drive of thousands
	// of stuck runs on a freshly-restarted replica.
	recoverySweepLimit = 20

	// recoveryLockTTL is the duration of the fresh lock acquired for a
	// re-driven run. Long enough for a typical run (5 min) with headroom.
	recoveryLockTTL = 10 * time.Minute
)

// orphanedRun holds the minimal fields we need to re-drive a run.
type orphanedRun struct {
	runID     string
	tenantID  string
	agentName string
	inputJSON []byte
}

// RecoverOrphanedRuns runs the sweep and returns counts.
// Safe to call on every replica; non-fatal on partial errors.
func (h *RESTHandler) RecoverOrphanedRuns(ctx context.Context) (recovered, skipped int) {
	if h.srv.Pool == nil {
		return 0, 0
	}
	log := h.logger().Named("recovery")

	orphans, err := findOrphanedRuns(ctx, h.srv.Pool)
	if err != nil {
		log.Error("recovery sweep: query failed", zap.Error(err))
		return 0, 0
	}
	if len(orphans) == 0 {
		log.Info("recovery sweep: no orphaned runs found")
		return 0, 0
	}
	log.Info("recovery sweep: found orphaned runs", zap.Int("count", len(orphans)))

	// Use the stable per-process workerID (hostname-pid) so that the lock
	// row we insert is identifiable in logs and can be deleted precisely
	// before handing off to executeRunInlineSync.
	wid := workerID()

	for _, run := range orphans {
		if ctx.Err() != nil {
			break
		}
		acquired, lockErr := acquireRecoveryLock(ctx, h.srv.Pool, run.runID, wid)
		if lockErr != nil {
			log.Warn("recovery sweep: lock error",
				zap.String("run_id", run.runID),
				zap.Error(lockErr),
			)
			skipped++
			continue
		}
		if !acquired {
			// Another replica won the lock for this run.
			log.Debug("recovery sweep: lock not acquired (another replica won)",
				zap.String("run_id", run.runID),
			)
			skipped++
			continue
		}

		log.Info("recovery sweep: re-driving run",
			zap.String("run_id", run.runID),
			zap.String("tenant_id", run.tenantID),
			zap.String("agent", run.agentName),
		)

		// Release the recovery lock BEFORE calling redriveRun.
		// redriveRun → executeRunInlineSync → acquireRunLease will
		// INSERT a fresh lease row.  If we held the recovery lock
		// during that call, acquireRunLease would see a live row with
		// wid = workerID() and (because the UPSERT only steals expired
		// locks) return false → self-deadlock: run never executes.
		// Deleting here is safe: the run is already out of findOrphanedRuns
		// because its status is 'running'/'queued' and we are the only
		// process that won the lock for it this sweep.
		// rls-exempt: background run-recovery sweep — no request tenant exists;
		// it re-drives orphaned runs across ALL tenants and must bypass RLS.
		_, _ = h.srv.Pool.Exec(ctx, `
			DELETE FROM run_locks WHERE run_id = $1 AND worker_id = $2
		`, run.runID, wid)

		if driveErr := h.redriveRun(ctx, run); driveErr != nil {
			log.Warn("recovery sweep: re-drive failed — marking run failed",
				zap.String("run_id", run.runID),
				zap.Error(driveErr),
			)
			if markErr := markRunFailed(ctx, h.srv.Pool, run.runID, driveErr); markErr != nil {
				log.Error("recovery sweep: failed to mark run as failed — run may remain stuck",
					zap.String("run_id", run.runID),
					zap.Error(markErr),
				)
			}
			skipped++
			continue
		}
		recovered++
	}

	log.Info("recovery sweep: complete",
		zap.Int("recovered", recovered),
		zap.Int("skipped", skipped),
	)
	return recovered, skipped
}

// findOrphanedRuns returns up to recoverySweepLimit runs whose lock is
// absent or already expired. We bypass RLS for this admin-level query
// by using a plain pool connection; tenant_id is carried on the row.
func findOrphanedRuns(ctx context.Context, pool *pgxpool.Pool) ([]orphanedRun, error) {
	rows, err := pool.Query(ctx, `
		SELECT r.id::text,
		       r.tenant_id::text,
		       COALESCE(a.name, '') AS agent_name,
		       COALESCE(r.input, '{}'::jsonb)::text::bytea AS input_json
		FROM   runs r
		LEFT   JOIN agents a ON a.id = r.agent_id AND a.tenant_id = r.tenant_id
		LEFT   JOIN run_locks rl ON rl.run_id = r.id
		WHERE  r.status IN ('running', 'queued')
		  AND  (rl.run_id IS NULL OR rl.expires_at < now())
		ORDER  BY r.created_at
		LIMIT  $1
	`, recoverySweepLimit)
	if err != nil {
		return nil, fmt.Errorf("query orphaned runs: %w", err)
	}
	defer rows.Close()

	var out []orphanedRun
	for rows.Next() {
		var run orphanedRun
		if err := rows.Scan(&run.runID, &run.tenantID, &run.agentName, &run.inputJSON); err != nil {
			return nil, fmt.Errorf("scan orphaned run: %w", err)
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// acquireRecoveryLock attempts an UPSERT on run_locks. Returns true iff
// this call won the lock (rows affected == 1 means insert; update means we
// refreshed our own stale lock). Returns false when another worker holds a
// valid (non-expired) lock, meaning rows affected == 0.
func acquireRecoveryLock(ctx context.Context, pool *pgxpool.Pool, runID, workerID string) (bool, error) {
	tag, err := pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1, $2, now(), now() + $3::interval)
		ON CONFLICT (run_id) DO UPDATE
		  SET worker_id   = EXCLUDED.worker_id,
		      acquired_at = now(),
		      expires_at  = now() + $3::interval
		WHERE run_locks.expires_at < now()
	`, runID, workerID, recoveryLockTTL.String())
	if err != nil {
		return false, fmt.Errorf("upsert run_lock: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// markRunFailed stamps runs.status = 'failed' with a recovery error message.
// It returns an error when the UPDATE itself fails (e.g. DB connectivity
// problem), so callers can log a distinct "mark-failed itself failed" message
// and know the run is still stuck in 'running'/'queued'.
func markRunFailed(ctx context.Context, pool *pgxpool.Pool, runID string, cause error) error {
	errJSON, _ := json.Marshal(map[string]string{
		"code":    "recovery_failed",
		"message": fmt.Sprintf("crash-recovery re-drive failed: %v", cause),
	})
	_, execErr := pool.Exec(ctx, `
		UPDATE runs
		SET status = 'failed', finished_at = now(), error = $2::jsonb
		WHERE id = $1 AND status IN ('running', 'queued')
	`, runID, string(errJSON))
	if execErr != nil {
		return fmt.Errorf("markRunFailed(%s): %w", runID, execErr)
	}
	return nil
}

// redriveRun re-executes a single orphaned run.
// For workflow-graph agents it falls through to runWorkflowIfPresent (which
// uses CompletedStep to skip already-done nodes). For plain LLM runs it
// calls executeRunInlineSync.
func (h *RESTHandler) redriveRun(ctx context.Context, run orphanedRun) error {
	if run.agentName == "" {
		return fmt.Errorf("agent not found for run %s — cannot re-drive", run.runID)
	}

	// Build a tenant-scoped context matching what executeRunInlineSync expects.
	runCtx := middleware.InjectTenantID(ctx, run.tenantID)
	md := metadata.Pairs("tenant_id", run.tenantID)
	runCtx = metadata.NewIncomingContext(runCtx, md)

	// Unmarshal the stored input.
	var input map[string]any
	if len(run.inputJSON) > 0 {
		_ = json.Unmarshal(run.inputJSON, &input)
	}
	if input == nil {
		input = map[string]any{}
	}

	if h.llmProxy == nil {
		return fmt.Errorf("llmProxy not wired — cannot re-drive run %s", run.runID)
	}

	// Try the workflow path first (idempotent via CompletedStep).
	if h.runWorkflowIfPresent(runCtx, run.runID, run.tenantID, run.agentName, input) {
		return nil
	}

	// Plain LLM run: re-drive inline.
	_, _, err := h.executeRunInlineSync(runCtx, run.runID, run.tenantID, run.agentName, input)
	return err
}

// recoveryInterval returns the configured sweep interval from the
// LANTERN_RECOVERY_INTERVAL env var (default 30s).
func recoveryInterval() time.Duration {
	if v := os.Getenv("LANTERN_RECOVERY_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 30 * time.Second
}

// RunRecoverySweepAsync launches the recovery sweep in a goroutine and
// logs the outcome. This is the main.go hook — non-blocking.
//
// Deprecated: prefer RunRecoveryLoop which repeats on a ticker. Kept for
// back-compat; callers in main.go are updated to use the loop.
func RunRecoverySweepAsync(ctx context.Context, h *RESTHandler, log *zap.Logger) {
	if h == nil || h.srv == nil || h.srv.Pool == nil {
		return
	}
	go func() {
		// Small delay so the HTTP server finishes starting first, making
		// /readyz requests return before we begin DB-heavy work.
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
		recovered, skipped := h.RecoverOrphanedRuns(ctx)
		log.Info("startup recovery sweep finished",
			zap.Int("recovered", recovered),
			zap.Int("skipped", skipped),
		)
	}()
}

// RunRecoveryLoop runs RecoverOrphanedRuns on a periodic ticker until ctx is
// cancelled. The first sweep fires after a 2s startup delay (same as the old
// one-shot), then every interval thereafter.
//
// Replace the RunRecoverySweepAsync call in main.go with this for continuous
// watchdog behaviour.
func RunRecoveryLoop(ctx context.Context, h *RESTHandler, log *zap.Logger, interval time.Duration) {
	if h == nil || h.srv == nil || h.srv.Pool == nil {
		return
	}
	if interval <= 0 {
		interval = recoveryInterval()
	}
	go func() {
		// Initial startup delay.
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			recovered, skipped := h.RecoverOrphanedRuns(ctx)
			log.Info("recovery sweep",
				zap.Int("recovered", recovered),
				zap.Int("skipped", skipped),
			)

			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
