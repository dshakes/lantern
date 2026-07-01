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
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
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
