package leader_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/dshakes/lantern/services/runtime-scheduler/internal/leader"
	"go.uber.org/zap"
)

// openDB skips the test when DATABASE_URL is unset or the DB is unreachable.
func requireDB(t *testing.T) string {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set — skipping leader election DB test")
	}
	return url
}

// TestAlwaysLeader verifies the no-DB path is always-leader.
func TestAlwaysLeader(t *testing.T) {
	e := leader.AlwaysLeader()
	if !e.IsLeader() {
		t.Fatal("AlwaysLeader.IsLeader() must return true")
	}
}

// TestCampaign_ExactlyOneLeader starts two Campaign instances against the same
// DATABASE_URL and asserts exactly one holds the lock within a short timeout.
// It then cancels the leader and asserts the standby acquires it.
func TestCampaign_ExactlyOneLeader(t *testing.T) {
	dbURL := requireDB(t)
	if testing.Short() {
		t.Skip("skipping leader election test in -short mode")
	}

	log := zap.NewNop()

	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()

	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()

	e1, err := leader.Campaign(ctx1, dbURL, log)
	if err != nil {
		t.Fatalf("Campaign e1: %v", err)
	}
	e2, err := leader.Campaign(ctx2, dbURL, log)
	if err != nil {
		t.Fatalf("Campaign e2: %v", err)
	}

	// Poll until one of them becomes leader (or timeout).
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		l1 := e1.IsLeader()
		l2 := e2.IsLeader()
		if l1 || l2 {
			// Exactly one must be the leader.
			if l1 && l2 {
				t.Fatalf("both e1 and e2 report IsLeader — split-brain")
			}
			// Good: exactly one leader.

			// Now cancel whichever is the leader; the other should acquire.
			var standby *leader.Elector
			if l1 {
				cancel1()
				standby = e2
			} else {
				cancel2()
				standby = e1
			}

			// Wait for the standby to acquire.
			deadline2 := time.Now().Add(15 * time.Second)
			for time.Now().Before(deadline2) {
				if standby.IsLeader() {
					return // success
				}
				time.Sleep(200 * time.Millisecond)
			}
			t.Fatal("standby did not acquire leader lock after leader was cancelled")
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("neither e1 nor e2 became leader within timeout")
}

// TestCampaign_CancelledContextReleasesLeader ensures that cancelling the leader
// context drives IsLeader to false before the function returns.
func TestCampaign_CancelledContextReleasesLeader(t *testing.T) {
	dbURL := requireDB(t)
	if testing.Short() {
		t.Skip("skipping leader election test in -short mode")
	}

	log := zap.NewNop()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	e, err := leader.Campaign(ctx, dbURL, log)
	if err != nil {
		t.Fatalf("Campaign: %v", err)
	}

	// Wait for it to acquire.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if e.IsLeader() {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !e.IsLeader() {
		t.Fatal("did not acquire leader lock within timeout")
	}

	// Cancel; within a short window IsLeader must flip to false.
	cancel()
	deadline2 := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline2) {
		if !e.IsLeader() {
			return // success
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("IsLeader did not flip to false after context cancellation")
}
