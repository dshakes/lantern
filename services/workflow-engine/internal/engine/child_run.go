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

// ErrChildRunDepthExceeded is returned when a child_run step would nest deeper
// than maxChildRunDepth. Typed so callers (and tests) can distinguish a cycle
// from a dispatch failure.
var ErrChildRunDepthExceeded = errors.New("child run depth limit exceeded — possible workflow cycle")

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
	parentRunID, parentStepID, tenantID, agentName string,
	input json.RawMessage,
) (json.RawMessage, error) {
	// 1. Cycle guard, before any row is written.
	depth, err := childRunDepth(ctx, e.pool, parentRunID)
	if err != nil {
		return nil, fmt.Errorf("resolve child run depth: %w", err)
	}
	if !childDepthAllowed(depth) {
		return nil, fmt.Errorf("%w: depth %d at agent %q", ErrChildRunDepthExceeded, depth+1, agentName)
	}

	// 2. Adopt an existing child if this step already created one (replay).
	childRunID, adopted, err := e.findExistingChild(ctx, parentRunID, parentStepID)
	if err != nil {
		return nil, err
	}

	var agentVersionID string
	if adopted {
		if err := e.pool.QueryRow(ctx, `
			SELECT agent_version_id::text FROM runs WHERE id = $1
		`, childRunID).Scan(&agentVersionID); err != nil {
			return nil, fmt.Errorf("load adopted child %s: %w", childRunID, err)
		}
		e.logger.Info("adopting existing child run (replay)",
			zap.String("parent_run_id", parentRunID),
			zap.String("step_id", parentStepID),
			zap.String("child_run_id", childRunID),
		)
	} else {
		childRunID, agentVersionID, err = e.createChildRun(ctx, parentRunID, parentStepID, tenantID, agentName, input, depth+1)
		if err != nil {
			return nil, err
		}
		if err := e.journalChildEvent(ctx, parentRunID, parentStepID, journal.KindChildStarted, map[string]any{
			"child_run_id": childRunID,
			"agent_name":   agentName,
			"depth":        depth + 1,
		}); err != nil {
			return nil, err
		}
	}

	// 3. Drive the child. ctx is the parent's, so cancelling the parent
	//    cancels the child rather than orphaning it mid-flight.
	runErr := e.driveChild(ctx, childRunID, tenantID, agentVersionID)

	// 4. Read the child's terminal state back from the row the engine owns,
	//    rather than trusting the in-memory result — a crash between these
	//    points must still report what actually happened.
	status, output, readErr := e.childOutcome(ctx, childRunID)
	if readErr != nil {
		return nil, readErr
	}

	result := childRunResult{ChildRunID: childRunID, Status: status, Output: output, Adopted: adopted}
	payload, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("marshal child run result: %w", err)
	}

	if err := e.journalChildEvent(ctx, parentRunID, parentStepID, journal.KindChildCompleted, map[string]any{
		"child_run_id": childRunID,
		"status":       status,
	}); err != nil {
		return nil, err
	}

	// A child that failed fails the parent step. runErr is preferred when set
	// because it carries the reason; status alone only says "failed".
	if runErr != nil {
		return payload, fmt.Errorf("child run %s (agent %q) failed: %w", childRunID, agentName, runErr)
	}
	if status != "succeeded" {
		return payload, fmt.Errorf("child run %s (agent %q) ended in status %q", childRunID, agentName, status)
	}
	return payload, nil
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

// findExistingChild returns the child this (parent run, step) already created,
// if any. This is what makes a replayed child_run step safe.
func (e *Engine) findExistingChild(ctx context.Context, parentRunID, parentStepID string) (string, bool, error) {
	var childRunID string
	err := e.pool.QueryRow(ctx, `
		SELECT id::text FROM runs
		WHERE parent_run_id = $1 AND trigger_meta->>'parent_step_id' = $2
		ORDER BY created_at ASC
		LIMIT 1
	`, parentRunID, parentStepID).Scan(&childRunID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("look up existing child run: %w", err)
	}
	return childRunID, true, nil
}

// createChildRun resolves the agent and inserts the child run row.
func (e *Engine) createChildRun(
	ctx context.Context,
	parentRunID, parentStepID, tenantID, agentName string,
	input json.RawMessage,
	depth int,
) (string, string, error) {
	var agentID, versionID string
	err := e.pool.QueryRow(ctx, `
		SELECT id::text, COALESCE(current_version_id::text, '')
		FROM agents
		WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL
	`, tenantID, agentName).Scan(&agentID, &versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", fmt.Errorf("child run: agent %q not found for this tenant", agentName)
	}
	if err != nil {
		return "", "", fmt.Errorf("resolve agent %q: %w", agentName, err)
	}
	if versionID == "" {
		return "", "", fmt.Errorf("child run: agent %q has no promoted version", agentName)
	}

	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	// parent_step_id is the idempotency anchor findExistingChild reads back.
	meta, err := json.Marshal(map[string]any{
		"parent_run_id":  parentRunID,
		"parent_step_id": parentStepID,
		"depth":          depth,
	})
	if err != nil {
		return "", "", fmt.Errorf("marshal child trigger_meta: %w", err)
	}

	var childRunID string
	if err := e.pool.QueryRow(ctx, `
		INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, trigger_meta, input, parent_run_id)
		VALUES ($1, $2, $3, 'queued', 'child_run', $4, $5, $6)
		RETURNING id::text
	`, tenantID, agentID, versionID, meta, input, parentRunID).Scan(&childRunID); err != nil {
		return "", "", fmt.Errorf("create child run: %w", err)
	}

	e.logger.Info("created child run",
		zap.String("parent_run_id", parentRunID),
		zap.String("step_id", parentStepID),
		zap.String("child_run_id", childRunID),
		zap.String("agent_name", agentName),
		zap.Int("depth", depth),
	)
	return childRunID, versionID, nil
}

// driveChild executes the child run to completion. An already-terminal child
// (adopted after a replay) is not re-run.
func (e *Engine) driveChild(ctx context.Context, childRunID, tenantID, agentVersionID string) error {
	var status string
	if err := e.pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, childRunID).Scan(&status); err != nil {
		return fmt.Errorf("read child status: %w", err)
	}
	if isTerminalRunStatus(status) {
		return nil
	}
	if status == "queued" {
		return e.ExecuteRun(ctx, childRunID, tenantID, agentVersionID)
	}
	// Mid-flight when we adopted it (a crash during the child's own execution).
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

// journalChildEvent records a child lifecycle event on the PARENT's journal, so
// the parent's event stream shows the child boundary.
func (e *Engine) journalChildEvent(ctx context.Context, parentRunID, stepID, kind string, fields map[string]any) error {
	payload, err := json.Marshal(fields)
	if err != nil {
		return fmt.Errorf("marshal %s payload: %w", kind, err)
	}
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin %s: %w", kind, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := journal.Append(ctx, tx, &journal.JournalEntry{
		RunID:   parentRunID,
		Kind:    kind,
		StepID:  stepID,
		Attempt: 1,
		Payload: payload,
	}); err != nil {
		return fmt.Errorf("journal %s: %w", kind, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit %s: %w", kind, err)
	}
	return nil
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
