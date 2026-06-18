// Package metrics declares the Prometheus metrics for the runtime-scheduler.
// All metrics are registered on a private registry so tests can use isolated
// registries without global-state collisions.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Registry is the scheduler's private Prometheus registry. Use this (not the
// default global one) so tests can instantiate Metrics without polluting the
// global namespace.
type Registry struct {
	reg *prometheus.Registry

	// ScheduleTotal counts Schedule RPCs by result label ("ok" | "error" | "quota").
	ScheduleTotal *prometheus.CounterVec

	// ScheduleErrorsTotal counts Schedule RPCs that returned an error.
	// Redundant with ScheduleTotal{result="error"} but kept as a plain counter
	// for simple alerting.
	ScheduleErrorsTotal prometheus.Counter

	// PlacementScore records the score assigned to the winning node on each
	// successful placement.
	PlacementScore prometheus.Histogram

	// ActiveVMs is the current number of VMs tracked by the scheduler that are
	// not in a terminal state.
	ActiveVMs prometheus.Gauge

	// Nodes is the current number of registered nodes.
	Nodes prometheus.Gauge

	// IsLeader is 1 when this replica holds the leader advisory lock, 0 otherwise.
	IsLeader prometheus.Gauge
}

// New creates and registers all metrics on a fresh private registry.
func New() *Registry {
	reg := prometheus.NewRegistry()
	// Always include the default Go and process collectors so /metrics is useful.
	reg.MustRegister(prometheus.NewGoCollector())
	reg.MustRegister(prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))

	m := &Registry{reg: reg}

	m.ScheduleTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "lantern_scheduler_schedule_total",
		Help: "Total Schedule RPCs, partitioned by result (ok|error|quota).",
	}, []string{"result"})
	reg.MustRegister(m.ScheduleTotal)

	m.ScheduleErrorsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "lantern_scheduler_schedule_errors_total",
		Help: "Total Schedule RPCs that returned an error.",
	})
	reg.MustRegister(m.ScheduleErrorsTotal)

	m.PlacementScore = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "lantern_scheduler_placement_score",
		Help:    "Placement score of the winning node (0–N weighted sum).",
		Buckets: prometheus.LinearBuckets(0, 0.5, 12),
	})
	reg.MustRegister(m.PlacementScore)

	m.ActiveVMs = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "lantern_scheduler_active_vms",
		Help: "Number of VMs in a non-terminal state tracked by the scheduler.",
	})
	reg.MustRegister(m.ActiveVMs)

	m.Nodes = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "lantern_scheduler_nodes",
		Help: "Number of registered nodes known to the scheduler.",
	})
	reg.MustRegister(m.Nodes)

	m.IsLeader = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "lantern_scheduler_is_leader",
		Help: "1 if this replica currently holds the leader advisory lock, 0 otherwise.",
	})
	reg.MustRegister(m.IsLeader)

	return m
}

// Prometheus returns the underlying registry for use with promhttp.HandlerFor.
func (m *Registry) Prometheus() *prometheus.Registry {
	return m.reg
}
