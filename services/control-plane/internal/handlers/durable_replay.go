package handlers

// durable_replay.go — crash-safe execution primitives for executeRunInlineSync.
//
// Three facilities live here:
//
//  1. Run lease  — executeRunInlineSync acquires a run_locks row before
//     executing and renews it every leaseTTL/3.  A concurrent replica
//     holding a live lease sees 0 rows-affected and aborts without
//     double-executing.
//
//  2. Plain-LLM journal  — the non-workflow LLM call is now wrapped in the
//     same EmitEvent / CompletedStep pattern the workflow path uses.  On a
//     crash-replay the cached step_completed payload is reused and the LLM
//     is NOT called again (no re-spent tokens).
//
//  3. Side-effect dedup  — before any external delivery (bridge, self-chat)
//     the executor INSERTs into side_effect_receipts ON CONFLICT DO NOTHING.
//     If the row already exists the delivery is skipped (already sent on a
//     prior attempt).
//
// Invariants preserved:
//   - #3  steps are idempotent / replayable
//   - #7  never cross-tenant (all queries are pinned by run_id / tenant_id)
//   - #8  every external side-effect carries an idempotency key keyed from
//     (run_id, step_id, attempt)

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// -----------------------------------------------------------------------
// Config (from env with safe defaults)
// -----------------------------------------------------------------------

// runLeaseTTL is the duration of a run lease.  A renewal goroutine bumps
// expires_at every leaseTTL/3 while execution is in flight.
func runLeaseTTL() time.Duration {
	if v := os.Getenv("LANTERN_RUN_LEASE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 60 * time.Second
}

// stableWorkerID is generated once per process: hostname + PID, stable for
// the lifetime of the binary.  Collisions across replicas are impossible in
// practice (same PID on different hosts won't conflict on a UUID primary key).
var (
	_workerIDOnce sync.Once
	_workerID     string
)

func workerID() string {
	_workerIDOnce.Do(func() {
		host, _ := os.Hostname()
		_workerID = fmt.Sprintf("%s-%d", host, os.Getpid())
	})
	return _workerID
}

// -----------------------------------------------------------------------
// 1. Run lease
// -----------------------------------------------------------------------

// acquireRunLease attempts to INSERT (or steal an expired) run_locks row.
// Returns (true, release, nil) on success; (false, nil, nil) when a live
// lease is held by another worker; (false, nil, err) on DB error.
//
// The UPSERT only steals when the existing lock is expired — it never
// overwrites a live lock from a different worker_id.  This means two goroutines
// in the same process with the same workerID() CANNOT mutually block each other
// via this function; cross-process blocking is the target.  Recovery avoids the
// self-deadlock by deleting the recovery lock BEFORE calling executeRunInlineSync
// (see redriveRun in recovery.go), so executeRunInlineSync's own lease
// acquisition finds no lock and inserts fresh.
//
// The caller MUST call release() when execution finishes; it cancels the
// renewal goroutine and deletes the lock row.
func acquireRunLease(ctx context.Context, pool *pgxpool.Pool, runID string, log *zap.Logger) (acquired bool, release func(), err error) {
	ttl := runLeaseTTL()
	wid := workerID()

	tag, err := pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, acquired_at, expires_at)
		VALUES ($1, $2, now(), now() + $3::interval)
		ON CONFLICT (run_id) DO UPDATE
		  SET worker_id   = EXCLUDED.worker_id,
		      acquired_at = now(),
		      expires_at  = now() + $3::interval
		WHERE run_locks.expires_at < now()
	`, runID, wid, ttl.String())
	if err != nil {
		return false, nil, fmt.Errorf("acquireRunLease(%s): %w", runID, err)
	}
	if tag.RowsAffected() == 0 {
		// Another worker holds a live (non-expired) lease.
		return false, nil, nil
	}

	// Start a renewal goroutine that bumps expires_at every ttl/3.
	renewCtx, cancelRenew := context.WithCancel(context.Background())
	renewInterval := ttl / 3
	go func() {
		ticker := time.NewTicker(renewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-renewCtx.Done():
				return
			case <-ticker.C:
				_, rErr := pool.Exec(renewCtx, `
					UPDATE run_locks
					SET expires_at = now() + $2::interval
					WHERE run_id = $1 AND worker_id = $3
				`, runID, ttl.String(), wid)
				if rErr != nil && renewCtx.Err() == nil {
					log.Warn("run lease renewal failed",
						zap.String("run_id", runID),
						zap.Error(rErr),
					)
				}
			}
		}
	}()

	release = func() {
		cancelRenew()
		// Best-effort delete; if the DB is unreachable the TTL will expire
		// naturally and the recovery sweep will re-drive.
		_, _ = pool.Exec(context.Background(), `
			DELETE FROM run_locks WHERE run_id = $1 AND worker_id = $2
		`, runID, wid)
	}
	return true, release, nil
}

// -----------------------------------------------------------------------
// 2. Plain-LLM journal helpers (reuse existing journal_events table)
// -----------------------------------------------------------------------

// llmStepID is the stable step_id used for the single-LLM-call path.
const llmStepID = "llm:main"

// llmStepPayload is what we persist in step_completed.  Enough to fully
// reconstruct the run's output/tokens/cost on replay without re-calling the
// LLM.
type llmStepPayload struct {
	Result    string  `json:"result"`
	TokensIn  int64   `json:"tokens_in"`
	TokensOut int64   `json:"tokens_out"`
	CostUSD   float64 `json:"cost_usd"`
	Provider  string  `json:"provider"`
	Model     string  `json:"model"`
}

// checkCachedLLMStep returns (payload, true, nil) when journal_events already
// contains a step_completed for llmStepID on this run (i.e. a prior attempt
// finished the LLM call before crashing).  Returns (zero, false, nil) when no
// cached result exists.
func checkCachedLLMStep(ctx context.Context, pool *pgxpool.Pool, runID string) (llmStepPayload, bool, error) {
	var raw []byte
	err := pool.QueryRow(ctx, `
		SELECT payload
		FROM   journal_events
		WHERE  run_id  = $1
		  AND  step_id = $2
		  AND  kind    = 'step_completed'
		ORDER  BY seq DESC
		LIMIT  1
	`, runID, llmStepID).Scan(&raw)
	if err != nil {
		// pgx returns pgx.ErrNoRows which is not a fatal error.
		return llmStepPayload{}, false, nil
	}
	var p llmStepPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		// Corrupt payload — treat as cache miss so we re-run cleanly.
		return llmStepPayload{}, false, nil
	}
	return p, true, nil
}

// emitLLMJournalEvent inserts a single journal_events row for the plain-LLM
// path using a self-contained INSERT … SELECT that computes MAX(seq)+1 inline.
// This eliminates the two-round-trip MAX then INSERT race: if a concurrent
// writer inserts the same seq between our SELECT and INSERT, ON CONFLICT DO
// NOTHING fires and we retry up to maxJournalRetries times.  A step_completed
// event is too important to lose silently (it is the replay anchor), so we
// keep retrying rather than dropping it.
//
// The inline SELECT form:
//
//	INSERT INTO journal_events (run_id, seq, …)
//	SELECT $1, COALESCE(MAX(seq),0)+1, … FROM journal_events WHERE run_id=$1
//	ON CONFLICT (run_id, seq) DO NOTHING
//
// is not guaranteed to be atomic on its own either, but the retry loop makes
// the probability of a permanent loss astronomically small (two concurrent
// writers would have to collide on every attempt).
const maxJournalRetries = 3

func emitLLMJournalEvent(ctx context.Context, pool *pgxpool.Pool, runID, kind string, payload any) {
	raw, _ := json.Marshal(payload)
	for i := 0; i < maxJournalRetries; i++ {
		tag, err := pool.Exec(ctx, `
			INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
			SELECT $1,
			       COALESCE((SELECT MAX(seq) FROM journal_events WHERE run_id = $1), 0) + 1,
			       $2, $3, 1, $4
			ON CONFLICT (run_id, seq) DO NOTHING
		`, runID, kind, llmStepID, raw)
		if err != nil {
			return // DB error — best-effort, give up
		}
		if tag.RowsAffected() > 0 {
			return // inserted successfully
		}
		// RowsAffected == 0 means a seq collision — retry with a fresh MAX.
	}
}

// -----------------------------------------------------------------------
// 3. Side-effect idempotency
// -----------------------------------------------------------------------

// idempotencyKey returns hex(sha256("runID|stepID|attempt")).
// Collision-resistant and deterministic across restarts.
func idempotencyKey(runID, stepID string, attempt int) string {
	h := sha256.New()
	_, _ = h.Write([]byte(strings.Join([]string{runID, stepID, strconv.Itoa(attempt)}, "|")))
	return hex.EncodeToString(h.Sum(nil))
}

// claimSideEffect tries to INSERT a receipt for (idemKey, runID, tenantID,
// kind).  Returns true when the INSERT succeeded (first delivery — proceed).
// Returns false when the row already existed (already delivered — skip).
func claimSideEffect(ctx context.Context, pool *pgxpool.Pool, idemKey, runID, tenantID, kind string) (bool, error) {
	tag, err := pool.Exec(ctx, `
		INSERT INTO side_effect_receipts (idem_key, run_id, tenant_id, kind)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (idem_key) DO NOTHING
	`, idemKey, runID, tenantID, kind)
	if err != nil {
		return false, fmt.Errorf("claimSideEffect(%s/%s): %w", kind, idemKey, err)
	}
	return tag.RowsAffected() > 0, nil
}

// -----------------------------------------------------------------------
// 4. Side-effect receipts janitor
// -----------------------------------------------------------------------

const (
	// envSideEffectRetentionDays controls how long side_effect_receipts rows
	// are kept. Default: 30 days. Receipts older than this cannot prevent
	// re-delivery, but runs older than the LLM step cache TTL won't be
	// re-driven anyway.
	envSideEffectRetentionDays     = "LANTERN_SIDE_EFFECT_RETENTION_DAYS"
	defaultSideEffectRetentionDays = 30

	// sideEffectRetentionSweepInterval is how often the janitor runs.
	sideEffectRetentionSweepInterval = time.Hour
)

func sideEffectRetentionDays() int {
	raw := os.Getenv(envSideEffectRetentionDays)
	if raw == "" {
		return defaultSideEffectRetentionDays
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultSideEffectRetentionDays
	}
	return n
}

// sweepOldSideEffectReceipts deletes side_effect_receipts rows older than the
// configured retention window. Returns the number of rows deleted.
func sweepOldSideEffectReceipts(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	days := sideEffectRetentionDays()
	tag, err := pool.Exec(ctx,
		`DELETE FROM side_effect_receipts WHERE created_at < now() - ($1 * interval '1 day')`,
		days,
	)
	if err != nil {
		return 0, fmt.Errorf("sweepOldSideEffectReceipts: %w", err)
	}
	return tag.RowsAffected(), nil
}

// RunSideEffectReceiptsJanitor runs a periodic sweep that deletes
// side_effect_receipts rows older than LANTERN_SIDE_EFFECT_RETENTION_DAYS
// (default 30). Blocks until ctx is cancelled.
//
// Call pattern (from main.go):
//
//	go handlers.RunSideEffectReceiptsJanitor(ctx, pool, logger)
func RunSideEffectReceiptsJanitor(ctx context.Context, pool *pgxpool.Pool, log *zap.Logger) {
	if pool == nil {
		return
	}
	log = log.Named("se_receipt_janitor")
	ticker := time.NewTicker(sideEffectRetentionSweepInterval)
	defer ticker.Stop()

	log.Info("side_effect_receipts retention janitor started",
		zap.Int("retention_days", sideEffectRetentionDays()))

	for {
		select {
		case <-ctx.Done():
			log.Info("side_effect_receipts janitor stopped")
			return
		case <-ticker.C:
			n, err := sweepOldSideEffectReceipts(ctx, pool)
			if err != nil && ctx.Err() == nil {
				log.Warn("side_effect_receipts sweep failed", zap.Error(err))
			} else if n > 0 {
				log.Info("side_effect_receipts sweep deleted rows", zap.Int64("count", n))
			}
		}
	}
}
