// Package reporter collects run status updates and metrics from the data plane
// and queues them for delivery to the control plane via the tunnel. When the
// tunnel is disconnected, reports are buffered locally and drained on reconnect.
package reporter

import (
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/data-plane-agent/internal/tunnel"
)

// Reporter buffers and delivers status updates and metrics to the control plane.
type Reporter struct {
	logger *zap.Logger

	mu      sync.Mutex
	pending []tunnel.PendingReport

	// Metrics are overwritten on each snapshot — only the latest matters.
	latestMetrics *tunnel.MetricsSnapshot
}

// New creates a new Reporter.
func New(logger *zap.Logger) *Reporter {
	return &Reporter{
		logger: logger.Named("reporter"),
	}
}

// OnRunStatusChange records a run status transition. If the tunnel is connected,
// this will be sent immediately by the tunnel's message loop. If disconnected,
// the report is queued for delivery on reconnect.
func (r *Reporter) OnRunStatusChange(runID, status string, metadata map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	report := tunnel.PendingReport{
		RunID:    runID,
		Status:   status,
		Metadata: metadata,
		Time:     time.Now(),
	}

	r.pending = append(r.pending, report)

	r.logger.Info("run status change recorded",
		zap.String("run_id", runID),
		zap.String("status", status),
		zap.Int("pending_count", len(r.pending)),
	)
}

// OnMetrics records a metrics snapshot. Only the latest snapshot is kept.
func (r *Reporter) OnMetrics(metrics *tunnel.MetricsSnapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.latestMetrics = metrics

	r.logger.Debug("metrics snapshot recorded",
		zap.Int("active_runs", metrics.ActiveRuns),
		zap.Int("queue_depth", metrics.QueueDepth),
	)
}

// DrainPending returns all queued reports and clears the queue. Called by the
// tunnel after reconnection to deliver buffered status updates.
func (r *Reporter) DrainPending() []tunnel.PendingReport {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.pending) == 0 {
		return nil
	}

	drained := r.pending
	r.pending = nil

	r.logger.Info("drained pending reports",
		zap.Int("count", len(drained)),
	)

	return drained
}

// PendingCount returns the number of queued reports.
func (r *Reporter) PendingCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

// LatestMetrics returns the most recent metrics snapshot, or nil if none.
func (r *Reporter) LatestMetrics() *tunnel.MetricsSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.latestMetrics
}
