package engine

import (
	"encoding/json"
	"sync"

	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// StepResult holds the cached result of a completed step. During replay,
// the engine populates these from the journal so that already-completed
// steps return their previous results without re-executing.
type StepResult struct {
	StepID  string          `json:"step_id"`
	Attempt int             `json:"attempt"`
	Output  json.RawMessage `json:"output,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// QueryHandler is a function that can answer a synchronous query against
// the current state of a running workflow.
type QueryHandler func(args json.RawMessage) (json.RawMessage, error)

// RunState holds the in-memory state for a single active run. It is
// reconstructed from the journal on cold start and maintained during
// execution. All mutations are protected by mu.
type RunState struct {
	RunID          string
	TenantID       string
	AgentVersionID string
	Status         string
	Journal        []journal.JournalEntry
	StepResults    map[string]*StepResult  // cached step results for replay
	Signals        map[string]chan any      // pending signal waiters
	Queries        map[string]QueryHandler // registered query handlers
	mu             sync.Mutex
}

// NewRunState creates a new RunState with initialized maps.
func NewRunState(runID, tenantID, agentVersionID string) *RunState {
	return &RunState{
		RunID:          runID,
		TenantID:       tenantID,
		AgentVersionID: agentVersionID,
		Status:         "running",
		StepResults:    make(map[string]*StepResult),
		Signals:        make(map[string]chan any),
		Queries:        make(map[string]QueryHandler),
	}
}

// HasStepResult returns true if the journal contains a completed result for
// the given step. This is the replay check — if true, the step should not
// be re-executed.
func (rs *RunState) HasStepResult(stepID string) (*StepResult, bool) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	r, ok := rs.StepResults[stepID]
	return r, ok
}

// SetStepResult caches a step result for replay.
func (rs *RunState) SetStepResult(stepID string, result *StepResult) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.StepResults[stepID] = result
}

// AppendJournal adds an entry to the in-memory journal. The database write
// happens separately in a transaction.
func (rs *RunState) AppendJournal(entry journal.JournalEntry) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.Journal = append(rs.Journal, entry)
}

// WaitForSignal returns a channel that will receive the signal value when
// the named signal is delivered. If a channel already exists for this signal
// name, the existing channel is returned.
func (rs *RunState) WaitForSignal(name string) chan any {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	ch, ok := rs.Signals[name]
	if !ok {
		ch = make(chan any, 1)
		rs.Signals[name] = ch
	}
	return ch
}

// DeliverSignal sends a value to a waiting signal channel. Returns true if
// a waiter was found and the signal was delivered.
func (rs *RunState) DeliverSignal(name string, value any) bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	ch, ok := rs.Signals[name]
	if !ok {
		return false
	}
	select {
	case ch <- value:
		delete(rs.Signals, name)
		return true
	default:
		// Channel already has a value buffered.
		return false
	}
}

// Lock acquires the RunState mutex. Used by external callers (e.g., query
// handlers) that need safe access to internal state.
func (rs *RunState) Lock() {
	rs.mu.Lock()
}

// Unlock releases the RunState mutex.
func (rs *RunState) Unlock() {
	rs.mu.Unlock()
}

// SetStatus updates the run status.
func (rs *RunState) SetStatus(status string) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.Status = status
}

// GetStatus returns the current run status.
func (rs *RunState) GetStatus() string {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.Status
}

// ReplayFromJournal reconstructs the in-memory state from a loaded journal.
// This is called on cold start when the engine picks up a run that was
// previously in progress.
func (rs *RunState) ReplayFromJournal(entries []journal.JournalEntry) {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	rs.Journal = entries

	for _, e := range entries {
		switch e.Kind {
		case journal.KindStepCompleted:
			var result StepResult
			if json.Unmarshal(e.Payload, &result) == nil {
				rs.StepResults[e.StepID] = &result
			} else {
				// Fallback: store with raw payload as output.
				rs.StepResults[e.StepID] = &StepResult{
					StepID:  e.StepID,
					Attempt: e.Attempt,
					Output:  e.Payload,
				}
			}

		case journal.KindStepFailed:
			var result StepResult
			if json.Unmarshal(e.Payload, &result) == nil {
				rs.StepResults[e.StepID] = &result
			}

		case journal.KindRunSucceeded:
			rs.Status = "succeeded"

		case journal.KindRunFailed:
			rs.Status = "failed"

		case journal.KindRunCancelled:
			rs.Status = "cancelled"

		case journal.KindRunStarted:
			rs.Status = "running"

		case journal.KindSignalWaiting:
			// Re-create the signal channel for signals that were waiting
			// when the run was last active.
			if e.StepID != "" {
				if _, exists := rs.Signals[e.StepID]; !exists {
					rs.Signals[e.StepID] = make(chan any, 1)
				}
			}

		case journal.KindSignalReceived:
			// Signal was delivered — remove the waiter if it was re-created.
			delete(rs.Signals, e.StepID)
		}
	}
}
