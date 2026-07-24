package internal

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RESTClient mirrors the gRPC client surface but uses HTTP/REST endpoints.
// It is used as a fallback when the gRPC control plane is unavailable.
type RESTClient struct {
	BaseURL    string
	APIKey     string
	Token      string
	HTTPClient *http.Client
}

// NewRESTClient creates a RESTClient targeting the given base URL.
func NewRESTClient(baseURL, apiKey, token string) *RESTClient {
	return &RESTClient{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// --- request helpers --------------------------------------------------------

func (c *RESTClient) newRequest(method, path string, body interface{}) (*http.Request, error) {
	var r io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		r = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	} else if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	return req, nil
}

func (c *RESTClient) do(req *http.Request, out interface{}) error {
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("API %d: %s", resp.StatusCode, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

// --- Agent types (REST) -----------------------------------------------------

// RESTAgent is the JSON representation returned by the REST API.
type RESTAgent struct {
	ID               string            `json:"id"`
	TenantID         string            `json:"tenantId,omitempty"`
	Name             string            `json:"name"`
	Description      string            `json:"description"`
	CurrentVersionID string            `json:"currentVersionId,omitempty"`
	CreatedAt        string            `json:"createdAt"`
	CreatedBy        string            `json:"createdBy,omitempty"`
	Labels           map[string]string `json:"labels,omitempty"`
	Status           string            `json:"status,omitempty"`
}

// RESTRun is the JSON representation of a run from the REST API.
type RESTRun struct {
	ID             string                 `json:"id"`
	TenantID       string                 `json:"tenantId,omitempty"`
	AgentID        string                 `json:"agentId,omitempty"`
	AgentName      string                 `json:"agentName"`
	AgentVersionID string                 `json:"agentVersionId,omitempty"`
	Status         string                 `json:"status"`
	Input          map[string]interface{} `json:"input,omitempty"`
	Output         map[string]interface{} `json:"output,omitempty"`
	TokensIn       int64                  `json:"tokensIn"`
	TokensOut      int64                  `json:"tokensOut"`
	CostUsd        float64                `json:"costUsd"`
	CreatedAt      string                 `json:"createdAt"`
	StartedAt      string                 `json:"startedAt,omitempty"`
	FinishedAt     string                 `json:"finishedAt,omitempty"`
	Labels         map[string]string      `json:"labels,omitempty"`
	Error          *RESTRunError          `json:"error,omitempty"`
}

// RESTRunError is the error detail within a run.
type RESTRunError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	StepID  string `json:"stepId,omitempty"`
}

// RESTLoginRequest is the body for POST /auth/login.
type RESTLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// RESTLoginResponse is the response from POST /auth/login.
type RESTLoginResponse struct {
	Token string   `json:"token"`
	User  RESTUser `json:"user"`
}

// RESTUser is the user profile from the REST API.
type RESTUser struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	TenantID string `json:"tenantId"`
	Role     string `json:"role"`
}

// --- Agent operations -------------------------------------------------------

// ListAgents returns all agents via GET /v1/agents.
func (c *RESTClient) ListAgents() ([]RESTAgent, error) {
	req, err := c.newRequest("GET", "/v1/agents", nil)
	if err != nil {
		return nil, err
	}
	var agents []RESTAgent
	if err := c.do(req, &agents); err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	return agents, nil
}

// CreateAgent creates a new agent via POST /v1/agents.
func (c *RESTClient) CreateAgent(name, description string) (*RESTAgent, error) {
	body := map[string]interface{}{
		"name":        name,
		"description": description,
	}
	req, err := c.newRequest("POST", "/v1/agents", body)
	if err != nil {
		return nil, err
	}
	var agent RESTAgent
	if err := c.do(req, &agent); err != nil {
		return nil, fmt.Errorf("create agent: %w", err)
	}
	return &agent, nil
}

// GetAgent gets an agent by name via GET /v1/agents/:name.
func (c *RESTClient) GetAgent(name string) (*RESTAgent, error) {
	req, err := c.newRequest("GET", "/v1/agents/"+name, nil)
	if err != nil {
		return nil, err
	}
	var agent RESTAgent
	if err := c.do(req, &agent); err != nil {
		return nil, fmt.Errorf("get agent: %w", err)
	}
	return &agent, nil
}

// CreateAgentWithSystemPrompt creates an agent with an explicit system prompt
// via POST /v1/agents.
func (c *RESTClient) CreateAgentWithSystemPrompt(name, description, systemPrompt string) (*RESTAgent, error) {
	body := map[string]interface{}{
		"name":         name,
		"description":  description,
		"systemPrompt": systemPrompt,
	}
	req, err := c.newRequest("POST", "/v1/agents", body)
	if err != nil {
		return nil, err
	}
	var agent RESTAgent
	if err := c.do(req, &agent); err != nil {
		return nil, fmt.Errorf("create agent: %w", err)
	}
	return &agent, nil
}

// NewGETRequest builds an authenticated GET *http.Request for the given path.
// Callers that need to decode the response themselves should pair this with DoJSON.
func (c *RESTClient) NewGETRequest(path string) (*http.Request, error) {
	return c.newRequest("GET", path, nil)
}

// DoJSON executes req and JSON-decodes the response body into out.
// It reuses the same error-handling semantics as the internal do helper.
func (c *RESTClient) DoJSON(req *http.Request, out interface{}) error {
	return c.do(req, out)
}

// ApplyTemplate creates an agent from a built-in template via
// POST /v1/agents/from-template. name overrides the default agent name;
// pass empty to use the template's default.
func (c *RESTClient) ApplyTemplate(templateID, name string) (*RESTAgent, error) {
	body := map[string]interface{}{
		"templateId": templateID,
	}
	if name != "" {
		body["name"] = name
	}
	req, err := c.newRequest("POST", "/v1/agents/from-template", body)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Agent RESTAgent `json:"agent"`
	}
	if err := c.do(req, &resp); err != nil {
		return nil, fmt.Errorf("apply template: %w", err)
	}
	return &resp.Agent, nil
}

// DeleteAgent deletes an agent by name via DELETE /v1/agents/:name.
func (c *RESTClient) DeleteAgent(name string) error {
	req, err := c.newRequest("DELETE", "/v1/agents/"+name, nil)
	if err != nil {
		return err
	}
	if err := c.do(req, nil); err != nil {
		return fmt.Errorf("delete agent: %w", err)
	}
	return nil
}

// --- Run operations ---------------------------------------------------------

// CreateRun creates a new run via POST /v1/runs.
func (c *RESTClient) CreateRun(agentName string, input json.RawMessage, stream bool) (*RESTRun, error) {
	body := map[string]interface{}{
		"agentName": agentName,
		"stream":    stream,
	}
	if input != nil {
		var parsed interface{}
		if err := json.Unmarshal(input, &parsed); err == nil {
			body["input"] = parsed
		}
	}
	req, err := c.newRequest("POST", "/v1/runs", body)
	if err != nil {
		return nil, err
	}
	var run RESTRun
	if err := c.do(req, &run); err != nil {
		return nil, fmt.Errorf("create run: %w", err)
	}
	return &run, nil
}

// --- Auth operations --------------------------------------------------------

// Login authenticates via POST /auth/login and returns the session token.
func (c *RESTClient) Login(email, password string) (*RESTLoginResponse, error) {
	req, err := c.newRequest("POST", "/auth/login", RESTLoginRequest{
		Email:    email,
		Password: password,
	})
	if err != nil {
		return nil, err
	}
	var resp RESTLoginResponse
	if err := c.do(req, &resp); err != nil {
		return nil, fmt.Errorf("login: %w", err)
	}
	return &resp, nil
}

// GetMe returns the current user profile via GET /auth/me.
func (c *RESTClient) GetMe() (*RESTUser, error) {
	req, err := c.newRequest("GET", "/auth/me", nil)
	if err != nil {
		return nil, err
	}
	var user RESTUser
	if err := c.do(req, &user); err != nil {
		return nil, fmt.Errorf("get profile: %w", err)
	}
	return &user, nil
}

// --- Connectivity check -----------------------------------------------------

// Ping checks if the REST API is reachable by calling GET /healthz.
func (c *RESTClient) Ping() error {
	req, err := c.newRequest("GET", "/healthz", nil)
	if err != nil {
		return err
	}
	c.HTTPClient.Timeout = 3 * time.Second
	defer func() { c.HTTPClient.Timeout = 30 * time.Second }()
	return c.do(req, nil)
}

// --- Agent generation -------------------------------------------------------

// GenerateSpecResult is the response from POST /v1/agents/generate-spec.
type GenerateSpecResult struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	SystemPrompt string `json:"systemPrompt"`
	Model        string `json:"model"`
}

// GenerateSpec calls POST /v1/agents/generate-spec with a plain-English description.
func (c *RESTClient) GenerateSpec(description string) (*GenerateSpecResult, error) {
	body := map[string]string{"description": description}
	req, err := c.newRequest("POST", "/v1/agents/generate-spec", body)
	if err != nil {
		return nil, err
	}
	var result GenerateSpecResult
	if err := c.do(req, &result); err != nil {
		return nil, fmt.Errorf("generate-spec: %w", err)
	}
	return &result, nil
}

// GenerateCode calls POST /v1/agents/generate-code (best-effort; returns the
// code string if available, empty string + nil error on 404/unsupported).
func (c *RESTClient) GenerateCode(agentName, description string) (string, error) {
	body := map[string]string{"agentName": agentName, "description": description}
	req, err := c.newRequest("POST", "/v1/agents/generate-code", body)
	if err != nil {
		return "", err
	}
	var result struct {
		Code string `json:"code"`
	}
	if err := c.do(req, &result); err != nil {
		// 404 = endpoint not yet wired; ignore gracefully.
		if strings.Contains(err.Error(), "API 404") || strings.Contains(err.Error(), "API 405") {
			return "", nil
		}
		return "", fmt.Errorf("generate-code: %w", err)
	}
	return result.Code, nil
}

// --- System health ----------------------------------------------------------

// SystemHealth calls GET /v1/system/health and returns the raw JSON map.
// Returns nil (no error) when the endpoint doesn't exist yet (404/405).
func (c *RESTClient) SystemHealth() (map[string]any, error) {
	req, err := c.newRequest("GET", "/v1/system/health", nil)
	if err != nil {
		return nil, err
	}
	// Short timeout — this is a diagnostic call.
	saved := c.HTTPClient.Timeout
	c.HTTPClient.Timeout = 5 * time.Second
	defer func() { c.HTTPClient.Timeout = saved }()

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
		return nil, nil // endpoint not yet wired
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return m, nil
}

// --- SSE streaming ----------------------------------------------------------

// SSEEvent is a parsed server-sent event from GET /v1/runs/{id}/events.
type SSEEvent struct {
	Kind    string         `json:"kind"`
	StepID  string         `json:"stepId,omitempty"`
	Seq     int64          `json:"seq,omitempty"`
	Payload map[string]any `json:"payload,omitempty"`
}

// StreamRunEventsSSE streams run events from GET /v1/runs/{id}/events.
// onEvent is called synchronously for each parsed SSE data line until the run
// reaches a terminal state or ctx is cancelled. The response body is closed on
// return. A nil onEvent is a no-op (still drains the stream).
func (c *RESTClient) StreamRunEventsSSE(ctx context.Context, runID string, onEvent func(*SSEEvent)) error {
	url := c.BaseURL + "/v1/runs/" + runID + "/events"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	} else if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	req.Header.Set("Accept", "text/event-stream")

	// Use a client without a read timeout — SSE streams run until the server closes.
	streamClient := &http.Client{Transport: c.HTTPClient.Transport}
	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("connect to event stream: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("event stream API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "" || data == "[DONE]" {
			continue
		}
		var ev SSEEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			// Also try parsing as a flat map for unknown shapes.
			var raw map[string]any
			if json.Unmarshal([]byte(data), &raw) == nil {
				if k, ok := raw["kind"].(string); ok {
					ev.Kind = k
				}
				ev.Payload = raw
			}
		}
		if onEvent != nil {
			onEvent(&ev)
		}
		// Stop when the stream signals end.
		if ev.Kind == "end" || ev.Kind == "stream_end" {
			return nil
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("read event stream: %w", err)
	}
	return nil
}

// --- Eval suites ------------------------------------------------------------

// RESTEvalSuite is a minimal eval suite from GET /v1/eval-suites.
type RESTEvalSuite struct {
	ID        string         `json:"id"`
	AgentName string         `json:"agentName"`
	Name      string         `json:"name"`
	Cases     []RESTEvalCase `json:"cases"`
}

// RESTEvalCase is a single test case within a suite.
type RESTEvalCase struct {
	ID       string `json:"id"`
	Input    any    `json:"input"`
	Expected string `json:"expected"`
}

// ListEvalSuites returns eval suites for the given agent name.
func (c *RESTClient) ListEvalSuites(agentName string) ([]RESTEvalSuite, error) {
	req, err := c.newRequest("GET", "/v1/eval-suites?agentName="+agentName, nil)
	if err != nil {
		return nil, err
	}
	var suites []RESTEvalSuite
	if err := c.do(req, &suites); err != nil {
		return nil, fmt.Errorf("list eval suites: %w", err)
	}
	return suites, nil
}

// PostEvalRun records eval run results and returns 422 if the run regressed vs baseline.
func (c *RESTClient) PostEvalRun(suiteID, agentName, agentVersion string, passed bool, score float64, caseResults any) error {
	body := map[string]any{
		"suiteId":      suiteID,
		"agentName":    agentName,
		"agentVersion": agentVersion,
		"passed":       passed,
		"score":        score,
		"casesResult":  caseResults,
	}
	req, err := c.newRequest("POST", "/v1/eval-runs", body)
	if err != nil {
		return err
	}
	return c.do(req, nil)
}
