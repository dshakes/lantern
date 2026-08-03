// Child runs: a workflow step that invokes another agent and waits for it.
//
// WHY THIS LIVES IN THE ENGINE, not behind a control-plane client
// ---------------------------------------------------------------
// The step used to fail with ErrChildRunUnavailable, explained as "the engine
// has no control-plane run client". That framing was wrong: architectural
// invariant #2 makes the workflow engine the ONLY thing that mutates run state,
// and the engine is already the component that drives a run to completion.
// Calling out to the control plane to ask it to create a run the engine itself
// owns would invert that invariant and add a network hop between two halves of
// the same responsibility. So a child run is created and driven here.
//
// DEPTH is computed from the parent_run_id chain in the database, not carried
// in the context. A durable engine crashes and replays; a context value resets
// to zero on the way back up, which turns the cycle guard off exactly when a
// pathological workflow is retrying hardest. The chain is the durable truth and
// survives restarts.
//
// REPLAY. RunState.GetStepResult is currently never consulted by the executor,
// so a replayed run re-executes its steps. For a child run that would mean a
// second agent invocation with real side effects. Rather than change the
// engine's replay model here, child creation is IDEMPOTENT: the child records
// its parent run + step in trigger_meta, and a re-execution finds and adopts
// that existing child instead of starting another. Fixing the executor's replay
// cache is worth doing on its own; this step must be safe either way.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// maxChildRunDepth caps how deeply child runs may nest before the chain is
// treated as a cycle. Matches the control-plane interpreter's
// maxSubagentDepth (handlers/rest.go) so both workflow surfaces agree.
const maxChildRunDepth = 5

// childChainScanLimit bounds the recursive ancestor walk. parent_run_id is
// acyclic by construction — a parent always exists before its child and the
// link is never rewritten — but a malformed row must not turn the guard query
// into an infinite recursion.
const childChainScanLimit = 100

// childLockRenewInterval is how often the parent's lock is renewed while it
// waits on a child. Comfortably shorter than the scheduler's lock duration so a
// single missed tick cannot strand the parent.
const childLockRenewInterval = 30 * time.Second

// ErrChildRunDepthExceeded is returned when a child_run step would nest deeper
// than maxChildRunDepth. Typed so callers (and tests) can distinguish a cycle
// from a dispatch failure.
var ErrChildRunDepthExceeded = errors.New("child run depth limit exceeded — possible workflow cycle")

// ErrChildRunPaused is returned when a child run stops on an approval or
// wait_signal step.
//
// Be precise about what this does and does not do: the parent step still
// FAILS. What changes is that the failure is typed and says the child is
// waiting rather than broken, so an operator (or a caller matching on it) can
// tell a pending approval apart from a crash. Actually suspending the parent
// until the child resumes requires the parent to become resumable too, which
// is an engine-level design — this names the limitation instead of implying
// nested approvals work.
var ErrChildRunPaused = errors.New("child run is paused awaiting a signal or approval")

// childRunResult is what a child_run step returns to the workflow.
type childRunResult struct {
	ChildRunID string          `json:"child_run_id"`
	Status     string          `json:"status"`
	Output     json.RawMessage `json:"output,omitempty"`
	Adopted    bool            `json:"adopted,omitempty"`
}

// runChild starts (or adopts) a child run for agentName and drives it to
// completion, returning the encoded childRunResult.
//
// Wired onto the StepExecutor as its childRunner at construction; when it is
// nil the step fails with ErrChildRunUnavailable rather than fabricating a
// result, matching how llm_call and tool_call behave without their clients.
func (e *Engine) runChild(
	ctx context.Context,
	state *RunState,
	parentStepID, agentName string,
	input json.RawMessage,
) (json.RawMessage, error) {
	parentRunID, tenantID := state.RunID, state.TenantID

	// 1. Cycle guard, before any row is written.
	depth, err := childRunDepth(ctx, e.pool, parentRunID)
	if err != nil {
		return nil, fmt.Errorf("resolve child run depth: %w", err)
	}
	if !childDepthAllowed(depth) {
		return nil, fmt.Errorf("%w: depth %d at agent %q", ErrChildRunDepthExceeded, depth+1, agentName)
	}

	// 2. Create the child, or adopt the one this step already created.
	childRunID, agentVersionID, adopted, err := e.findOrCreateChild(
		ctx, parentRunID, parentStepID, tenantID, agentName, input, depth+1)
	if err != nil {
		return nil, err
	}
	if !adopted {
		if err := e.journalChildEvent(ctx, state, parentStepID, journal.KindChildStarted, map[string]any{
			"child_run_id": childRunID,
			"agent_name":   agentName,
			"depth":        depth + 1,
		}); err != nil {
			return nil, err
		}
	}

	// 3. Drive the child. ctx is the parent's, so cancelling the parent
	//    cancels the child rather than orphaning it mid-flight.
	//
	// Renew the PARENT's lock while it waits. dispatchRun only renews between
	// steps, so a parent sitting inside this one step renews nothing: a child
	// outliving the lock duration would let CleanExpiredLocks drop the parent's
	// lock and the scheduler re-claim and re-execute the whole parent run. A
	// child run is an entire nested workflow, so that is minutes, not an edge
	// case. (Any long-blocking step has this shape; fixing it engine-wide means
	// renewing concurrently for every step, which is its own change.)
	stopRenew := e.keepParentLockAlive(ctx, parentRunID)
	runErr := e.driveChild(ctx, childRunID, tenantID, agentVersionID)
	stopRenew()

	// 4. Read the child's state back from the row the engine owns rather than
	//    trusting the in-memory result — a crash between these points must
	//    still report what actually happened.
	status, output, readErr := e.childOutcome(ctx, childRunID)
	if readErr != nil {
		return nil, readErr
	}

	result := childRunResult{ChildRunID: childRunID, Status: status, Output: output, Adopted: adopted}
	payload, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal child run result: %w", err)
	}

	if err := e.journalChildEvent(ctx, state, parentStepID, journal.KindChildCompleted, map[string]any{
		"child_run_id": childRunID,
		"status":       status,
	}); err != nil {
		return nil, err
	}

	// A child that PAUSED has not failed — it is waiting on a signal or a human
	// approval and will resume later. Reporting that as a generic step failure
	// would be wrong twice over: it loses the distinction, and it makes any
	// child that ever pauses look broken. Resuming a parent around a paused
	// child needs the parent to become resumable too, which is a design in its
	// own right, so say exactly that instead of guessing.
	if isPausedRunStatus(status) {
		return payload, fmt.Errorf("%w: child run %s (agent %q) is %s", ErrChildRunPaused, childRunID, agentName, status)
	}
	// runErr is preferred when set because it carries the reason; a status of
	// "failed" alone only says that it did.
	if runErr != nil {
		return payload, fmt.Errorf("child run %s (agent %q) failed: %w", childRunID, agentName, runErr)
	}
	if status != "succeeded" {
		return payload, fmt.Errorf("child run %s (agent %q) ended in status %q", childRunID, agentName, status)
	}
	return payload, nil
}

// keepParentLockAlive renews the parent's run lock until the returned stop is
// called. Returns a no-op when there is no scheduler (unit tests).
func (e *Engine) keepParentLockAlive(ctx context.Context, parentRunID string) func() {
	if e.scheduler == nil {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(childLockRenewInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := e.scheduler.RenewLock(ctx, parentRunID); err != nil {
					e.logger.Warn("failed to renew parent lock during child run (continuing)",
						zap.String("parent_run_id", parentRunID),
						zap.Error(err),
					)
				}
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}

// childDepthAllowed reports whether a parent at parentDepth may spawn a child.
//
// Pure and separate from the query so the cap — the thing standing between a
// self-referencing workflow and unbounded recursion — is testable at its
// boundary without a database.
func childDepthAllowed(parentDepth int) bool {
	return parentDepth+1 <= maxChildRunDepth
}

// childRunDepth counts how many ancestors runID already has.
func childRunDepth(ctx context.Context, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, runID string) (int, error) {
	var depth int
	err := pool.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, parent_run_id, 0 AS depth
			FROM runs WHERE id = $1
			UNION ALL
			SELECT r.id, r.parent_run_id, c.depth + 1
			FROM runs r
			JOIN chain c ON r.id = c.parent_run_id
			WHERE c.depth < $2
		)
		SELECT COALESCE(MAX(depth), 0) FROM chain
	`, runID, childChainScanLimit).Scan(&depth)
	if err != nil {
		return 0, err
	}
	return depth, nil
}

// findOrCreateChild returns the child run for this (parent run, step),
// creating it if this is the first execution.
//
// Both halves run in ONE transaction that first locks the PARENT run row.
// Without that lock, two executions of the same step can both look, both find
// nothing, and both insert — producing two child runs for one step and quietly
// defeating the adoption that makes replay safe.
//
// The child is created as 'running', NOT 'queued'. The scheduler polls
// `status IN ('queued','resumable')`, so a queued child would be claimed by a
// scheduler worker at the same moment the parent drives it inline — two
// goroutines executing one run, with duplicated LLM and tool side effects.
// Creating it already-running means the poller cannot see it by construction,
// which removes the race rather than narrowing it. Recovery is unchanged in
// kind: a parent that crashes mid-child re-drives it on replay via the same
// adoption path (an in-flight child is not terminal, so driveChild resumes it).
func (e *Engine) findOrCreateChild(
	ctx context.Context,
	parentRunID, parentStepID, tenantID, agentName string,
	input json.RawMessage,
	depth int,
) (childRunID, agentVersionID string, adopted bool, err error) {
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return "", "", false, fmt.Errorf("begin child run creation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialise concurrent executions of this step against each other.
	if _, err := tx.Exec(ctx, `SELECT id FROM runs WHERE id = $1 FOR UPDATE`, parentRunID); err != nil {
		return "", "", false, fmt.Errorf("lock parent run %s: %w", parentRunID, err)
	}

	err = tx.QueryRow(ctx, `
		SELECT id::text, agent_version_id::text FROM runs
		WHERE parent_run_id = $1 AND trigger_meta->>'parent_step_id' = $2
		ORDER BY created_at ASC
		LIMIT 1
	`, parentRunID, parentStepID).Scan(&childRunID, &agentVersionID)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return "", "", false, fmt.Errorf("commit child adoption: %w", err)
		}
		e.logger.Info("adopting existing child run (replay)",
			zap.String("parent_run_id", parentRunID),
			zap.String("step_id", parentStepID),
			zap.String("child_run_id", childRunID),
		)
		return childRunID, agentVersionID, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, fmt.Errorf("look up existing child run: %w", err)
	}

	var agentID string
	err = tx.QueryRow(ctx, `
		SELECT id::text, COALESCE(current_version_id::text, '')
		FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, agentName).Scan(&agentID, &agentVersionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", false, fmt.Errorf("child run: agent %q not found for this tenant", agentName)
	}
	if err != nil {
		return "", "", false, fmt.Errorf("resolve agent %q: %w", agentName, err)
	}
	if agentVersionID == "" {
		return "", "", false, fmt.Errorf("child run: agent %q has no promoted version", agentName)
	}

	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	// parent_step_id is the idempotency anchor the lookup above reads back.
	meta, err := json.Marshal(map[string]any{
		"parent_run_id":  parentRunID,
		"parent_step_id": parentStepID,
		"depth":          depth,
	})
	if err != nil {
		return "", "", false, fmt.Errorf("marshal child trigger_meta: %w", err)
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, started_at, trigger_kind, trigger_meta, input, parent_run_id, session_id)
		VALUES ($1, $2, $3, 'running', now(), 'child_run', $4, $5, $6,
			(SELECT session_id FROM runs WHERE id = $6))
		RETURNING id::text
	`, tenantID, agentID, agentVersionID, meta, input, parentRunID).Scan(&childRunID); err != nil {
		return "", "", false, fmt.Errorf("create child run: %w", err)
	}
	// Record a run_locks row for the child in the same transaction.
	//
	// Exclusion here comes from the STATUS — the scheduler polls
	// queued/resumable and cannot select a 'running' child — but every other
	// executing run has a lock row, and without one the child is invisible to
	// lock-based tooling and to CleanExpiredLocks. Best-effort by design: the
	// row is bookkeeping, not the thing preventing a second worker.
	if e.scheduler != nil {
		if _, err := tx.Exec(ctx, `
			INSERT INTO run_locks (run_id, worker_id, expires_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (run_id) DO UPDATE SET
				worker_id = $2, acquired_at = now(), expires_at = $3
		`, childRunID, e.scheduler.workerID, time.Now().Add(lockDuration)); err != nil {
			return "", "", false, fmt.Errorf("record child run lock: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", false, fmt.Errorf("commit child run creation: %w", err)
	}

	e.logger.Info("created child run",
		zap.String("parent_run_id", parentRunID),
		zap.String("step_id", parentStepID),
		zap.String("child_run_id", childRunID),
		zap.String("agent_name", agentName),
		zap.Int("depth", depth),
	)
	return childRunID, agentVersionID, false, nil
}

// driveChild executes the child run to completion. An already-terminal child
// (adopted after a replay) is not re-run. The child is created 'running', so
// dispatchRun — not ExecuteRun, which requires a queued row — is the entry
// point in both the fresh and the resumed case.
func (e *Engine) driveChild(ctx context.Context, childRunID, tenantID, agentVersionID string) error {
	var status string
	if err := e.pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, childRunID).Scan(&status); err != nil {
		return fmt.Errorf("read child status: %w", err)
	}
	if isTerminalRunStatus(status) {
		return nil
	}
	return e.dispatchRun(ctx, childRunID, tenantID, agentVersionID)
}

// childOutcome reads the child's terminal status and output.
func (e *Engine) childOutcome(ctx context.Context, childRunID string) (string, json.RawMessage, error) {
	var status string
	var output []byte
	if err := e.pool.QueryRow(ctx, `
		SELECT status, COALESCE(output, 'null'::jsonb) FROM runs WHERE id = $1
	`, childRunID).Scan(&status, &output); err != nil {
		return "", nil, fmt.Errorf("read child run outcome: %w", err)
	}
	return status, json.RawMessage(output), nil
}

// journalChildEvent records a child lifecycle event on the PARENT's journal.
// It appends to the parent's in-memory RunState as well as the database —
// writing only to the database leaves the running parent's view of its own
// history missing the child boundary until the next replay.
func (e *Engine) journalChildEvent(ctx context.Context, state *RunState, stepID, kind string, fields map[string]any) error {
	parentRunID := state.RunID
	payload, err := json.Marshal(fields)
	if err != nil {
		return fmt.Errorf("marshal %s payload: %w", kind, err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin %s: %w", kind, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	entry := &journal.JournalEntry{
		RunID:   parentRunID,
		Kind:    kind,
		StepID:  stepID,
		Attempt: 1,
		Payload: payload,
	}
	if err := journal.Append(ctx, tx, entry); err != nil {
		return fmt.Errorf("journal %s: %w", kind, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit %s: %w", kind, err)
	}
	state.AppendJournal(*entry)
	return nil
}

// isPausedRunStatus reports whether a run is waiting rather than finished.
func isPausedRunStatus(status string) bool {
	return status == "paused" || status == "resumable"
}

// isTerminalRunStatus reports whether a run will not progress further.
func isTerminalRunStatus(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "canceled":
		return true
	default:
		return false
	}
}
