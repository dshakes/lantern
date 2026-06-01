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
	"net/http"
	"strings"

	"go.uber.org/zap"

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
	ctx := r.Context()
	tenantID := claims.TenantID

	calendar := h.upcomingCalendar(ctx, tenantID)
	emails := h.recentEmails(ctx, tenantID)
	awaiting := h.awaitingReply(ctx, tenantID)

	brief := h.phraseBrief(ctx, tenantID, calendar, emails, awaiting)

	writeJSON(w, http.StatusOK, map[string]any{
		"brief":         brief,
		"calendar":      calendar,
		"recentEmails":  emails,
		"awaitingReply": awaiting,
	})
}

// upcomingCalendar returns event-kind timeline rows from now through the
// next 24h, soonest first.
func (h *JarvisHandler) upcomingCalendar(ctx context.Context, tenantID string) []string {
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT content FROM memory_events
		WHERE tenant_id = $1 AND kind = 'event'
		  AND occurred_at >= now() - interval '1 hour'
		  AND occurred_at <  now() + interval '24 hours'
		ORDER BY occurred_at ASC LIMIT 20
	`, tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if rows.Scan(&c) == nil {
			out = append(out, c)
		}
	}
	return out
}

// recentEmails returns email-kind rows from the last 36h, newest first.
func (h *JarvisHandler) recentEmails(ctx context.Context, tenantID string) []briefEmail {
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT COALESCE(p.display_name, ''), me.content
		FROM memory_events me LEFT JOIN people p ON p.id = me.person_id
		WHERE me.tenant_id = $1 AND me.kind = 'email'
		  AND me.created_at >= now() - interval '36 hours'
		ORDER BY me.occurred_at DESC LIMIT 15
	`, tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []briefEmail
	for rows.Next() {
		var from, content string
		if rows.Scan(&from, &content) == nil {
			if from == "" {
				from = "?"
			}
			out = append(out, briefEmail{From: from, Content: content})
		}
	}
	return out
}

// awaitingReply finds people whose most recent message (last 4 days) was
// inbound — i.e. the ball is in your court.
func (h *JarvisHandler) awaitingReply(ctx context.Context, tenantID string) []briefReply {
	rows, err := h.srv.Pool.Query(ctx, `
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
		return nil
	}
	defer rows.Close()
	var out []briefReply
	for rows.Next() {
		var person, content string
		if rows.Scan(&person, &content) == nil {
			if person == "" {
				person = "someone"
			}
			out = append(out, briefReply{Person: person, Content: content})
		}
	}
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
	ownerName := getEnvOr("LANTERN_OWNER_NAME", "Shekhar")
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
	return strings.TrimSpace(out)
}
