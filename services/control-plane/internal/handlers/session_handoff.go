package handlers

// session_handoff.go — human handoff for interactive sessions (W2-X1).
//
// An agent labelled handoff=human gets one built-in tool, handoff_to_human, and
// nothing else (a public webchat key must not reach connectors). When the model
// judges it cannot answer, it calls the tool: the session flips to
// status='handoff', the widget is told over SSE, and an optional Slack ping goes
// to label handoff_slack_channel through the tenant's installed Slack connector.
// While in handoff the LLM stays silent: customer messages are recorded, and a
// human replies via POST /v1/sessions/{id}/operator-messages. The transition
// is the idempotency guard (invariant #8): only the UPDATE that actually moves
// active/processing -> handoff pings Slack, so a retry or a second tool call
// never double-notifies.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/pal/services/control-plane/internal/server"
)

const (
	handoffToolName   = "handoff_to_human"
	handoffMessage    = "Connecting you to a human teammate — they'll reply here shortly."
	maxOperatorMsgLen = 4000
)

// handoffTool is the OpenAI-format tool definition.
func handoffTool() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": handoffToolName,
			"description": "Hand this conversation to a human teammate. Call it when the customer asks for a person, " +
				"or when you cannot answer confidently from the knowledge base (refunds, billing disputes, account changes, anything you would have to guess). " +
				"Do not call it for questions the knowledge base answers.",
			"parameters": map[string]any{
				"type":                 "object",
				"properties":           map[string]any{"reason": map[string]any{"type": "string", "description": "One sentence for the human: what the customer needs."}},
				"required":             []string{"reason"},
				"additionalProperties": false,
			},
		},
	}
}

// handoffConfig reads the agent's labels: handoff=human enables it,
// handoff_slack_channel names the Slack channel to ping.
func handoffConfig(labelsJSON []byte) (enabled bool, slackChannel string) {
	var labels map[string]string
	if json.Unmarshal(labelsJSON, &labels) != nil {
		return false, ""
	}
	return labels["handoff"] == "human", labels["handoff_slack_channel"]
}

// RegisterHandoffRoutes wires the handoff routes onto mux.
func (h *SessionHandler) RegisterHandoffRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/sessions/{id}/handoff", h.auth.WithScope(ScopeRunsExecute, h.RequestHandoff))
	// Operator actions need the coarse write scope, which a public widget key
	// (runs:execute) does not imply: a website visitor must not be able to speak
	// as the operator or hand the chat back to the bot.
	mux.HandleFunc("POST /v1/sessions/{id}/operator-messages", h.auth.WithScope(ScopeWrite, h.OperatorReply))
	mux.HandleFunc("POST /v1/sessions/{id}/resolve", h.auth.WithScope(ScopeWrite, h.ResolveHandoff))
}

// RegisterSupportDeskRoutes wires the knowledge base and session handoff
// (W2-X1) onto mux and connects retrieval to the session handler.
func RegisterSupportDeskRoutes(mux *http.ServeMux, srv *server.Server, auth *AuthHandler, llm *LlmProxyHandler, sessions *SessionHandler) {
	kb := NewKnowledgeHandler(srv, auth, llm)
	sessions.SetKnowledge(kb)
	kb.RegisterRoutes(mux)
	sessions.RegisterHandoffRoutes(mux)
}

// doHandoff moves the session into handoff. changed is false when the session
// was not active/processing (already handed off, stopped, or not this
// tenant's); only a real transition notifies anyone.
func (h *SessionHandler) doHandoff(ctx context.Context, tenantID, sessionID, agentName, reason, slackChannel string) (changed bool, err error) {
	var messagesRaw []byte
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx, `
			UPDATE sessions SET status='handoff', handoff_reason=$3, handoff_at=now(), updated_at=now()
			WHERE id=$1 AND tenant_id=$2 AND status IN ('active','processing')
			RETURNING messages`, sessionID, tenantID, reason).Scan(&messagesRaw)
		if e == pgx.ErrNoRows {
			return nil
		}
		changed = e == nil
		return e
	})
	if err != nil || !changed {
		return false, err
	}

	h.publishEvent(sessionID, "session.handoff", map[string]string{"reason": reason, "message": handoffMessage})

	if slackChannel != "" {
		var msgs []sessionMessage
		_ = json.Unmarshal(messagesRaw, &msgs)
		last := ""
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].Role == "user" {
				last = msgs[i].Content
				break
			}
		}
		if r := []rune(last); len(r) > 300 {
			last = string(r[:300]) + "…"
		}
		text := fmt.Sprintf("Handoff requested on agent `%s` (session %s)\nReason: %s\nCustomer: %s", agentName, sessionID, reason, last)
		pingCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		// rls-exempt: shared connector helper takes a *Pool and self-scopes by tenantID.
		if _, perr := executeConnectorAction(pingCtx, h.srv.Pool, tenantID, "slack", "post_message",
			map[string]any{"channel": slackChannel, "text": text}); perr != nil {
			// The handoff itself stands; the dashboard queue (status=handoff) still shows it.
			h.logger().Warn("handoff slack ping failed", zap.String("session_id", sessionID), zap.Error(perr))
		}
	}
	return true, nil
}

// handoffDispatch executes the handoff_to_human tool call.
func (h *SessionHandler) handoffDispatch(ctx context.Context, tenantID, sessionID, agentName, slackChannel string, args map[string]any) (any, error) {
	reason, _ := args["reason"].(string)
	if reason = strings.TrimSpace(reason); reason == "" {
		reason = "customer needs a human"
	}
	if r := []rune(reason); len(r) > 500 {
		reason = string(r[:500])
	}
	changed, err := h.doHandoff(ctx, tenantID, sessionID, agentName, reason, slackChannel)
	if err != nil {
		return nil, fmt.Errorf("handoff failed: %w", err)
	}
	return map[string]any{"status": "handoff", "newlyHandedOff": changed, "message": handoffMessage}, nil
}

// RequestHandoff handles POST /v1/sessions/{id}/handoff {reason?} — the
// customer (widget button) or an operator forcing a handoff without the LLM.
func (h *SessionHandler) RequestHandoff(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	sessionID := r.PathValue("id")
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body)
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "customer asked for a human"
	}
	if rr := []rune(reason); len(rr) > 500 {
		reason = string(rr[:500])
	}

	var agentName, status string
	var labels []byte
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT s.agent_name, s.status, COALESCE(a.labels, '{}'::jsonb)
			FROM sessions s LEFT JOIN agents a ON a.tenant_id = s.tenant_id AND a.name = s.agent_name
			WHERE s.id=$1 AND s.tenant_id=$2`, sessionID, tenantID).Scan(&agentName, &status, &labels)
	})
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	if err != nil {
		h.logger().Error("handoff lookup failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if status == "handoff" {
		writeJSON(w, http.StatusOK, map[string]any{"status": "handoff", "newlyHandedOff": false})
		return
	}
	_, slackChannel := handoffConfig(labels)
	changed, err := h.doHandoff(ctx, tenantID, sessionID, agentName, reason, slackChannel)
	if err != nil {
		h.logger().Error("handoff failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !changed {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session is not active"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "handoff", "newlyHandedOff": true})
}

// OperatorReply handles POST /v1/sessions/{id}/operator-messages {content}.
// 404 for another tenant's (or a missing) session, 409 unless in handoff.
func (h *SessionHandler) OperatorReply(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	sessionID := r.PathValue("id")
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil ||
		strings.TrimSpace(body.Content) == "" || len(body.Content) > maxOperatorMsgLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("content is required (max %d bytes)", maxOperatorMsgLen)})
		return
	}
	msg := sessionMessage{Role: "operator", Content: strings.TrimSpace(body.Content), Timestamp: time.Now().UTC().Format(time.RFC3339)}
	msgJSON, _ := json.Marshal(msg)

	var status string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT status FROM sessions WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, sessionID, tenantID).Scan(&status); e != nil {
			return e
		}
		if status != "handoff" {
			return nil
		}
		_, e := tx.Exec(ctx, `UPDATE sessions SET messages = messages || $1::jsonb, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
			string(msgJSON), sessionID, tenantID)
		return e
	})
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	if err != nil {
		h.logger().Error("operator reply failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if status != "handoff" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session is not in handoff"})
		return
	}
	h.publishEvent(sessionID, "operator.message", map[string]string{"content": msg.Content, "timestamp": msg.Timestamp})
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// ResolveHandoff handles POST /v1/sessions/{id}/resolve — hand the
// conversation back to the agent.
func (h *SessionHandler) ResolveHandoff(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	sessionID := r.PathValue("id")
	var n int64
	var exists bool
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE sessions SET status='active', updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='handoff'`, sessionID, tenantID)
		if e != nil {
			return e
		}
		if n = tag.RowsAffected(); n == 0 {
			return tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM sessions WHERE id=$1 AND tenant_id=$2)`, sessionID, tenantID).Scan(&exists)
		}
		return nil
	})
	if err != nil {
		h.logger().Error("resolve handoff failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if n == 0 {
		if !exists {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		} else {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "session is not in handoff"})
		}
		return
	}
	h.publishEvent(sessionID, "session.resolved", map[string]string{})
	writeJSON(w, http.StatusOK, map[string]string{"status": "active"})
}
