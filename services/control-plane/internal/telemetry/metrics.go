package telemetry

import (
	"fmt"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

// InitMetrics installs a global OTel MeterProvider backed by a Prometheus
// exporter and returns the /metrics handler. Instruments created through
// otel.Meter (internal/middleware/metrics.go) resolve lazily against the global
// provider, so they start reporting without any change at their call sites.
// A private registry is used so the endpoint serves only OTel-bridged metrics
// plus nothing a stray dependency registered on the default one.
func InitMetrics() (http.Handler, error) {
	reg := prometheus.NewRegistry()
	exp, err := otelprom.New(otelprom.WithRegisterer(reg))
	if err != nil {
		return nil, fmt.Errorf("telemetry: prometheus exporter: %w", err)
	}
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(exp)))
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{}), nil
}
