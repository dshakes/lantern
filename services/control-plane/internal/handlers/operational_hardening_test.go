package handlers

// operational_hardening_test.go — tests for GA operational-hardening items:
//
//   Item 2: graceful drain (DrainInFlightRuns WaitGroup)
//   Item 3: retention janitor sweep queries
//   Item 4: Redis-backed distributed spawn rate limiter + fallback

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// -----------------------------------------------------------------------
// Item 2 — DrainInFlightRuns
// -----------------------------------------------------------------------

func TestDrainInFlightRuns_WaitsForGoroutine(t *testing.T) {
	h := &RESTHandler{}

	started := make(chan struct{})
	release := make(chan struct{})

	h.inFlightRuns.Add(1)
	go func() {
		defer h.inFlightRuns.Done()
		close(started)
		<-release // block until test releases
	}()

	<-started // goroutine is in flight

	drained := make(chan struct{})
	go func() {
		h.DrainInFlightRuns(5 * time.Second)
		close(drained)
	}()

	// DrainInFlightRuns should NOT return while goroutine holds the WaitGroup.
	select {
	case <-drained:
		t.Fatal("DrainInFlightRuns returned before goroutine finished")
	case <-time.After(50 * time.Millisecond):
		// expected: still waiting
	}

	close(release) // let the goroutine finish

	select {
	case <-drained:
		// expected
	case <-time.After(2 * time.Second):
		t.Fatal("DrainInFlightRuns did not return after goroutine finished")
	}
}

func TestDrainInFlightRuns_TimeoutReturns(t *testing.T) {
	h := &RESTHandler{}

	h.inFlightRuns.Add(1)
	// Goroutine never calls Done → simulates a run that exceeds the timeout.
	go func() {
		time.Sleep(10 * time.Second) // far longer than the drain timeout
		h.inFlightRuns.Done()
	}()

	start := time.Now()
	h.DrainInFlightRuns(50 * time.Millisecond)
	elapsed := time.Since(start)

	// Should return promptly after the timeout, not after 10 seconds.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("DrainInFlightRuns took %v; expected ~50ms timeout", elapsed)
	}
}

func TestDrainInFlightRuns_NoGoRoutines_ReturnsImmediately(t *testing.T) {
	h := &RESTHandler{}
	start := time.Now()
	h.DrainInFlightRuns(5 * time.Second)
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("DrainInFlightRuns with no in-flight goroutines took too long")
	}
}

func TestInFlightWaitGroup_IncrementedAndDecremented(t *testing.T) {
	// Verify that the WaitGroup counter tracks goroutine lifecycle correctly.
	h := &RESTHandler{}
	var counter int64

	const n = 5
	for i := 0; i < n; i++ {
		h.inFlightRuns.Add(1)
		go func() {
			defer h.inFlightRuns.Done()
			atomic.AddInt64(&counter, 1)
		}()
	}

	h.DrainInFlightRuns(2 * time.Second)

	if atomic.LoadInt64(&counter) != n {
		t.Fatalf("expected %d goroutines to complete, got %d", n, counter)
	}
}

// -----------------------------------------------------------------------
// Item 3 — retention janitor sweep queries (pure-logic, no DB)
// -----------------------------------------------------------------------

func TestRetentionDays_Default(t *testing.T) {
	cases := []struct {
		env      string
		fallback int
	}{
		{envJournalRetentionDays, defaultJournalRetentionDays},
		{envAuditRetentionDays, defaultAuditRetentionDays},
		{envUsageDailyRetentionDays, defaultUsageDailyRetentionDays},
	}
	for _, tc := range cases {
		t.Run(tc.env, func(t *testing.T) {
			t.Setenv(tc.env, "")
			got := retentionDays(tc.env, tc.fallback)
			if got != tc.fallback {
				t.Errorf("expected default %d, got %d", tc.fallback, got)
			}
		})
	}
}

func TestRetentionDays_EnvOverride(t *testing.T) {
	t.Setenv(envJournalRetentionDays, "180")
	got := retentionDays(envJournalRetentionDays, defaultJournalRetentionDays)
	if got != 180 {
		t.Fatalf("expected 180, got %d", got)
	}
}

func TestRetentionDays_InvalidFallsBack(t *testing.T) {
	t.Setenv(envJournalRetentionDays, "banana")
	got := retentionDays(envJournalRetentionDays, defaultJournalRetentionDays)
	if got != defaultJournalRetentionDays {
		t.Fatalf("expected default %d, got %d", defaultJournalRetentionDays, got)
	}
}

func TestRetentionDays_ZeroFallsBack(t *testing.T) {
	t.Setenv(envJournalRetentionDays, "0")
	got := retentionDays(envJournalRetentionDays, defaultJournalRetentionDays)
	if got != defaultJournalRetentionDays {
		t.Fatalf("expected default %d for zero, got %d", defaultJournalRetentionDays, got)
	}
}

// -----------------------------------------------------------------------
// Item 4 — Redis-backed spawn rate limiter
// -----------------------------------------------------------------------

// fakeRedis is a minimal in-process implementation of spawnRedisClient for
// testing without a real Redis server or the miniredis dependency.
type fakeRedis struct {
	mu      sync.Mutex
	counts  map[string]int64
	failAll bool // when true every Incr returns an error
}

func newFakeRedis() *fakeRedis {
	return &fakeRedis{counts: make(map[string]int64)}
}

// fakeIntCmd carries the result of an Incr call.
type fakeIntCmd struct {
	val int64
	err error
}

func (c *fakeIntCmd) Result() (int64, error) { return c.val, c.err }

// fakeBoolCmd carries the result of an Expire call.
type fakeBoolCmd struct{}

func (c *fakeBoolCmd) Err() error { return nil }

func (f *fakeRedis) Incr(_ context.Context, key string) *redis.IntCmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAll {
		// Return an error command — use a real *redis.IntCmd that carries an
		// error via the standard constructor.
		cmd := redis.NewIntCmd(context.Background())
		cmd.SetErr(context.DeadlineExceeded)
		return cmd
	}
	f.counts[key]++
	cmd := redis.NewIntCmd(context.Background())
	cmd.SetVal(f.counts[key])
	return cmd
}

func (f *fakeRedis) Expire(_ context.Context, _ string, _ time.Duration) *redis.BoolCmd {
	cmd := redis.NewBoolCmd(context.Background())
	cmd.SetVal(true)
	return cmd
}

func TestSpawnRateLimiter_Redis_AllowsUnderLimit(t *testing.T) {
	rdb := newFakeRedis()
	l := newSpawnRateLimiterWithClock(5, 5, time.Now)
	l.SetRedis(rdb)

	for i := 0; i < 5; i++ {
		if !l.Allow("tenant-a") {
			t.Fatalf("expected allow on attempt %d", i+1)
		}
	}
	l.Stop()
}

func TestSpawnRateLimiter_Redis_DeniesOverLimit(t *testing.T) {
	rdb := newFakeRedis()
	l := newSpawnRateLimiterWithClock(3, 3, time.Now)
	l.SetRedis(rdb)

	for i := 0; i < 3; i++ {
		if !l.Allow("tenant-b") {
			t.Fatalf("expected allow on attempt %d", i+1)
		}
	}
	if l.Allow("tenant-b") {
		t.Fatal("expected deny on 4th attempt (over limit of 3)")
	}
	l.Stop()
}

func TestSpawnRateLimiter_Redis_TenantsAreIsolated(t *testing.T) {
	rdb := newFakeRedis()
	l := newSpawnRateLimiterWithClock(2, 2, time.Now)
	l.SetRedis(rdb)
	defer l.Stop()

	// Exhaust tenant-x
	l.Allow("tenant-x")
	l.Allow("tenant-x")
	if l.Allow("tenant-x") {
		t.Fatal("tenant-x should be denied")
	}

	// tenant-y is independent — should still be allowed.
	if !l.Allow("tenant-y") {
		t.Fatal("tenant-y should be allowed (separate bucket)")
	}
}

func TestSpawnRateLimiter_FallsBackToMemoryOnRedisError(t *testing.T) {
	rdb := newFakeRedis()
	rdb.failAll = true

	l := newSpawnRateLimiterWithClock(100, 100, time.Now)
	l.SetRedis(rdb)
	defer l.Stop()

	// With Redis failing, in-memory limiter takes over. 100 burst → all allowed.
	for i := 0; i < 10; i++ {
		if !l.Allow("tenant-c") {
			t.Fatalf("expected in-memory fallback to allow on attempt %d", i+1)
		}
	}
}

func TestSpawnRateLimiter_NoRedis_InMemory(t *testing.T) {
	// No Redis wired — pure in-memory path.
	l := newSpawnRateLimiterWithClock(3, 3, time.Now)
	defer l.Stop()

	for i := 0; i < 3; i++ {
		if !l.Allow("t1") {
			t.Fatalf("expected allow on attempt %d", i+1)
		}
	}
	if l.Allow("t1") {
		t.Fatal("expected deny on 4th in-memory attempt")
	}
}
