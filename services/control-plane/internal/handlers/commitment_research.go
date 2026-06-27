package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"
)

// ---------- Action-plan types ----------

// ActionPlan is the structured research output stored in commitments.action_plan.
// It is DATA produced by the LLM and shown to the owner — never executed
// server-side (invariant: web/LLM output is untrusted data).
type ActionPlan struct {
	Summary string         `json:"summary"`
	Steps   []ActionStep   `json:"steps"`
	Sources []ActionSource `json:"sources"`
}

// ActionStep is one concrete step inside an ActionPlan.
type ActionStep struct {
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Link     string `json:"link,omitempty"`
	Deadline string `json:"deadline,omitempty"`
	// OneClick is a UI hint: "", "calendar", "reminder", "mail_draft", or "link".
	// Populated by the model; the bridge or dashboard renders an affordance.
	// The server never acts on it — it is a SUGGESTION for the owner only.
	OneClick string `json:"oneClick,omitempty"`
}

// ActionSource is a cited reference attached to an ActionPlan.
type ActionSource struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// ---------- LLM seam (injectable for tests) ----------

// researchCompleteFn is the type of the injectable LLM call used by
// ResearchCommitment. Defaults to h.llmProxy.CompleteInternal.
type researchCompleteFn func(ctx context.Context, tenantID, system, user string) (string, error)

// SetLlmProxy wires the LLM proxy into the commitment handler so
// ResearchCommitment can call the LLM. Also sets the default completeFn.
func (h *CommitmentHandler) SetLlmProxy(p *LlmProxyHandler) {
	h.llmProxy = p
	h.completeFn = func(ctx context.Context, tenantID, system, user string) (string, error) {
		return p.CompleteInternal(ctx, tenantID, system, user, 0)
	}
}

// ---------- Handler ----------

// ResearchCommitment handles POST /v1/commitments/{id}/research.
//
// Stage 2 of the Concierge pipeline: calls the LLM to produce a cited,
// step-by-step ActionPlan for the commitment and stores it in action_plan.
// Sets status='suggested'. Returns the ActionPlan on success.
//
// Security: the LLM response is stored as a plan to SHOW the owner; it is
// never executed server-side. Secrets are never logged (invariant #10).
// Idempotency key: "commitment:{id}:research" (invariant #8).
func (h *CommitmentHandler) ResearchCommitment(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	if h.completeFn == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LLM not configured"})
		return
	}

	// 1. Load commitment — tenant-scoped (404 on cross-tenant).
	var (
		title         string
		kind          *string
		sourcePreview *string
		currentStatus string
	)
	var found bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT title, kind, source_preview, status
			FROM commitments
			WHERE id = $1 AND tenant_id = $2
			LIMIT 1
		`, id, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		if rows.Next() {
			if scanErr := rows.Scan(&title, &kind, &sourcePreview, &currentStatus); scanErr != nil {
				return scanErr
			}
			found = true
		}
		return rows.Err()
	})
	if err != nil {
		h.logger().Error("research: load commitment failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "commitment not found"})
		return
	}

	// 2. Build research prompt.
	kindStr := ""
	if kind != nil {
		kindStr = *kind
	}
	preview := ""
	if sourcePreview != nil {
		preview = *sourcePreview
	}

	systemPrompt := `You are a personal research assistant helping a busy professional take action on their commitments.
Given a task, produce a CITED, step-by-step action plan with concrete next steps, any official links, deadlines, fees, and eligibility.

Output ONLY valid JSON matching this exact structure (no markdown fences, no explanation outside the JSON):
{
  "summary": "one-sentence summary",
  "steps": [
    {
      "title": "short step title",
      "detail": "concrete detail",
      "link": "https://... (optional)",
      "deadline": "YYYY-MM-DD or descriptive (optional)",
      "oneClick": ""
    }
  ],
  "sources": [
    {"title": "source name", "url": "https://..."}
  ]
}

oneClick must be one of: "" (none), "calendar", "reminder", "mail_draft", "link".
Be specific, cite real URLs when you know them. Steps must be actionable in the next 24–72 hours.`

	userPrompt := fmt.Sprintf("Task title: %s\nKind: %s\nContext: %s",
		title, kindStr, preview)

	// 3. Call LLM — idempotency key stamped on context (invariant #8).
	idemBase := "commitment:" + id + ":research"
	callCtx := WithLLMIdempotencyBase(ctx, idemBase)

	rawText, llmErr := h.completeFn(callCtx, tenantID, systemPrompt, userPrompt)
	if llmErr != nil {
		h.logger().Error("research: LLM call failed",
			zap.String("id", id), zap.Error(llmErr))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LLM call failed: " + llmErr.Error()})
		return
	}

	// 4. Parse the response — strip code fences, tolerate extra prose.
	plan, parseErr := parseActionPlan(rawText)
	if parseErr != nil {
		h.logger().Warn("research: bad LLM JSON — not storing garbage",
			zap.String("id", id), zap.String("raw", rawText[:min(len(rawText), 200)]),
			zap.Error(parseErr))
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":  "LLM returned unparseable JSON: " + parseErr.Error(),
			"detail": rawText[:min(len(rawText), 500)],
		})
		return
	}

	// 5. Store — only on a clean parse (never store garbage).
	planJSON, _ := json.Marshal(plan)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE commitments
			SET action_plan = $1::jsonb, status = 'suggested', updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, string(planJSON), id, tenantID)
		return e
	})
	if err != nil {
		h.logger().Error("research: store action_plan failed", zap.String("id", id), zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to store action plan"})
		return
	}

	h.logger().Info("research: stored action plan",
		zap.String("id", id), zap.String("tenant", tenantID),
		zap.Int("steps", len(plan.Steps)))

	writeJSON(w, http.StatusOK, plan)
}

// parseActionPlan strips code fences and prose from raw LLM output and
// unmarshals it into an ActionPlan. Returns an error if no valid JSON
// object is found or it doesn't have at least a non-empty Summary.
func parseActionPlan(raw string) (*ActionPlan, error) {
	// Strip common code-fence patterns: ```json ... ```, ``` ... ```.
	s := strings.TrimSpace(raw)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		// skip optional "json" tag
		if strings.HasPrefix(s, "json") {
			s = s[4:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
		s = strings.TrimSpace(s)
	}
	// Find the first '{' in case there is leading prose.
	if start := strings.Index(s, "{"); start != -1 {
		s = s[start:]
	}
	// Find the last '}' to trim trailing prose.
	if end := strings.LastIndex(s, "}"); end != -1 {
		s = s[:end+1]
	}

	var plan ActionPlan
	if err := json.Unmarshal([]byte(s), &plan); err != nil {
		return nil, fmt.Errorf("json.Unmarshal: %w", err)
	}
	if strings.TrimSpace(plan.Summary) == "" {
		return nil, fmt.Errorf("parsed plan has empty summary — likely incomplete model output")
	}
	return &plan, nil
}
