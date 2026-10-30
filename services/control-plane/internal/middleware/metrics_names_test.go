package middleware

import (
	"context"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// ADR 0032: every measurement lands under the PAL name with pal.* attributes
// and, for one release, under the legacy name with lantern.* attributes —
// lantern_run_total{lantern_status=...} alerts keep firing.
func TestMetrics_DualEmitPALAndLegacyNames(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	prev := otel.GetMeterProvider()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))
	t.Cleanup(func() { otel.SetMeterProvider(prev); metricsOnce = sync.Once{} })
	metricsOnce = sync.Once{}

	RecordRunTotal(context.Background(), "agent-a", "shared", "failed")

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	found := map[string]string{} // metric name -> status attribute value
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, dp := range sum.DataPoints {
				for _, key := range []string{"pal.status", "lantern.status"} {
					if v, ok := dp.Attributes.Value(attributeKey(key)); ok {
						found[m.Name+"|"+key] = v.AsString()
					}
				}
			}
		}
	}
	for _, want := range []string{"pal.run.total|pal.status", "lantern.run.total|lantern.status"} {
		if found[want] != "failed" {
			t.Errorf("%s: got %q (all: %v)", want, found[want], found)
		}
	}
}

func attributeKey(k string) attribute.Key { return attribute.Key(k) }
