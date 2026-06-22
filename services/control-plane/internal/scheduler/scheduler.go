package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// ExecutorFunc is the callback invoked for each due schedule. It receives the
// run ID (empty — the executor creates it), tenant ID, agent name, and an
// optional input template. The executor is expected to create and run the agent
// synchronously or in a background goroutine.
type ExecutorFunc func(runID, tenantID, agentName string, input map[string]any)

// SimpleScheduler polls the schedules table every 60 seconds and fires due
// schedules. It uses SELECT … FOR UPDATE SKIP LOCKED inside a transaction so
// that multiple replicas never claim the same due row: a given schedule fires
// at most once per due window even when N control-plane replicas are running.
//
// The invariant is:
//  1. A transaction claims (locks) a batch of due rows.
//  2. next_fire_at is advanced atomically inside the same transaction.
//  3. The transaction commits before the executor is called.
//
// Because next_fire_at is advanced before the commit, a concurrent replica that
// tries to claim the same row after the commit will find next_fire_at > now()
// and skip it.  A crash between commit and executor call leaves next_fire_at
// already advanced, so the schedule will not fire again until its next cron
// window — acceptable (at-most-once) for a GA scheduler.
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

// claimedSchedule holds a due schedule row plus the pre-computed next fire time
// determined inside the claim transaction.
type claimedSchedule struct {
	id            string
	tenantID      string
	agentName     string
	inputTemplate map[string]any
	cronExpr      string
	config        map[string]any
	nextFireAt    time.Time
}

// poll opens a transaction, claims all due schedule rows with FOR UPDATE SKIP
// LOCKED, advances next_fire_at for each row atomically inside the same
// transaction, commits, and then fires the executor for each claimed row.
//
// Because next_fire_at is advanced before commit, no other replica can claim the
// same row for the current window. Two concurrent poll() calls will each see a
// disjoint set of rows (SKIP LOCKED skips rows already locked by the peer).
func (s *SimpleScheduler) poll(ctx context.Context) {
	claimed, err := s.claimDueSchedules(ctx)
	if err != nil {
		s.logger.Error("scheduler: failed to claim due schedules", zap.Error(err))
		return
	}

	for _, ds := range claimed {
		s.logger.Info("scheduler: firing schedule",
			zap.String("schedule_id", ds.id),
			zap.String("agent", ds.agentName),
			zap.String("tenant", ds.tenantID),
			zap.Time("next_fire_at", ds.nextFireAt),
		)
		s.executor("", ds.tenantID, ds.agentName, ds.inputTemplate)
	}

	if len(claimed) > 0 {
		s.logger.Info("scheduler: poll complete", zap.Int("fired", len(claimed)))
	}
}

// claimDueSchedules runs a single serializable transaction that:
//  1. SELECTs all enabled rows with next_fire_at <= now() FOR UPDATE SKIP LOCKED.
//  2. For each row, computes the next cron time and UPDATEs next_fire_at +
//     last_fired_at (or disables the schedule on a bad cron expression).
//  3. Commits.
//
// Returns the rows that were successfully claimed and whose next_fire_at was
// advanced. Rows with a bad cron expression are disabled in the same transaction
// and excluded from the returned slice.
func (s *SimpleScheduler) claimDueSchedules(ctx context.Context) ([]claimedSchedule, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.ReadCommitted, // SKIP LOCKED works fine at read-committed
		AccessMode: pgx.ReadWrite,
	})
	if err != nil {
		return nil, fmt.Errorf("claimDueSchedules: begin tx: %w", err)
	}
	defer func() {
		// Rollback is a no-op after a successful Commit.
		_ = tx.Rollback(ctx)
	}()

	rows, err := tx.Query(ctx, `
		SELECT id, tenant_id, agent_name, input_template, cron_expr, config
		FROM   schedules
		WHERE  enabled = true
		  AND  next_fire_at <= now()
		FOR UPDATE SKIP LOCKED
	`)
	if err != nil {
		return nil, fmt.Errorf("claimDueSchedules: query: %w", err)
	}

	type rawRow struct {
		id         string
		tenantID   string
		agentName  string
		inputJSON  []byte
		cronExpr   string
		configJSON []byte
	}

	var rawRows []rawRow
	for rows.Next() {
		var r rawRow
		if scanErr := rows.Scan(&r.id, &r.tenantID, &r.agentName, &r.inputJSON, &r.cronExpr, &r.configJSON); scanErr != nil {
			s.logger.Error("scheduler: scan error", zap.Error(scanErr))
			continue
		}
		rawRows = append(rawRows, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("claimDueSchedules: rows iteration: %w", err)
	}

	now := time.Now()
	var claimed []claimedSchedule

	for _, r := range rawRows {
		next, cronErr := NextCronTime(r.cronExpr, now)
		if cronErr != nil {
			s.logger.Error("scheduler: bad cron expr, disabling schedule",
				zap.String("schedule_id", r.id),
				zap.String("cron", r.cronExpr),
				zap.Error(cronErr),
			)
			if _, execErr := tx.Exec(ctx,
				`UPDATE schedules SET enabled = false WHERE id = $1`,
				r.id,
			); execErr != nil {
				s.logger.Error("scheduler: failed to disable schedule with bad cron",
					zap.String("schedule_id", r.id),
					zap.Error(execErr),
				)
			}
			continue
		}

		// Advance next_fire_at atomically inside this transaction. After commit,
		// any peer replica will see next_fire_at > now() and skip this row.
		if _, execErr := tx.Exec(ctx,
			`UPDATE schedules SET next_fire_at = $1, last_fired_at = now() WHERE id = $2`,
			next, r.id,
		); execErr != nil {
			s.logger.Error("scheduler: failed to advance next_fire_at",
				zap.String("schedule_id", r.id),
				zap.Error(execErr),
			)
			continue
		}

		ds := claimedSchedule{
			id:         r.id,
			tenantID:   r.tenantID,
			agentName:  r.agentName,
			cronExpr:   r.cronExpr,
			nextFireAt: next,
		}
		if len(r.inputJSON) > 0 {
			_ = json.Unmarshal(r.inputJSON, &ds.inputTemplate)
		}
		if len(r.configJSON) > 0 {
			_ = json.Unmarshal(r.configJSON, &ds.config)
		}
		claimed = append(claimed, ds)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("claimDueSchedules: commit: %w", err)
	}
	return claimed, nil
}
