package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"go.uber.org/zap"
)

// TestExecuteChildRun_Unavailable verifies a child_run step fails with the
// typed ErrChildRunUnavailable instead of fabricating a child completion
// (regression: it used to journal a fake child_started/child_completed pair
// and return "[child run placeholder for agent=...]").
func TestExecuteChildRun_Unavailable(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	state := NewRunState("run-1", "tenant-1", "v1")

	out, err := se.executeChildRun(context.Background(), state, "step-1", "run-1:step-1:1", json.RawMessage(`{"agent_name":"researcher"}`))
	if !errors.Is(err, ErrChildRunUnavailable) {
		t.Fatalf("err = %v, want ErrChildRunUnavailable", err)
	}
	if out != nil {
		t.Fatalf("out = %s, want nil (no fabricated output)", out)
	}
	if !strings.Contains(err.Error(), "researcher") {
		t.Errorf("error should name the agent: %v", err)
	}
	if got := len(state.Journal); got != 0 {
		t.Errorf("journal entries = %d, want 0 (no fake child events)", got)
	}
}

// TestExecuteChildRun_InvalidPayload rejects malformed payloads before dispatch.
func TestExecuteChildRun_InvalidPayload(t *testing.T) {
	se := NewStepExecutor(nil, nil, zap.NewNop(), nil, nil)
	state := NewRunState("run-1", "tenant-1", "v1")

	if _, err := se.executeChildRun(context.Background(), state, "step-1", "k", json.RawMessage(`{`)); err == nil {
		t.Fatal("expected error for malformed payload")
	}
}
