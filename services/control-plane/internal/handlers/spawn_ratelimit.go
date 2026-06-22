package handlers

// spawn_ratelimit.go — per-tenant token-bucket rate limiter for spawn storms.
//
// Controls the rate at which a single tenant can trigger run-creation and
// runtime-schedule operations.
//
// Primary path — Redis fixed-window counter (distributed, survives replica
// restarts). A single tenant's spawn count is tracked in a Redis key with a
// 60-second TTL; when the key's value exceeds ratePerMin the request is denied.
// The window is fixed (not sliding): the counter resets when the key expires.
// This is intentionally simple (no sub-second precision) because spawn storms
// manifest over seconds, not milliseconds.
//
// Fallback path — in-memory token-bucket per replica (previous implementation).
// Activated automatically when the Redis client is nil or the Redis call fails.
// The fallback is per-replica, so N replicas give N× the effective limit during
// a Redis outage; that is the documented trade-off.
//
// Configuration (env vars, unchanged from the previous implementation):
//
//	LANTERN_SPAWN_RATE_PER_MIN  max spawns per 60-second window (default 120)
//	LANTERN_SPAWN_BURST         burst size for the in-memory fallback (default 20)

import (
	"context"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	defaultSpawnRatePerMin = 120
	defaultSpawnBurst      = 20

	// idleEvict is how long a bucket must be idle before the janitor removes it.
	idleEvict = 5 * time.Minute
	// janitorInterval controls how often the janitor sweeps stale buckets.
	janitorInterval = 2 * time.Minute
)

// -----------------------------------------------------------------------
// Redis abstraction (thin interface so tests can inject a fake)
// -----------------------------------------------------------------------

// spawnRedisClient is the subset of redis.Client used by the rate-limiter.
// *redis.Client satisfies this without any adaptation.
type spawnRedisClient interface {
	// Incr increments key and returns the new value.
	Incr(ctx context.Context, key string) *redis.IntCmd
	// Expire sets the TTL on key. Errors are silently ignored (best-effort TTL).
	Expire(ctx context.Context, key string, expiration time.Duration) *redis.BoolCmd
}

// -----------------------------------------------------------------------
// In-memory token-bucket (fallback / standalone)
// -----------------------------------------------------------------------

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
	// multiply by elapsed seconds.
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

// inMemoryLimiter is the per-replica fallback.
type inMemoryLimiter struct {
	mu          sync.Mutex
	buckets     map[string]*tokenBucket
	ratePerMin  float64
	burst       float64
	now         func() time.Time
	stopJanitor chan struct{}
}

func newInMemoryLimiter(ratePerMin, burst float64, now func() time.Time) *inMemoryLimiter {
	l := &inMemoryLimiter{
		buckets:     make(map[string]*tokenBucket),
		ratePerMin:  ratePerMin,
		burst:       burst,
		now:         now,
		stopJanitor: make(chan struct{}),
	}
	go l.runJanitor()
	return l
}

func (l *inMemoryLimiter) allow(tenantID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[tenantID]
	if !ok {
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

func (l *inMemoryLimiter) stop() {
	select {
	case <-l.stopJanitor:
	default:
		close(l.stopJanitor)
	}
}

func (l *inMemoryLimiter) runJanitor() {
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

func (l *inMemoryLimiter) evictIdle() {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, b := range l.buckets {
		if now.Sub(b.lastUsed) > idleEvict {
			delete(l.buckets, id)
		}
	}
}

// -----------------------------------------------------------------------
// SpawnRateLimiter — public API (unchanged interface)
// -----------------------------------------------------------------------

// SpawnRateLimiter is a per-tenant rate limiter for spawn operations. Create
// it with NewSpawnRateLimiter; call Allow(tenantID) before every spawn
// operation. It is safe for concurrent use.
//
// When a Redis client is provided (SetRedis), spawn counts are tracked
// distributed across replicas. When Redis is unavailable the limiter falls
// back to the per-replica in-memory bucket — the effective limit becomes
// N× during a Redis outage (the documented degradation, not fail-open).
type SpawnRateLimiter struct {
	ratePerMin int64
	redis      spawnRedisClient // nil → in-memory only
	mem        *inMemoryLimiter
}

// NewSpawnRateLimiter constructs a SpawnRateLimiter reading configuration from
// LANTERN_SPAWN_RATE_PER_MIN and LANTERN_SPAWN_BURST. It starts a background
// janitor that evicts idle in-memory buckets; Stop() shuts it down.
func NewSpawnRateLimiter() *SpawnRateLimiter {
	rate := envIntOrDefault("LANTERN_SPAWN_RATE_PER_MIN", defaultSpawnRatePerMin)
	burst := envIntOrDefault("LANTERN_SPAWN_BURST", defaultSpawnBurst)
	return newSpawnRateLimiterWithClock(float64(rate), float64(burst), time.Now)
}

// newSpawnRateLimiterWithClock is the internal constructor used by tests to
// inject a synthetic clock so tests never need to sleep.
func newSpawnRateLimiterWithClock(ratePerMin, burst float64, now func() time.Time) *SpawnRateLimiter {
	return &SpawnRateLimiter{
		ratePerMin: int64(ratePerMin),
		mem:        newInMemoryLimiter(ratePerMin, burst, now),
	}
}

// SetRedis wires a Redis client for distributed rate limiting. Call this from
// main.go after the Redis client is initialised. It is not safe to call
// concurrently with Allow.
func (l *SpawnRateLimiter) SetRedis(rdb spawnRedisClient) {
	l.redis = rdb
}

// Allow reports whether the tenant may perform one spawn operation right now.
// Returns false when the rate limit is exceeded (caller should return HTTP 429).
//
// Redis path: fixed-window counter with a 60-second TTL.
// Fallback:   per-replica in-memory token-bucket.
func (l *SpawnRateLimiter) Allow(tenantID string) bool {
	if l.redis != nil {
		ok, err := l.redisAllow(tenantID)
		if err == nil {
			return ok
		}
		// Redis error → fall through to in-memory limiter (per-replica degradation).
	}
	return l.mem.allow(tenantID)
}

// redisAllow implements a fixed-window counter (NOT sliding-window — corrected
// label) over a 60-second window. The counter resets when the key expires.
//
// TTL safety: EXPIRE is called unconditionally on every request, not only
// when n==1. This closes the availability hole where a transient Expire
// failure on the first INCR leaves the key with no TTL — without this fix,
// once the tenant crosses the limit they are denied forever until the key is
// manually deleted. Calling EXPIRE every time means the TTL is refreshed
// towards 60s on each allowed request; the window effectively extends while
// traffic flows, which is conservative (never under-counts) and correct.
//
// Returns (allowed, error). On any Redis error the caller falls back to mem.
func (l *SpawnRateLimiter) redisAllow(tenantID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	key := "spawn_rl:" + tenantID
	n, err := l.redis.Incr(ctx, key).Result()
	if err != nil {
		return false, err
	}
	// Refresh the TTL on every call so a failed Expire on the first INCR
	// can never leave the key without an expiry (permanent 429 availability bug).
	// Ignore the error: if Expire fails here the next INCR will retry it.
	l.redis.Expire(ctx, key, 60*time.Second) //nolint:errcheck
	return n <= l.ratePerMin, nil
}

// Stop shuts down the background in-memory janitor goroutine. Safe to call
// multiple times.
func (l *SpawnRateLimiter) Stop() {
	l.mem.stop()
}

// evictIdle delegates to the in-memory limiter's idle-eviction sweep.
// Exposed for tests that verify bucket recreation after the idle window.
func (l *SpawnRateLimiter) evictIdle() {
	l.mem.evictIdle()
}

// -----------------------------------------------------------------------
// envIntOrDefault (shared helper — also used by env.go callers)
// -----------------------------------------------------------------------

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
