package metrics_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/dshakes/lantern/services/runtime-scheduler/internal/metrics"
)

// TestMetricsEndpoint verifies that:
//  1. The /metrics handler returns HTTP 200.
//  2. The expected metric names appear in the response body after incrementing
//     a counter and setting a gauge.
func TestMetricsEndpoint(t *testing.T) {
	m := metrics.New()

	// Increment the schedule counter with the "ok" label and record a score.
	m.ScheduleTotal.WithLabelValues("ok").Inc()
	m.ScheduleErrorsTotal.Inc()
	m.PlacementScore.Observe(3.5)
	m.ActiveVMs.Set(7)
	m.Nodes.Set(2)
	m.IsLeader.Set(1)

	handler := promhttp.HandlerFor(m.Prometheus(), promhttp.HandlerOpts{})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	text := string(body)

	wantMetrics := []string{
		"lantern_scheduler_schedule_total",
		"lantern_scheduler_schedule_errors_total",
		"lantern_scheduler_placement_score",
		"lantern_scheduler_active_vms",
		"lantern_scheduler_nodes",
		"lantern_scheduler_is_leader",
	}
	for _, name := range wantMetrics {
		if !strings.Contains(text, name) {
			t.Errorf("metric %q not found in /metrics output", name)
		}
	}
}

// TestIsLeaderGaugeReflectsState ensures is_leader gauge correctly reports 0/1.
func TestIsLeaderGaugeReflectsState(t *testing.T) {
	m := metrics.New()

	handler := promhttp.HandlerFor(m.Prometheus(), promhttp.HandlerOpts{})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Default: is_leader unset (zero value = 0).
	resp := scrape(t, srv.URL)
	if !strings.Contains(resp, "lantern_scheduler_is_leader 0") {
		t.Errorf("expected is_leader 0 before setting; body:\n%s", resp)
	}

	// Set to 1 (leader).
	m.IsLeader.Set(1)
	resp = scrape(t, srv.URL)
	if !strings.Contains(resp, "lantern_scheduler_is_leader 1") {
		t.Errorf("expected is_leader 1 after leader acquired; body:\n%s", resp)
	}

	// Set to 0 (standby).
	m.IsLeader.Set(0)
	resp = scrape(t, srv.URL)
	if !strings.Contains(resp, "lantern_scheduler_is_leader 0") {
		t.Errorf("expected is_leader 0 after leader released; body:\n%s", resp)
	}
}

func scrape(t *testing.T, baseURL string) string {
	t.Helper()
	resp, err := http.Get(baseURL + "/metrics")
	if err != nil {
		t.Fatalf("scrape: %v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(b)
}
