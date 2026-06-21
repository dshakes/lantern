// Package leader implements Postgres advisory-lock-based leader election for
// the runtime-scheduler. A fixed 64-bit key is contested across all scheduler
// replicas; whichever process holds the session-level lock is the leader.
//
// When the leader process exits (gracefully or otherwise) Postgres releases
// its session-level lock automatically, allowing a standby to acquire it.
//
// When DATABASE_URL is unset the process defaults to always-leader so that
// single-node dev mode is unaffected.
package leader

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// lockKey is the application-level Postgres advisory lock key.
// Pick an arbitrary stable int64; must be the same across all replicas.
const lockKey int64 = 0x4C6E_5363_6865_6400 // "LnSched\0" in hex

// Elector holds leader state. Create it with Campaign; observe with IsLeader.
type Elector struct {
	isLeader atomic.Bool

	mu       sync.Mutex    // protects resignCh
	resignCh chan struct{} // closed by Resign to force an immediate step-down
}

// IsLeader reports whether this instance currently holds the advisory lock.
func (e *Elector) IsLeader() bool {
	return e.isLeader.Load()
}

// AlwaysLeader returns an Elector that is permanently the leader. Used when
// DATABASE_URL is unset (single-node dev).
func AlwaysLeader() *Elector {
	e := &Elector{resignCh: make(chan struct{})}
	e.isLeader.Store(true)
	return e
}

// Resign immediately steps this instance down and releases the Postgres
// advisory lock by closing the underlying connection. The Campaign goroutine
// remains running: it will re-enter the contention loop after retryInterval,
// so the Elector may re-acquire leadership if no other replica picks it up.
//
// This is primarily useful for tests and orderly hand-off (e.g. before a
// rolling restart). The semantics are equivalent to the session connection
// being severed (Postgres auto-releases session locks on disconnect).
//
// Calling Resign on an Elector that is not currently the leader is a no-op.
// Calling Resign more than once is safe.
func (e *Elector) Resign() {
	// Closing resignCh signals hold() to return, which causes run() to close
	// the connection (releasing the advisory lock), flip isLeader to false,
	// and re-enter the contention loop. We replace resignCh so the Elector
	// can acquire leadership again after the retry interval.
	e.mu.Lock()
	old := e.resignCh
	e.resignCh = make(chan struct{})
	e.mu.Unlock()

	select {
	case <-old:
		// already resigned / channel already closed — no-op
	default:
		close(old)
	}
}

// Campaign acquires a Postgres session-level advisory lock on lockKey using a
// dedicated single connection (not a pool connection — the lock is
// session-scoped and must not be checked back into a pool). It blocks until
// either the lock is acquired or ctx is cancelled.
//
// Once acquired it holds the lock and re-probes it on a short interval so that
// if the connection silently drops (network partition), it notices and resets
// IsLeader to false until it can reconnect and re-acquire.
//
// Campaign returns when ctx is cancelled. The caller should treat the returned
// error as informational only.
func Campaign(ctx context.Context, connStr string, logger *zap.Logger) (*Elector, error) {
	e := &Elector{resignCh: make(chan struct{})}
	go e.run(ctx, connStr, logger)
	return e, nil
}

// retryInterval controls how often a standby polls for the lock.
const retryInterval = 2 * time.Second

// probeInterval controls how often the leader checks its connection is alive.
const probeInterval = 5 * time.Second

func (e *Elector) run(ctx context.Context, connStr string, logger *zap.Logger) {
	for {
		if ctx.Err() != nil {
			e.isLeader.Store(false)
			return
		}

		conn, err := pgx.Connect(ctx, connStr)
		if err != nil {
			logger.Warn("leader: failed to open advisory-lock connection, retrying",
				zap.Error(err), zap.Duration("retry_in", retryInterval))
			select {
			case <-ctx.Done():
				return
			case <-time.After(retryInterval):
			}
			continue
		}

		acquired, err := tryAcquire(ctx, conn)
		if err != nil || !acquired {
			_ = conn.Close(ctx)
			if err != nil {
				logger.Warn("leader: pg_try_advisory_lock error, retrying",
					zap.Error(err), zap.Duration("retry_in", retryInterval))
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(retryInterval):
			}
			continue
		}

		// We hold the lock.
		logger.Info("leader: acquired advisory lock — this replica is now the leader",
			zap.Int64("lock_key", lockKey))
		e.isLeader.Store(true)

		// Hold the lock until the connection dies or ctx is cancelled.
		e.hold(ctx, conn, logger)

		// hold() has returned (connection dropped or ctx cancelled); step down
		// and close the connection, which releases the session advisory lock.
		// Use a fresh context so Close still runs cleanly when ctx is cancelled.
		e.isLeader.Store(false)
		logger.Info("leader: released advisory lock — this replica is now a standby")
		_ = conn.Close(context.Background())

		// Brief pause before re-contesting.
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryInterval):
		}
	}
}

// tryAcquire calls pg_try_advisory_lock. Returns (true, nil) when acquired.
func tryAcquire(ctx context.Context, conn *pgx.Conn) (bool, error) {
	var ok bool
	err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, lockKey).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("pg_try_advisory_lock: %w", err)
	}
	return ok, nil
}

// hold keeps the connection alive by pinging until ctx is cancelled, the
// connection breaks, or Resign() is called.
func (e *Elector) hold(ctx context.Context, conn *pgx.Conn, logger *zap.Logger) {
	// Snapshot the current resign channel under the lock so we're not racing
	// with a concurrent Resign() call that swaps the pointer.
	e.mu.Lock()
	resignCh := e.resignCh
	e.mu.Unlock()

	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-resignCh:
			logger.Info("leader: Resign called — stepping down voluntarily")
			return
		case <-ticker.C:
			if err := conn.Ping(ctx); err != nil {
				logger.Warn("leader: advisory-lock connection lost, stepping down",
					zap.Error(err))
				return
			}
		}
	}
}
