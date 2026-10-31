package telemetry_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"

	"github.com/dshakes/pal/services/control-plane/internal/middleware"
	"github.com/dshakes/pal/services/control-plane/internal/telemetry"
)

// The alert rules in infra/monitoring/prometheus/alerts.yml query these exact
// series; this test pins the names so a rename breaks here, not silently in prod.
func TestInitMetricsExposesAlertedSeries(t *testing.T) {
	h, err := telemetry.InitMetrics()
	if err != nil {
		t.Fatal(err)
	}
	middleware.RecordBudgetBlock(context.Background(), "a")
	middleware.RecordRunTotal(context.Background(), "a", "shared", "failed")
	api := otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}), "t", otelhttp.WithMetricAttributesFn(func(*http.Request) []attribute.KeyValue {
		return []attribute.KeyValue{attribute.String("pal.traffic", "api")}
	}))
	api.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{
		"pal_run_budget_blocks_total",
		`pal_run_total{`,
		`pal_agent_name="a"`,
		`http_server_request_duration_seconds_count{`,
		`http_response_status_code="500"`,
		`pal_traffic="api"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in /metrics:\n%s", want, body)
		}
	}
}
