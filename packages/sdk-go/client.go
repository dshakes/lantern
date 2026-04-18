// Package lantern is the official Go SDK for Lantern — the open-source
// runtime for AI agents with VPC deployment, pre-run cost forecasts,
// policy budgets, and eval-in-CI.
package lantern

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// DefaultBaseURL is used when no explicit base URL is configured.
const DefaultBaseURL = "https://api.lantern.run"

// Client talks to a Lantern control plane over HTTPS.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL overrides the control-plane URL.
// Defaults to LANTERN_API_URL env var, then DefaultBaseURL.
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = u } }

// WithAPIKey sets the API key used for authentication.
// Defaults to LANTERN_API_KEY env var.
func WithAPIKey(k string) Option { return func(c *Client) { c.apiKey = k } }

// WithHTTPClient injects a custom *http.Client (for testing or custom transport).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// New constructs a Client.
func New(opts ...Option) *Client {
	c := &Client{
		baseURL: getenv("LANTERN_API_URL", DefaultBaseURL),
		apiKey:  os.Getenv("LANTERN_API_KEY"),
		http:    &http.Client{Timeout: 60 * time.Second},
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// APIError represents a non-2xx response from the API.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string { return fmt.Sprintf("lantern: http %d: %s", e.Status, e.Body) }

// ---------- Core types ----------

type Agent struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	CreatedAt   time.Time         `json:"createdAt,omitempty"`
}

type Run struct {
	ID          string          `json:"id"`
	AgentName   string          `json:"agentName,omitempty"`
	Status      string          `json:"status"`
	Input       json.RawMessage `json:"input,omitempty"`
	Output      json.RawMessage `json:"output,omitempty"`
	CostUsd     float64         `json:"costUsd"`
	TokensIn    int64           `json:"tokensIn"`
	TokensOut   int64           `json:"tokensOut"`
	CreatedAt   time.Time       `json:"createdAt,omitempty"`
	FinishedAt  *time.Time      `json:"finishedAt,omitempty"`
}

type Forecast struct {
	AgentName          string          `json:"agentName"`
	Model              string          `json:"model"`
	Provider           string          `json:"provider"`
	EstimatedTokensIn  int64           `json:"estimatedTokensIn"`
	EstimatedTokensOut int64           `json:"estimatedTokensOut"`
	EstimatedCostUsd   float64         `json:"estimatedCostUsd"`
	Confidence         float64         `json:"confidence"`
	WouldExceedBudget  bool            `json:"wouldExceedBudget"`
	BlockReason        string          `json:"blockReason,omitempty"`
	Reasoning          map[string]any  `json:"reasoning,omitempty"`
}

type Budget struct {
	AgentName        string         `json:"agentName"`
	MaxCostUsdPerDay *float64       `json:"maxCostUsdPerDay,omitempty"`
	MaxCostUsdPerRun *float64       `json:"maxCostUsdPerRun,omitempty"`
	MaxRunsPerDay    *int           `json:"maxRunsPerDay,omitempty"`
	ToolLimits       map[string]int `json:"toolLimits,omitempty"`
	HardFail         bool           `json:"hardFail"`
	NotifyAtPct      int            `json:"notifyAtPct,omitempty"`
}

type EvalCase struct {
	Name     string         `json:"name"`
	Input    string         `json:"input"`
	Expected string         `json:"expected,omitempty"`
	Assert   map[string]any `json:"assert,omitempty"`
	Weight   float64        `json:"weight,omitempty"`
}

type EvalCaseResult struct {
	Name      string  `json:"name"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Actual    string  `json:"actual,omitempty"`
	Expected  string  `json:"expected,omitempty"`
	Error     string  `json:"error,omitempty"`
	LatencyMs int64   `json:"latencyMs,omitempty"`
	CostUsd   float64 `json:"costUsd,omitempty"`
}

type EvalRunResult struct {
	ID            string   `json:"id"`
	Passed        bool     `json:"passed"`
	Score         float64  `json:"score"`
	CasesTotal    int      `json:"casesTotal"`
	CasesPassed   int      `json:"casesPassed"`
	Regressed     bool     `json:"regressed"`
	BaselineScore *float64 `json:"baselineScore,omitempty"`
}

// ---------- Agents ----------

// CreateAgent creates a new agent.
func (c *Client) CreateAgent(ctx context.Context, name, description string) (*Agent, error) {
	var out Agent
	err := c.do(ctx, http.MethodPost, "/v1/agents", map[string]any{
		"name": name, "description": description,
	}, &out)
	return &out, err
}

// GetAgent fetches an agent by name.
func (c *Client) GetAgent(ctx context.Context, name string) (*Agent, error) {
	var out Agent
	err := c.do(ctx, http.MethodGet, "/v1/agents/"+name, nil, &out)
	return &out, err
}

// ListAgents returns all agents for the authenticated tenant.
func (c *Client) ListAgents(ctx context.Context) ([]Agent, error) {
	var out []Agent
	err := c.do(ctx, http.MethodGet, "/v1/agents", nil, &out)
	return out, err
}

// DeleteAgent deletes an agent.
func (c *Client) DeleteAgent(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/v1/agents/"+name, nil, nil)
}

// ---------- Runs ----------

// RunOptions controls CreateRun.
type RunOptions struct {
	AgentName string          `json:"agentName"`
	Input     any             `json:"input,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
}

// CreateRun creates and starts a run synchronously.
func (c *Client) CreateRun(ctx context.Context, opts RunOptions) (*Run, error) {
	var out Run
	err := c.do(ctx, http.MethodPost, "/v1/runs", opts, &out)
	return &out, err
}

// GetRun fetches a run by id.
func (c *Client) GetRun(ctx context.Context, id string) (*Run, error) {
	var out Run
	err := c.do(ctx, http.MethodGet, "/v1/runs/"+id, nil, &out)
	return &out, err
}

// ForecastRun asks the control plane what a run will cost before executing.
// If a budget is configured and exceeded, err is nil but Forecast.WouldExceedBudget=true.
// If the budget is hard-fail, the API returns 402 which surfaces as *APIError.
func (c *Client) ForecastRun(ctx context.Context, agentName, input string) (*Forecast, error) {
	var out Forecast
	err := c.do(ctx, http.MethodPost, "/v1/runs/forecast", map[string]string{
		"agentName": agentName, "input": input,
	}, &out)
	return &out, err
}

// ---------- Budgets ----------

// UpsertBudget writes or replaces a budget for an agent.
func (c *Client) UpsertBudget(ctx context.Context, agentName string, b Budget) error {
	b.AgentName = agentName
	return c.do(ctx, http.MethodPut, "/v1/agents/"+agentName+"/budget", b, nil)
}

// GetBudget returns the budget configured for an agent, or ErrNoBudget if none.
func (c *Client) GetBudget(ctx context.Context, agentName string) (*Budget, error) {
	var out Budget
	err := c.do(ctx, http.MethodGet, "/v1/agents/"+agentName+"/budget", nil, &out)
	if apiErr := (&APIError{}); errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return nil, ErrNoBudget
	}
	return &out, err
}

// ErrNoBudget is returned by GetBudget when no budget is configured.
var ErrNoBudget = errors.New("lantern: no budget configured")

// ---------- Evals ----------

// EvalSuite represents a named test suite for an agent.
type EvalSuite struct {
	ID          string     `json:"id,omitempty"`
	AgentName   string     `json:"agentName"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Cases       []EvalCase `json:"cases"`
}

// UpsertEvalSuite creates or updates an eval suite.
func (c *Client) UpsertEvalSuite(ctx context.Context, s EvalSuite) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	err := c.do(ctx, http.MethodPost, "/v1/eval-suites", s, &out)
	return out.ID, err
}

// RecordEvalRun submits the results of locally executed eval cases for a suite.
// Returns the server-side score and regression flag (true if the score fell
// below the branch baseline).
func (c *Client) RecordEvalRun(ctx context.Context, req RecordEvalRunRequest) (*EvalRunResult, error) {
	var out EvalRunResult
	err := c.do(ctx, http.MethodPost, "/v1/eval-runs", req, &out)
	return &out, err
}

// RecordEvalRunRequest is the payload for RecordEvalRun.
type RecordEvalRunRequest struct {
	SuiteID      string           `json:"suiteId"`
	AgentVersion string           `json:"agentVersion,omitempty"`
	CommitSha    string           `json:"commitSha,omitempty"`
	Branch       string           `json:"branch,omitempty"`
	DurationMs   int64            `json:"durationMs"`
	TotalCostUsd float64          `json:"totalCostUsd"`
	CaseResults  []EvalCaseResult `json:"caseResults"`
}

// SetEvalBaseline pins an eval run as the baseline for a branch.
// Subsequent eval-runs on that branch are compared against this score.
func (c *Client) SetEvalBaseline(ctx context.Context, agentName, branch, evalRunID string) error {
	return c.do(ctx, http.MethodPost, "/v1/eval-baselines", map[string]string{
		"agentName": agentName, "branch": branch, "evalRunId": evalRunID,
	}, nil)
}

// ---------- internals ----------

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("lantern: marshal body: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		b, _ := io.ReadAll(res.Body)
		return &APIError{Status: res.StatusCode, Body: string(b)}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
