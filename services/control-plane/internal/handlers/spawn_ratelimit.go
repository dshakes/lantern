package handlers

// spawn_ratelimit.go — per-tenant token-bucket rate limiter for spawn storms.
//
// Controls the rate at which a single tenant can trigger run-creation and
// runtime-schedule operations. In-memory; buckets are lazily created and
// evicted after idleEvict of inactivity by a background janitor.
//
// Configuration (env vars):
//
//	LANTERN_SPAWN_RATE_PER_MIN  tokens refilled per minute (default 120)
//	LANTERN_SPAWN_BURST         maximum burst size       (default 20)
//
// Wired into main.go (NewSpawnRateLimiter) and called via Allow(tenantID) in
// the CreateRun and runtime Schedule handlers; returns HTTP 429 when denied.

import (
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	defaultSpawnRatePerMin = 120
	defaultSpawnBurst      = 20

	// idleEvict is how long a bucket must be idle before the janitor removes it.
	idleEvict = 5 * time.Minute
	// janitorInterval controls how often the janitor sweeps stale buckets.
	janitorInterval = 2 * time.Minute
)

// tokenBucket is a simple token-bucket for one tenant.
type tokenBucket struct {
	tokens   float64
	capacity float64   // == burst size
	rate     float64   // tokens per minute
	lastUsed time.Time // last Allow call (for idle-eviction)
}

// allow attempts to consume one token. The caller MUST hold the parent mu.
func (b *tokenBucket) allow(now time.Time) bool {
	elapsed := now.Sub(b.lastUsed)
	b.lastUsed = now

	// Refill: rate is tokens/min; divide by 60 to get tokens/sec, then
	// multiply by elapsed seconds.  Do NOT multiply — that would be 3600× too
	// permissive and defeat the guard entirely.
	b.tokens += elapsed.Seconds() * (b.rate / 60.0)
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// SpawnRateLimiter is a per-tenant token-bucket rate limiter. Create it with
// NewSpawnRateLimiter; call Allow(tenantID) before every spawn operation.
// It is safe for concurrent use.
type SpawnRateLimiter struct {
	mu          sync.Mutex
	buckets     map[string]*tokenBucket
	ratePerMin  float64
	burst       float64
	now         func() time.Time // injectable for tests
	stopJanitor chan struct{}
}

// NewSpawnRateLimiter constructs a SpawnRateLimiter reading configuration from
// LANTERN_SPAWN_RATE_PER_MIN and LANTERN_SPAWN_BURST. It starts a background
// janitor that evicts idle buckets; Stop() shuts it down.
func NewSpawnRateLimiter() *SpawnRateLimiter {
	rate := float64(envIntOrDefault("LANTERN_SPAWN_RATE_PER_MIN", defaultSpawnRatePerMin))
	burst := float64(envIntOrDefault("LANTERN_SPAWN_BURST", defaultSpawnBurst))
	return newSpawnRateLimiterWithClock(rate, burst, time.Now)
}

// newSpawnRateLimiterWithClock is the internal constructor used by tests to
// inject a synthetic clock so tests never need to sleep.
func newSpawnRateLimiterWithClock(ratePerMin, burst float64, now func() time.Time) *SpawnRateLimiter {
	l := &SpawnRateLimiter{
		buckets:     make(map[string]*tokenBucket),
		ratePerMin:  ratePerMin,
		burst:       burst,
		now:         now,
		stopJanitor: make(chan struct{}),
	}
	go l.runJanitor()
	return l
}

// Allow reports whether the tenant may perform one spawn operation right now.
// Returns false when the bucket is exhausted (caller should return HTTP 429).
func (l *SpawnRateLimiter) Allow(tenantID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[tenantID]
	if !ok {
		// Lazy-create; new bucket starts full.
		b = &tokenBucket{
			tokens:   l.burst,
			capacity: l.burst,
			rate:     l.ratePerMin,
			lastUsed: l.now(),
		}
		l.buckets[tenantID] = b
	}
	return b.allow(l.now())
}

// Stop shuts down the background janitor goroutine. Safe to call multiple times.
func (l *SpawnRateLimiter) Stop() {
	select {
	case <-l.stopJanitor:
		// already stopped
	default:
		close(l.stopJanitor)
	}
}

// runJanitor periodically evicts buckets that have been idle for idleEvict.
func (l *SpawnRateLimiter) runJanitor() {
	ticker := time.NewTicker(janitorInterval)
	defer ticker.Stop()
	for {
		select {
		case <-l.stopJanitor:
			return
		case <-ticker.C:
			l.evictIdle()
		}
	}
}

func (l *SpawnRateLimiter) evictIdle() {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, b := range l.buckets {
		if now.Sub(b.lastUsed) > idleEvict {
			delete(l.buckets, id)
		}
	}
}

// envIntOrDefault reads an integer from an environment variable, returning
// fallback when the variable is unset or non-numeric.
func envIntOrDefault(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
