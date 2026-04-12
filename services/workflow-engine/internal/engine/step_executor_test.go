package engine_test

import (
	"encoding/json"
	"testing"

	"github.com/dshakes/lantern/services/workflow-engine/internal/engine"
	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// ---------------------------------------------------------------------------
// RunState replay tests — verify the replay-or-execute logic that makes the
// workflow engine durable. These test the in-memory state reconstruction
// without requiring a database.
// ---------------------------------------------------------------------------

// TestStepReplay verifies that cached results are returned on replay.
// The RunState is reconstructed from journal entries, and HasStepResult
// should return the previously completed result.
func TestStepReplay(t *testing.T) {
	state := engine.NewRunState("run-1", "tenant-1", "v1")

	// Simulate a completed step result in the cache.
	result := &engine.StepResult{
		StepID:  "step-a",
		Attempt: 1,
		Output:  json.RawMessage(`{"answer": 42}`),
	}
	state.SetStepResult("step-a:1", result)

	// Verify the cache hit
	cached, ok := state.HasStepResult("step-a:1")
	if !ok {
		t.Fatal("expected cache hit for step-a:1")
	}
	if cached.StepID != "step-a" {
		t.Errorf("expected StepID=step-a, got %q", cached.StepID)
	}
	if cached.Attempt != 1 {
		t.Errorf("expected Attempt=1, got %d", cached.Attempt)
	}
	if string(cached.Output) != `{"answer": 42}` {
		t.Errorf("unexpected output: %s", cached.Output)
	}

	// Verify cache miss for a different key
	_, ok = state.HasStepResult("step-a:2")
	if ok {
		t.Error("expected cache miss for step-a:2")
	}
}

// TestStepReplayFromJournal verifies that ReplayFromJournal correctly
// reconstructs step results from journal entries.
func TestStepReplayFromJournal(t *testing.T) {
	state := engine.NewRunState("run-2", "tenant-1", "v1")

	entries := []journal.JournalEntry{
		{
			RunID:   "run-2",
			Seq:     1,
			Kind:    journal.KindRunStarted,
			Payload: json.RawMessage(`{}`),
		},
		{
			RunID:   "run-2",
			Seq:     2,
			Kind:    journal.KindStepStarted,
			StepID:  "step-x",
			Attempt: 1,
			Payload: json.RawMessage(`{"kind": "llm_call"}`),
		},
		{
			RunID:   "run-2",
			Seq:     3,
			Kind:    journal.KindStepCompleted,
			StepID:  "step-x",
			Attempt: 1,
			Payload: json.RawMessage(`{"step_id": "step-x", "attempt": 1, "output": {"text": "hello"}}`),
		},
	}

	state.ReplayFromJournal(entries)

	// The step result should be available in the cache.
	cached, ok := state.HasStepResult("step-x")
	if !ok {
		t.Fatal("expected step-x to be cached after replay")
	}
	if cached.StepID != "step-x" {
		t.Errorf("expected StepID=step-x, got %q", cached.StepID)
	}
	if cached.Attempt != 1 {
		t.Errorf("expected Attempt=1, got %d", cached.Attempt)
	}

	// The run status should be "running" (from run_started)
	if state.GetStatus() != "running" {
		t.Errorf("expected status=running, got %q", state.GetStatus())
	}
}

// TestStepRetry_StateTracking verifies that failed step results are tracked
// for the retry logic.
func TestStepRetry_StateTracking(t *testing.T) {
	state := engine.NewRunState("run-3", "tenant-1", "v1")

	// Simulate a failed attempt
	failedResult := &engine.StepResult{
		StepID:  "step-b",
		Attempt: 1,
		Error:   "timeout exceeded",
	}
	state.SetStepResult("step-b:1", failedResult)

	// Simulate a successful retry
	successResult := &engine.StepResult{
		StepID:  "step-b",
		Attempt: 2,
		Output:  json.RawMessage(`{"result": "ok"}`),
	}
	state.SetStepResult("step-b:2", successResult)

	// Verify both are cached independently
	cached1, ok := state.HasStepResult("step-b:1")
	if !ok {
		t.Fatal("expected cache hit for step-b:1")
	}
	if cached1.Error != "timeout exceeded" {
		t.Errorf("expected error for attempt 1, got %q", cached1.Error)
	}

	cached2, ok := state.HasStepResult("step-b:2")
	if !ok {
		t.Fatal("expected cache hit for step-b:2")
	}
	if cached2.Error != "" {
		t.Errorf("expected no error for attempt 2, got %q", cached2.Error)
	}
	if string(cached2.Output) != `{"result": "ok"}` {
		t.Errorf("unexpected output for attempt 2: %s", cached2.Output)
	}
}

// TestRunState_StatusTransitions verifies correct status transitions.
func TestRunState_StatusTransitions(t *testing.T) {
	state := engine.NewRunState("run-4", "tenant-1", "v1")

	if state.GetStatus() != "running" {
		t.Errorf("initial status should be running, got %q", state.GetStatus())
	}

	state.SetStatus("paused")
	if state.GetStatus() != "paused" {
		t.Errorf("expected paused, got %q", state.GetStatus())
	}

	state.SetStatus("running")
	if state.GetStatus() != "running" {
		t.Errorf("expected running, got %q", state.GetStatus())
	}

	state.SetStatus("succeeded")
	if state.GetStatus() != "succeeded" {
		t.Errorf("expected succeeded, got %q", state.GetStatus())
	}
}

// TestRunState_Signals verifies signal delivery.
func TestRunState_Signals(t *testing.T) {
	state := engine.NewRunState("run-5", "tenant-1", "v1")

	// Create a signal waiter
	ch := state.WaitForSignal("approval:step-1")

	// Deliver the signal
	delivered := state.DeliverSignal("approval:step-1", map[string]any{"approved": true})
	if !delivered {
		t.Error("expected signal to be delivered")
	}

	// Read from channel
	value := <-ch
	m, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected map, got %T", value)
	}
	if m["approved"] != true {
		t.Errorf("expected approved=true, got %v", m["approved"])
	}

	// Delivering again should fail (waiter removed)
	delivered = state.DeliverSignal("approval:step-1", nil)
	if delivered {
		t.Error("expected second delivery to fail")
	}
}

// TestRunState_JournalAppend verifies in-memory journal appending.
func TestRunState_JournalAppend(t *testing.T) {
	state := engine.NewRunState("run-6", "tenant-1", "v1")

	state.AppendJournal(journal.JournalEntry{
		RunID: "run-6",
		Seq:   1,
		Kind:  journal.KindRunStarted,
	})
	state.AppendJournal(journal.JournalEntry{
		RunID:  "run-6",
		Seq:    2,
		Kind:   journal.KindStepStarted,
		StepID: "step-1",
	})

	state.Lock()
	count := len(state.Journal)
	state.Unlock()

	if count != 2 {
		t.Errorf("expected 2 journal entries, got %d", count)
	}
}

// TestReplayFromJournal_RunFailed verifies that a failed run status
// is correctly restored from the journal.
func TestReplayFromJournal_RunFailed(t *testing.T) {
	state := engine.NewRunState("run-7", "tenant-1", "v1")

	entries := []journal.JournalEntry{
		{RunID: "run-7", Seq: 1, Kind: journal.KindRunStarted},
		{RunID: "run-7", Seq: 2, Kind: journal.KindStepStarted, StepID: "s1", Attempt: 1},
		{RunID: "run-7", Seq: 3, Kind: journal.KindStepFailed, StepID: "s1", Attempt: 1,
			Payload: json.RawMessage(`{"step_id":"s1","attempt":1,"error":"boom"}`)},
		{RunID: "run-7", Seq: 4, Kind: journal.KindRunFailed},
	}

	state.ReplayFromJournal(entries)

	if state.GetStatus() != "failed" {
		t.Errorf("expected status=failed, got %q", state.GetStatus())
	}
}
