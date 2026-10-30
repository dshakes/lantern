// Package metrics declares the Prometheus metrics for the runtime-scheduler.
// All metrics are registered on a private registry so tests can use isolated
// registries without global-state collisions.
package metrics

import (
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"google.golang.org/protobuf/proto"
)

// metricPrefix is the PAL name of every scheduler metric. legacyMetricPrefix
// is the pre-PAL name (ADR 0032): each pal_scheduler_* family is re-exposed
// under it at scrape time for one release, so dashboards and alerts that
// still query lantern_scheduler_* keep working while they migrate.
const (
	metricPrefix       = "pal_scheduler_"
	legacyMetricPrefix = "lantern_scheduler_"
)

// Registry is the scheduler's private Prometheus registry. Use this (not the
// default global one) so tests can instantiate Metrics without polluting the
// global namespace.
type Registry struct {
	reg *prometheus.Registry

	// ScheduleTotal counts Schedule RPCs by result label
	// ("ok" | "error" | "quota" | "standby").
	ScheduleTotal *prometheus.CounterVec

	// ScheduleErrorsTotal counts Schedule RPCs that returned an error.
	// Redundant with ScheduleTotal{result="error"} but kept as a plain counter
	// for simple alerting.
	ScheduleErrorsTotal prometheus.Counter

	// ScheduleDuration is the Schedule RPC latency (placement; the spawn
	// dispatch is async) by result ("ok" | "error"). Backs the
	// scheduling-latency SLO (ADR 0041); leader-only, standby rejections excluded.
	ScheduleDuration *prometheus.HistogramVec

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
		Name: metricPrefix + "schedule_total",
		Help: "Total Schedule RPCs, partitioned by result (ok|error|quota|standby).",
	}, []string{"result"})
	reg.MustRegister(m.ScheduleTotal)

	m.ScheduleErrorsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: metricPrefix + "schedule_errors_total",
		Help: "Total Schedule RPCs that returned an error.",
	})
	reg.MustRegister(m.ScheduleErrorsTotal)

	m.ScheduleDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "lantern_scheduler_schedule_duration_seconds",
		Help:    "Schedule RPC latency (placement; spawn dispatch is async), partitioned by result (ok|error).",
		Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
	}, []string{"result"})
	reg.MustRegister(m.ScheduleDuration)

	m.PlacementScore = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    metricPrefix + "placement_score",
		Help:    "Placement score of the winning node (0–N weighted sum).",
		Buckets: prometheus.LinearBuckets(0, 0.5, 12),
	})
	reg.MustRegister(m.PlacementScore)

	m.ActiveVMs = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: metricPrefix + "active_vms",
		Help: "Number of VMs in a non-terminal state tracked by the scheduler.",
	})
	reg.MustRegister(m.ActiveVMs)

	m.Nodes = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: metricPrefix + "nodes",
		Help: "Number of registered nodes known to the scheduler.",
	})
	reg.MustRegister(m.Nodes)

	m.IsLeader = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: metricPrefix + "is_leader",
		Help: "1 if this replica currently holds the leader advisory lock, 0 otherwise.",
	})
	reg.MustRegister(m.IsLeader)

	return m
}

// Prometheus returns the gatherer for promhttp.HandlerFor: the registry's
// families plus a legacy-named copy of each pal_scheduler_* family.
func (m *Registry) Prometheus() prometheus.Gatherer {
	return prometheus.GathererFunc(func() ([]*dto.MetricFamily, error) {
		mfs, err := m.reg.Gather()
		out := mfs
		for _, mf := range mfs {
			if tail, ok := strings.CutPrefix(mf.GetName(), metricPrefix); ok {
				legacy := proto.Clone(mf).(*dto.MetricFamily)
				legacy.Name = proto.String(legacyMetricPrefix + tail)
				out = append(out, legacy)
			}
		}
		return out, err
	})
}
