package handlers

// Proactive Jarvis — the daily brief (Phase 3).
//
// Assembles a chief-of-staff style brief from the unified cross-channel
// timeline: what's coming up on your calendar, the latest email traffic,
// and who's waiting on a reply from you. The structured data is phrased
// into a terse, natural brief by the LLM; if the LLM is unavailable the
// raw sections are still returned so the brief never fails closed.
//
//   GET /v1/jarvis/brief  → { brief, calendar[], recentEmails[], awaitingReply[] }

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type JarvisHandler struct {
	srv  *server.Server
	auth *AuthHandler
	llm  *LlmProxyHandler
}

func NewJarvisHandler(srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler) *JarvisHandler {
	return &JarvisHandler{srv: srv, auth: auth, llm: llm}
}

func (h *JarvisHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("jarvis")
}

type briefEmail struct {
	From    string `json:"from"`
	Content string `json:"content"`
}
type briefReply struct {
	Person  string `json:"person"`
	Content string `json:"content"`
}

// Brief handles GET /v1/jarvis/brief.
func (h *JarvisHandler) Brief(w http.ResponseWriter, r *http.Request) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	brief, calendar, emails, awaiting := h.composeBrief(r.Context(), claims.TenantID)
	writeJSON(w, http.StatusOK, map[string]any{
		"brief":         brief,
		"calendar":      calendar,
		"recentEmails":  emails,
		"awaitingReply": awaiting,
	})
}

// composeBrief gathers the sections + phrases the brief. Shared by the
// HTTP endpoint and the scheduled morning push.
func (h *JarvisHandler) composeBrief(ctx context.Context, tenantID string) (string, []string, []briefEmail, []briefReply) {
	calendar := h.upcomingCalendar(ctx, tenantID)
	emails := h.recentEmails(ctx, tenantID)
	awaiting := h.awaitingReply(ctx, tenantID)
	brief := h.phraseBrief(ctx, tenantID, calendar, emails, awaiting)
	return brief, calendar, emails, awaiting
}

// upcomingCalendar returns event-kind timeline rows from now through the
// next 24h, soonest first.
func (h *JarvisHandler) upcomingCalendar(ctx context.Context, tenantID string) []string {
	// memory_events is tenant-scoped → read under WithTenant (RLS). The tenant
	// is injected from the tenantID arg so this works for both the request path
	// and the (single-tenant) scheduled brief push. Rows drained in the closure.
	var out []string
	_ = h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT content FROM memory_events
			WHERE tenant_id = $1 AND kind = 'event'
			  AND occurred_at >= now() - interval '1 hour'
			  AND occurred_at <  now() + interval '24 hours'
			ORDER BY occurred_at ASC LIMIT 20
		`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c string
			if rows.Scan(&c) == nil {
				out = append(out, c)
			}
		}
		return rows.Err()
	})
	return out
}

// recentEmails returns email-kind rows from the last 36h, newest first.
func (h *JarvisHandler) recentEmails(ctx context.Context, tenantID string) []briefEmail {
	// memory_events is tenant-scoped → read under WithTenant (RLS).
	var out []briefEmail
	_ = h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT COALESCE(p.display_name, ''), me.content
			FROM memory_events me LEFT JOIN people p ON p.id = me.person_id
			WHERE me.tenant_id = $1 AND me.kind = 'email'
			  AND me.created_at >= now() - interval '36 hours'
			ORDER BY me.occurred_at DESC LIMIT 15
		`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var from, content string
			if rows.Scan(&from, &content) == nil {
				if from == "" {
					from = "?"
				}
				out = append(out, briefEmail{From: from, Content: content})
			}
		}
		return rows.Err()
	})
	return out
}

// awaitingReply finds people whose most recent message (last 4 days) was
// inbound — i.e. the ball is in your court.
func (h *JarvisHandler) awaitingReply(ctx context.Context, tenantID string) []briefReply {
	// memory_events is tenant-scoped → read under WithTenant (RLS).
	var out []briefReply
	_ = h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
		WITH latest AS (
			SELECT DISTINCT ON (person_id)
			       person_id, direction, content, occurred_at
			FROM memory_events
			WHERE tenant_id = $1 AND person_id IS NOT NULL
			  AND kind IN ('message_in', 'message_out')
			  AND occurred_at >= now() - interval '4 days'
			ORDER BY person_id, occurred_at DESC
		)
		SELECT COALESCE(p.display_name, ''), l.content
		FROM latest l JOIN people p ON p.id = l.person_id
		WHERE l.direction = 'in'
		ORDER BY l.occurred_at DESC LIMIT 10
	`, tenantID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var person, content string
			if rows.Scan(&person, &content) == nil {
				if person == "" {
					person = "someone"
				}
				out = append(out, briefReply{Person: person, Content: content})
			}
		}
		return rows.Err()
	})
	return out
}

// phraseBrief turns the structured sections into a terse natural brief via
// the LLM. Falls back to a plain assembled brief when the LLM is absent or
// errors — and to a short status line when there's nothing to report.
func (h *JarvisHandler) phraseBrief(ctx context.Context, tenantID string, calendar []string, emails []briefEmail, awaiting []briefReply) string {
	if len(calendar) == 0 && len(emails) == 0 && len(awaiting) == 0 {
		return "nothing on the radar right now — calendar's clear and no one's waiting on you."
	}

	var data strings.Builder
	if len(calendar) > 0 {
		data.WriteString("UPCOMING (next 24h):\n")
		for _, c := range calendar {
			data.WriteString("- " + c + "\n")
		}
	}
	if len(awaiting) > 0 {
		data.WriteString("\nAWAITING YOUR REPLY:\n")
		for _, a := range awaiting {
			data.WriteString("- " + a.Person + ": " + smsTruncate(a.Content, 120) + "\n")
		}
	}
	if len(emails) > 0 {
		data.WriteString("\nRECENT EMAIL:\n")
		for _, e := range emails {
			data.WriteString("- " + e.From + ": " + smsTruncate(e.Content, 120) + "\n")
		}
	}
	fallback := strings.TrimSpace(data.String())

	if h.llm == nil {
		return fallback
	}
	ownerName := getEnvOr("LANTERN_OWNER_NAME", "Ada")
	system := strings.Join([]string{
		"You are " + ownerName + "'s chief of staff. Write his brief from the data below.",
		"Terse, scannable, friendly. Plain text, no markdown headers. Group into short lines.",
		"Lead with what's most time-sensitive (upcoming meetings, people waiting).",
		"Don't invent anything not in the data. If a section is empty, skip it.",
		"Open with a one-line summary, then the details.",
	}, "\n")
	out, err := h.llm.CompleteInternal(ctx, tenantID, system, data.String(), 400)
	if err != nil || strings.TrimSpace(out) == "" {
		h.logger().Debug("brief LLM phrasing failed; returning raw sections", zap.Error(err))
		return fallback
	}
	return stripAssistantPreamble(out)
}

// stripAssistantPreamble removes meta-preamble some models (notably the
// claude-code-local backend) prepend to user-facing output — e.g. "This
// is a writing task… Let me write…\n\n---\n\n<actual content>". Keeps the
// reply clean for SMS/voice/brief surfaces.
func stripAssistantPreamble(s string) string {
	s = strings.TrimSpace(s)
	// If a "---" fence appears near the top, the real content is after it.
	if idx := strings.Index(s, "\n---\n"); idx >= 0 && idx < 320 {
		s = strings.TrimSpace(s[idx+len("\n---\n"):])
	}
	metaPrefixes := []string{
		"this is a ", "let me ", "here's ", "here is ", "sure,", "okay,",
		"ok,", "i'll write", "i will write", "got it,", "alright,",
	}
	lines := strings.Split(s, "\n")
	for len(lines) > 0 {
		l := strings.ToLower(strings.TrimSpace(lines[0]))
		if l == "" {
			lines = lines[1:]
			continue
		}
		matched := false
		for _, p := range metaPrefixes {
			if strings.HasPrefix(l, p) {
				matched = true
				break
			}
		}
		if !matched {
			break
		}
		lines = lines[1:]
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// ---- proactive morning push ------------------------------------------------

// RunBriefScheduler delivers the brief once a day at LANTERN_JARVIS_BRIEF_HOUR
// (0-23, local time). Disabled when unset. Delivers via SMS when
// LANTERN_TWILIO_NUMBER + LANTERN_OWNER_PHONE are set, else via email to
// LANTERN_OWNER_EMAIL. Best-effort; loops until ctx is cancelled.
func (h *JarvisHandler) RunBriefScheduler(ctx context.Context) {
	hourStr := strings.TrimSpace(os.Getenv("LANTERN_JARVIS_BRIEF_HOUR"))
	if hourStr == "" {
		h.logger().Info("jarvis morning brief disabled (LANTERN_JARVIS_BRIEF_HOUR unset)")
		return
	}
	hour, err := strconv.Atoi(hourStr)
	if err != nil || hour < 0 || hour > 23 {
		h.logger().Warn("invalid LANTERN_JARVIS_BRIEF_HOUR — disabling brief push", zap.String("value", hourStr))
		return
	}
	tenantID := getEnvOr("LANTERN_DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001")
	h.logger().Info("jarvis morning brief scheduled", zap.Int("hour", hour))

	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	lastSentDay := ""
	for {
		// Check immediately on each tick (and once right away).
		now := time.Now()
		today := now.Format("2006-01-02")
		if now.Hour() == hour && lastSentDay != today {
			lastSentDay = today // mark up front so a delivery error doesn't spam the hour
			brief, cal, emails, awaiting := h.composeBrief(ctx, tenantID)
			if len(cal) == 0 && len(emails) == 0 && len(awaiting) == 0 {
				h.logger().Info("morning brief: nothing to report, skipping send")
			} else {
				h.deliverBrief(ctx, tenantID, brief)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// deliverBrief sends the brief to the owner. The preferred channel (from
// briefChannel) is tried first, then the remaining channels as fallbacks,
// so a brief never silently vanishes. WhatsApp is the default — it's where
// the owner lives and bypasses US A2P 10DLC SMS filtering.
func (h *JarvisHandler) deliverBrief(ctx context.Context, tenantID, brief string) {
	order := []string{"whatsapp", "sms", "email"}
	if pref := h.briefChannel(); pref != "" {
		reordered := []string{pref}
		for _, c := range order {
			if c != pref {
				reordered = append(reordered, c)
			}
		}
		order = reordered
	}
	for _, ch := range order {
		ok := false
		switch ch {
		case "whatsapp":
			ok = h.sendBriefWhatsApp(ctx, tenantID, brief)
		case "sms":
			ok = h.sendBriefSMS(ctx, tenantID, brief)
		case "email":
			ok = h.sendBriefEmail(ctx, tenantID, brief)
		}
		if ok {
			h.logger().Info("morning brief sent", zap.String("channel", ch))
			return
		}
	}
	h.logger().Warn("morning brief: no delivery channel succeeded")
}

// briefChannel resolves the preferred delivery channel. A runtime override
// file (~/.lantern/brief-channel, written by the A2P watcher on approval)
// wins over the LANTERN_JARVIS_BRIEF_CHANNEL env — so the channel can flip
// without restarting the control-plane.
func (h *JarvisHandler) briefChannel() string {
	if home := os.Getenv("HOME"); home != "" {
		if b, err := os.ReadFile(home + "/.lantern/brief-channel"); err == nil {
			if c := strings.ToLower(strings.TrimSpace(string(b))); c != "" {
				return c
			}
		}
	}
	return strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_JARVIS_BRIEF_CHANNEL")))
}

// twilioFromNumber resolves the SMS sending number: env override, else the
// phoneNumber on the installed twilio connector — so SMS works without a
// dedicated env var once the connector is configured.
func (h *JarvisHandler) twilioFromNumber(ctx context.Context, tenantID string) string {
	if n := strings.TrimSpace(os.Getenv("LANTERN_TWILIO_NUMBER")); n != "" {
		return n
	}
	var cfg []byte
	// connector_installs is tenant-scoped → read under WithTenant (RLS).
	cfgErr := h.srv.WithTenant(middleware.InjectTenantID(ctx, tenantID), func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT config FROM connector_installs WHERE tenant_id = $1 AND connector_id = 'twilio' LIMIT 1`,
			tenantID).Scan(&cfg)
	})
	if cfgErr == nil {
		dec, decErr := secrets.Decrypt(cfg)
		if decErr != nil {
			return ""
		}
		m := map[string]any{}
		if json.Unmarshal(dec, &m) == nil {
			if p, ok := m["phoneNumber"].(string); ok {
				return strings.TrimSpace(p)
			}
		}
	}
	return ""
}

func (h *JarvisHandler) sendBriefSMS(ctx context.Context, tenantID, brief string) bool {
	from := h.twilioFromNumber(ctx, tenantID)
	owner := strings.TrimSpace(os.Getenv("LANTERN_OWNER_PHONE"))
	if from == "" || owner == "" {
		return false
	}
	body := brief
	if len(body) > 600 {
		body = body[:590] + " […]"
	}
	_, err := executeConnectorAction(ctx, h.srv.Pool, tenantID, "twilio", "send_sms",
		map[string]any{"to": owner, "from": from, "body": body})
	if err != nil {
		h.logger().Warn("brief SMS failed", zap.Error(err))
	}
	return err == nil
}

func (h *JarvisHandler) sendBriefEmail(ctx context.Context, tenantID, brief string) bool {
	owner := strings.TrimSpace(os.Getenv("LANTERN_OWNER_EMAIL"))
	if owner == "" {
		return false
	}
	_, err := executeConnectorAction(ctx, h.srv.Pool, tenantID, "gmail", "send_message",
		map[string]any{"to": owner, "subject": "Your Lantern brief", "body": brief, "label": "lantern", "skipInbox": false})
	if err != nil {
		h.logger().Warn("brief email failed", zap.Error(err))
	}
	return err == nil
}

// sendBriefWhatsApp posts the brief to the owner's WhatsApp self-chat via
// the bridge's send-self endpoint. Returns true on a 2xx.
func (h *JarvisHandler) sendBriefWhatsApp(ctx context.Context, tenantID, brief string) bool {
	bridgeURL := getEnvOr("LANTERN_BRIDGE_URL", "http://localhost:3100")
	payload := `{"message":` + strconv.Quote("🌅 *Morning brief*\n\n"+brief) + `}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(bridgeURL, "/")+"/session/"+tenantID+"/send-self", strings.NewReader(payload))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		h.logger().Debug("brief WhatsApp send failed", zap.Error(err))
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode/100 == 2
}
