package internal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
