package handlers

// retention_janitor.go — periodic retention sweeps for high-growth tables.
//
// Tables covered:
//
//   journal_events       — grows with every LLM step. Default retention: 90 days.
//                          CAUTION: only prune rows whose run is terminal AND
//                          older than the window, so a long-lived run's events
//                          are never deleted mid-flight.
//
//   runtime_audit_events — append-only audit log. Default retention: 365 days.
//
//   agent_usage_daily    — daily rollup for budget enforcement. Kept ~400 days
//                          so the billing team has 13 months for reconciliation.
//                          Default: 400 days.
//
// Env vars (all optional; server behaviour is unchanged when not set):
//
//	LANTERN_JOURNAL_RETENTION_DAYS        default 90
//	LANTERN_AUDIT_RETENTION_DAYS          default 365
//	LANTERN_USAGE_DAILY_RETENTION_DAYS    default 400
//
// Sweep interval for all three: 1 hour (mirrors the side_effect_receipts janitor).

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

const (
	retentionSweepInterval = time.Hour

	envJournalRetentionDays     = "LANTERN_JOURNAL_RETENTION_DAYS"
	defaultJournalRetentionDays = 90

	envAuditRetentionDays     = "LANTERN_AUDIT_RETENTION_DAYS"
	defaultAuditRetentionDays = 365

	envUsageDailyRetentionDays     = "LANTERN_USAGE_DAILY_RETENTION_DAYS"
	defaultUsageDailyRetentionDays = 400
)

func retentionDays(envKey string, fallback int) int {
	if raw := os.Getenv(envKey); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

// sweepJournalEvents deletes journal_events rows that are both:
//   - created_at older than the retention window, AND
//   - belonging to a run that is already in a terminal state (succeeded /
//     failed / cancelled) — so in-flight run events are never removed.
//
// Returns the number of rows deleted.
func sweepJournalEvents(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	days := retentionDays(envJournalRetentionDays, defaultJournalRetentionDays)
	tag, err := pool.Exec(ctx, `
		DELETE FROM journal_events
		WHERE created_at < now() - ($1 * interval '1 day')
		  AND run_id IN (
			SELECT id FROM runs
			WHERE status IN ('succeeded', 'failed', 'cancelled')
		  )
	`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// sweepAuditEvents deletes runtime_audit_events rows older than the retention window.
func sweepAuditEvents(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	days := retentionDays(envAuditRetentionDays, defaultAuditRetentionDays)
	tag, err := pool.Exec(ctx, `
		DELETE FROM runtime_audit_events
		WHERE at < now() - ($1 * interval '1 day')
	`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// sweepUsageDaily deletes agent_usage_daily rows older than the retention window.
func sweepUsageDaily(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	days := retentionDays(envUsageDailyRetentionDays, defaultUsageDailyRetentionDays)
	tag, err := pool.Exec(ctx, `
		DELETE FROM agent_usage_daily
		WHERE usage_date < (current_date - $1 * interval '1 day')::date
	`, days)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// RunRetentionJanitor periodically purges rows from journal_events,
// runtime_audit_events, and agent_usage_daily. It blocks until ctx is
// cancelled (which is the graceful-shutdown signal from main).
//
// Call pattern (from main.go):
//
//	go handlers.RunRetentionJanitor(ctx, pool, logger)
func RunRetentionJanitor(ctx context.Context, pool *pgxpool.Pool, log *zap.Logger) {
	if pool == nil {
		return
	}
	log = log.Named("retention_janitor")
	ticker := time.NewTicker(retentionSweepInterval)
	defer ticker.Stop()

	log.Info("retention janitor started",
		zap.Int("journal_retention_days", retentionDays(envJournalRetentionDays, defaultJournalRetentionDays)),
		zap.Int("audit_retention_days", retentionDays(envAuditRetentionDays, defaultAuditRetentionDays)),
		zap.Int("usage_daily_retention_days", retentionDays(envUsageDailyRetentionDays, defaultUsageDailyRetentionDays)),
	)

	for {
		select {
		case <-ctx.Done():
			log.Info("retention janitor stopped")
			return
		case <-ticker.C:
			sweepCtx, cancel := context.WithTimeout(ctx, 30*time.Second)

			if n, err := sweepJournalEvents(sweepCtx, pool); err != nil {
				if ctx.Err() == nil {
					log.Warn("journal_events sweep failed", zap.Error(err))
				}
			} else if n > 0 {
				log.Info("journal_events sweep deleted rows", zap.Int64("count", n))
			}

			if n, err := sweepAuditEvents(sweepCtx, pool); err != nil {
				if ctx.Err() == nil {
					log.Warn("runtime_audit_events sweep failed", zap.Error(err))
				}
			} else if n > 0 {
				log.Info("runtime_audit_events sweep deleted rows", zap.Int64("count", n))
			}

			if n, err := sweepUsageDaily(sweepCtx, pool); err != nil {
				if ctx.Err() == nil {
					log.Warn("agent_usage_daily sweep failed", zap.Error(err))
				}
			} else if n > 0 {
				log.Info("agent_usage_daily sweep deleted rows", zap.Int64("count", n))
			}

			cancel()
		}
	}
}
