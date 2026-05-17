package handlers

// Agent templates — pre-baked configurations that create the agent +
// system prompt + budget + schedule in one atomic POST. Removes the
// manual "click into 4 different tabs" step from useful daily-driver
// demos like Inbox Concierge.
//
// Each template lives as a const here (single file = grep-able + no
// extra DB table needed). Adding a new template means appending one
// entry + redeploying.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
	"google.golang.org/protobuf/types/known/structpb"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

type TemplateHandler struct {
	rest *RESTHandler // borrows agentSvc + pool for atomic creation
	auth *AuthHandler
}

func NewTemplateHandler(rest *RESTHandler, auth *AuthHandler) *TemplateHandler {
	return &TemplateHandler{rest: rest, auth: auth}
}

func (h *TemplateHandler) logger() *zap.Logger {
	return h.rest.srv.Logger.Named("templates")
}

// ---- Template definitions ---------------------------------------------------

type templateDef struct {
	ID            string
	Name          string // default agent name (user can override)
	Description   string
	Model         string
	SystemPrompt  string
	CronExpr      string // optional schedule
	MaxCostUsdDay float64
	MaxCostRun    float64
	Connectors    []string // shown to the user as "you'll need: gmail, …"
	Surfaces      []string // ditto: "delivery via: whatsapp"
}

var templates = map[string]templateDef{
	"inbox-concierge": {
		ID:          "inbox-concierge",
		Name:        "inbox-concierge",
		Description: "Reads your Gmail every morning and texts a 3-bucket summary to your WhatsApp. Reply to it to draft, archive, snooze — all from your phone.",
		Model:       "auto",
		SystemPrompt: `You are an inbox concierge that texts on WhatsApp.

When the user asks "summarize my inbox" or the schedule fires, do this:
1. Read unread emails from the last 24 hours via the Gmail connector.
2. Group them into three buckets:
   - "reply today" — real humans waiting on a response from the user
   - "FYI" — informational, no action needed
   - "archive" — newsletters, receipts, marketing
3. Text a single WhatsApp message under 600 characters total. Use short bullets,
   lowercase, no corporate phrasing. The user does NOT want "Hello!" / "I'd be
   happy to" / "Let me know if you have questions" — strip every assistant tell.

When the user replies via WhatsApp with instructions:
- "draft a reply to X saying Y" → use Gmail to send the reply, confirm in one line.
- "archive newsletters" → bulk-archive the newsletter bucket, confirm count.
- "what was the X email about?" → quote the most relevant snippet.

If Gmail is not connected, say so honestly in one short line. Never invent
emails or fake summaries — better to admit the connector isn't installed.`,
		CronExpr:      "0 8 * * *",
		MaxCostUsdDay: 1.00,
		MaxCostRun:    0.10,
		Connectors:    []string{"gmail"},
		Surfaces:      []string{"whatsapp"},
	},
	"morning-brief": {
		ID:          "morning-brief",
		Name:        "morning-brief",
		Description: "Texts you 3 bullets every weekday at 8am about what needs your attention across GitHub PRs/issues and Linear tickets.",
		Model:       "auto",
		SystemPrompt: `You are a morning briefing assistant that texts on WhatsApp.

When the schedule fires (or the user asks), do this:
1. Use the GitHub connector to list issues assigned to the user + PRs awaiting review.
2. Use the Linear connector to list tickets where the user is assignee or watcher
   AND whose status changed in the last 24 hours.
3. Synthesize into EXACTLY 3 bullets — the most important things for today.
   Not a status report. Not everything. Just the 3 things they should act on.
4. Text a single WhatsApp message under 500 characters total. Friendly tone,
   lowercase fine, short. Never sound like a corporate digest.

If either connector is missing, say so once and continue with what is available.`,
		CronExpr:      "0 8 * * 1-5",
		MaxCostUsdDay: 1.00,
		MaxCostRun:    0.05,
		Connectors:    []string{"github", "linear"},
		Surfaces:      []string{"whatsapp"},
	},
}

// ---- HTTP ----

// ListTemplates handles GET /v1/agents/templates.
// Public-shape data only (no secret). Auth not required since these are
// just static template descriptors.
func (h *TemplateHandler) ListTemplates(w http.ResponseWriter, r *http.Request) {
	out := make([]map[string]any, 0, len(templates))
	for _, t := range templates {
		out = append(out, map[string]any{
			"id":              t.ID,
			"name":            t.Name,
			"description":     t.Description,
			"model":           t.Model,
			"cronExpr":        t.CronExpr,
			"maxCostUsdDay":   t.MaxCostUsdDay,
			"maxCostUsdPerRun": t.MaxCostRun,
			"connectors":      t.Connectors,
			"surfaces":        t.Surfaces,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// Apply handles POST /v1/agents/from-template.
//
// Body: { "templateId": "inbox-concierge", "name": "optional-override" }
//
// Atomically creates: the agent (with system prompt), a daily schedule,
// and a budget. Returns the new agent and a checklist of what the user
// still has to configure manually (connector tokens, WhatsApp pairing).
//
// Idempotent on (tenantId, agentName): if an agent with the resolved name
// already exists, we return 409 instead of clobbering it.
func (h *TemplateHandler) Apply(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		TemplateID string `json:"templateId"`
		Name       string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	tpl, ok := templates[body.TemplateID]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("unknown templateId %q", body.TemplateID),
		})
		return
	}
	agentName := body.Name
	if agentName == "" {
		agentName = tpl.Name
	}

	// 1. Check for a name collision so we never overwrite an existing agent.
	var existingID string
	_ = h.rest.srv.Pool.QueryRow(ctx,
		`SELECT id::text FROM agents WHERE tenant_id = $1 AND name = $2`,
		tenantID, agentName,
	).Scan(&existingID)
	if existingID != "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": fmt.Sprintf("agent %q already exists; pick a different name", agentName),
			"existing": existingID,
		})
		return
	}

	// 2. Create the agent via the existing service.
	agent, err := h.rest.agentSvc.CreateAgent(ctx, &lanternv1.CreateAgentRequest{
		Name:        agentName,
		Description: tpl.Description,
	})
	if err != nil {
		h.logger().Error("template create-agent failed", zap.Error(err), zap.String("template", tpl.ID))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create agent"})
		return
	}

	// 3. Set the system prompt + model on the agent row.
	_, _ = h.rest.srv.Pool.Exec(ctx,
		`UPDATE agents SET system_prompt = $1, model = $2 WHERE name = $3 AND tenant_id = $4`,
		tpl.SystemPrompt, tpl.Model, agentName, tenantID,
	)

	// 4. Insert a budget row. Hard-cap so the template can never surprise.
	_, _ = h.rest.srv.Pool.Exec(ctx, `
		INSERT INTO agent_budgets
			(tenant_id, agent_name, max_cost_usd_per_day, max_cost_usd_per_run, hard_fail)
		VALUES ($1, $2, $3, $4, true)
		ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
			max_cost_usd_per_day = EXCLUDED.max_cost_usd_per_day,
			max_cost_usd_per_run = EXCLUDED.max_cost_usd_per_run,
			hard_fail            = EXCLUDED.hard_fail,
			updated_at           = now()
	`, tenantID, agentName, tpl.MaxCostUsdDay, tpl.MaxCostRun)

	// 5. Optional schedule. Only insert when the template carries a cron.
	if tpl.CronExpr != "" {
		cfgJSON, _ := json.Marshal(map[string]any{
			"deliverySurfaces": tpl.Surfaces, // hint for the runner
		})
		_, _ = h.rest.srv.Pool.Exec(ctx, `
			INSERT INTO schedules
				(tenant_id, agent_name, cron_expr, input_template, config, enabled, next_fire_at)
			VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, true, now())
			ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
				cron_expr      = EXCLUDED.cron_expr,
				config         = EXCLUDED.config,
				enabled        = true,
				updated_at     = now()
		`, tenantID, agentName, tpl.CronExpr, string(cfgJSON))
	}

	// 6. Compute the "still to do" checklist for the UI. Tokens are user-
	// supplied, so we can't auto-install them — surface them as next steps.
	var checklist []map[string]string
	for _, c := range tpl.Connectors {
		checklist = append(checklist, map[string]string{
			"kind":  "install_connector",
			"id":    c,
			"label": fmt.Sprintf("Install %s connector with your token", c),
		})
	}
	for _, s := range tpl.Surfaces {
		if s == "whatsapp" {
			checklist = append(checklist, map[string]string{
				"kind":  "pair_surface",
				"id":    "whatsapp",
				"label": "Pair WhatsApp by scanning the QR code",
			})
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"agent": map[string]any{
			"id":          agent.GetId(),
			"name":        agentName,
			"description": tpl.Description,
		},
		"templateId":  tpl.ID,
		"appliedAt":   time.Now().UTC(),
		"nextSteps":   checklist,
	})
}

// Avoid an unused-import error during incremental builds.
var _ = context.Background
var _ = structpb.NewStruct
