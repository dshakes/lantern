package journal_test

import (
	"encoding/json"
	"testing"

	"github.com/dshakes/lantern/services/workflow-engine/internal/journal"
)

// TestJournalEntry_Marshal verifies that JournalEntry can be round-tripped
// through JSON serialization, which is how entries are stored in the payload
// column and passed between services.
func TestJournalEntry_Marshal(t *testing.T) {
	entry := journal.JournalEntry{
		RunID:   "run-123",
		Seq:     5,
		Kind:    journal.KindStepCompleted,
		StepID:  "step-abc",
		Attempt: 1,
		Payload: json.RawMessage(`{"output": "hello"}`),
	}

	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded journal.JournalEntry
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.RunID != entry.RunID {
		t.Errorf("RunID mismatch: got %q, want %q", decoded.RunID, entry.RunID)
	}
	if decoded.Seq != entry.Seq {
		t.Errorf("Seq mismatch: got %d, want %d", decoded.Seq, entry.Seq)
	}
	if decoded.Kind != entry.Kind {
		t.Errorf("Kind mismatch: got %q, want %q", decoded.Kind, entry.Kind)
	}
	if decoded.StepID != entry.StepID {
		t.Errorf("StepID mismatch: got %q, want %q", decoded.StepID, entry.StepID)
	}
	if decoded.Attempt != entry.Attempt {
		t.Errorf("Attempt mismatch: got %d, want %d", decoded.Attempt, entry.Attempt)
	}
	// Normalize JSON whitespace for comparison
	var origCompact, decodedCompact json.RawMessage
	_ = json.Unmarshal(entry.Payload, &origCompact)
	_ = json.Unmarshal(decoded.Payload, &decodedCompact)
	origBytes, _ := json.Marshal(origCompact)
	decodedBytes, _ := json.Marshal(decodedCompact)
	if string(origBytes) != string(decodedBytes) {
		t.Errorf("Payload mismatch: got %s, want %s", decodedBytes, origBytes)
	}
}

// TestEventKinds verifies all kind constants are non-empty strings and unique.
func TestEventKinds(t *testing.T) {
	kinds := []string{
		journal.KindRunStarted,
		journal.KindStepStarted,
		journal.KindStepCompleted,
		journal.KindStepFailed,
		journal.KindSignalReceived,
		journal.KindSignalWaiting,
		journal.KindSleepStarted,
		journal.KindSleepCompleted,
		journal.KindApprovalRequested,
		journal.KindApprovalGranted,
		journal.KindApprovalDenied,
		journal.KindRunSucceeded,
		journal.KindRunFailed,
		journal.KindRunCancelled,
		journal.KindChildStarted,
		journal.KindChildCompleted,
	}

	seen := make(map[string]bool)
	for _, kind := range kinds {
		if kind == "" {
			t.Error("found empty kind constant")
		}
		if seen[kind] {
			t.Errorf("duplicate kind constant: %q", kind)
		}
		seen[kind] = true
	}

	// Verify the expected count
	if len(kinds) != 16 {
		t.Errorf("expected 16 kind constants, got %d", len(kinds))
	}
}

// TestJournalEntry_EmptyPayload ensures entries with nil/empty payloads still
// round-trip correctly.
func TestJournalEntry_EmptyPayload(t *testing.T) {
	entry := journal.JournalEntry{
		RunID:   "run-456",
		Seq:     1,
		Kind:    journal.KindRunStarted,
		Attempt: 0,
	}

	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded journal.JournalEntry
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.RunID != "run-456" {
		t.Errorf("RunID mismatch: got %q", decoded.RunID)
	}
	if decoded.Kind != journal.KindRunStarted {
		t.Errorf("Kind mismatch: got %q", decoded.Kind)
	}
}

// TestJournalEntry_PayloadTypes verifies that different payload shapes work.
func TestJournalEntry_PayloadTypes(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{"object", `{"key": "value"}`},
		{"array", `[1, 2, 3]`},
		{"string", `"hello"`},
		{"number", `42`},
		{"null", `null`},
		{"nested", `{"a": {"b": [1, {"c": true}]}}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entry := journal.JournalEntry{
				RunID:   "run-test",
				Seq:     1,
				Kind:    journal.KindStepCompleted,
				Payload: json.RawMessage(tt.payload),
			}

			data, err := json.Marshal(entry)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var decoded journal.JournalEntry
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			// Compact both for comparison (normalize whitespace)
			var origBuf, decodedBuf json.RawMessage
			if err := json.Unmarshal([]byte(tt.payload), &origBuf); err != nil {
				t.Fatalf("normalize original: %v", err)
			}
			if err := json.Unmarshal(decoded.Payload, &decodedBuf); err != nil {
				t.Fatalf("normalize decoded: %v", err)
			}

			orig, _ := json.Marshal(origBuf)
			dec, _ := json.Marshal(decodedBuf)

			if string(orig) != string(dec) {
				t.Errorf("payload mismatch: got %s, want %s", dec, orig)
			}
		})
	}
}
