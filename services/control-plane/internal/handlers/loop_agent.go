package handlers

// Loop-agent platform primitive (Stage 3 / Part B).
//
//   B1. POST /v1/agents/loop  — single-prompt creator (LoopAgentHandler).
//   B2. runLoopAgentIfPresent — called from executeRunInlineSync to detect and
//       dispatch a loop-type agent run by Role.
//   B3. Loop bodies:
//       concierge         → scanAndNudgeCommitments (existing)
//       chief_of_staff    → runChiefOfStaffBrief
//       inbox_autopilot   → runInboxAutopilot / processInboxMessages
//       relationship_keeper → runRelationshipKeeper
//   B4. SeedLoopAgents    — idempotent dev seeding of all built-in loop agents.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/scheduler"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ---------- LoopManifest ----------

// LoopManifest is the agent_versions.manifest shape for loop agents.
// Written by CreateLoopAgent (B1), read by runLoopAgentIfPresent (B2).
type LoopManifest struct {
	Type    string   `json:"type"` // always "loop"
	Role    string   `json:"role"` // concierge|chief_of_staff|inbox_autopilot|relationship_keeper; default "concierge"
	Name    string   `json:"name"`
	Goal    string   `json:"goal"`    // what the loop watches / does
	Tier    string   `json:"tier"`    // nano|micro|meso|macro|mega
	Cron    string   `json:"cron"`    // 5-field cron; derived from tier when absent/invalid
	Sensors []string `json:"sensors"` // e.g. ["commitments","life_events","signals"]
	Actions []string `json:"actions"` // e.g. ["nudge","draft","calendar","research"]
	Trust   string   `json:"trust"`   // "ask" | "auto_safe" | "manual"
}

// tierCronDefault maps tier to the canonical 5-field cron expression.
// nano has no schedule (event-driven; CreateLoopAgent skips the schedule row).
// All expressions validated against scheduler.NextCronTime before insert.
var tierCronDefault = map[string]string{
	"micro": "*/5 * * * *",
	"meso":  "*/45 * * * *",
	"macro": "0 8 * * *",
	"mega":  "0 9 * * 1",
}

// ---------- B1: LoopAgentHandler ----------

// LoopAgentHandler implements POST /v1/agents/loop.
type LoopAgentHandler struct {
	srv      *server.Server
	auth     *AuthHandler
	llmProxy *LlmProxyHandler
}

// NewLoopAgentHandler creates a LoopAgentHandler.
func NewLoopAgentHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *LoopAgentHandler {
	return &LoopAgentHandler{srv: srv, auth: auth, llmProxy: llm}
}

func (h *LoopAgentHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("loop-agent")
}

// CreateLoopAgent handles POST /v1/agents/loop.
//
// Body: {prompt (required), name?}.
//
// Flow:
//  1. LLM → LoopManifest (with tier→cron defaults).
//  2. Create agent + agent_version (manifest = LoopManifest). Idempotent on name.
//  3. If tier != nano: create/upsert schedule row.
//  4. Return {agentName, scheduleId?, manifest}.
func (h *LoopAgentHandler) CreateLoopAgent(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	tenantID := claims.TenantID

	var body struct {
		Prompt string `json:"prompt"`
		Name   string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "prompt is required"})
		return
	}

	if h.llmProxy == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LLM not configured"})
		return
	}

	// 1. Generate LoopManifest via LLM.
	manifest, err := h.generateLoopManifest(ctx, tenantID, body.Prompt, body.Name)
	if err != nil {
		h.logger().Error("CreateLoopAgent: manifest generation failed", zap.Error(err))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "manifest generation failed: " + err.Error()})
		return
	}

	// 2. Create agent + version (WithTenant for RLS scoping).
	var agentName, versionID string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		// Insert/upsert agent.
		var agentID string
		if qErr := tx.QueryRow(ctx, `
			INSERT INTO agents (tenant_id, name, description)
			VALUES ($1, $2, $3)
			ON CONFLICT (tenant_id, name) DO UPDATE
				SET description = EXCLUDED.description, archived_at = NULL
			RETURNING id
		`, tenantID, manifest.Name, manifest.Goal).Scan(&agentID); qErr != nil {
			return fmt.Errorf("insert agent: %w", qErr)
		}
		agentName = manifest.Name

		// Insert/upsert agent_version with the loop manifest.
		manifestJSON, _ := json.Marshal(manifest)
		// ON CONFLICT on (agent_id, version) so re-runs are idempotent.
		if qErr := tx.QueryRow(ctx, `
			INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
			VALUES ($1, 'loop-v1', decode(md5($2), 'hex'), 'local://loop', $3::jsonb)
			ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
			RETURNING id
		`, agentID, manifest.Name+"-loop-v1", string(manifestJSON)).Scan(&versionID); qErr != nil {
			return fmt.Errorf("insert agent_version: %w", qErr)
		}

		// Promote the version.
		if _, qErr := tx.Exec(ctx,
			`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
			versionID, agentID,
		); qErr != nil {
			return fmt.Errorf("promote version: %w", qErr)
		}
		return nil
	})
	if err != nil {
		h.logger().Error("CreateLoopAgent: DB write failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create loop agent"})
		return
	}

	// 3. Create schedule (skip for nano — event-driven only).
	var scheduleID string
	if manifest.Tier != "nano" && manifest.Cron != "" {
		nextFire, cronErr := scheduler.NextCronTime(manifest.Cron, time.Now())
		if cronErr != nil {
			h.logger().Warn("CreateLoopAgent: invalid cron — skipping schedule",
				zap.String("cron", manifest.Cron), zap.Error(cronErr))
		} else {
			err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `
					INSERT INTO schedules (tenant_id, agent_name, cron_expr, input_template, config, enabled, next_fire_at)
					VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, true, $4)
					ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
						cron_expr    = EXCLUDED.cron_expr,
						next_fire_at = EXCLUDED.next_fire_at,
						enabled      = true,
						updated_at   = now()
					RETURNING id
				`, tenantID, agentName, manifest.Cron, nextFire).Scan(&scheduleID)
			})
			if err != nil {
				h.logger().Error("CreateLoopAgent: schedule insert failed", zap.Error(err))
				// Non-fatal: agent + version already committed; log and continue.
			}
		}
	}

	h.logger().Info("loop agent created",
		zap.String("tenant", tenantID), zap.String("agent", agentName),
		zap.String("role", manifest.Role), zap.String("tier", manifest.Tier),
		zap.String("cron", manifest.Cron))

	resp := map[string]any{
		"agentName": agentName,
		"manifest":  manifest,
	}
	if scheduleID != "" {
		resp["scheduleId"] = scheduleID
	}
	writeJSON(w, http.StatusCreated, resp)
}

// generateLoopManifest calls the LLM to produce a LoopManifest from a
// natural-language prompt. Falls back to tier-based cron defaults when the
// model omits or returns an invalid expression.
func (h *LoopAgentHandler) generateLoopManifest(ctx context.Context, tenantID, prompt, preferredName string) (*LoopManifest, error) {
	systemPrompt := `You are Lantern's loop-agent architect. Given a description, generate a structured loop-agent manifest.

Output ONLY valid JSON with this exact structure (no markdown, no backticks, no explanation):
{
  "type": "loop",
  "role": "concierge",
  "name": "kebab-case-name",
  "goal": "one sentence: what this loop monitors or does",
  "tier": "meso",
  "cron": "*/45 * * * *",
  "sensors": ["commitments"],
  "actions": ["nudge"],
  "trust": "ask"
}

Valid roles (pick the one that best matches the description):
  concierge           → monitors open commitments, nudges the owner (default)
  chief_of_staff      → composes a concise morning brief (tier=macro)
  inbox_autopilot     → polls email for new actionable messages (tier=meso)
  relationship_keeper → surfaces stale VIP contacts for outreach (tier=mega)

Valid tiers and their default crons:
  nano   → no schedule (event-driven only); omit cron
  micro  → "*/5 * * * *"  (every 5 min)
  meso   → "*/45 * * * *" (every 45 min)
  macro  → "0 8 * * *"    (daily at 8am)
  mega   → "0 9 * * 1"    (weekly Monday 9am)

Valid sensors: commitments, life_events, signals, calendar, email, people
Valid actions: nudge, draft, calendar, research, remind, escalate, brief, create_commitment
Valid trust: ask (owner approves), auto_safe (auto-act for low-risk), manual (never auto)

Pick the right tier for the cadence described. Use kebab-case for name.`

	userPrompt := prompt
	if preferredName != "" {
		userPrompt = fmt.Sprintf("Name: %s\nDescription: %s", preferredName, prompt)
	}

	// Stamp idempotency base so provider-level dedup works (invariant #8).
	idemBase := "loop-manifest:" + tenantID + ":" + prompt
	callCtx := WithLLMIdempotencyBase(ctx, idemBase)

	rawText, err := h.llmProxy.CompleteInternal(callCtx, tenantID, systemPrompt, userPrompt, 0)
	if err != nil {
		return nil, fmt.Errorf("LLM call: %w", err)
	}

	manifest, err := parseLoopManifest(rawText)
	if err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}

	// Override name if caller provided one.
	if preferredName != "" {
		manifest.Name = preferredName
	}

	// Apply tier→cron default when the model omits or returns invalid cron.
	if def, ok := tierCronDefault[manifest.Tier]; ok {
		if manifest.Cron == "" {
			manifest.Cron = def
		} else if _, err := scheduler.NextCronTime(manifest.Cron, time.Now()); err != nil {
			manifest.Cron = def
		}
	} else if manifest.Tier == "nano" {
		manifest.Cron = "" // no schedule for nano
	}

	return manifest, nil
}

// parseLoopManifest strips code fences and unmarshals a LoopManifest.
func parseLoopManifest(raw string) (*LoopManifest, error) {
	s := strings.TrimSpace(raw)
	if idx := strings.Index(s, "```"); idx != -1 {
		s = s[idx+3:]
		if strings.HasPrefix(s, "json") {
			s = s[4:]
		}
		if end := strings.Index(s, "```"); end != -1 {
			s = s[:end]
		}
		s = strings.TrimSpace(s)
	}
	if start := strings.Index(s, "{"); start != -1 {
		s = s[start:]
	}
	if end := strings.LastIndex(s, "}"); end != -1 {
		s = s[:end+1]
	}

	var m LoopManifest
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, fmt.Errorf("json.Unmarshal: %w", err)
	}
	if m.Type == "" {
		m.Type = "loop"
	}
	if m.Name == "" {
		return nil, fmt.Errorf("manifest missing name")
	}
	if m.Tier == "" {
		m.Tier = "meso"
	}
	if m.Trust == "" {
		m.Trust = "ask"
	}
	if m.Role == "" {
		m.Role = "concierge"
	}
	return &m, nil
}

// ---------- B2: loop executor (called from executeRunInlineSync) ----------

// runLoopAgentIfPresent checks whether the given agent's current version has
// a loop-type manifest, and if so runs the loop body instead of the plain LLM
// path. Returns true when the loop was dispatched (caller must not also run
// the plain path).
//
// Dispatches by Role:
//   - "concierge" (default)    → scanAndNudgeCommitments
//   - "chief_of_staff"         → runChiefOfStaffBrief
//   - "inbox_autopilot"        → runInboxAutopilot
//   - "relationship_keeper"    → runRelationshipKeeper
//
// completeFn is the injectable LLM seam; nil → LLM-optional bodies fall back
// to their template path. Called from executeRunInlineSync.
func runLoopAgentIfPresent(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, agentName, runID string,
	completeFn researchCompleteFn,
) bool {
	// Read the current version's manifest (agent_versions is RLS-exempt: no
	// tenant_id column; the FK to agents provides indirect scoping; we carry
	// the explicit tenant_id join for defence-in-depth).
	// rls-exempt: agent_versions has no tenant_id column; scoped by joining
	// agents.tenant_id = $2 and agents.name = $1.
	var manifestJSON []byte
	err := pool.QueryRow(ctx, `
		SELECT av.manifest
		FROM   agent_versions av
		JOIN   agents a ON a.current_version_id = av.id
		WHERE  a.name = $1 AND a.tenant_id = $2
		LIMIT  1
	`, agentName, tenantID).Scan(&manifestJSON)
	if err != nil || len(manifestJSON) == 0 {
		return false
	}

	var m LoopManifest
	if err := json.Unmarshal(manifestJSON, &m); err != nil || m.Type != "loop" {
		return false
	}

	// Default role to concierge for backward compat (existing agents have no role field).
	role := m.Role
	if role == "" {
		role = "concierge"
	}

	logger.Info("loop-agent: dispatching loop run",
		zap.String("agent", agentName), zap.String("run_id", runID),
		zap.String("role", role), zap.String("tier", m.Tier))

	var outputJSON []byte
	switch role {
	case "chief_of_staff":
		briefChars, runErr := runChiefOfStaffBrief(ctx, pool, logger, tenantID, runID, completeFn)
		if runErr != nil {
			logger.Error("loop-agent: chief_of_staff brief failed",
				zap.String("run_id", runID), zap.Error(runErr))
		}
		outputJSON, _ = json.Marshal(map[string]any{"brief_chars": briefChars})

	case "inbox_autopilot":
		newN, createdM, runErr := runInboxAutopilot(ctx, pool, logger, tenantID, runID)
		if runErr != nil {
			logger.Error("loop-agent: inbox_autopilot failed",
				zap.String("run_id", runID), zap.Error(runErr))
		}
		outputJSON, _ = json.Marshal(map[string]any{"new": newN, "created": createdM})

	case "relationship_keeper":
		surfaced, runErr := runRelationshipKeeper(ctx, pool, logger, tenantID, runID)
		if runErr != nil {
			logger.Error("loop-agent: relationship_keeper failed",
				zap.String("run_id", runID), zap.Error(runErr))
		}
		outputJSON, _ = json.Marshal(map[string]any{"surfaced": surfaced})

	default: // "concierge" + any unrecognised role
		surfaced := 0
		for _, sensor := range m.Sensors {
			if sensor == "commitments" {
				n, scanErr := scanAndNudgeCommitments(ctx, pool, logger, tenantID, runID)
				if scanErr != nil {
					logger.Error("loop-agent: commitments scan failed",
						zap.String("run_id", runID), zap.Error(scanErr))
				}
				surfaced += n
			}
			// Future sensors (life_events, signals, calendar) handled here.
		}
		outputJSON, _ = json.Marshal(map[string]any{"surfaced": surfaced})
	}

	// Write a terminal journal event summarising the run output.
	// rls-exempt: journal_events is RLS-exempt (no tenant_id; keyed by run_id).
	seq := int64(10000)
	_, _ = pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, $2, 'loop_complete', 'loop', 1, $3)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, seq, outputJSON)

	return true
}

// scanAndNudgeCommitments scans open/suggested/in_progress commitments whose
// next_nudge_at is due, advances the nudge time with escalating cadence, and
// emits a journal_events row per surfaced commitment.
//
// The pool is passed directly because this runs in the detached inline executor
// goroutine (context.Background(), no JWT, no tenant scope from WithTenant).
// The explicit `tenant_id = $1` filter provides the same isolation.
// rls-exempt: inline executor — commitments access carries explicit tenant_id;
// journal_events is RLS-exempt child table.
func scanAndNudgeCommitments(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
) (int, error) {
	type dueRow struct {
		id          string
		title       string
		tier        string
		urgency     string
		createdAt   time.Time
		nextNudgeAt *time.Time
	}

	rows, err := pool.Query(ctx, `
		SELECT id, title, tier, urgency, created_at, next_nudge_at
		FROM   commitments
		WHERE  tenant_id = $1
		  AND  status IN ('open', 'suggested', 'in_progress')
		  AND  (next_nudge_at IS NULL OR next_nudge_at <= now())
		ORDER BY
			CASE urgency
				WHEN 'now'    THEN 1
				WHEN 'soon'   THEN 2
				WHEN 'normal' THEN 3
				WHEN 'fyi'    THEN 4
				ELSE 5
			END,
			deadline NULLS LAST
	`, tenantID)
	if err != nil {
		return 0, fmt.Errorf("scanAndNudge: query: %w", err)
	}
	defer rows.Close()

	var due []dueRow
	for rows.Next() {
		var d dueRow
		if scanErr := rows.Scan(&d.id, &d.title, &d.tier, &d.urgency,
			&d.createdAt, &d.nextNudgeAt); scanErr != nil {
			logger.Error("loop-agent: scan row failed", zap.Error(scanErr))
			continue
		}
		due = append(due, d)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("scanAndNudge: rows: %w", err)
	}

	now := time.Now()
	surfaced := 0
	for i, d := range due {
		next := nextNudgeAt(d.nextNudgeAt, d.createdAt, now)

		// Advance next_nudge_at. Status is NOT changed here.
		if _, updErr := pool.Exec(ctx, `
			UPDATE commitments SET next_nudge_at = $1, updated_at = now()
			WHERE id = $2 AND tenant_id = $3
		`, next, d.id, tenantID); updErr != nil {
			logger.Error("loop-agent: advance nudge failed",
				zap.String("commitment_id", d.id), zap.Error(updErr))
			continue
		}

		// Emit journal event (seq = i+1 to keep them distinct within this run).
		payload, _ := json.Marshal(map[string]any{
			"commitment_id": d.id,
			"title":         d.title,
			"tier":          d.tier,
			"urgency":       d.urgency,
		})
		// rls-exempt: journal_events — RLS-exempt child table keyed by run_id.
		if _, evErr := pool.Exec(ctx, `
			INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
			VALUES ($1, $2, 'loop_nudge', $3, 1, $4)
			ON CONFLICT (run_id, seq) DO NOTHING
		`, runID, int64(i+1), d.id, payload); evErr != nil {
			logger.Error("loop-agent: emit journal event failed",
				zap.String("commitment_id", d.id), zap.Error(evErr))
		}
		surfaced++
	}

	return surfaced, nil
}

// nextNudgeAt returns the next time a commitment should be surfaced.
// Cadence escalates based on age since creation (proxy for how many times
// the loop has already nudged this item):
//
//	first nudge         → now + 45m
//	age < 2h since born → now + 2h
//	age < 8h since born → now + 6h
//	age ≥ 8h            → now + 24h
//
// ponytail: no attempt counter column — age is a safe proxy that avoids
// schema changes. Add an attempt column if finer-grained control is needed.
func nextNudgeAt(lastNudge *time.Time, createdAt, now time.Time) time.Time {
	if lastNudge == nil {
		return now.Add(45 * time.Minute)
	}
	age := now.Sub(createdAt)
	switch {
	case age < 2*time.Hour:
		return now.Add(2 * time.Hour)
	case age < 8*time.Hour:
		return now.Add(6 * time.Hour)
	default:
		return now.Add(24 * time.Hour)
	}
}

// ---------- B3a: chief_of_staff body ----------

// runChiefOfStaffBrief composes a concise morning brief from open commitments
// and recent life events, persists it as a daily_brief journal event, and
// returns the character count of the brief text.
//
// LLM fallback: if completeFn is nil or the call fails, a deterministic
// template brief is used so the run never fails due to a missing LLM.
//
// rls-exempt: inline executor — all queries carry explicit tenant_id filter;
// journal_events is RLS-exempt child table.
func runChiefOfStaffBrief(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
	completeFn researchCompleteFn,
) (briefChars int, err error) {
	now := time.Now()

	// 1. Read open/urgent commitments (top 10 by urgency).
	type briefItem struct{ title, urgency string }
	var commitments []briefItem
	rows, qErr := pool.Query(ctx, `
		SELECT title, urgency FROM commitments
		WHERE  tenant_id = $1
		  AND  status IN ('open', 'suggested', 'in_progress')
		ORDER BY
			CASE urgency
				WHEN 'now'    THEN 1
				WHEN 'soon'   THEN 2
				WHEN 'normal' THEN 3
				ELSE 4
			END
		LIMIT 10
	`, tenantID)
	if qErr != nil {
		return 0, fmt.Errorf("chief_of_staff: query commitments: %w", qErr)
	}
	for rows.Next() {
		var bi briefItem
		if sErr := rows.Scan(&bi.title, &bi.urgency); sErr == nil {
			commitments = append(commitments, bi)
		}
	}
	rows.Close()
	if rErr := rows.Err(); rErr != nil {
		logger.Warn("chief_of_staff: commitments rows error", zap.Error(rErr))
	}

	// 2. Count recent life events (last 24h).
	var lifeEventCount int
	_ = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM life_events
		WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'
	`, tenantID).Scan(&lifeEventCount)

	// 3. Compose brief — try LLM first, fall back to template.
	var briefText string
	if completeFn != nil {
		var topItems strings.Builder
		for i, c := range commitments {
			if i >= 5 {
				break
			}
			topItems.WriteString(fmt.Sprintf("  - [%s] %s\n", c.urgency, c.title))
		}
		systemPrompt := `You are a personal chief-of-staff AI. Write a concise morning brief (3–6 sentences, plain text, no bullet points, no markdown). Be direct and actionable.`
		userPrompt := fmt.Sprintf(
			"Date: %s\nOpen items (%d total, top %d shown):\n%sLife events in last 24h: %d\nWrite the brief.",
			now.Format("Mon Jan 2, 2006"),
			len(commitments), min(len(commitments), 5),
			topItems.String(),
			lifeEventCount,
		)
		// Idempotency key scoped to tenant + calendar day (invariant #8).
		idemCtx := WithLLMIdempotencyBase(ctx, "daily-brief:"+tenantID+":"+now.Format("2006-01-02"))
		llmText, llmErr := completeFn(idemCtx, tenantID, systemPrompt, userPrompt)
		if llmErr != nil {
			logger.Warn("chief_of_staff: LLM call failed — using template brief",
				zap.String("tenant", tenantID), zap.Error(llmErr))
		} else {
			briefText = strings.TrimSpace(llmText)
		}
	}

	if briefText == "" {
		// Template fallback — always succeeds.
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("Morning brief for %s: ", now.Format("Mon Jan 2")))
		if len(commitments) > 0 {
			sb.WriteString(fmt.Sprintf("%d open item(s). ", len(commitments)))
			top := commitments[0].title
			if len(top) > 80 {
				top = top[:80] + "…"
			}
			sb.WriteString(fmt.Sprintf("Top: %s.", top))
		} else {
			sb.WriteString("No open commitments.")
		}
		if lifeEventCount > 0 {
			sb.WriteString(fmt.Sprintf(" %d life event(s) in the last 24h.", lifeEventCount))
		}
		briefText = sb.String()
	}

	// 4. Persist as a daily_brief journal event.
	payload, _ := json.Marshal(map[string]any{
		"text":            briefText,
		"commitmentCount": len(commitments),
		"lifeEventCount":  lifeEventCount,
		"date":            now.Format("2006-01-02"),
	})
	// rls-exempt: journal_events — RLS-exempt child table keyed by run_id.
	_, _ = pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, 1, 'daily_brief', 'brief', 1, $2)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, payload)

	return len(briefText), nil
}

// ---------- B3b: inbox_autopilot body ----------

// runInboxAutopilot fetches recent Gmail messages via the tenant's connector,
// filters to messages newer than the stored high-water mark, and creates
// commitments for actionable ones.
//
// Graceful no-op when the Gmail connector is not installed for this tenant.
//
// rls-exempt: inline executor — executeConnectorAction self-scopes by tenant_id;
// cursor table and commitments carry explicit tenant_id; journal_events exempt.
func runInboxAutopilot(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
) (newN, createdM int, err error) {
	// 1. Pull recent Gmail.
	gmailResult, gmailErr := executeConnectorAction(ctx, pool, tenantID, "gmail", "list_recent",
		map[string]any{"limit": 25})
	if gmailErr != nil {
		if isConnectorNotInstalled(gmailErr) {
			logger.Debug("inbox-autopilot: gmail connector not installed, skipping",
				zap.String("tenant", tenantID))
			emitInboxSwept(ctx, pool, runID, 0, 0)
			return 0, 0, nil
		}
		emitInboxSwept(ctx, pool, runID, 0, 0)
		return 0, 0, fmt.Errorf("inbox-autopilot: gmail fetch: %w", gmailErr)
	}

	// 2. Read high-water mark.
	// rls-exempt: inline executor — gmail_poll_cursors keyed by tenant_id (PK).
	var lastInternalDate string
	_ = pool.QueryRow(ctx,
		`SELECT COALESCE(last_internal_date, '') FROM gmail_poll_cursors WHERE tenant_id = $1`,
		tenantID,
	).Scan(&lastInternalDate)

	// 3. Extract messages from the connector result.
	resMap, ok := gmailResult.(map[string]any)
	if !ok {
		return 0, 0, fmt.Errorf("inbox-autopilot: unexpected result type %T", gmailResult)
	}
	msgs, _ := resMap["messages"].([]GmailMessage)

	// 4. Process: filter, create commitments, advance cursor.
	newN, createdM, err = processInboxMessages(ctx, pool, logger, tenantID, runID, msgs, lastInternalDate)
	return newN, createdM, err
}

// processInboxMessages is the testable core of runInboxAutopilot. It filters
// msgs to those newer than lastInternalDate, creates commitments for
// actionable ones, advances the cursor, and emits inbox_swept.
func processInboxMessages(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
	msgs []GmailMessage,
	lastInternalDate string,
) (newN, createdM int, err error) {
	maxDate := lastInternalDate
	for _, msg := range msgs {
		if msg.ID == "" {
			continue
		}
		// Skip messages at or before the high-water mark (string compare is
		// safe: Gmail internalDate is always a 13-digit ms-epoch string).
		if lastInternalDate != "" && msg.InternalDate <= lastInternalDate {
			continue
		}
		newN++
		if msg.InternalDate > maxDate {
			maxDate = msg.InternalDate
		}

		// ponytail: cheap heuristic promo filter; model-router classification
		// or the bridge's classifier is the upgrade path if false-positive rate matters.
		if isPromoEmail(msg) {
			logger.Debug("inbox-autopilot: skipping promo",
				zap.String("subject", msg.Subject), zap.String("from", msg.From))
			continue
		}

		title := msg.Subject
		if title == "" {
			title = "(no subject)"
		}
		if len(title) > 500 {
			title = title[:500]
		}
		snippet := msg.Snippet
		if len(snippet) > 500 {
			snippet = snippet[:500]
		}

		// Create commitment; ON CONFLICT DO NOTHING is the idempotency guard.
		// rls-exempt: inline executor — explicit tenant_id; dedup on Gmail message ID.
		var insertedID string
		insertErr := pool.QueryRow(ctx, `
			INSERT INTO commitments (tenant_id, title, source, idempotency_key, source_preview, tier, urgency)
			VALUES ($1, $2, 'email', $3, $4, 'meso', 'normal')
			ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
			DO NOTHING
			RETURNING id
		`, tenantID, title, msg.ID, snippet).Scan(&insertedID)
		if insertErr == nil {
			createdM++
		} else if !errors.Is(insertErr, pgx.ErrNoRows) {
			logger.Warn("inbox-autopilot: insert commitment failed",
				zap.String("msg_id", msg.ID), zap.Error(insertErr))
		}
	}

	// Advance cursor to the max internalDate seen in this batch.
	if maxDate > lastInternalDate {
		// rls-exempt: inline executor — gmail_poll_cursors keyed by tenant_id (PK).
		_, _ = pool.Exec(ctx, `
			INSERT INTO gmail_poll_cursors (tenant_id, last_internal_date, last_checked_at)
			VALUES ($1, $2, now())
			ON CONFLICT (tenant_id) DO UPDATE SET
				last_internal_date = EXCLUDED.last_internal_date,
				last_checked_at    = now()
		`, tenantID, maxDate)
	}

	emitInboxSwept(ctx, pool, runID, newN, createdM)
	return newN, createdM, nil
}

// isPromoEmail returns true for obvious promotional / newsletter / bulk emails
// that should not become commitments.
// ponytail: cheap string heuristics only — upgrade to model-router pass if
// false-positive rate matters in production.
func isPromoEmail(msg GmailMessage) bool {
	from := strings.ToLower(msg.From)
	subject := strings.ToLower(msg.Subject)

	promoFrom := []string{
		"noreply", "no-reply", "donotreply", "do-not-reply",
		"notifications@", "newsletter", "marketing@", "deals@",
		"promotions@", "offers@", "unsubscribe",
	}
	for _, p := range promoFrom {
		if strings.Contains(from, p) {
			return true
		}
	}

	promoSubject := []string{
		"unsubscribe", "% off", "sale ends", "limited time",
		"weekly digest", "newsletter", "your statement",
		"new arrivals", "don't miss", "free shipping",
	}
	for _, p := range promoSubject {
		if strings.Contains(subject, p) {
			return true
		}
	}

	return false
}

// emitInboxSwept writes an inbox_swept journal event.
// rls-exempt: journal_events — RLS-exempt child table keyed by run_id.
func emitInboxSwept(ctx context.Context, pool *pgxpool.Pool, runID string, newN, createdM int) {
	payload, _ := json.Marshal(map[string]any{"new": newN, "created": createdM})
	_, _ = pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, 1, 'inbox_swept', 'inbox', 1, $2)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, payload)
}

// ---------- B3c: relationship_keeper body ----------

// runRelationshipKeeper queries people with a relationship label whose
// last interaction is older than 21 days, and creates a weekly reach-out
// commitment for each (idempotent within the same ISO week).
//
// Graceful no-op when the people table is empty or all contacts are fresh.
//
// rls-exempt: inline executor — people query carries explicit tenant_id;
// commitments carry explicit tenant_id; journal_events is RLS-exempt.
func runRelationshipKeeper(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, runID string,
) (surfaced int, err error) {
	// 1. Find stale labeled contacts.
	type staleContact struct {
		id          string
		displayName string
	}
	rows, qErr := pool.Query(ctx, `
		SELECT id::text, COALESCE(display_name, '') FROM people
		WHERE  tenant_id = $1
		  AND  relationship IS NOT NULL AND relationship != ''
		  AND  is_owner = false
		  AND  updated_at < now() - interval '21 days'
		ORDER BY updated_at ASC
		LIMIT 50
	`, tenantID)
	if qErr != nil {
		return 0, fmt.Errorf("relationship_keeper: query people: %w", qErr)
	}
	var stale []staleContact
	for rows.Next() {
		var c staleContact
		if sErr := rows.Scan(&c.id, &c.displayName); sErr == nil {
			stale = append(stale, c)
		}
	}
	rows.Close()
	if rErr := rows.Err(); rErr != nil {
		logger.Warn("relationship_keeper: people rows error", zap.Error(rErr))
	}

	if len(stale) == 0 {
		emitRelationshipSwept(ctx, pool, runID, 0)
		return 0, nil
	}

	// 2. Create weekly reach-out commitments (one per person per ISO week).
	year, week := time.Now().ISOWeek()
	for _, c := range stale {
		name := c.displayName
		if name == "" {
			name = "contact"
		}
		// Idempotency key = agent + person + ISO week (invariant #8).
		idemKey := fmt.Sprintf("relkeeper:%s:%d-W%02d", c.id, year, week)
		title := fmt.Sprintf("Reach out to %s", name)

		// rls-exempt: inline executor — explicit tenant_id; dedup on idemKey.
		var insertedID string
		insertErr := pool.QueryRow(ctx, `
			INSERT INTO commitments (tenant_id, title, source, kind, idempotency_key, tier, urgency)
			VALUES ($1, $2, 'vip', 'relationship', $3, 'meso', 'fyi')
			ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
			DO NOTHING
			RETURNING id
		`, tenantID, title, idemKey).Scan(&insertedID)
		if insertErr == nil {
			surfaced++
		} else if !errors.Is(insertErr, pgx.ErrNoRows) {
			logger.Warn("relationship_keeper: insert commitment failed",
				zap.String("person_id", c.id), zap.Error(insertErr))
		}
	}

	emitRelationshipSwept(ctx, pool, runID, surfaced)
	return surfaced, nil
}

// emitRelationshipSwept writes a relationship_swept journal event.
// rls-exempt: journal_events — RLS-exempt child table keyed by run_id.
func emitRelationshipSwept(ctx context.Context, pool *pgxpool.Pool, runID string, surfaced int) {
	payload, _ := json.Marshal(map[string]any{"surfaced": surfaced})
	_, _ = pool.Exec(ctx, `
		INSERT INTO journal_events (run_id, seq, kind, step_id, attempt, payload)
		VALUES ($1, 1, 'relationship_swept', 'relkeeper', 1, $2)
		ON CONFLICT (run_id, seq) DO NOTHING
	`, runID, payload)
}

// ---------- B4: seeding ----------

// SeedLoopAgents idempotently creates all 4 built-in loop agents for the dev
// tenant: concierge, chief-of-staff, inbox-autopilot, relationship-keeper.
// Called from main.go when seedDev=true. Replaces the old SeedConciergeAgent
// call site (SeedConciergeAgent is kept as a backward-compat alias).
func SeedLoopAgents(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger) {
	for _, m := range []LoopManifest{
		{
			Role:    "concierge",
			Type:    "loop",
			Name:    "concierge",
			Goal:    "Monitor open commitments and surface actionable items to the owner on a meso cadence",
			Tier:    "meso",
			Cron:    tierCronDefault["meso"],
			Sensors: []string{"commitments", "life_events"},
			Actions: []string{"nudge", "research", "draft"},
			Trust:   "ask",
		},
		{
			Role:    "chief_of_staff",
			Type:    "loop",
			Name:    "chief-of-staff",
			Goal:    "Compose and deliver a morning brief summarising open commitments and recent life events",
			Tier:    "macro",
			Cron:    tierCronDefault["macro"],
			Sensors: []string{"commitments", "life_events"},
			Actions: []string{"brief"},
			Trust:   "ask",
		},
		{
			Role:    "inbox_autopilot",
			Type:    "loop",
			Name:    "inbox-autopilot",
			Goal:    "Poll Gmail for new actionable emails and create commitments",
			Tier:    "meso",
			Cron:    tierCronDefault["meso"],
			Sensors: []string{"email"},
			Actions: []string{"create_commitment"},
			Trust:   "ask",
		},
		{
			Role:    "relationship_keeper",
			Type:    "loop",
			Name:    "relationship-keeper",
			Goal:    "Surface VIP contacts who have not been contacted in 21+ days",
			Tier:    "mega",
			Cron:    tierCronDefault["mega"],
			Sensors: []string{"people"},
			Actions: []string{"create_commitment"},
			Trust:   "ask",
		},
	} {
		seedOneLoopAgent(ctx, pool, logger, m)
	}
}

// SeedConciergeAgent is a backward-compat alias; callers should prefer
// SeedLoopAgents which seeds all 4 built-in agents.
func SeedConciergeAgent(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger) {
	seedOneLoopAgent(ctx, pool, logger, LoopManifest{
		Role:    "concierge",
		Type:    "loop",
		Name:    "concierge",
		Goal:    "Monitor open commitments and surface actionable items to the owner on a meso cadence",
		Tier:    "meso",
		Cron:    tierCronDefault["meso"],
		Sensors: []string{"commitments", "life_events"},
		Actions: []string{"nudge", "research", "draft"},
		Trust:   "ask",
	})
}

// seedOneLoopAgent is the shared idempotent helper: upsert agent + version +
// schedule for the dev tenant. Used by SeedLoopAgents.
func seedOneLoopAgent(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger, manifest LoopManifest) {
	const devTenantID = "00000000-0000-0000-0000-000000000001"
	manifestJSON, _ := json.Marshal(manifest)

	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, $3)
		ON CONFLICT (tenant_id, name) DO UPDATE
			SET description = EXCLUDED.description, archived_at = NULL
		RETURNING id
	`, devTenantID, manifest.Name, manifest.Goal).Scan(&agentID); err != nil {
		logger.Error("seed loop agent: upsert agent failed",
			zap.String("name", manifest.Name), zap.Error(err))
		return
	}

	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'loop-v1', decode(md5($2), 'hex'), 'local://loop', $3::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, manifest.Name+"-loop-v1", string(manifestJSON)).Scan(&versionID); err != nil {
		logger.Error("seed loop agent: upsert version failed",
			zap.String("name", manifest.Name), zap.Error(err))
		return
	}

	if _, err := pool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
		versionID, agentID,
	); err != nil {
		logger.Error("seed loop agent: promote version failed",
			zap.String("name", manifest.Name), zap.Error(err))
		return
	}

	if manifest.Tier == "nano" || manifest.Cron == "" {
		logger.Info("loop agent seeded (no schedule)",
			zap.String("agent_id", agentID), zap.String("name", manifest.Name))
		return
	}

	nextFire, err := scheduler.NextCronTime(manifest.Cron, time.Now())
	if err != nil {
		logger.Error("seed loop agent: bad cron",
			zap.String("name", manifest.Name), zap.String("cron", manifest.Cron), zap.Error(err))
		return
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO schedules (tenant_id, agent_name, cron_expr, input_template, config, enabled, next_fire_at)
		VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, true, $4)
		ON CONFLICT (tenant_id, agent_name) DO UPDATE SET
			cron_expr    = EXCLUDED.cron_expr,
			next_fire_at = EXCLUDED.next_fire_at,
			enabled      = true,
			updated_at   = now()
	`, devTenantID, manifest.Name, manifest.Cron, nextFire); err != nil {
		logger.Error("seed loop agent: upsert schedule failed",
			zap.String("name", manifest.Name), zap.Error(err))
		return
	}

	logger.Info("loop agent seeded",
		zap.String("agent_id", agentID), zap.String("version_id", versionID),
		zap.String("name", manifest.Name), zap.String("cron", manifest.Cron))
}
