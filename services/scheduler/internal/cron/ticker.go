package cron

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel"
	"go.uber.org/zap"
)

var tracer = otel.Tracer("lantern.scheduler.cron")

const maxAttempts = 5

// RunCreator is a function that creates a run in the control plane.
// In production, this calls the control-plane gRPC CreateRun endpoint.
type RunCreator func(ctx context.Context, tenantID, agentName string, input json.RawMessage) (string, error)

// Ticker is the cron loop that checks schedules and fires them.
type Ticker struct {
	pool       *pgxpool.Pool
	logger     *zap.Logger
	interval   time.Duration
	createRun  RunCreator
}

// NewTicker creates a new cron Ticker.
func NewTicker(pool *pgxpool.Pool, logger *zap.Logger, createRun RunCreator) *Ticker {
	return &Ticker{
		pool:      pool,
		logger:    logger.Named("cron_ticker"),
		interval:  1 * time.Second,
		createRun: createRun,
	}
}

// Run starts the cron tick loop. Blocks until context is cancelled.
func (t *Ticker) Run(ctx context.Context) {
	t.logger.Info("cron ticker started", zap.Duration("interval", t.interval))

	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			t.logger.Info("cron ticker stopped")
			return
		case <-ticker.C:
			t.tick(ctx)
		}
	}
}

func (t *Ticker) tick(ctx context.Context) {
	ctx, span := tracer.Start(ctx, "CronTicker.tick")
	defer span.End()

	now := time.Now().UTC()

	// Select all enabled schedules that are due.
	rows, err := t.pool.Query(ctx, `
		SELECT id, tenant_id, agent_name, cron_expr, timezone, input_template
		FROM schedules
		WHERE enabled = true
		  AND next_fire_at IS NOT NULL
		  AND next_fire_at <= $1
		ORDER BY next_fire_at ASC
		LIMIT 100
	`, now)
	if err != nil {
		t.logger.Error("failed to query due schedules", zap.Error(err))
		return
	}
	defer rows.Close()

	type dueSchedule struct {
		id           string
		tenantID     string
		agentName    string
		cronExpr     string
		timezone     string
		inputTemplate json.RawMessage
	}

	var schedules []dueSchedule
	for rows.Next() {
		var s dueSchedule
		if err := rows.Scan(&s.id, &s.tenantID, &s.agentName, &s.cronExpr, &s.timezone, &s.inputTemplate); err != nil {
			t.logger.Error("scan schedule failed", zap.Error(err))
			continue
		}
		schedules = append(schedules, s)
	}
	if err := rows.Err(); err != nil {
		t.logger.Error("row iteration failed", zap.Error(err))
		return
	}

	for _, s := range schedules {
		t.fireSchedule(ctx, s.id, s.tenantID, s.agentName, s.cronExpr, s.timezone, s.inputTemplate)
	}
}

func (t *Ticker) fireSchedule(ctx context.Context, scheduleID, tenantID, agentName, cronExpr, timezone string, inputTemplate json.RawMessage) {
	ctx, span := tracer.Start(ctx, "CronTicker.fireSchedule")
	defer span.End()

	// Acquire Postgres advisory lock to prevent double-firing in multi-replica.
	// Use a hash of the schedule ID as the lock key.
	lockKey := advisoryLockKey(scheduleID)

	tx, err := t.pool.Begin(ctx)
	if err != nil {
		t.logger.Error("failed to begin transaction", zap.Error(err))
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Try to acquire advisory lock (non-blocking).
	var locked bool
	err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, lockKey).Scan(&locked)
	if err != nil {
		t.logger.Error("advisory lock query failed", zap.Error(err))
		return
	}
	if !locked {
		t.logger.Debug("schedule already locked by another replica",
			zap.String("schedule_id", scheduleID),
		)
		return
	}

	// Re-check that the schedule is still due (another replica may have fired it).
	var nextFireAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT next_fire_at FROM schedules
		WHERE id = $1 AND enabled = true AND next_fire_at <= now()
	`, scheduleID).Scan(&nextFireAt)
	if err != nil {
		// Not due anymore or not found — skip.
		return
	}

	// Calculate the next fire time.
	sched, err := Parse(cronExpr)
	if err != nil {
		t.logger.Error("failed to parse cron expression",
			zap.String("schedule_id", scheduleID),
			zap.String("cron_expr", cronExpr),
			zap.Error(err),
		)
		return
	}

	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
	}

	now := time.Now().In(loc)
	nextFire := NextFireTime(sched, now)

	// Update the schedule: set next_fire_at and last_fire_at.
	_, err = tx.Exec(ctx, `
		UPDATE schedules
		SET next_fire_at = $2, last_fire_at = now()
		WHERE id = $1
	`, scheduleID, nextFire.UTC())
	if err != nil {
		t.logger.Error("failed to update schedule fire times",
			zap.String("schedule_id", scheduleID),
			zap.Error(err),
		)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		t.logger.Error("failed to commit schedule update",
			zap.String("schedule_id", scheduleID),
			zap.Error(err),
		)
		return
	}

	// Fire the run (outside the transaction so the lock is released).
	runID, err := t.createRun(ctx, tenantID, agentName, inputTemplate)
	if err != nil {
		t.logger.Error("failed to create run from schedule",
			zap.String("schedule_id", scheduleID),
			zap.String("agent_name", agentName),
			zap.Error(err),
		)

		// Move to dead letter after max attempts.
		t.handleFailure(ctx, scheduleID, tenantID, agentName, inputTemplate, err)
		return
	}

	t.logger.Info("cron schedule fired",
		zap.String("schedule_id", scheduleID),
		zap.String("tenant_id", tenantID),
		zap.String("agent_name", agentName),
		zap.String("run_id", runID),
		zap.Time("next_fire_at", nextFire),
	)
}

func (t *Ticker) handleFailure(ctx context.Context, scheduleID, tenantID, agentName string, input json.RawMessage, fireErr error) {
	_, err := t.pool.Exec(ctx, `
		INSERT INTO dead_letter (tenant_id, agent_name, input, error, attempts, schedule_id)
		VALUES ($1, $2, $3, $4, 1, $5)
	`, tenantID, agentName, input, fireErr.Error(), scheduleID)
	if err != nil {
		t.logger.Error("failed to insert dead letter entry",
			zap.String("schedule_id", scheduleID),
			zap.Error(err),
		)
	}
}

// advisoryLockKey converts a schedule ID string to an int64 for Postgres advisory locks.
func advisoryLockKey(id string) int64 {
	h := fnv.New64a()
	h.Write([]byte(id))
	return int64(h.Sum64())
}

// InitScheduleNextFireTimes sets the initial next_fire_at for any schedule
// that doesn't have one yet. Called on startup.
func InitScheduleNextFireTimes(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger) error {
	rows, err := pool.Query(ctx, `
		SELECT id, cron_expr, timezone FROM schedules
		WHERE enabled = true AND next_fire_at IS NULL
	`)
	if err != nil {
		return fmt.Errorf("failed to query schedules without next_fire_at: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id, cronExpr, timezone string
		if err := rows.Scan(&id, &cronExpr, &timezone); err != nil {
			logger.Error("scan schedule failed", zap.Error(err))
			continue
		}

		sched, err := Parse(cronExpr)
		if err != nil {
			logger.Error("failed to parse cron expression",
				zap.String("schedule_id", id),
				zap.String("cron_expr", cronExpr),
				zap.Error(err),
			)
			continue
		}

		loc, err := time.LoadLocation(timezone)
		if err != nil {
			loc = time.UTC
		}

		now := time.Now().In(loc)
		nextFire := NextFireTime(sched, now)

		_, err = pool.Exec(ctx, `
			UPDATE schedules SET next_fire_at = $2 WHERE id = $1
		`, id, nextFire.UTC())
		if err != nil {
			logger.Error("failed to set next_fire_at",
				zap.String("schedule_id", id),
				zap.Error(err),
			)
		}
	}

	return rows.Err()
}
