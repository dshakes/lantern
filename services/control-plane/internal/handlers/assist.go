package handlers

// assist.go — inline "explain this" for the dashboard (runs, eval failures).
//
// POST /v1/assist/explain is the dashboard's one LLM explanation seam. It
// exists separately from /v1/onboarding/explain because that prompt is about
// a user's FIRST run; this one reads any run or failing eval case.
//
// Grounding: for kind=run the server loads the run itself (tenant-scoped via
// db.WithTenantConn AND an explicit tenant_id filter) plus its last journal
// events, so the model only ever sees real state — a client cannot hand it a
// fabricated failure for someone else's run. A run the caller does not own is
// 404 (no existence leak, invariant #7). The LLM call goes through
// CompleteInternal (model router seam, capability-addressed, invariant #6).
// Error payloads are clipped before they enter the prompt; secrets never do
// (runs.error/output are already secret-free per invariant #10).
//
// kind=eval_case is NOT server-grounded: the dashboard forwards fields it read
// from the tenant's own /v1/eval-observability/failures. A caller can only
// make the model explain text it supplied itself, on its own provider key and
// budget — no other tenant's data is reachable. Inputs are length-clipped.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/db"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// AssistHandler serves /v1/assist/*.
type AssistHandler struct {
	srv  *server.Server
	auth *AuthHandler
	llm  *LlmProxyHandler
}

// NewAssistHandler wires the handler.
func NewAssistHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *AssistHandler {
	return &AssistHandler{srv: srv, auth: auth, llm: llm}
}

// RegisterRoutes mounts the assist routes. explain spends tenant money on an
// LLM call, so it carries the same scope as /v1/onboarding/explain.
func (h *AssistHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/assist/explain", h.auth.WithScope(ScopeRunsExecute, h.Explain))
}

type assistExplainRequest struct {
	Kind string `json:"kind"` // "run" | "eval_case"

	// kind=run
	RunID string `json:"runId,omitempty"`

	// kind=eval_case — values the dashboard already read from
	// /v1/eval-observability/failures for this tenant.
	AgentName string `json:"agentName,omitempty"`
	Case      string `json:"case,omitempty"`
	Expected  string `json:"expected,omitempty"`
	Actual    string `json:"actual,omitempty"`
	Error     string `json:"error,omitempty"`
}

var errAssistNotFound = errors.New("not found")

const assistExplainPrompt = `You explain agent runs and failing eval cases to the developer who owns them, inside a dashboard.

Rules:
- At most 4 short sentences, plain text, no markdown, no filler ("Great question!", "Certainly!").
- First sentence: what actually happened, grounded ONLY in the data given. Quote identifiers exactly; never invent steps, errors, or numbers.
- Then the most likely cause, and the one concrete next thing to try (a setting, a prompt change, a retry, a provider key).
- If the data does not show why it failed, say so plainly and name what to look at next. Never claim success the data does not show.`

// Explain handles POST /v1/assist/explain.
func (h *AssistHandler) Explain(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil || claims.TenantID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	tenantID := claims.TenantID

	var req assistExplainRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}

	var subject string
	switch req.Kind {
	case "run":
		if !isUUID(req.RunID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "runId must be a run id"})
			return
		}
		subject, err = h.runSubject(r.Context(), tenantID, req.RunID)
		if errors.Is(err, errAssistNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
			return
		}
		if err != nil {
			h.srv.Logger.Error("assist: load run", zap.String("tenant_id", tenantID), zap.String("run_id", req.RunID), zap.Error(err))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
	case "eval_case":
		if strings.TrimSpace(req.Case) == "" || (strings.TrimSpace(req.Error) == "" && strings.TrimSpace(req.Actual) == "") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "case and error or actual are required"})
			return
		}
		subject = evalCaseSubject(req)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be run or eval_case"})
		return
	}

	if !h.llm.hasAnyLLMProvider(r.Context(), tenantID) {
		writeLLMAssistError(w, errNoLLMProvider)
		return
	}
	text, err := h.llm.CompleteInternal(r.Context(), tenantID, assistExplainPrompt, subject, 0)
	if err == nil && strings.TrimSpace(text) == "" {
		err = errors.New("empty response")
	}
	if err != nil {
		h.srv.Logger.Warn("assist: explain failed", zap.String("tenant_id", tenantID), zap.String("kind", req.Kind), zap.Error(err))
		writeLLMAssistError(w, fmt.Errorf("explain: %w", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"explanation": strings.TrimSpace(text)})
}

// runSubject renders the grounded prompt input for one run the tenant owns.
func (h *AssistHandler) runSubject(ctx context.Context, tenantID, runID string) (string, error) {
	var (
		status, agentName, trigger string
		input, output, runErr      []byte
		costUSD                    float64
		durationSecs               *float64
		events                     []string
	)
	err := db.WithTenantConn(ctx, h.srv.TenantPool(), tenantID, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT r.status, COALESCE(a.name, ''), r.trigger_kind,
			       r.input, COALESCE(r.output, 'null'::jsonb), COALESCE(r.error, 'null'::jsonb),
			       r.cost_usd::float8,
			       EXTRACT(EPOCH FROM (r.finished_at - r.started_at))::float8
			FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
			WHERE r.id = $1 AND r.tenant_id = $2`, runID, tenantID,
		).Scan(&status, &agentName, &trigger, &input, &output, &runErr, &costUSD, &durationSecs)
		if errors.Is(err, pgx.ErrNoRows) {
			return errAssistNotFound
		}
		if err != nil {
			return err
		}
		// journal_events is an RLS-exempt child table; ownership was proven
		// by the tenant-filtered runs read above.
		rows, err := tx.Query(ctx, `
			SELECT kind, COALESCE(step_id, ''), COALESCE(payload, ''::bytea)
			FROM journal_events WHERE run_id = $1
			ORDER BY seq DESC LIMIT 15`, runID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var kind, step string
			var payload []byte // JSON bytes in a bytea column
			if err := rows.Scan(&kind, &step, &payload); err != nil {
				return err
			}
			events = append(events, fmt.Sprintf("- %s %s %s", kind, step, clip(strings.ToValidUTF8(string(payload), ""), 400)))
		}
		return rows.Err()
	})
	if err != nil {
		return "", err
	}
	// Oldest first reads like a timeline.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	duration := "unknown"
	if durationSecs != nil {
		duration = fmt.Sprintf("%.1fs", *durationSecs)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Subject: run %s\nAgent: %s\nStatus: %s\nTrigger: %s\nDuration: %s\nCost: $%.4f\n",
		runID, clip(agentName, 64), status, trigger, duration, costUSD)
	fmt.Fprintf(&b, "Input:\n%s\nOutput:\n%s\nError:\n%s\n", clip(string(input), 2000), clip(string(output), 3000), clip(string(runErr), 2000))
	if len(events) > 0 {
		fmt.Fprintf(&b, "Last journal events (oldest first):\n%s\n", strings.Join(events, "\n"))
	} else {
		b.WriteString("Last journal events: none recorded\n")
	}
	return b.String(), nil
}

func evalCaseSubject(req assistExplainRequest) string {
	return fmt.Sprintf("Subject: failing eval case\nAgent: %s\nCase: %s\nExpected:\n%s\nActual:\n%s\nError:\n%s\n",
		clip(req.AgentName, 64), clip(req.Case, 200), clip(req.Expected, 2000), clip(req.Actual, 3000), clip(req.Error, 2000))
}

// isUUID is a cheap shape check so a junk id never reaches a uuid cast.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}
