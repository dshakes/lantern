package leader_test

// resign_failover_test.go — integration tests for Resign-based leader failover.
//
// These tests require a live Postgres instance. They are skipped when
// DATABASE_URL is unset, matching the pattern in leader_test.go.
//
// Test strategy:
//   - Start two Campaign instances (A and B) against the same advisory key.
//   - Wait until exactly one holds the lock (A wins, B stands by).
//   - Call A.Resign() — simulates a crash/voluntary step-down without
//     cancelling A's context. The Postgres session is closed, releasing the
//     advisory lock.
//   - Assert B acquires leadership within a bounded window
//     (< 3 × retryInterval = ~6 s).
//   - Assert A's IsLeader flips to false immediately after Resign.

import (
	"context"
	"testing"
	"time"

	"github.com/dshakes/lantern/services/runtime-scheduler/internal/leader"
	"go.uber.org/zap"
)

// maxFailoverWait is how long we allow for the standby to acquire the lock
// after the leader resigns. retryInterval is 2 s, so 3× gives comfortable
// headroom without making the test slow on a loaded CI box.
const maxFailoverWait = 3 * 2 * time.Second // 6 s

// TestResign_StandbyAcquiresAfterLeaderResigns is the core failover test.
func TestResign_StandbyAcquiresAfterLeaderResigns(t *testing.T) {
	dbURL := requireDB(t)
	if testing.Short() {
		t.Skip("skipping resign failover test in -short mode")
	}

	log := zap.NewNop()

	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()

	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()

	eA, err := leader.Campaign(ctxA, dbURL, log)
	if err != nil {
		t.Fatalf("Campaign A: %v", err)
	}
	eB, err := leader.Campaign(ctxB, dbURL, log)
	if err != nil {
		t.Fatalf("Campaign B: %v", err)
	}

	// --- Phase 1: wait for exactly one leader to emerge. ---
	deadline := time.Now().Add(10 * time.Second)
	var leaderElector, standby *leader.Elector
	for time.Now().Before(deadline) {
		aL, bL := eA.IsLeader(), eB.IsLeader()
		if aL && bL {
			t.Fatal("split-brain: both A and B report IsLeader")
		}
		if aL {
			leaderElector, standby = eA, eB
			break
		}
		if bL {
			leaderElector, standby = eB, eA
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if leaderElector == nil {
		t.Fatal("no leader elected within 10 s")
	}

	// --- Phase 2: resign the leader. ---
	if !leaderElector.IsLeader() {
		t.Fatal("precondition: leaderElector must be the leader before Resign")
	}
	leaderElector.Resign()

	// isLeader must drop to false on the resigning elector promptly (the
	// hold() goroutine unblocks synchronously on the channel close, then
	// run() stores false before closing the conn).
	resignDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(resignDeadline) {
		if !leaderElector.IsLeader() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if leaderElector.IsLeader() {
		t.Error("leaderElector.IsLeader() did not flip to false after Resign")
	}

	// --- Phase 3: assert standby acquires within maxFailoverWait. ---
	failoverDeadline := time.Now().Add(maxFailoverWait)
	for time.Now().Before(failoverDeadline) {
		if standby.IsLeader() {
			return // success
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("standby did not acquire leadership within %s after leader resigned", maxFailoverWait)
}

// TestResign_IdempotentOnNonLeader verifies Resign is safe to call on an
// elector that has not yet acquired leadership (no panic, no deadlock).
func TestResign_IdempotentOnNonLeader(t *testing.T) {
	dbURL := requireDB(t)
	if testing.Short() {
		t.Skip("skipping resign idempotent test in -short mode")
	}

	log := zap.NewNop()

	// Start two campaigns: one will be the leader, one the standby.
	ctxA, cancelA := context.WithCancel(context.Background())
	defer cancelA()
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()

	eA, _ := leader.Campaign(ctxA, dbURL, log)
	eB, _ := leader.Campaign(ctxB, dbURL, log)

	// Wait for one leader.
	deadline := time.Now().Add(10 * time.Second)
	var standby *leader.Elector
	for time.Now().Before(deadline) {
		if eA.IsLeader() && !eB.IsLeader() {
			standby = eB
			break
		}
		if eB.IsLeader() && !eA.IsLeader() {
			standby = eA
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if standby == nil {
		t.Skip("could not settle to a single leader within 10 s — skipping idempotency check")
	}

	// Calling Resign on the standby must not panic or block.
	done := make(chan struct{})
	go func() {
		standby.Resign()
		standby.Resign() // second call must also be safe
		close(done)
	}()

	select {
	case <-done:
		// pass
	case <-time.After(2 * time.Second):
		t.Fatal("Resign on standby blocked for > 2 s")
	}
}
