package handlers

// confidence_calibration.go — outcome-calibrated confidence gate support.
//
// Reads historical regret signals (auto-executed gated steps that ended in
// thumbs-down feedback or run failure) back from the DB and lowers the
// confidence score for node types that have burned the user.
//
// Feature is OFF by default (LANTERN_CONFIDENCE_CALIBRATE unset).
// Opt-in; fail-safe everywhere — any error returns 0 (no calibration).

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/workflow"
)

// regretCacheTTL is how long a regret-rate lookup is cached per (tenant, agent, nodeType).
const regretCacheTTL = 5 * time.Minute

// regretMinSamples is the minimum number of auto-executed gated steps required
// before calibration is applied. Below this threshold no calibration occurs to
// avoid small-sample instability.
// ponytail: 3 is conservative; raise to 10+ if false positives are a concern.
const regretMinSamples = 3

// regretCacheMaxEntries bounds the in-memory cache. Keyed by
// (tenant, agent, node_type); harmless in a single-tenant deployment but must
// not grow unbounded in a multi-tenant rollout (the TTL never reclaims space).
const regretCacheMaxEntries = 10000

// regretCacheKey identifies a unique (tenant, agent, nodeType) combination.
type regretCacheKey struct {
	tenantID  string
	agentName string
	nodeType  string
}

type regretCacheEntry struct {
	rate      float64
	expiresAt time.Time
}

// regretCache is a short-TTL in-memory cache of computed regret rates.
// Shared across all runs in the process — safe for concurrent access.
type regretCache struct {
	mu    sync.RWMutex
	items map[regretCacheKey]regretCacheEntry
}

// ponytail: process-level global cache; per-handler field if isolation needed.
var globalRegretCache = &regretCache{items: make(map[regretCacheKey]regretCacheEntry)}

// get returns the regret rate for (tenantID, agentName, nodeType), using the
// cache when fresh and querying the DB otherwise. Returns 0 on any error (fail-safe).
func (rc *regretCache) get(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, agentName, nodeType string,
	logger *zap.Logger,
) float64 {
	key := regretCacheKey{tenantID, agentName, nodeType}

	rc.mu.RLock()
	entry, ok := rc.items[key]
	rc.mu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.rate
	}

	rate := queryRegretRate(ctx, pool, tenantID, agentName, nodeType, logger)

	rc.mu.Lock()
	// Bound memory: the TTL never reclaims space on its own (stale entries sit
	// until re-fetched). At capacity, sweep expired entries; if still full, skip
	// caching this one — the value is still returned, just recomputed next time.
	if len(rc.items) >= regretCacheMaxEntries {
		now := time.Now()
		for k, e := range rc.items {
			if now.After(e.expiresAt) {
				delete(rc.items, k)
			}
		}
		if len(rc.items) >= regretCacheMaxEntries {
			rc.mu.Unlock()
			return rate
		}
	}
	rc.items[key] = regretCacheEntry{rate: rate, expiresAt: time.Now().Add(regretCacheTTL)}
	rc.mu.Unlock()

	return rate
}

// queryRegretRate queries journal_events + run_feedback + runs to compute
// the fraction of auto-executed gated steps (decision="execute") that were a
// genuine regret: the SAME step later failed (a step_failed event for the same
// (run_id, step_id)), OR the run received a thumbs-down (run_feedback.score ≤ 2).
//
// Regret is attributed per STEP, not per run: a run that fails at step 7 for an
// unrelated reason must not mark steps 1–6's auto-executions as regrets, which
// would progressively over-tighten the gate on innocent node types. Only a
// step whose own execution failed counts (plus the run-level thumbs-down, which
// is a deliberate global dissatisfaction signal).
//
// Tenant isolation is enforced via db.WithTenantConn (sets app.tenant_id);
// the RLS policies on runs/agents/run_feedback ensure cross-tenant reads
// are impossible. journal_events is RLS-exempt but is filtered implicitly
// through the JOIN with the tenant-scoped runs table.
//
// Returns 0 on any error or insufficient sample count (fail-safe).
func queryRegretRate(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, agentName, nodeType string,
	logger *zap.Logger,
) float64 {
	var total, regrets int64

	err := db.WithTenantConn(ctx, pool, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT
				COUNT(*) AS total,
				COUNT(*) FILTER (
					WHERE EXISTS (
					          SELECT 1
					          FROM   journal_events sf
					          WHERE  sf.run_id  = je.run_id
					            AND  sf.step_id = je.step_id
					            AND  sf.kind    = 'step_failed'
					      )
					   OR EXISTS (
					          SELECT 1
					          FROM   run_feedback f
					          WHERE  f.run_id = je.run_id
					            AND  f.score  <= 2
					      )
				) AS regrets
			FROM   journal_events je
			JOIN   runs   r ON r.id   = je.run_id
			JOIN   agents a ON a.id   = r.agent_id
			WHERE  je.kind                    = 'confidence_evaluated'
			  AND  je.payload->>'decision'    = 'execute'
			  AND  r.created_at               > NOW() - INTERVAL '30 days'
			  AND  ($1 = '' OR a.name         = $1)
			  AND  ($2 = '' OR je.payload->>'node_type' = $2)
		`, agentName, nodeType).Scan(&total, &regrets)
	})
	if err != nil {
		if logger != nil {
			logger.Debug("confidence calibration: regret query failed",
				zap.String("tenant_id", tenantID),
				zap.String("agent_name", agentName),
				zap.String("node_type", nodeType),
				zap.Error(err),
			)
		}
		return 0 // fail-safe
	}

	return computeRegretRate(total, regrets, regretMinSamples)
}

// computeRegretRate computes the regret fraction from raw counts.
// Returns 0 when total < minSamples (insufficient data).
// Exported for unit testing without a live DB.
func computeRegretRate(total, regrets int64, minSamples int) float64 {
	if total < int64(minSamples) || total == 0 {
		return 0
	}
	rate := float64(regrets) / float64(total)
	if rate > 1 {
		rate = 1
	}
	return rate
}

// confidenceCalibrateEnabled reports whether LANTERN_CONFIDENCE_CALIBRATE
// is set to a truthy value. Default OFF.
func confidenceCalibrateEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_CONFIDENCE_CALIBRATE")))
	return v == "1" || v == "true" || v == "on"
}

// newRegretLookup returns a workflow.RegretLookup that is scoped to
// (tenantID, agentName) and uses the process-level regret cache.
// The pool must be the tenant (non-superuser) pool so RLS is enforced.
func newRegretLookup(
	pool *pgxpool.Pool,
	tenantID, agentName string,
	logger *zap.Logger,
) workflow.RegretLookup {
	return func(ctx context.Context, nodeType string) float64 {
		return globalRegretCache.get(ctx, pool, tenantID, agentName, nodeType, logger)
	}
}
