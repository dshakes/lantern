package handlers

// spawn_ratelimit_test.go — table-driven tests for SpawnRateLimiter.
//
// All tests inject a synthetic clock so no test sleeps.

import (
	"testing"
	"time"
)

// makeTime returns a deterministic base time for tests.
func makeTime() time.Time {
	return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
}

// TestSpawnRateLimiter_BurstThenThrottled verifies that a tenant can use up
// the full burst and is then denied until tokens refill.
func TestSpawnRateLimiter_BurstThenThrottled(t *testing.T) {
	const burst = 5
	const ratePerMin = 60.0 // 1 token/s

	now := makeTime()
	clock := func() time.Time { return now }

	l := newSpawnRateLimiterWithClock(ratePerMin, burst, clock)
	defer l.Stop()

	// First burst tokens should all be allowed.
	for i := 0; i < burst; i++ {
		if !l.Allow("tenant-a") {
			t.Fatalf("expected Allow=true on call %d (burst not exhausted)", i+1)
		}
	}

	// Next call — bucket is empty — must be denied.
	if l.Allow("tenant-a") {
		t.Fatal("expected Allow=false after burst exhausted")
	}
}

// TestSpawnRateLimiter_RefillOverTime verifies that advancing the clock refills
// the bucket enough for new allows.
func TestSpawnRateLimiter_RefillOverTime(t *testing.T) {
	const burst = 2
	const ratePerMin = 60.0 // 1 token/s

	now := makeTime()
	clock := func() time.Time { return now }

	l := newSpawnRateLimiterWithClock(ratePerMin, burst, clock)
	defer l.Stop()

	// Drain the bucket.
	for i := 0; i < burst; i++ {
		if !l.Allow("tenant-b") {
			t.Fatalf("unexpected deny on initial burst call %d", i+1)
		}
	}
	if l.Allow("tenant-b") {
		t.Fatal("expected deny after burst exhausted")
	}

	// Advance clock by 2 seconds → 2 tokens refilled (rate=1/s).
	now = now.Add(2 * time.Second)

	if !l.Allow("tenant-b") {
		t.Fatal("expected Allow=true after 2s refill (1 token available)")
	}
	if !l.Allow("tenant-b") {
		t.Fatal("expected Allow=true after 2s refill (2nd token available)")
	}
	// Third allow still empty.
	if l.Allow("tenant-b") {
		t.Fatal("expected deny after consuming refilled tokens")
	}
}

// TestSpawnRateLimiter_PerTenantIsolation verifies that throttling one tenant
// does not affect another.
func TestSpawnRateLimiter_PerTenantIsolation(t *testing.T) {
	const burst = 3
	const ratePerMin = 60.0

	now := makeTime()
	clock := func() time.Time { return now }

	l := newSpawnRateLimiterWithClock(ratePerMin, burst, clock)
	defer l.Stop()

	// Drain tenant-x.
	for i := 0; i < burst; i++ {
		l.Allow("tenant-x") //nolint:errcheck
	}
	if l.Allow("tenant-x") {
		t.Fatal("tenant-x should be throttled")
	}

	// tenant-y is a fresh bucket; should still have full burst.
	for i := 0; i < burst; i++ {
		if !l.Allow("tenant-y") {
			t.Fatalf("tenant-y Allow=false on call %d — throttling should be per-tenant", i+1)
		}
	}
}

// TestSpawnRateLimiter_IdleEviction verifies that buckets idle beyond the
// eviction window are removed and re-created fresh on the next Allow call.
func TestSpawnRateLimiter_IdleEviction(t *testing.T) {
	const burst = 2
	const ratePerMin = 60.0

	now := makeTime()
	clock := func() time.Time { return now }

	l := newSpawnRateLimiterWithClock(ratePerMin, burst, clock)
	defer l.Stop()

	// Drain bucket for tenant-c.
	for i := 0; i < burst; i++ {
		l.Allow("tenant-c") //nolint:errcheck
	}
	if l.Allow("tenant-c") {
		t.Fatal("tenant-c should be throttled before eviction")
	}

	// Advance clock past idleEvict window.
	now = now.Add(idleEvict + time.Second)

	// Trigger eviction manually (simulates janitor firing).
	l.evictIdle()

	// Bucket should be gone; next Allow re-creates it full.
	if !l.Allow("tenant-c") {
		t.Fatal("expected Allow=true after idle eviction re-created the bucket")
	}
}

// TestSpawnRateLimiter_RefillRateIsExact pins the actual tokens-per-second
// rate so that the bug of multiplying by 60 instead of dividing is caught.
//
// Setup: rate=120/min (= 2 tokens/s), burst=200 (much larger than any refill
// we measure, so the capacity clamp never hides the real refill amount).
// Drain 10 tokens from the bucket, advance the clock 30 s, then drain again
// until denied — the number of extra allows must equal exactly 60 tokens
// (30 s × 2 tokens/s). Under the old buggy math (×60) the refill would be
// 30 × 120 × 60 = 216 000 tokens, so the bucket would immediately hit
// capacity (200) and we'd count 200 extra allows, not 60 — the assertion
// would fail, proving the test has teeth.
func TestSpawnRateLimiter_RefillRateIsExact(t *testing.T) {
	const ratePerMin = 120.0 // 2 tokens/s
	const burst = 200        // large enough that the clamp never fires during the test
	const drainFirst = 10    // initial drain so the bucket isn't at capacity
	const elapsedSec = 30
	const wantRefilled = int(ratePerMin / 60.0 * elapsedSec) // 2 tokens/s × 30 s = 60

	now := makeTime()
	clock := func() time.Time { return now }

	l := newSpawnRateLimiterWithClock(ratePerMin, burst, clock)
	defer l.Stop()

	// Drain drainFirst tokens to leave the bucket at (burst - drainFirst).
	for i := 0; i < drainFirst; i++ {
		if !l.Allow("tenant-rate") {
			t.Fatalf("unexpected deny on initial drain call %d", i+1)
		}
	}

	// Drain the remaining tokens to empty the bucket completely.
	remaining := burst - drainFirst
	for i := 0; i < remaining; i++ {
		if !l.Allow("tenant-rate") {
			t.Fatalf("unexpected deny draining remaining tokens, call %d", i+1)
		}
	}
	if l.Allow("tenant-rate") {
		t.Fatal("expected bucket to be empty after full drain")
	}

	// Advance the synthetic clock by elapsedSec seconds.
	now = now.Add(elapsedSec * time.Second)

	// Count exactly how many allows succeed (= tokens refilled).
	got := 0
	for l.Allow("tenant-rate") {
		got++
		if got > burst {
			t.Fatalf("refill produced more tokens than burst capacity (%d) — math is wrong", burst)
		}
	}

	if got != wantRefilled {
		t.Errorf("refill after %ds at %.0f tokens/min: got %d allows, want %d — refill math is wrong (old bug: ×60 instead of ÷60)",
			elapsedSec, ratePerMin, got, wantRefilled)
	}
}

// TestSpawnRateLimiter_EnvDefaults exercises NewSpawnRateLimiter to confirm
// it constructs without panicking and defaults apply.
func TestSpawnRateLimiter_EnvDefaults(t *testing.T) {
	t.Setenv("LANTERN_SPAWN_RATE_PER_MIN", "")
	t.Setenv("LANTERN_SPAWN_BURST", "")

	l := NewSpawnRateLimiter()
	defer l.Stop()

	// With default burst=20, first 20 calls should be allowed.
	for i := 0; i < defaultSpawnBurst; i++ {
		if !l.Allow("tenant-default") {
			t.Fatalf("expected Allow=true on burst call %d with default burst=%d", i+1, defaultSpawnBurst)
		}
	}
	if l.Allow("tenant-default") {
		t.Fatal("expected deny after default burst exhausted")
	}
}
