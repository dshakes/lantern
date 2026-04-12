package engine

import (
	"context"
	"fmt"
	"hash/fnv"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const (
	// defaultPollInterval is how often the scheduler checks for new queued runs.
	defaultPollInterval = 1 * time.Second

	// lockDuration is how long an advisory lock on a run is held before expiry.
	// Workers must renew before this expires.
	lockDuration = 5 * time.Minute
)

// Scheduler polls Postgres for runs that are ready to execute (status='queued'
// or status='resumable') and dispatches them to the engine's worker pool.
// It uses Postgres advisory locks to prevent two workers from picking up the
// same run (split-brain prevention).
type Scheduler struct {
	pool         *pgxpool.Pool
	logger       *zap.Logger
	workerID     string
	pollInterval time.Duration
	dispatch     func(ctx context.Context, runID, tenantID, agentVersionID string) error
}

// NewScheduler creates a new Scheduler.
func NewScheduler(pool *pgxpool.Pool, logger *zap.Logger, dispatch func(ctx context.Context, runID, tenantID, agentVersionID string) error) *Scheduler {
	hostname, _ := os.Hostname()
	workerID := fmt.Sprintf("%s-%d", hostname, os.Getpid())

	return &Scheduler{
		pool:         pool,
		logger:       logger.Named("scheduler"),
		workerID:     workerID,
		pollInterval: defaultPollInterval,
		dispatch:     dispatch,
	}
}

// Start begins the polling loop. It runs until the context is cancelled.
func (s *Scheduler) Start(ctx context.Context) {
	s.logger.Info("scheduler started",
		zap.String("worker_id", s.workerID),
		zap.Duration("poll_interval", s.pollInterval),
	)

	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("scheduler stopped")
			return
		case <-ticker.C:
			s.poll(ctx)
		}
	}
}

// poll queries for queued/resumable runs and attempts to claim them.
// Fair-share scheduling: we order by tenant_id to round-robin across tenants,
// then by created_at within each tenant.
func (s *Scheduler) poll(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, agent_version_id
		FROM runs
		WHERE status IN ('queued', 'resumable')
		ORDER BY tenant_id, created_at ASC
		LIMIT 10
	`)
	if err != nil {
		s.logger.Error("scheduler poll failed", zap.Error(err))
		return
	}
	defer rows.Close()

	type candidate struct {
		RunID          string
		TenantID       string
		AgentVersionID string
	}

	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.RunID, &c.TenantID, &c.AgentVersionID); err != nil {
			s.logger.Error("scheduler scan failed", zap.Error(err))
			return
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("scheduler row iteration failed", zap.Error(err))
		return
	}

	for _, c := range candidates {
		if err := s.tryAcquireAndDispatch(ctx, c.RunID, c.TenantID, c.AgentVersionID); err != nil {
			s.logger.Warn("failed to acquire run",
				zap.String("run_id", c.RunID),
				zap.Error(err),
			)
		}
	}
}

// tryAcquireAndDispatch attempts to acquire an advisory lock on the run and,
// if successful, dispatches it to the engine.
func (s *Scheduler) tryAcquireAndDispatch(ctx context.Context, runID, tenantID, agentVersionID string) error {
	// Derive a stable int64 lock key from the run_id using FNV hash.
	lockKey := advisoryLockKey(runID)

	// Try to acquire a session-level advisory lock (non-blocking).
	var acquired bool
	err := s.pool.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey).Scan(&acquired)
	if err != nil {
		return fmt.Errorf("advisory lock query: %w", err)
	}
	if !acquired {
		// Another worker already holds this run.
		return nil
	}

	// Record the lock in the run_locks table for visibility and expiry tracking.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO run_locks (run_id, worker_id, expires_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (run_id) DO UPDATE SET
			worker_id = $2,
			acquired_at = now(),
			expires_at = $3
	`, runID, s.workerID, time.Now().Add(lockDuration)); err != nil {
		// Release the advisory lock on failure.
		s.pool.Exec(ctx, `SELECT pg_advisory_unlock($1)`, lockKey) //nolint:errcheck
		return fmt.Errorf("record lock: %w", err)
	}

	s.logger.Info("acquired run",
		zap.String("run_id", runID),
		zap.String("tenant_id", tenantID),
		zap.String("worker_id", s.workerID),
	)

	// Dispatch in a goroutine. The advisory lock is released when done.
	go func() {
		defer func() {
			// Release advisory lock.
			s.pool.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey) //nolint:errcheck
			// Clean up the run_locks row.
			s.pool.Exec(context.Background(), `DELETE FROM run_locks WHERE run_id = $1`, runID) //nolint:errcheck
		}()

		if err := s.dispatch(ctx, runID, tenantID, agentVersionID); err != nil {
			s.logger.Error("run dispatch failed",
				zap.String("run_id", runID),
				zap.Error(err),
			)
		}
	}()

	return nil
}

// RenewLock extends the lock expiry for a run that is still actively executing.
// Should be called periodically by long-running runs.
func (s *Scheduler) RenewLock(ctx context.Context, runID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE run_locks SET expires_at = $1
		WHERE run_id = $2 AND worker_id = $3
	`, time.Now().Add(lockDuration), runID, s.workerID)
	if err != nil {
		return fmt.Errorf("renew lock: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("lock not found for run %s (may have been stolen)", runID)
	}
	return nil
}

// CleanExpiredLocks removes lock rows that have expired. This is called
// periodically to recover from worker crashes.
func (s *Scheduler) CleanExpiredLocks(ctx context.Context) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM run_locks WHERE expires_at < now()
	`)
	if err != nil {
		return fmt.Errorf("clean expired locks: %w", err)
	}
	if tag.RowsAffected() > 0 {
		s.logger.Info("cleaned expired run locks",
			zap.Int64("count", tag.RowsAffected()),
		)
	}
	return nil
}

// advisoryLockKey derives a stable int64 from a run_id string for use with
// Postgres advisory locks.
func advisoryLockKey(runID string) int64 {
	h := fnv.New64a()
	h.Write([]byte(runID)) //nolint:errcheck
	return int64(h.Sum64())
}
