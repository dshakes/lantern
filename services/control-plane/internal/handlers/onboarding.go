package handlers

// onboarding.go — server-side state + agent explanations for the agentic
// onboarding flow (dashboard /onboarding, `lantern onboard`).
//
// State lives in tenants.settings->'onboarding' rather than a new table:
// one small JSON document per tenant is all resume needs (YAGNI). `tenants`
// is the tenant root and is in the documented RLS-exempt set; every query
// here is scoped by `id = <auth tenant>`, and no request can name a tenant.
//
// The state is a WHITELISTED struct — unknown fields (e.g. a provider key a
// buggy client tried to cache) are dropped on decode, never persisted
// (invariant #10).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// OnboardingHandler serves /v1/onboarding.
type OnboardingHandler struct {
	srv  *server.Server
	auth *AuthHandler
	llm  *LlmProxyHandler
}

// NewOnboardingHandler wires the handler. llm is used for explanations.
func NewOnboardingHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *OnboardingHandler {
	return &OnboardingHandler{srv: srv, auth: auth, llm: llm}
}

// RegisterRoutes mounts /v1/onboarding with its scopes. Kept here (not in
// main.go) so the scope wiring is under test.
//   - explain makes an LLM call (spends tenant money) → runs:execute
//   - state writes → settings:write; state read → read
func (h *OnboardingHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/onboarding", h.auth.WithScope(ScopeRead, h.GetState))
	mux.HandleFunc("PUT /v1/onboarding", h.auth.WithScope(ScopeSettingsWrite, h.PutState))
	mux.HandleFunc("DELETE /v1/onboarding", h.auth.WithScope(ScopeSettingsWrite, h.DeleteState))
	mux.HandleFunc("POST /v1/onboarding/explain", h.auth.WithScope(ScopeRunsExecute, h.Explain))
}

// onboardingSteps is the flow order; the dashboard state machine mirrors it.
var onboardingSteps = map[string]bool{
	"goal": true, "spec": true, "provider": true, "create": true,
	"run": true, "sandbox": true, "done": true,
}

var onboardingSandboxStates = map[string]bool{
	"": true, "skipped": true, "unavailable": true, "ran": true, "failed": true,
}

var onboardingAgentName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// onboardingSpec is the persisted agent design: only the fields the flow
// reads. Typed (not map[string]any) so arbitrary nested fields — e.g. a key
// a client stuffed into the spec — are dropped on decode, never stored.
type onboardingSpec struct {
	Name         string                `json:"name"`
	Description  string                `json:"description,omitempty"`
	Model        string                `json:"model,omitempty"`
	SystemPrompt string                `json:"systemPrompt,omitempty"`
	FirstInput   *onboardingFirstInput `json:"firstInput,omitempty"`
	Rationale    string                `json:"rationale,omitempty"`
	Isolation    string                `json:"isolation,omitempty"`
	Tools        []string              `json:"tools,omitempty"`
	Steps        []onboardingSpecStep  `json:"steps,omitempty"`
}

type onboardingFirstInput struct {
	Prompt string `json:"prompt"`
}

type onboardingSpecStep struct {
	Name        string `json:"name"`
	Type        string `json:"type,omitempty"`
	Description string `json:"description,omitempty"`
}

func (s *onboardingSpec) validate() error {
	if s.Name != "" && !onboardingAgentName.MatchString(s.Name) {
		return errors.New("spec.name must be lowercase letters, digits and hyphens")
	}
	if s.Model != "" && !specCapabilityModels[s.Model] && s.Model != "fast" && s.Model != "balanced" {
		return errors.New("spec.model must be a capability name (auto, chat-small, …), never a vendor model")
	}
	if len(s.Description) > 500 || len(s.SystemPrompt) > 8000 || len(s.Rationale) > 1000 ||
		(s.FirstInput != nil && len(s.FirstInput.Prompt) > 4000) || len(s.Steps) > 20 || len(s.Tools) > 20 {
		return errors.New("spec is too large")
	}
	return nil
}

// onboardingState is the persisted resume document.
type onboardingState struct {
	Step         string          `json:"step"`
	Goal         string          `json:"goal,omitempty"`
	Spec         *onboardingSpec `json:"spec,omitempty"`
	SpecApproved bool            `json:"specApproved,omitempty"`
	AgentName    string          `json:"agentName,omitempty"`
	AgentCreated bool            `json:"agentCreated,omitempty"`
	RunID        string          `json:"runId,omitempty"`
	RunStatus    string          `json:"runStatus,omitempty"`
	Sandbox      string          `json:"sandbox,omitempty"`
	VMID         string          `json:"vmId,omitempty"`
	CompletedAt  *time.Time      `json:"completedAt,omitempty"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

func (s *onboardingState) validate() error {
	if !onboardingSteps[s.Step] {
		return fmt.Errorf("step must be one of goal|spec|provider|create|run|sandbox|done")
	}
	if len(s.Goal) > 2000 {
		return errors.New("goal is too long (max 2000 chars)")
	}
	if s.AgentName != "" && !onboardingAgentName.MatchString(s.AgentName) {
		return errors.New("agentName must be lowercase letters, digits and hyphens")
	}
	if !onboardingSandboxStates[s.Sandbox] {
		return errors.New("sandbox must be one of skipped|unavailable|ran|failed")
	}
	if len(s.RunID) > 64 || len(s.VMID) > 64 || len(s.RunStatus) > 32 {
		return errors.New("runId/vmId/runStatus too long")
	}
	if s.Spec != nil {
		return s.Spec.validate()
	}
	return nil
}

func (h *OnboardingHandler) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	claims, err := h.auth.validateRequest(r)
	if err != nil || claims.TenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return "", false
	}
	return claims.TenantID, true
}

// GetState handles GET /v1/onboarding. Returns {} when nothing is saved.
func (h *OnboardingHandler) GetState(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var raw []byte
	// rls-exempt: tenants is the tenant root (documented exempt set); scoped by
	// the auth tenant's own id, never a request-supplied one.
	err := h.srv.Pool.QueryRow(r.Context(),
		`SELECT COALESCE(settings->'onboarding', '{}'::jsonb) FROM tenants WHERE id = $1`, tenantID,
	).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "tenant not found"})
		return
	}
	if err != nil {
		h.srv.Logger.Error("onboarding: get state", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}

// PutState handles PUT /v1/onboarding — replaces the resume document.
func (h *OnboardingHandler) PutState(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var st onboardingState
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&st); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := st.validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	st.UpdatedAt = time.Now().UTC()
	if st.Step == "done" && st.CompletedAt == nil {
		now := st.UpdatedAt
		st.CompletedAt = &now
	}
	doc, err := json.Marshal(st)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	// rls-exempt: tenants is the tenant root (documented exempt set); scoped by
	// the auth tenant's own id.
	var prev *string
	err = h.srv.Pool.QueryRow(r.Context(), `
		WITH old AS (SELECT settings->'onboarding'->>'step' AS s FROM tenants WHERE id = $1),
		upd AS (UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{onboarding}', $2::jsonb)
		        WHERE id = $1 RETURNING 1)
		SELECT (SELECT s FROM old) FROM upd`,
		tenantID, doc).Scan(&prev)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "tenant not found"})
		return
	}
	if err != nil {
		h.srv.Logger.Error("onboarding: put state", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	recordOnboardingTransition(r.Context(), prev, st.Step)
	writeJSON(w, http.StatusOK, st)
}

// DeleteState handles DELETE /v1/onboarding ("start over").
func (h *OnboardingHandler) DeleteState(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := h.tenant(w, r)
	if !ok {
		return
	}
	// rls-exempt: tenants is the tenant root; scoped by the auth tenant's id.
	if _, err := h.srv.Pool.Exec(r.Context(),
		`UPDATE tenants SET settings = settings - 'onboarding' WHERE id = $1`, tenantID); err != nil {
		h.srv.Logger.Error("onboarding: delete state", zap.String("tenant_id", tenantID), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type onboardingExplainRequest struct {
	Goal      string `json:"goal"`
	AgentName string `json:"agentName"`
	Output    string `json:"output"`
	Error     string `json:"error"`
}

const onboardingGuidePrompt = `You are PAL's onboarding guide. The user just ran their first agent. You get their goal, the agent's output, and any error.

Rules:
- At most 3 short sentences, plain text, no markdown, no filler ("Great!", "Certainly!").
- Say what the agent actually did (quote nothing you were not given), whether it met the goal, and the one most useful next thing to try.
- If there was an error, say plainly what failed and how to fix it. Never claim success the output does not show.`

// Explain handles POST /v1/onboarding/explain — the onboarding agent's
// plain-language read of a run. LLM-only by design: callers keep their own
// deterministic text as the fallback when this returns an error.
func (h *OnboardingHandler) Explain(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := h.tenant(w, r)
	if !ok {
		return
	}
	var req onboardingExplainRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(req.Output) == "" && strings.TrimSpace(req.Error) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "output or error is required"})
		return
	}
	text, err := h.explain(r.Context(), tenantID, req)
	if err != nil {
		writeLLMAssistError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"explanation": text})
}

func (h *OnboardingHandler) explain(ctx context.Context, tenantID string, req onboardingExplainRequest) (string, error) {
	if !h.llm.hasAnyLLMProvider(ctx, tenantID) {
		return "", errNoLLMProvider
	}
	user := fmt.Sprintf("Goal: %s\nAgent: %s\nOutput:\n%s\nError: %s",
		clip(req.Goal, 2000), clip(req.AgentName, 64), clip(req.Output, 6000), clip(req.Error, 2000))
	text, err := h.llm.CompleteInternal(ctx, tenantID, onboardingGuidePrompt, user, 0)
	if err != nil {
		h.srv.Logger.Warn("onboarding: explain failed", zap.String("tenant_id", tenantID), zap.Error(err))
		return "", fmt.Errorf("explain: %w", err)
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("explain: empty response")
	}
	return text, nil
}

// clip truncates to at most n runes (never splits a multi-byte character —
// Telugu / emoji input must not become invalid UTF-8 in the prompt).
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// recordOnboardingTransition emits step metrics when the saved step changes:
// the new step is "reached", the one it left is "completed". Re-saving the same
// step (autosave) emits nothing, so counts are per transition, not per PUT.
func recordOnboardingTransition(ctx context.Context, prev *string, next string) {
	p := ""
	if prev != nil {
		p = *prev
	}
	if p == next {
		return
	}
	if p != "" {
		middleware.RecordOnboardingStep(ctx, p, "completed")
	}
	middleware.RecordOnboardingStep(ctx, next, "reached")
	if next == "done" {
		middleware.RecordOnboardingStep(ctx, next, "completed")
	}
}
