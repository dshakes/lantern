package handlers

import (
	"net"
	"testing"
	"time"

	"go.uber.org/zap"
)

// TestProbeTracker exercises the pure debounce/transition state machine.
// No sockets, no goroutines — table-driven so each case names exactly
// which invariant it checks.
func TestProbeTracker(t *testing.T) {
	tests := []struct {
		name       string
		sequence   []bool   // probe results in order (true=ok, false=fail)
		wantTrans  []string // expected transition string per step
		wantDeclUp bool     // expected declaredUp after all steps
	}{
		{
			name:       "steady up — no transition",
			sequence:   []bool{true, true, true},
			wantTrans:  []string{"", "", ""},
			wantDeclUp: true,
		},
		{
			name:       "threshold not crossed — 2 failures, no alert",
			sequence:   []bool{false, false},
			wantTrans:  []string{"", ""},
			wantDeclUp: true, // still assumed up
		},
		{
			name:       "exactly at threshold — 3 failures → down",
			sequence:   []bool{false, false, false},
			wantTrans:  []string{"", "", "down"},
			wantDeclUp: false,
		},
		{
			name:       "past threshold — 4th failure is silent (already down)",
			sequence:   []bool{false, false, false, false},
			wantTrans:  []string{"", "", "down", ""},
			wantDeclUp: false,
		},
		{
			name:       "recovery after down",
			sequence:   []bool{false, false, false, true},
			wantTrans:  []string{"", "", "down", "up"},
			wantDeclUp: true,
		},
		{
			name:       "second recovery is silent",
			sequence:   []bool{false, false, false, true, true},
			wantTrans:  []string{"", "", "down", "up", ""},
			wantDeclUp: true,
		},
		{
			name:     "failure reset after partial run",
			sequence: []bool{false, false, true, false, false, false},
			// Two failures, then a success resets counter, then three more → down
			wantTrans:  []string{"", "", "", "", "", "down"},
			wantDeclUp: false,
		},
		{
			name:       "consecutive down→up→down cycle",
			sequence:   []bool{false, false, false, true, false, false, false},
			wantTrans:  []string{"", "", "down", "up", "", "", "down"},
			wantDeclUp: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			tracker := newProbeTracker()
			for i, ok := range tc.sequence {
				got := tracker.observe(ok)
				want := tc.wantTrans[i]
				if got != want {
					t.Errorf("step %d (ok=%v): transition=%q, want %q", i, ok, got, want)
				}
			}
			if tracker.declaredUp != tc.wantDeclUp {
				t.Errorf("final declaredUp=%v, want %v", tracker.declaredUp, tc.wantDeclUp)
			}
		})
	}
}

// TestProbeTracker_LastTransitionSet checks that lastTransition is stamped
// on each transition and lastChecked is updated on every call.
func TestProbeTracker_LastTransitionSet(t *testing.T) {
	tracker := newProbeTracker()
	zero := time.Time{}

	if tracker.lastTransition != zero {
		t.Fatal("lastTransition should be zero on construction")
	}

	// Two failures — no transition yet.
	tracker.observe(false)
	tracker.observe(false)
	if tracker.lastTransition != zero {
		t.Error("lastTransition should still be zero before threshold")
	}
	if tracker.lastChecked == zero {
		t.Error("lastChecked should be set after observe")
	}

	// Third failure — transition to down.
	before := time.Now()
	tracker.observe(false)
	after := time.Now()
	if tracker.lastTransition.Before(before) || tracker.lastTransition.After(after) {
		t.Errorf("lastTransition=%v should be between %v and %v", tracker.lastTransition, before, after)
	}

	// Success — transition to up.
	before = time.Now()
	tracker.observe(true)
	after = time.Now()
	if tracker.lastTransition.Before(before) || tracker.lastTransition.After(after) {
		t.Errorf("lastTransition=%v should be between %v and %v", tracker.lastTransition, before, after)
	}
}

// TestTCPProbe_DetectsDownAndUp opens a real listener, confirms tcpProbe
// returns true, then closes it and confirms tcpProbe returns false.
// This validates the TCP dial path end-to-end without any gRPC machinery.
func TestTCPProbe_DetectsDownAndUp(t *testing.T) {
	// Start a real listener on a random port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("could not start listener: %v", err)
	}
	addr := ln.Addr().String()

	// Service is up — probe should succeed.
	if !tcpProbe(addr) {
		t.Errorf("tcpProbe(%q) = false, want true while listener is up", addr)
	}

	// Close the listener — probe should now fail.
	ln.Close()

	// Retry with a short deadline so the test does not hang 3 s on every
	// CI run (DialTimeout already caps at 3 s, which is fine for real usage
	// but slow for a unit test; we use a wrapper here instead of altering
	// production code).
	const maxWait = 5 * time.Second
	deadline := time.Now().Add(maxWait)
	var down bool
	for time.Now().Before(deadline) {
		if !tcpProbe(addr) {
			down = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !down {
		t.Errorf("tcpProbe(%q) still true after listener closed", addr)
	}
}

// TestHealthSweeper_SnapshotReflectsState creates a sweeper with a fake
// address that can never connect and confirms the snapshot correctly reports
// the declared state after enough failures.
func TestHealthSweeper_SnapshotReflectsState(t *testing.T) {
	// Swap sendSelfNote so no real bridge call fires.
	orig := sendSelfNote
	sendSelfNote = func(_, _ string) error { return nil }
	defer func() { sendSelfNote = orig }()

	logger := zap.NewNop()
	hs := &HealthSweeper{
		logger: logger,
		services: []serviceEntry{
			{name: "fake", addr: "127.0.0.1:1", tracker: newProbeTracker()},
		},
	}

	// Before any tick the snapshot shows "assumed up".
	snap := hs.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("want 1 service in snapshot, got %d", len(snap))
	}
	if !snap[0].Up {
		t.Error("initial snapshot should show Up=true (assumed up)")
	}

	// Three ticks against an unreachable address → should declare down.
	for i := 0; i < downThreshold; i++ {
		hs.tick()
	}
	snap = hs.Snapshot()
	if snap[0].Up {
		t.Error("snapshot should show Up=false after 3 failed probes")
	}
	if snap[0].ConsecutiveFailures < downThreshold {
		t.Errorf("consecutiveFailures=%d, want >= %d", snap[0].ConsecutiveFailures, downThreshold)
	}
	if snap[0].LastTransition.IsZero() {
		t.Error("lastTransition should be set after down transition")
	}
}
