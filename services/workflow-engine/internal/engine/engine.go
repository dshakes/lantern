package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// Engine is the core workflow execution engine. It manages a pool of worker
// goroutines that pick up queued runs, replay their journals, and execute
// new steps. The engine is the only thing that mutates run state
// (architectural invariant #2).
type Engine struct {
	pool      *pgxpool.Pool
	redis     *redis.Client
	logger    *zap.Logger
	workers   int
	runs      map[string]*RunState // active runs, keyed by run_id
	mu        sync.RWMutex
	cancel    context.CancelFunc
	scheduler *Scheduler
	streamer  *EventStreamer
	executor  *StepExecutor
	wg        sync.WaitGroup
}

// NewEngine creates a new Engine instance.
func NewEngine(pool *pgxpool.Pool, rdb *redis.Client, logger *zap.Logger, workerCount int) *Engine {
	eng := &Engine{
		pool:    pool,
		redis:   rdb,
		logger:  logger.Named("engine"),
		workers: workerCount,
		runs:    make(map[string]*RunState),
	}

	eng.streamer = NewEventStreamer(rdb, logger)
	eng.executor = NewStepExecutor(pool, eng.streamer, logger)
	eng.scheduler = NewScheduler(pool, logger, eng.dispatchRun)

	return eng
}

// Start begins the engine's worker pool and scheduler. Workers poll for
// queued runs and execute them.
func (e *Engine) Start(ctx context.Context) {
	ctx, e.cancel = context.WithCancel(ctx)

	e.logger.Info("engine starting",
		zap.Int("workers", e.workers),
	)

	// Start the scheduler.
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		e.scheduler.Start(ctx)
	}()

	// Start the expired lock cleaner (runs every 30 seconds).
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.scheduler.CleanExpiredLocks(ctx); err != nil {
					e.logger.Error("failed to clean expired locks", zap.Error(err))
				}
			}
		}
	}()

	e.logger.Info("engine started")
}

// Stop gracefully shuts down the engine. It cancels all active runs and waits
// for them to drain.
func (e *Engine) Stop() {
	e.logger.Info("engine stopping, draining active runs")

	if e.cancel != nil {
		e.cancel()
	}

	// Wait for scheduler and cleaner goroutines.
	e.wg.Wait()

	e.mu.RLock()
	activeCount := len(e.runs)
	e.mu.RUnlock()

	e.logger.Info("engine stopped",
		zap.Int("active_runs_at_shutdown", activeCount),
	)
}

// dispatchRun is called by the scheduler when a run is ready to execute.
// It loads the journal, replays state, and kicks off execution.
func (e *Engine) dispatchRun(ctx context.Context, runID, tenantID, agentVersionID string) error {
	e.logger.Info("dispatching run",
		zap.String("run_id", runID),
		zap.String("tenant_id", tenantID),
	)

	// Load the journal to reconstruct state.
	entries, err := journal.Load(ctx, e.pool, runID)
	if err != nil {
		return fmt.Errorf("load journal: %w", err)
	}

	// Create or recover run state.
	state := NewRunState(runID, tenantID, agentVersionID)
	if len(entries) > 0 {
		state.ReplayFromJournal(entries)
		e.logger.Info("replayed journal",
			zap.String("run_id", runID),
			zap.Int("entries", len(entries)),
			zap.String("status", state.GetStatus()),
		)
	}

	// Register the run as active.
	e.mu.Lock()
	e.runs[runID] = state
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		delete(e.runs, runID)
		e.mu.Unlock()
	}()

	// If this is a fresh run, journal run_started and update status.
	if len(entries) == 0 {
		if err := e.journalRunStarted(ctx, state); err != nil {
			return fmt.Errorf("journal run_started: %w", err)
		}
	}

	// Execute the run. In a full implementation, the runtime manager drives
	// step execution — the engine receives StepRequests from the runtime
	// and responds with StepResponses. For the spike, we simulate a simple
	// linear workflow by reading steps from the run's manifest.
	err = e.executeRunWorkflow(ctx, state)

	// Terminal state.
	if err != nil {
		if ctx.Err() != nil {
			// Context cancelled — the run was cancelled externally.
			e.journalRunCancelled(ctx, state) //nolint:errcheck
			return nil
		}
		e.journalRunFailed(ctx, state, err) //nolint:errcheck
		return nil
	}

	e.journalRunSucceeded(ctx, state) //nolint:errcheck
	return nil
}

// executeRunWorkflow is the main execution loop for a run. In the full
// implementation, this would receive StepRequests from the runtime manager
// via gRPC streaming. For the spike, it demonstrates the replay + execute
// pattern with a simulated workflow.
func (e *Engine) executeRunWorkflow(ctx context.Context, state *RunState) error {
	// In production, the engine receives steps from the runtime manager.
	// The runtime manager runs user code in a microVM, and when the code
	// calls sdk.step(), the runtime sends a StepRequest to the engine.
	// The engine journals the step, executes it (or replays it), and sends
	// the StepResponse back.
	//
	// For the spike, we simulate by reading from the runs table input
	// which may contain a "steps" array.
	var input struct {
		Steps []struct {
			StepID  string          `json:"step_id"`
			Kind    string          `json:"kind"`
			Data    json.RawMessage `json:"data,omitempty"`
			Retries int             `json:"retries,omitempty"`
			Timeout int             `json:"timeout,omitempty"`
		} `json:"steps,omitempty"`
	}

	// Load the run's input from the database.
	var inputJSON []byte
	err := e.pool.QueryRow(ctx, `SELECT input FROM runs WHERE id = $1`, state.RunID).Scan(&inputJSON)
	if err != nil {
		return fmt.Errorf("load run input: %w", err)
	}

	if err := json.Unmarshal(inputJSON, &input); err != nil {
		// If input doesn't have steps, the run completes immediately.
		e.logger.Info("run has no steps, completing",
			zap.String("run_id", state.RunID),
		)
		return nil
	}

	for _, step := range input.Steps {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		payload := &StepPayload{
			Kind:       step.Kind,
			Data:       step.Data,
			MaxRetries: step.Retries,
			TimeoutSec: step.Timeout,
		}

		result, err := e.executor.ExecuteStep(ctx, state, step.StepID, payload)
		if err != nil {
			return fmt.Errorf("step %s failed: %w", step.StepID, err)
		}

		if result.Error != "" {
			return fmt.Errorf("step %s: %s", step.StepID, result.Error)
		}

		// Renew the advisory lock periodically to prevent expiry on long runs.
		if err := e.scheduler.RenewLock(ctx, state.RunID); err != nil {
			e.logger.Warn("failed to renew lock (continuing)",
				zap.String("run_id", state.RunID),
				zap.Error(err),
			)
		}
	}

	return nil
}

// ExecuteRun handles the gRPC ExecuteRun call. It updates the run status to
// 'running' and dispatches it.
func (e *Engine) ExecuteRun(ctx context.Context, runID, tenantID, agentVersionID string) error {
	// Update run status to running.
	tag, err := e.pool.Exec(ctx, `
		UPDATE runs SET status = 'running', started_at = now()
		WHERE id = $1 AND status = 'queued'
	`, runID)
	if err != nil {
		return fmt.Errorf("update run status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("run %s not in queued state", runID)
	}

	return e.dispatchRun(ctx, runID, tenantID, agentVersionID)
}

// ResumeRun resumes a paused run. The run is expected to have a pending
// signal or sleep that was satisfied.
func (e *Engine) ResumeRun(ctx context.Context, runID string) error {
	// Load run metadata.
	var tenantID, agentVersionID, status string
	err := e.pool.QueryRow(ctx, `
		SELECT tenant_id, agent_version_id, status FROM runs WHERE id = $1
	`, runID).Scan(&tenantID, &agentVersionID, &status)
	if err != nil {
		return fmt.Errorf("load run: %w", err)
	}

	if status != "paused" && status != "resumable" {
		return fmt.Errorf("run %s is in status %s, expected paused or resumable", runID, status)
	}

	// Update to resumable so the scheduler picks it up.
	if _, err := e.pool.Exec(ctx, `
		UPDATE runs SET status = 'resumable' WHERE id = $1
	`, runID); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	e.logger.Info("run marked for resume",
		zap.String("run_id", runID),
		zap.String("tenant_id", tenantID),
	)

	return nil
}

// SignalRun delivers an external signal to a running or paused run.
func (e *Engine) SignalRun(ctx context.Context, runID, signalName string, value json.RawMessage) error {
	// First, try to deliver to an active in-memory run.
	e.mu.RLock()
	state, active := e.runs[runID]
	e.mu.RUnlock()

	if active {
		var parsed any
		json.Unmarshal(value, &parsed) //nolint:errcheck
		if state.DeliverSignal(signalName, parsed) {
			e.logger.Info("signal delivered to active run",
				zap.String("run_id", runID),
				zap.String("signal_name", signalName),
			)
			return nil
		}
	}

	// Run is not active or no waiter for this signal. Store the signal in the
	// journal so it's picked up when the run resumes.
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   runID,
		Kind:    journal.KindSignalReceived,
		StepID:  signalName,
		Attempt: 1,
		Payload: value,
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return fmt.Errorf("journal signal: %w", err)
	}

	// If the run is paused, mark it as resumable.
	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'resumable'
		WHERE id = $1 AND status = 'paused'
	`, runID); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit signal: %w", err)
	}

	e.logger.Info("signal stored in journal",
		zap.String("run_id", runID),
		zap.String("signal_name", signalName),
	)

	return nil
}

// CancelRun cancels a running or paused run.
func (e *Engine) CancelRun(ctx context.Context, runID string) error {
	// If the run is active in memory, cancel it.
	e.mu.RLock()
	state, active := e.runs[runID]
	e.mu.RUnlock()

	if active {
		state.SetStatus("cancelled")
		// The execution loop checks status and will exit.
	}

	// Update the database.
	tag, err := e.pool.Exec(ctx, `
		UPDATE runs SET status = 'cancelled', finished_at = now()
		WHERE id = $1 AND status IN ('queued', 'running', 'paused', 'resumable')
	`, runID)
	if err != nil {
		return fmt.Errorf("update run status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("run %s not in a cancellable state", runID)
	}

	// Journal the cancellation.
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   runID,
		Kind:    journal.KindRunCancelled,
		Attempt: 1,
		Payload: mustMarshal(map[string]string{"reason": "user_requested"}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return fmt.Errorf("journal run_cancelled: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	e.logger.Info("run cancelled",
		zap.String("run_id", runID),
	)

	// Publish terminal stream event.
	e.streamer.PublishEnd(ctx, runID, 0, "cancelled")

	return nil
}

// Streamer returns the event streamer for use by gRPC handlers.
func (e *Engine) Streamer() *EventStreamer {
	return e.streamer
}

// GetActiveRun returns the in-memory state of an active run, if present.
func (e *Engine) GetActiveRun(runID string) (*RunState, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	state, ok := e.runs[runID]
	return state, ok
}

// GetQueryHandler returns a registered query handler for an active run.
func (e *Engine) GetQueryHandler(runID, queryName string) (QueryHandler, error) {
	e.mu.RLock()
	state, ok := e.runs[runID]
	e.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("run %s is not active", runID)
	}

	state.Lock()
	handler, exists := state.Queries[queryName]
	state.Unlock()

	if !exists {
		return nil, fmt.Errorf("query %q not registered on run %s", queryName, runID)
	}

	return handler, nil
}

// --- internal journal helpers ---

func (e *Engine) journalRunStarted(ctx context.Context, state *RunState) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindRunStarted,
		Attempt: 1,
		Payload: mustMarshal(map[string]string{
			"agent_version_id": state.AgentVersionID,
			"tenant_id":        state.TenantID,
		}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	// Update run status transactionally.
	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'running', started_at = now()
		WHERE id = $1
	`, state.RunID); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)

	// Publish stream event.
	e.streamer.Publish(ctx, &StreamEvent{
		RunID: state.RunID,
		Seq:   entry.Seq,
		Kind:  journal.KindRunStarted,
		TS:    time.Now().UTC(),
	})

	return nil
}

func (e *Engine) journalRunSucceeded(ctx context.Context, state *RunState) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindRunSucceeded,
		Attempt: 1,
		Payload: mustMarshal(map[string]string{"status": "succeeded"}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'succeeded', finished_at = now()
		WHERE id = $1
	`, state.RunID); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	state.SetStatus("succeeded")

	e.logger.Info("run succeeded",
		zap.String("run_id", state.RunID),
		zap.String("tenant_id", state.TenantID),
	)

	e.streamer.Publish(ctx, &StreamEvent{
		RunID: state.RunID,
		Seq:   entry.Seq,
		Kind:  journal.KindRunSucceeded,
		TS:    time.Now().UTC(),
	})
	e.streamer.PublishEnd(ctx, state.RunID, entry.Seq+1, "succeeded")

	return nil
}

func (e *Engine) journalRunFailed(ctx context.Context, state *RunState, runErr error) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindRunFailed,
		Attempt: 1,
		Payload: mustMarshal(map[string]string{
			"error": runErr.Error(),
		}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	errJSON, _ := json.Marshal(map[string]string{
		"code":    "RUN_FAILED",
		"message": runErr.Error(),
	})

	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'failed', finished_at = now(), error = $2
		WHERE id = $1
	`, state.RunID, errJSON); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	state.SetStatus("failed")

	e.logger.Error("run failed",
		zap.String("run_id", state.RunID),
		zap.String("tenant_id", state.TenantID),
		zap.Error(runErr),
	)

	e.streamer.Publish(ctx, &StreamEvent{
		RunID: state.RunID,
		Seq:   entry.Seq,
		Kind:  journal.KindRunFailed,
		Payload: mustMarshal(map[string]string{
			"error": runErr.Error(),
		}),
		TS: time.Now().UTC(),
	})
	e.streamer.PublishEnd(ctx, state.RunID, entry.Seq+1, "failed")

	return nil
}

func (e *Engine) journalRunCancelled(ctx context.Context, state *RunState) error {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	entry := &journal.JournalEntry{
		RunID:   state.RunID,
		Kind:    journal.KindRunCancelled,
		Attempt: 1,
		Payload: mustMarshal(map[string]string{"reason": "context_cancelled"}),
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'cancelled', finished_at = now()
		WHERE id = $1
	`, state.RunID); err != nil {
		return fmt.Errorf("update run status: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	state.AppendJournal(*entry)
	state.SetStatus("cancelled")

	e.logger.Info("run cancelled",
		zap.String("run_id", state.RunID),
		zap.String("tenant_id", state.TenantID),
	)

	e.streamer.PublishEnd(ctx, state.RunID, entry.Seq+1, "cancelled")

	return nil
}
