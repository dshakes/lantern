package handlers

// Slack /lantern slash command.
//
// Mirrors the WhatsApp /lantern command suite so Slack users can check
// bridge / agent state from inside Slack the same way WhatsApp users do
// from their phone.
//
// Setup (one-time, per workspace):
//   1. https://api.slack.com/apps → your app → Slash Commands → Create New
//      Command name: /lantern
//      Request URL:  https://<your-control-plane>/v1/surfaces/slack/command
//      Short desc:   Lantern agent control
//      Usage hint:   status | ping | agents | help
//   2. Copy your app's Signing Secret into SLACK_SIGNING_SECRET on the
//      control-plane so we can verify request authenticity. In dev (no
//      secret set) we accept unverified requests + log a warning so
//      iteration via ngrok still works.
//
// Commands:
//   /lantern              -> help
//   /lantern status       -> uptime, configured surfaces, recent runs
//   /lantern ping         -> liveness check (round-trip)
//   /lantern agents       -> list of active agents in this tenant
//
// Slack expects a JSON response within 3s OR a 200 + async via response_url.
// We answer synchronously since all handlers are sub-second DB reads.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type SlackCommandHandler struct {
	srv *server.Server
}

func NewSlackCommandHandler(srv *server.Server) *SlackCommandHandler {
	return &SlackCommandHandler{srv: srv}
}

func (h *SlackCommandHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("slack_command")
}

// HandleCommand is the entry point for POST /v1/surfaces/slack/command.
// Slack sends application/x-www-form-urlencoded with: team_id, team_domain,
// channel_id, channel_name, user_id, user_name, command (e.g. "/lantern"),
// text (the subcommand + args), response_url, trigger_id.
//
// See https://api.slack.com/interactivity/slash-commands#app_command_handling
func (h *SlackCommandHandler) HandleCommand(w http.ResponseWriter, r *http.Request) {
	// Read raw body for signature verification.
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, slackReply("Could not read request body."))
		return
	}

	// Verify signature if SLACK_SIGNING_SECRET is configured. Refuse
	// unverified requests in prod; in dev (no secret set) log a warning
	// and proceed so the user can iterate locally via ngrok.
	if signingSecret := os.Getenv("SLACK_SIGNING_SECRET"); signingSecret != "" {
		if !verifySlackSignature(r, bodyBytes, signingSecret) {
			h.logger().Warn("rejected slash command with invalid signature",
				zap.String("ip", r.RemoteAddr))
			writeJSON(w, http.StatusUnauthorized, slackReply("Signature verification failed."))
			return
		}
	} else {
		h.logger().Warn("SLACK_SIGNING_SECRET not set — accepting unverified slash command (dev only)")
	}

	form, err := url.ParseQuery(string(bodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, slackReply("Could not parse slash-command payload."))
		return
	}
	teamID := form.Get("team_id")
	userName := form.Get("user_name")
	text := strings.TrimSpace(form.Get("text"))

	h.logger().Info("slack slash command",
		zap.String("team_id", teamID),
		zap.String("user", userName),
		zap.String("text", text),
	)

	// Resolve the tenant. Look up by team_id stored in surface_configs
	// config.workspaceId; fall back to the dev tenant so /lantern works
	// out of the box on the seeded data.
	tenantID := h.resolveTenantFromSlackTeam(r.Context(), teamID)

	// Now that the tenant is resolved, inject it into the context so the
	// post-resolution reply handlers can route their tenant-scoped reads
	// through WithTenant (RLS).
	ctx := middleware.InjectTenantID(r.Context(), tenantID)

	parts := strings.Fields(text)
	sub := ""
	if len(parts) > 0 {
		sub = strings.ToLower(parts[0])
	}

	switch sub {
	case "", "help":
		writeJSON(w, http.StatusOK, slackReply(slackHelpBlock()))
	case "ping":
		writeJSON(w, http.StatusOK, slackReply(":table_tennis_paddle_and_ball: pong — control-plane is alive"))
	case "status":
		writeJSON(w, http.StatusOK, slackReply(h.statusReply(ctx, tenantID)))
	case "agents":
		writeJSON(w, http.StatusOK, slackReply(h.agentsReply(ctx, tenantID)))
	default:
		writeJSON(w, http.StatusOK, slackReply(
			fmt.Sprintf("Unknown subcommand `%s`. Try `/lantern help` for the list.", sub),
		))
	}
}

// slackReply wraps a plain-text body in Slack's standard ephemeral
// response shape so only the invoking user sees it.
func slackReply(text string) map[string]any {
	return map[string]any{
		"response_type": "ephemeral",
		"text":          text,
	}
}

func slackHelpBlock() string {
	return strings.Join([]string{
		":robot_face: *Lantern commands*",
		"",
		"`/lantern status` — control-plane uptime + configured surfaces + recent runs",
		"`/lantern ping` — quick liveness check",
		"`/lantern agents` — list active agents in this workspace's tenant",
		"`/lantern help` — show this message",
	}, "\n")
}

// statusReply assembles a compact health summary for the tenant. Each
// query is independent — a failure on one (DB hiccup, etc.) degrades
// to "0" rather than aborting the whole reply.
func (h *SlackCommandHandler) statusReply(ctx context.Context, tenantID string) string {
	if tenantID == "" {
		return ":warning: This Slack workspace isn't linked to a Lantern tenant yet. Install the Slack surface in the dashboard first."
	}
	var (
		surfaces         int
		connectors       int
		agents           int
		runs24h          int
		lastRunStartedAt *time.Time
	)
	// Post-resolution tenant-scoped reads → WithTenant (RLS). Each scan ignores
	// errors so a single DB hiccup degrades to "0" rather than aborting.
	_ = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		_ = tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM surface_configs WHERE tenant_id = $1 AND status = 'connected'`,
			tenantID,
		).Scan(&surfaces)
		_ = tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM connector_installs WHERE tenant_id = $1 AND status = 'connected'`,
			tenantID,
		).Scan(&connectors)
		_ = tx.QueryRow(ctx,
			`SELECT COUNT(*) FROM agents WHERE tenant_id = $1 AND archived_at IS NULL`,
			tenantID,
		).Scan(&agents)
		_ = tx.QueryRow(ctx,
			`SELECT COUNT(*), MAX(started_at) FROM runs
			 WHERE tenant_id = $1 AND started_at > now() - interval '24 hours'`,
			tenantID,
		).Scan(&runs24h, &lastRunStartedAt)
		return nil
	})

	lines := []string{
		":green_circle: *Lantern is alive*",
		fmt.Sprintf("agents: %d · connectors: %d · surfaces: %d", agents, connectors, surfaces),
		fmt.Sprintf("runs (24h): %d", runs24h),
	}
	if lastRunStartedAt != nil {
		lines = append(lines, fmt.Sprintf("last run: %s ago", humanizeSlackDuration(time.Since(*lastRunStartedAt))))
	}
	return strings.Join(lines, "\n")
}

// agentsReply lists the tenant's active agents with their model.
func (h *SlackCommandHandler) agentsReply(ctx context.Context, tenantID string) string {
	if tenantID == "" {
		return ":warning: This Slack workspace isn't linked to a Lantern tenant yet."
	}
	lines := []string{":scroll: *Agents*"}
	count := 0
	// Post-resolution tenant-scoped read → WithTenant (RLS). Rows are drained
	// inside the closure before the tx commits.
	err := h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qerr := tx.Query(ctx,
			`SELECT name, COALESCE(model, 'auto') FROM agents
			 WHERE tenant_id = $1 AND archived_at IS NULL
			 ORDER BY updated_at DESC NULLS LAST
			 LIMIT 15`,
			tenantID,
		)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var name, model string
			if err := rows.Scan(&name, &model); err == nil {
				lines = append(lines, fmt.Sprintf("• `%s` — %s", name, model))
				count++
			}
		}
		return rows.Err()
	})
	if err != nil {
		return ":x: Could not list agents."
	}
	if count == 0 {
		return "No active agents in this tenant yet."
	}
	return strings.Join(lines, "\n")
}

// resolveTenantFromSlackTeam looks up the tenant that owns this Slack
// workspace by team_id stored in surface_configs.config. Falls back to
// the dev tenant when nothing is configured so /lantern works against
// seeded data without explicit setup.
func (h *SlackCommandHandler) resolveTenantFromSlackTeam(ctx context.Context, teamID string) string {
	if teamID == "" {
		return devTenantID
	}
	var tenantID string
	// rls-exempt: pre-tenant-resolution lookup — maps a Slack workspace/team to
	// its owning tenant across all surface_configs before any tenant context
	// exists. The tenant is the OUTPUT of this query.
	err := h.srv.Pool.QueryRow(ctx,
		`SELECT tenant_id::text FROM surface_configs
		 WHERE surface_id = 'slack' AND status = 'connected'
		   AND (config->>'workspaceId' = $1 OR config->>'team_id' = $1)
		 LIMIT 1`,
		teamID,
	).Scan(&tenantID)
	if err != nil {
		return devTenantID
	}
	return tenantID
}

// verifySlackSignature implements Slack's signed-request verification.
// See https://api.slack.com/authentication/verifying-requests-from-slack
//
// Rejects requests:
//   - older than 5 minutes (replay protection)
//   - whose computed HMAC doesn't match the X-Slack-Signature header
func verifySlackSignature(r *http.Request, body []byte, signingSecret string) bool {
	tsStr := r.Header.Get("X-Slack-Request-Timestamp")
	sig := r.Header.Get("X-Slack-Signature")
	if tsStr == "" || sig == "" {
		return false
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return false
	}
	if time.Now().Unix()-ts > 5*60 {
		return false
	}
	base := fmt.Sprintf("v0:%d:%s", ts, body)
	mac := hmac.New(sha256.New, []byte(signingSecret))
	mac.Write([]byte(base))
	expected := "v0=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

// humanizeSlackDuration renders durations as compact, glanceable strings
// (35s, 7m, 2h, 3d). Distinct from formatUptimeShort in the bridge so
// the two services can evolve independently.
func humanizeSlackDuration(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	m := s / 60
	if m < 60 {
		return fmt.Sprintf("%dm", m)
	}
	h := m / 60
	if h < 24 {
		return fmt.Sprintf("%dh", h)
	}
	return fmt.Sprintf("%dd", h/24)
}
