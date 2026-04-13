package scheduler

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// ExecutorFunc is the callback invoked for each due schedule. It receives the
// run ID (empty — the executor creates it), tenant ID, agent name, and an
// optional input template. The executor is expected to create and run the agent
// synchronously or in a background goroutine.
type ExecutorFunc func(runID, tenantID, agentName string, input map[string]any)

// SimpleScheduler polls the schedules table every 60 seconds and fires due
// schedules. This is the spike-mode scheduler — in production, the separate
// scheduler service handles this with advisory locks.
type SimpleScheduler struct {
	pool     *pgxpool.Pool
	logger   *zap.Logger
	executor ExecutorFunc
	stop     chan struct{}
}

// New creates a SimpleScheduler.
func New(pool *pgxpool.Pool, logger *zap.Logger, executor ExecutorFunc) *SimpleScheduler {
	return &SimpleScheduler{
		pool:     pool,
		logger:   logger.Named("scheduler"),
		executor: executor,
		stop:     make(chan struct{}),
	}
}

// Start begins the polling loop. It blocks until Stop is called or the context
// is cancelled.
func (s *SimpleScheduler) Start(ctx context.Context) {
	s.logger.Info("scheduler started, polling every 60s")

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Fire immediately on first tick, then every 60s.
	s.poll(ctx)

	for {
		select {
		case <-ctx.Done():
			s.logger.Info("scheduler stopping (context cancelled)")
			return
		case <-s.stop:
			s.logger.Info("scheduler stopping (stop called)")
			return
		case <-ticker.C:
			s.poll(ctx)
		}
	}
}

// Stop signals the polling loop to exit.
func (s *SimpleScheduler) Stop() {
	select {
	case s.stop <- struct{}{}:
	default:
	}
}

// poll queries for due schedules and fires them.
func (s *SimpleScheduler) poll(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, agent_name, input_template, cron_expr, config
		FROM schedules
		WHERE enabled = true AND next_fire_at <= now()
	`)
	if err != nil {
		s.logger.Error("scheduler: failed to query due schedules", zap.Error(err))
		return
	}
	defer rows.Close()

	type dueSchedule struct {
		id            string
		tenantID      string
		agentName     string
		inputTemplate map[string]any
		cronExpr      string
		config        map[string]any
	}

	var due []dueSchedule
	for rows.Next() {
		var ds dueSchedule
		var inputJSON, configJSON []byte
		if err := rows.Scan(&ds.id, &ds.tenantID, &ds.agentName, &inputJSON, &ds.cronExpr, &configJSON); err != nil {
			s.logger.Error("scheduler: scan error", zap.Error(err))
			continue
		}
		if len(inputJSON) > 0 {
			_ = json.Unmarshal(inputJSON, &ds.inputTemplate)
		}
		if len(configJSON) > 0 {
			_ = json.Unmarshal(configJSON, &ds.config)
		}
		due = append(due, ds)
	}

	for _, ds := range due {
		s.logger.Info("scheduler: firing schedule",
			zap.String("schedule_id", ds.id),
			zap.String("agent", ds.agentName),
			zap.String("tenant", ds.tenantID),
		)

		// Fire the executor.
		s.executor("", ds.tenantID, ds.agentName, ds.inputTemplate)

		// Calculate next fire time and update the row.
		next, err := NextCronTime(ds.cronExpr, time.Now())
		if err != nil {
			s.logger.Error("scheduler: bad cron expr, disabling schedule",
				zap.String("schedule_id", ds.id),
				zap.String("cron", ds.cronExpr),
				zap.Error(err),
			)
			_, _ = s.pool.Exec(ctx,
				`UPDATE schedules SET enabled = false WHERE id = $1`,
				ds.id,
			)
			continue
		}

		_, err = s.pool.Exec(ctx,
			`UPDATE schedules SET next_fire_at = $1, last_fired_at = now() WHERE id = $2`,
			next, ds.id,
		)
		if err != nil {
			s.logger.Error("scheduler: failed to update next_fire_at",
				zap.String("schedule_id", ds.id),
				zap.Error(err),
			)
		}
	}

	if len(due) > 0 {
		s.logger.Info("scheduler: poll complete", zap.Int("fired", len(due)))
	}
}
