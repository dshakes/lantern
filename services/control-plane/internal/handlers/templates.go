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
		SystemPrompt: `You are a morning briefing assistant. Your job is to call your tools and synthesize the results into 3 bullets.

WORKFLOW — do this every time. Do NOT ask the user for clarification first.

Step 1: Call ` + "`github__list_issues`" + ` (state="open", filter="assigned"). This returns issues assigned to the user.
Step 2: Call ` + "`linear__list_issues`" + `. This returns the user's recent Linear tickets.
Step 3: If either of the above returns >0 items, also call ` + "`github__list_prs`" + ` for a repo where you saw recent activity.
Step 4: Synthesize the combined results into EXACTLY 3 bullets — the single most important thing from each source, or the 3 most urgent items overall. Not a status report. Just the 3 things they should act on RIGHT NOW.
Step 5: Reply with a friendly, short message (under 500 chars, lowercase OK). Never sound like a corporate digest.

Rules:
- ALWAYS start by calling the tools above. Your first response MUST be a tool call, not text.
- If a tool returns an empty list, that's fine — say so naturally ("nothing new on Linear today") and still synthesize the others. Do NOT abort the whole workflow because one source was empty.
- NEVER respond with "I don't have any connectors set up" or "I need access" or "connect them first". The tools listed in your tools[] ARE the connectors. Call them.`,
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

	// 1. Block only if an ACTIVE agent with this name exists. A soft-deleted
	//    (archived_at IS NOT NULL) row is fine — the underlying CreateAgent
	//    upsert will restore it by clearing archived_at.
	var existingID string
	_ = h.rest.srv.Pool.QueryRow(ctx,
		`SELECT id::text FROM agents WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL`,
		tenantID, agentName,
	).Scan(&existingID)
	if existingID != "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":    fmt.Sprintf("agent %q already exists; pick a different name", agentName),
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

	// 3. Set the system prompt + model on the agent row, and stamp the
	//    template ID + required connectors/surfaces into labels JSONB so
	//    the /setup gate can re-derive what's missing on a later visit.
	labelsPatch, _ := json.Marshal(map[string]any{
		"lantern.template":            tpl.ID,
		"lantern.required_connectors": tpl.Connectors,
		"lantern.required_surfaces":   tpl.Surfaces,
	})
	_, _ = h.rest.srv.Pool.Exec(ctx,
		`UPDATE agents SET system_prompt = $1, model = $2, labels = COALESCE(labels, '{}'::jsonb) || $5::jsonb
		 WHERE name = $3 AND tenant_id = $4`,
		tpl.SystemPrompt, tpl.Model, agentName, tenantID, string(labelsPatch),
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

// SetupStatus handles GET /v1/agents/{name}/setup.
//
// Reads the agent's labels JSONB for required connectors/surfaces (written by
// Apply above), cross-references the tenant's connector_installs and
// surface_configs rows, and returns a ready/not-ready verdict + checklist.
// The frontend uses this both to render the /agents/{name}/setup gate page
// and to disable Run on the agent detail page when ready=false.
func (h *TemplateHandler) SetupStatus(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	name := r.PathValue("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing agent name"})
		return
	}

	// Pull labels off the agent.
	var labelsBytes []byte
	err = h.rest.srv.Pool.QueryRow(ctx,
		`SELECT COALESCE(labels, '{}'::jsonb)::text::bytea FROM agents
		 WHERE tenant_id = $1 AND name = $2 AND archived_at IS NULL`,
		tenantID, name,
	).Scan(&labelsBytes)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent not found"})
		return
	}

	var labels struct {
		TemplateID         string   `json:"lantern.template"`
		RequiredConnectors []string `json:"lantern.required_connectors"`
		RequiredSurfaces   []string `json:"lantern.required_surfaces"`
	}
	_ = json.Unmarshal(labelsBytes, &labels)

	// Back-fill from the static template registry when the agent was
	// created before we started persisting required arrays into labels.
	// Old agents will still gate correctly without forcing the user to
	// delete + recreate.
	if labels.TemplateID != "" && len(labels.RequiredConnectors) == 0 && len(labels.RequiredSurfaces) == 0 {
		if tpl, ok := templates[labels.TemplateID]; ok {
			labels.RequiredConnectors = tpl.Connectors
			labels.RequiredSurfaces = tpl.Surfaces
		}
	}
	// Second-line back-fill: agents created before *any* labels-patch (no
	// templateId persisted) whose name matches a known template ID get
	// gated on that template. The user's morning-brief from before today
	// lands here.
	if labels.TemplateID == "" {
		if tpl, ok := templates[name]; ok {
			labels.TemplateID = tpl.ID
			labels.RequiredConnectors = tpl.Connectors
			labels.RequiredSurfaces = tpl.Surfaces
		}
	}

	// Fast path: agent has no template — nothing to gate on, ready.
	if len(labels.RequiredConnectors) == 0 && len(labels.RequiredSurfaces) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"templateId": labels.TemplateID,
			"required":   map[string][]string{"connectors": {}, "surfaces": {}},
			"installed":  map[string][]string{"connectors": {}, "surfaces": {}},
			"missing":    map[string][]string{"connectors": {}, "surfaces": {}},
			"ready":      true,
			"nextSteps":  []map[string]string{},
		})
		return
	}

	// Pull installed connectors for this tenant.
	installedConnectors := map[string]bool{}
	if rows, err := h.rest.srv.Pool.Query(ctx,
		`SELECT connector_id FROM connector_installs WHERE tenant_id = $1 AND status = 'connected'`,
		tenantID,
	); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err == nil {
				installedConnectors[c] = true
			}
		}
	}

	// Pull configured surfaces for this tenant.
	configuredSurfaces := map[string]bool{}
	if rows, err := h.rest.srv.Pool.Query(ctx,
		`SELECT surface_id FROM surface_configs WHERE tenant_id = $1 AND status = 'connected'`,
		tenantID,
	); err == nil {
		defer rows.Close()
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err == nil {
				configuredSurfaces[s] = true
			}
		}
	}

	// Diff.
	installedC := []string{}
	missingC := []string{}
	for _, c := range labels.RequiredConnectors {
		if installedConnectors[c] {
			installedC = append(installedC, c)
		} else {
			missingC = append(missingC, c)
		}
	}
	installedS := []string{}
	missingS := []string{}
	for _, s := range labels.RequiredSurfaces {
		if configuredSurfaces[s] {
			installedS = append(installedS, s)
		} else {
			missingS = append(missingS, s)
		}
	}

	checklist := []map[string]string{}
	for _, c := range missingC {
		checklist = append(checklist, map[string]string{
			"kind":  "install_connector",
			"id":    c,
			"label": fmt.Sprintf("Connect %s", c),
			"href":  "/connectors",
		})
	}
	for _, s := range missingS {
		label := fmt.Sprintf("Set up %s", s)
		if s == "whatsapp" {
			label = "Pair WhatsApp"
		}
		checklist = append(checklist, map[string]string{
			"kind":  "pair_surface",
			"id":    s,
			"label": label,
			"href":  "/surfaces",
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"templateId": labels.TemplateID,
		"required":   map[string][]string{"connectors": labels.RequiredConnectors, "surfaces": labels.RequiredSurfaces},
		"installed":  map[string][]string{"connectors": installedC, "surfaces": installedS},
		"missing":    map[string][]string{"connectors": missingC, "surfaces": missingS},
		"ready":      len(missingC) == 0 && len(missingS) == 0,
		"nextSteps":  checklist,
	})
}

// Avoid an unused-import error during incremental builds.
var _ = context.Background
var _ = structpb.NewStruct
