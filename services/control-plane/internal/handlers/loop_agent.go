package handlers

// Loop-agent platform primitive (Stage 3 / Part B).
//
//   B1. POST /v1/agents/loop  — single-prompt creator (LoopAgentHandler).
//   B2. runLoopAgentIfPresent — called from executeRunInlineSync to detect and
//       dispatch a loop-type agent run; scanAndNudgeCommitments does the work.
//   B3. SeedConciergeAgent    — idempotent dev seeding of the Concierge instance.

import (
	"context"
	"encoding/json"
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
		zap.String("tier", manifest.Tier), zap.String("cron", manifest.Cron))

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
  "name": "kebab-case-name",
  "goal": "one sentence: what this loop monitors or does",
  "tier": "meso",
  "cron": "*/45 * * * *",
  "sensors": ["commitments"],
  "actions": ["nudge"],
  "trust": "ask"
}

Valid tiers and their default crons:
  nano   → no schedule (event-driven only); omit cron
  micro  → "*/5 * * * *"  (every 5 min)
  meso   → "*/45 * * * *" (every 45 min)
  macro  → "0 8 * * *"    (daily at 8am)
  mega   → "0 9 * * 1"    (weekly Monday 9am)

Valid sensors: commitments, life_events, signals, calendar, email
Valid actions: nudge, draft, calendar, research, remind, escalate
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
	return &m, nil
}

// ---------- B2: loop executor (called from executeRunInlineSync) ----------

// runLoopAgentIfPresent checks whether the given agent's current version has
// a loop-type manifest, and if so runs the loop body instead of the plain LLM
// path. Returns true when the loop was dispatched (caller must not also run
// the plain path).
//
// Called from executeRunInlineSync at the same hook point as runWorkflowIfPresent.
func runLoopAgentIfPresent(
	ctx context.Context,
	pool *pgxpool.Pool,
	logger *zap.Logger,
	tenantID, agentName, runID string,
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

	logger.Info("loop-agent: dispatching loop run",
		zap.String("agent", agentName), zap.String("run_id", runID),
		zap.String("tier", m.Tier), zap.Strings("sensors", m.Sensors))

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

	// Write a terminal journal event summarising the run output.
	// rls-exempt: journal_events is RLS-exempt (no tenant_id; keyed by run_id).
	outputJSON, _ := json.Marshal(map[string]any{"surfaced": surfaced})
	// Use a high seq so it doesn't collide with the per-commitment events.
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

// ---------- B3: SeedConciergeAgent ----------

// SeedConciergeAgent idempotently creates the Concierge loop agent (tier=meso,
// sensors=[commitments, life_events], actions=[nudge, research, draft],
// trust=ask) and its schedule for the dev tenant.
//
// Mirror of devSeedStatements in db/migrate.go but as Go because the manifest
// is a structured JSON object. Called from main.go when seedDev=true.
func SeedConciergeAgent(ctx context.Context, pool *pgxpool.Pool, logger *zap.Logger) {
	const devTenantID = "00000000-0000-0000-0000-000000000001"
	const agentName = "concierge"

	manifest := LoopManifest{
		Type:    "loop",
		Name:    agentName,
		Goal:    "Monitor open commitments and surface actionable items to the owner on a meso cadence",
		Tier:    "meso",
		Cron:    tierCronDefault["meso"],
		Sensors: []string{"commitments", "life_events"},
		Actions: []string{"nudge", "research", "draft"},
		Trust:   "ask",
	}
	manifestJSON, _ := json.Marshal(manifest)

	// Upsert agent.
	var agentID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agents (tenant_id, name, description)
		VALUES ($1, $2, $3)
		ON CONFLICT (tenant_id, name) DO UPDATE
			SET description = EXCLUDED.description, archived_at = NULL
		RETURNING id
	`, devTenantID, agentName, manifest.Goal).Scan(&agentID); err != nil {
		logger.Error("seed concierge: upsert agent failed", zap.Error(err))
		return
	}

	// Upsert agent_version.
	var versionID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_versions (agent_id, version, digest, bundle_uri, manifest)
		VALUES ($1, 'loop-v1', decode(md5($2), 'hex'), 'local://loop', $3::jsonb)
		ON CONFLICT (agent_id, version) DO UPDATE SET manifest = EXCLUDED.manifest
		RETURNING id
	`, agentID, agentName+"-loop-v1", string(manifestJSON)).Scan(&versionID); err != nil {
		logger.Error("seed concierge: upsert version failed", zap.Error(err))
		return
	}

	// Promote.
	if _, err := pool.Exec(ctx,
		`UPDATE agents SET current_version_id = $1 WHERE id = $2`,
		versionID, agentID,
	); err != nil {
		logger.Error("seed concierge: promote version failed", zap.Error(err))
		return
	}

	// Upsert schedule.
	nextFire, err := scheduler.NextCronTime(manifest.Cron, time.Now())
	if err != nil {
		logger.Error("seed concierge: bad cron", zap.String("cron", manifest.Cron), zap.Error(err))
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
	`, devTenantID, agentName, manifest.Cron, nextFire); err != nil {
		logger.Error("seed concierge: upsert schedule failed", zap.Error(err))
		return
	}

	logger.Info("concierge loop agent seeded",
		zap.String("agent_id", agentID), zap.String("version_id", versionID),
		zap.String("cron", manifest.Cron))
}
