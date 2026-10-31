package handlers

// Regression tests for the cost forecaster.
//
// TestForecastZeroHistory (DB-backed, skips when DATABASE_URL unset) proves
// that an agent with no completed runs returns absent (nil) estimates and
// calibrated=false rather than fabricated token counts.
//
// TestForecasterZeroHistory_NoBudgetBlock (unit, no DB) proves the struct
// logic: nil estimates must never set WouldExceedBudget=true.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

// TestForecasterZeroHistory_NilEstimates_Unit proves the forecastResponse
// struct invariant: when Calibrated=false (no history), all three estimated
// fields must be nil and WouldExceedBudget must be false.
// This is a pure struct test — no DB, no network.
func TestForecasterZeroHistory_NilEstimates_Unit(t *testing.T) {
	resp := forecastResponse{
		AgentName:        "new-agent",
		Calibrated:       false,
		NoHistoricalData: true,
		Confidence:       0,
	}
	if resp.EstimatedTokensIn != nil {
		t.Error("zero-history: EstimatedTokensIn must be nil, got non-nil")
	}
	if resp.EstimatedTokensOut != nil {
		t.Error("zero-history: EstimatedTokensOut must be nil, got non-nil")
	}
	if resp.EstimatedCostUsd != nil {
		t.Error("zero-history: EstimatedCostUsd must be nil, got non-nil")
	}
	if resp.WouldExceedBudget {
		t.Error("zero-history: WouldExceedBudget must be false when estimates are nil")
	}
}

// TestForecasterHistoricalConfidence_Unit proves the confidence formula only
// fires for runs > 0.
func TestForecasterHistoricalConfidence_Unit(t *testing.T) {
	// Zero runs → confidence 0 (not the old fabricated 0.3 floor).
	zero := historicalStats{runs: 0}
	if zero.confidence != 0 {
		t.Errorf("zero-run confidence = %v, want 0 (fabrication guard)", zero.confidence)
	}

	// Positive runs → confidence > 0 (populated by historical()).
	positive := historicalStats{runs: 5, confidence: 0.47}
	if positive.confidence <= 0 {
		t.Errorf("positive-run confidence = %v, want > 0", positive.confidence)
	}
}

// TestForecastZeroHistory_HTTP is a DB-backed integration test. Skips when
// DATABASE_URL is unset. Sends a forecast for a brand-new agent (no runs) and
// asserts the response has calibrated=false and no fabricated token numbers.
func TestForecastZeroHistory_HTTP(t *testing.T) {
	pool := openTestPool(t) // skips if DATABASE_URL unset

	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	auth := NewAuthHandler(srv, testJWTSecret)
	h := NewForecastHandler(srv, auth)

	// Seed a tenant for this test.
	tenantID := seedA2ATenant(t, pool, "forecast-zero-hist-tenant")
	tok := mintTestToken(t, tenantID, "user-fcast", "owner")

	body, _ := json.Marshal(forecastRequest{
		AgentName: "nonexistent-agent-with-no-runs",
		Input:     "hello world",
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs/forecast", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", bearerHeader(tok))
	w := httptest.NewRecorder()
	h.Forecast(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("forecast: got %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp forecastResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("forecast decode: %v", err)
	}

	// Core assertions: no fabricated numbers.
	if resp.Calibrated {
		t.Error("zero-history forecast: Calibrated must be false")
	}
	if !resp.NoHistoricalData {
		t.Error("zero-history forecast: NoHistoricalData must be true")
	}
	if resp.EstimatedTokensIn != nil {
		t.Errorf("zero-history forecast: EstimatedTokensIn must be nil, got %d", *resp.EstimatedTokensIn)
	}
	if resp.EstimatedTokensOut != nil {
		t.Errorf("zero-history forecast: EstimatedTokensOut must be nil, got %d", *resp.EstimatedTokensOut)
	}
	if resp.EstimatedCostUsd != nil {
		t.Errorf("zero-history forecast: EstimatedCostUsd must be nil, got %f", *resp.EstimatedCostUsd)
	}
	// A missing estimate must never auto-block.
	if resp.WouldExceedBudget {
		t.Error("zero-history forecast: WouldExceedBudget must be false (unknown ≠ exceeded)")
	}
	if resp.Confidence != 0 {
		t.Errorf("zero-history forecast: Confidence must be 0, got %f (old fabricated-0.3 floor)", resp.Confidence)
	}
}

// TestForecastHistory_SucceededRuns: runs finish as 'succeeded', and the
// history query once filtered on 'completed' — a status runs never take — so
// every forecast was uncalibrated and the per-run cap never fired. Seeds
// succeeded runs (plus a failed one that must not count) and expects a
// calibrated forecast that a hard-fail per-run cap blocks with 402.
func TestForecastHistory_SucceededRuns(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	logger, _ := zap.NewDevelopment()
	srv := &server.Server{Pool: pool, Logger: logger}
	h := NewForecastHandler(srv, NewAuthHandler(srv, testJWTSecret))

	tenantID := seedA2ATenant(t, pool, "forecast-succeeded-tenant")
	const agent = "forecast-history-agent"
	seedA2AAgentWithVersion(t, pool, tenantID, agent, false)
	for _, status := range []string{"succeeded", "succeeded", "failed"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO runs (tenant_id, agent_id, agent_version_id, status, trigger_kind, input, tokens_in, tokens_out, cost_usd)
			SELECT tenant_id, id, current_version_id, $3, 'api', '{}'::jsonb, 100000, 50000, 1.5
			FROM agents WHERE tenant_id = $1 AND name = $2`, tenantID, agent, status); err != nil {
			t.Fatalf("seed %s run: %v", status, err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_budgets (tenant_id, agent_name, max_cost_usd_per_run, hard_fail, notify_at_pct)
		VALUES ($1, $2, 0.01, true, 80)`, tenantID, agent); err != nil {
		t.Fatalf("seed budget: %v", err)
	}

	hist, err := h.historical(tenantCtx(tenantID), tenantID, agent)
	if err != nil {
		t.Fatalf("historical: %v", err)
	}
	if hist.runs != 2 || hist.avgTokensIn != 100000 {
		t.Fatalf("historical = %+v, want 2 succeeded runs averaging 100000 tokens in", hist)
	}

	body, _ := json.Marshal(forecastRequest{AgentName: agent, Input: "hello"})
	req := httptest.NewRequest(http.MethodPost, "/v1/runs/forecast", bytes.NewReader(body))
	req.Header.Set("Authorization", bearerHeader(mintTestToken(t, tenantID, "user-fcast", "owner")))
	w := httptest.NewRecorder()
	h.Forecast(w, req)
	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("forecast: got %d, want 402 (per-run cap); body: %s", w.Code, w.Body.String())
	}
	var resp forecastResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.Calibrated || !strings.Contains(resp.BlockReason, "per-run cost") {
		t.Fatalf("forecast = calibrated %v, reason %q; want calibrated per-run block", resp.Calibrated, resp.BlockReason)
	}
}
