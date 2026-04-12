package cron

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// DelayedProcessor polls for delayed runs that are due and creates runs.
type DelayedProcessor struct {
	pool      *pgxpool.Pool
	logger    *zap.Logger
	interval  time.Duration
	createRun RunCreator
}

// NewDelayedProcessor creates a new DelayedProcessor.
func NewDelayedProcessor(pool *pgxpool.Pool, logger *zap.Logger, createRun RunCreator) *DelayedProcessor {
	return &DelayedProcessor{
		pool:      pool,
		logger:    logger.Named("delayed_processor"),
		interval:  1 * time.Second,
		createRun: createRun,
	}
}

// Run starts the delayed run polling loop. Blocks until context is cancelled.
func (d *DelayedProcessor) Run(ctx context.Context) {
	d.logger.Info("delayed processor started", zap.Duration("interval", d.interval))

	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			d.logger.Info("delayed processor stopped")
			return
		case <-ticker.C:
			d.processDelayed(ctx)
		}
	}
}

func (d *DelayedProcessor) processDelayed(ctx context.Context) {
	ctx, span := tracer.Start(ctx, "DelayedProcessor.processDelayed")
	defer span.End()

	now := time.Now().UTC()

	rows, err := d.pool.Query(ctx, `
		SELECT id, tenant_id, agent_name, input
		FROM delayed_runs
		WHERE fire_at <= $1 AND status = 'pending'
		ORDER BY fire_at ASC
		LIMIT 50
	`, now)
	if err != nil {
		d.logger.Error("failed to query delayed runs", zap.Error(err))
		return
	}
	defer rows.Close()

	type delayedRun struct {
		id        string
		tenantID  string
		agentName string
		input     json.RawMessage
	}

	var runs []delayedRun
	for rows.Next() {
		var r delayedRun
		if err := rows.Scan(&r.id, &r.tenantID, &r.agentName, &r.input); err != nil {
			d.logger.Error("scan delayed run failed", zap.Error(err))
			continue
		}
		runs = append(runs, r)
	}
	if err := rows.Err(); err != nil {
		d.logger.Error("row iteration failed", zap.Error(err))
		return
	}

	for _, r := range runs {
		d.processOne(ctx, r.id, r.tenantID, r.agentName, r.input)
	}
}

func (d *DelayedProcessor) processOne(ctx context.Context, id, tenantID, agentName string, input json.RawMessage) {
	// Try to claim this delayed run with advisory lock.
	lockKey := advisoryLockKey(id)

	tx, err := d.pool.Begin(ctx)
	if err != nil {
		d.logger.Error("failed to begin transaction", zap.Error(err))
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var locked bool
	err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, lockKey).Scan(&locked)
	if err != nil || !locked {
		return
	}

	// Re-check status.
	var status string
	err = tx.QueryRow(ctx, `
		SELECT status FROM delayed_runs WHERE id = $1
	`, id).Scan(&status)
	if err != nil || status != "pending" {
		return
	}

	// Mark as processing.
	_, err = tx.Exec(ctx, `
		UPDATE delayed_runs SET status = 'processing' WHERE id = $1
	`, id)
	if err != nil {
		d.logger.Error("failed to mark delayed run as processing", zap.String("id", id), zap.Error(err))
		return
	}

	if err := tx.Commit(ctx); err != nil {
		d.logger.Error("failed to commit delayed run status", zap.Error(err))
		return
	}

	// Create the run.
	runID, err := d.createRun(ctx, tenantID, agentName, input)
	if err != nil {
		d.logger.Error("failed to create run from delayed trigger",
			zap.String("delayed_run_id", id),
			zap.String("agent_name", agentName),
			zap.Error(err),
		)

		// Mark as failed.
		_, _ = d.pool.Exec(ctx, `
			UPDATE delayed_runs SET status = 'failed' WHERE id = $1
		`, id)

		// Insert into dead letter.
		_, _ = d.pool.Exec(ctx, `
			INSERT INTO dead_letter (tenant_id, agent_name, input, error, attempts)
			VALUES ($1, $2, $3, $4, 1)
		`, tenantID, agentName, input, err.Error())
		return
	}

	// Mark as completed.
	_, err = d.pool.Exec(ctx, `
		UPDATE delayed_runs SET status = 'completed' WHERE id = $1
	`, id)
	if err != nil {
		d.logger.Error("failed to mark delayed run as completed", zap.String("id", id), zap.Error(err))
	}

	d.logger.Info("delayed run fired",
		zap.String("delayed_run_id", id),
		zap.String("tenant_id", tenantID),
		zap.String("agent_name", agentName),
		zap.String("run_id", runID),
	)
}
