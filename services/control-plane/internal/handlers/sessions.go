package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/middleware"
	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// SessionHandler provides HTTP handlers for interactive agent sessions.
// A session is a durable, long-lived entity that allows multi-turn
// conversation with an agent. Users send messages, the agent responds,
// and users can steer mid-execution.
type SessionHandler struct {
	srv      *server.Server
	auth     *AuthHandler
	llmProxy *LlmProxyHandler
}

// NewSessionHandler creates a new SessionHandler.
func NewSessionHandler(srv *server.Server, auth *AuthHandler, llmProxy *LlmProxyHandler) *SessionHandler {
	return &SessionHandler{
		srv:      srv,
		auth:     auth,
		llmProxy: llmProxy,
	}
}

func (h *SessionHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("sessions")
}

// contextWithTenant extracts the JWT from the request and returns a context
// carrying the tenant_id, plus the tenant ID string itself.
func (h *SessionHandler) contextWithTenant(r *http.Request) (context.Context, string, error) {
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		return nil, "", err
	}
	ctx := middleware.InjectTenantID(r.Context(), claims.TenantID)
	return ctx, claims.TenantID, nil
}

// ---------- JSON types ----------

type sessionMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp string `json:"timestamp"`
	// Optional. Set on assistant turns that invoked one or more connector
	// tools. Persisted to sessions.messages JSONB so the chat UI can re-
	// render "Used github · list_prs" chips after a page reload. The
	// frontend reads exactly this shape.
	ToolCalls []persistedToolCall `json:"toolCalls,omitempty"`
}

// persistedToolCall is the serialized form of a ToolInvocation that
// survives in DB. We truncate the result payload to keep the JSONB column
// from ballooning; the full result already left the system as the tool
// message in the LLM call.
type persistedToolCall struct {
	Name   string `json:"name"`
	Args   string `json:"args"`             // raw JSON
	Result string `json:"result,omitempty"` // truncated JSON
	Error  string `json:"error,omitempty"`
	Status string `json:"status"` // "completed" | "failed"
}

type sessionJSON struct {
	ID        string           `json:"id"`
	TenantID  string           `json:"tenantId"`
	AgentName string           `json:"agentName"`
	Status    string           `json:"status"`
	Messages  []sessionMessage `json:"messages"`
	CreatedAt string           `json:"createdAt"`
	UpdatedAt string           `json:"updatedAt"`
}

// ---------- Handlers ----------

// CreateSession handles POST /v1/sessions.
// Creates a new interactive session for an agent.
func (h *SessionHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		AgentName   string            `json:"agentName"`
		Environment map[string]string `json:"environment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.AgentName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName is required"})
		return
	}

	// Insert session row.
	var sessionID string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO sessions (tenant_id, agent_name, status, messages)
		VALUES ($1, $2, 'active', '[]'::jsonb)
		RETURNING id
	`, tenantID, body.AgentName).Scan(&sessionID)
	if err != nil {
		h.logger().Error("create session failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create session"})
		return
	}

	h.logger().Info("session created",
		zap.String("session_id", sessionID),
		zap.String("agent", body.AgentName),
		zap.String("tenant_id", tenantID),
	)

	writeJSON(w, http.StatusCreated, map[string]string{
		"id":     sessionID,
		"status": "active",
	})
}

// SendMessage handles POST /v1/sessions/{id}/messages.
// Appends a user message to the session, triggers an LLM response, and
// publishes events to Redis for SSE consumers.
func (h *SessionHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	sessionID := r.PathValue("id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id is required"})
		return
	}

	var body struct {
		Content     string   `json:"content"`
		Attachments []string `json:"attachments"`
		// SystemHint, when present, replaces the agent's stored system prompt
		// for this turn only. Used by the WhatsApp bridge to inject a
		// "you're texting as the owner, sound natural" persona with fresh
		// per-thread style cues. Not persisted — strictly transient.
		SystemHint string `json:"systemHint,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}

	// Verify session belongs to tenant and is active.
	var agentName, status string
	var messagesRaw []byte
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT agent_name, status, messages
		FROM sessions
		WHERE id = $1 AND tenant_id = $2
	`, sessionID, tenantID).Scan(&agentName, &status, &messagesRaw)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	if err != nil {
		h.logger().Error("query session failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if status != "active" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "session is not active"})
		return
	}

	// Parse existing messages.
	var messages []sessionMessage
	if len(messagesRaw) > 0 {
		if err := json.Unmarshal(messagesRaw, &messages); err != nil {
			messages = []sessionMessage{}
		}
	}

	// Append user message.
	userMsg := sessionMessage{
		Role:      "user",
		Content:   body.Content,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	messages = append(messages, userMsg)

	// Update messages in DB and mark as processing.
	updatedMsgs, _ := json.Marshal(messages)
	_, err = h.srv.Pool.Exec(ctx, `
		UPDATE sessions SET messages = $1::jsonb, status = 'processing', updated_at = now()
		WHERE id = $2
	`, string(updatedMsgs), sessionID)
	if err != nil {
		h.logger().Error("update session messages failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save message"})
		return
	}

	// Publish user message event to Redis for SSE listeners.
	h.publishEvent(sessionID, "user.message", map[string]string{
		"content":   body.Content,
		"timestamp": userMsg.Timestamp,
	})

	// Return immediately — the LLM call happens asynchronously.
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status": "processing",
	})

	// Kick off LLM response in background. The systemHint (if any) is passed
	// through so it can override the agent's stored system prompt for this
	// turn only — see processMessage.
	go h.processMessage(sessionID, tenantID, agentName, messages, body.SystemHint)
}

// processMessage calls the LLM with the full message history and appends the
// assistant response. Events are published to Redis as the processing happens.
//
// systemHint, when non-empty, takes precedence over the agent's stored
// system_prompt for this turn only. The bridge uses it to ship a fresh
// "natural texting" persona per inbound — see whatsapp-bridge/src/natural.ts.
func (h *SessionHandler) processMessage(sessionID, tenantID, agentName string, messages []sessionMessage, systemHint string) {
	ctx := context.Background()
	ctx = middleware.InjectTenantID(ctx, tenantID)

	h.publishEvent(sessionID, "agent.thinking", map[string]string{
		"status": "Processing your message...",
	})

	// Resolve system prompt: turn-level hint > stored agent prompt > default.
	var storedPrompt *string
	_ = h.srv.Pool.QueryRow(ctx, `
		SELECT system_prompt FROM agents WHERE name = $1 AND tenant_id = $2
	`, agentName, tenantID).Scan(&storedPrompt)

	systemPrompt := fmt.Sprintf("You are the agent '%s'. You are in an interactive session. Respond helpfully and concisely.", agentName)
	if storedPrompt != nil && *storedPrompt != "" {
		systemPrompt = *storedPrompt
	}
	if systemHint != "" {
		systemPrompt = systemHint
	}

	// Build the message list in the OpenAI tool-aware shape (any-valued
	// content so we can interleave tool_call / tool messages later).
	var promptMessages []map[string]any
	promptMessages = append(promptMessages, map[string]any{
		"role":    "system",
		"content": systemPrompt,
	})
	for _, m := range messages {
		promptMessages = append(promptMessages, map[string]any{
			"role":    m.Role,
			"content": m.Content,
		})
	}

	// Resolve model and API key. Consult the tenant's configured providers
	// (dashboard Settings) so auto-routing reflects what the user actually
	// set up. Fall back to the alternate provider if the first key is missing.
	provider, model := h.llmProxy.resolveModelForTenant(ctx, tenantID, "auto")
	apiKey, err := h.llmProxy.resolveProviderKey(ctx, tenantID, provider)
	if err != nil {
		altProvider := "anthropic"
		if provider == "anthropic" {
			altProvider = "openai"
		}
		if altKey, altErr := h.llmProxy.resolveProviderKey(ctx, tenantID, altProvider); altErr == nil {
			provider = altProvider
			apiKey = altKey
			if provider == "openai" {
				model = "gpt-4o"
			} else {
				model = "claude-sonnet-4-20250514"
			}
		} else {
			h.logger().Warn("session: no LLM key", zap.Error(err))
			h.appendAssistantMessage(ctx, sessionID, "I'm unable to process your request right now. Please configure an LLM provider in Settings.")
			h.publishEvent(sessionID, "agent.message", map[string]string{
				"content": "I'm unable to process your request right now. Please configure an LLM provider in Settings.",
			})
			h.publishEvent(sessionID, "session.status_idle", map[string]string{})
			return
		}
	}

	// Build the tool list from the tenant's installed connectors. Empty
	// list = no tool-calling, model just responds in text (unchanged
	// behavior for agents without connectors).
	tools, toolsErr := toolsForTenant(ctx, h.srv.Pool, tenantID)
	if toolsErr != nil {
		h.logger().Warn("session: tool catalog lookup failed", zap.Error(toolsErr))
		tools = nil
	}

	// Dispatch function closes over the tenant + pool so the tool-call
	// loop can invoke connector actions without re-resolving credentials.
	dispatch := func(dispatchCtx context.Context, name string, args map[string]any) (any, error) {
		return dispatchTool(dispatchCtx, h.srv.Pool, tenantID, name, args)
	}

	// Accumulator for tool invocations that will be persisted with the
	// assistant message after the loop finishes. Indexed in the order
	// invocations complete; we mutate the started entry on completion so
	// the chip ordering matches what the user saw via SSE.
	persisted := []persistedToolCall{}

	// Emit per-tool-call events so the UI can render "Used GitHub →
	// list_prs" chips inline with the conversation. Each invocation fires
	// twice: once before dispatch (Result==nil) and once after. We also
	// stash a serialized copy into `persisted` so it survives reload.
	onToolCall := func(inv ToolInvocation) {
		argsJSON, _ := json.Marshal(inv.Args)
		event := "agent.tool_call_started"
		payload := map[string]string{
			"name": inv.Name,
			"args": string(argsJSON),
		}
		switch {
		case inv.Error != "":
			event = "agent.tool_call_failed"
			payload["error"] = inv.Error
			// Find the most recent started entry with this name; mutate.
			for i := len(persisted) - 1; i >= 0; i-- {
				if persisted[i].Name == inv.Name && persisted[i].Status == "started" {
					persisted[i].Status = "failed"
					persisted[i].Error = inv.Error
					break
				}
			}
		case inv.Result != nil:
			event = "agent.tool_call_completed"
			resultJSON, _ := json.Marshal(inv.Result)
			s := string(resultJSON)
			if len(s) > 2000 {
				s = s[:2000] + "...(truncated)"
			}
			payload["result"] = s
			for i := len(persisted) - 1; i >= 0; i-- {
				if persisted[i].Name == inv.Name && persisted[i].Status == "started" {
					persisted[i].Status = "completed"
					persisted[i].Result = s
					break
				}
			}
		default:
			// Initial fire — Result not yet set. Record as "started".
			persisted = append(persisted, persistedToolCall{
				Name:   inv.Name,
				Args:   string(argsJSON),
				Status: "started",
			})
		}
		h.publishEvent(sessionID, event, payload)
	}

	// Run the tool-call loop. Up to 5 turns of tool use.
	result, _, _, _, llmErr := h.llmProxy.callLLMWithTools(
		ctx, provider, model, apiKey,
		promptMessages, tools, dispatch, onToolCall, 5,
	)
	if llmErr != nil {
		h.logger().Error("session: LLM call failed", zap.Error(llmErr))
		errContent := fmt.Sprintf("Sorry, I encountered an error: %s", llmErr.Error())
		h.appendAssistantMessageWithTools(ctx, sessionID, errContent, persisted)
		h.publishEvent(sessionID, "agent.message", map[string]string{
			"content": errContent,
		})
		h.publishEvent(sessionID, "session.status_idle", map[string]string{})
		return
	}

	// Append assistant message (with any persisted tool calls) and publish.
	h.appendAssistantMessageWithTools(ctx, sessionID, result, persisted)
	h.publishEvent(sessionID, "agent.message", map[string]string{
		"content":   result,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
	h.publishEvent(sessionID, "session.status_idle", map[string]string{})
}

// appendAssistantMessage appends an assistant message to the session in DB
// and sets the status back to active.
func (h *SessionHandler) appendAssistantMessage(ctx context.Context, sessionID, content string) {
	h.appendAssistantMessageWithTools(ctx, sessionID, content, nil)
}

// appendAssistantMessageWithTools is the variant used by processMessage when
// the assistant turn invoked one or more connector tools. Tool calls are
// stored on the message so they survive a page reload.
func (h *SessionHandler) appendAssistantMessageWithTools(ctx context.Context, sessionID, content string, toolCalls []persistedToolCall) {
	msg := sessionMessage{
		Role:      "assistant",
		Content:   content,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		ToolCalls: toolCalls,
	}
	msgJSON, _ := json.Marshal(msg)

	_, err := h.srv.Pool.Exec(ctx, `
		UPDATE sessions
		SET messages = messages || $1::jsonb,
		    status = 'active',
		    updated_at = now()
		WHERE id = $2
	`, string(msgJSON), sessionID)
	if err != nil {
		h.logger().Error("append assistant message failed", zap.String("session_id", sessionID), zap.Error(err))
	}
}

// publishEvent sends an event to Redis pub/sub for SSE consumers.
func (h *SessionHandler) publishEvent(sessionID, eventType string, data map[string]string) {
	evt := map[string]any{
		"type":      eventType,
		"data":      data,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	payload, _ := json.Marshal(evt)
	channel := fmt.Sprintf("session:%s:events", sessionID)
	if err := h.srv.Redis.Publish(context.Background(), channel, string(payload)).Err(); err != nil {
		h.logger().Warn("publish event failed", zap.String("session_id", sessionID), zap.Error(err))
	}
}

// GetEvents handles GET /v1/sessions/{id}/events.
// Returns a Server-Sent Events stream of session events.
func (h *SessionHandler) GetEvents(w http.ResponseWriter, r *http.Request) {
	// SSE requires the connection to stay open. Validate auth first.
	claims, err := h.auth.validateRequest(r)
	if err != nil {
		// Also check query param for EventSource (which can't set headers).
		tokenParam := r.URL.Query().Get("token")
		if tokenParam != "" {
			claims, err = h.auth.ValidateToken(tokenParam)
		}
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
	}
	tenantID := claims.TenantID

	sessionID := r.PathValue("id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id is required"})
		return
	}

	// Verify session belongs to tenant.
	var exists bool
	err = h.srv.Pool.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM sessions WHERE id = $1 AND tenant_id = $2)
	`, sessionID, tenantID).Scan(&exists)
	if err != nil || !exists {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}

	// Set SSE headers.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}

	// Send initial connected event.
	fmt.Fprintf(w, "data: %s\n\n", `{"type":"connected","data":{}}`)
	flusher.Flush()

	// Subscribe to Redis pub/sub for this session.
	channel := fmt.Sprintf("session:%s:events", sessionID)
	pubsub := h.srv.Redis.Subscribe(r.Context(), channel)
	defer pubsub.Close()

	ch := pubsub.Channel()

	// Keep connection open and forward events.
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg.Payload)
			flusher.Flush()
		}
	}
}

// StopSession handles POST /v1/sessions/{id}/stop.
func (h *SessionHandler) StopSession(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	sessionID := r.PathValue("id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id is required"})
		return
	}

	tag, err := h.srv.Pool.Exec(ctx, `
		UPDATE sessions SET status = 'stopped', updated_at = now()
		WHERE id = $1 AND tenant_id = $2
	`, sessionID, tenantID)
	if err != nil {
		h.logger().Error("stop session failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}

	h.publishEvent(sessionID, "session.stopped", map[string]string{})

	writeJSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}

// DeleteSession handles DELETE /v1/sessions/{id}.
func (h *SessionHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	sessionID := r.PathValue("id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id is required"})
		return
	}

	tag, err := h.srv.Pool.Exec(ctx, `
		DELETE FROM sessions WHERE id = $1 AND tenant_id = $2
	`, sessionID, tenantID)
	if err != nil {
		h.logger().Error("delete session failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListSessions handles GET /v1/sessions.
func (h *SessionHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id, tenant_id, agent_name, status, messages, created_at, updated_at
		FROM sessions
		WHERE tenant_id = $1
		ORDER BY updated_at DESC
		LIMIT 100
	`, tenantID)
	if err != nil {
		h.logger().Error("list sessions failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	defer rows.Close()

	sessions := make([]sessionJSON, 0)
	for rows.Next() {
		var s sessionJSON
		var messagesRaw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&s.ID, &s.TenantID, &s.AgentName, &s.Status, &messagesRaw, &createdAt, &updatedAt); err != nil {
			continue
		}
		s.CreatedAt = createdAt.Format(time.RFC3339)
		s.UpdatedAt = updatedAt.Format(time.RFC3339)
		if err := json.Unmarshal(messagesRaw, &s.Messages); err != nil {
			s.Messages = []sessionMessage{}
		}
		sessions = append(sessions, s)
	}

	writeJSON(w, http.StatusOK, sessions)
}

// GetSession handles GET /v1/sessions/{id}.
func (h *SessionHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ctx, tenantID, err := h.contextWithTenant(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	sessionID := r.PathValue("id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session id is required"})
		return
	}

	var s sessionJSON
	var messagesRaw []byte
	var createdAt, updatedAt time.Time
	err = h.srv.Pool.QueryRow(ctx, `
		SELECT id, tenant_id, agent_name, status, messages, created_at, updated_at
		FROM sessions
		WHERE id = $1 AND tenant_id = $2
	`, sessionID, tenantID).Scan(&s.ID, &s.TenantID, &s.AgentName, &s.Status, &messagesRaw, &createdAt, &updatedAt)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	if err != nil {
		h.logger().Error("get session failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	s.CreatedAt = createdAt.Format(time.RFC3339)
	s.UpdatedAt = updatedAt.Format(time.RFC3339)
	if err := json.Unmarshal(messagesRaw, &s.Messages); err != nil {
		s.Messages = []sessionMessage{}
	}

	writeJSON(w, http.StatusOK, s)
}

// ---------- LLM helper for multi-turn messages ----------

// callLLMWithMessages calls the LLM with a full message history (multi-turn).
// This extends callLLMSync to support the session abstraction.
func (h *SessionHandler) callLLMWithMessages(ctx context.Context, provider, model, apiKey string, messages []map[string]string) (result string, tokensIn, tokensOut int64, costUsd float64, err error) {
	// Build a single prompt from the messages for the existing callLLMSync.
	// In production, this would use the native messages API. For the spike,
	// we concatenate messages into a structured prompt.
	var prompt string
	for _, m := range messages {
		role := m["role"]
		content := m["content"]
		switch role {
		case "system":
			prompt += fmt.Sprintf("[System]\n%s\n\n", content)
		case "user":
			prompt += fmt.Sprintf("[User]\n%s\n\n", content)
		case "assistant":
			prompt += fmt.Sprintf("[Assistant]\n%s\n\n", content)
		}
	}
	prompt += "[Assistant]\n"

	return h.llmProxy.callLLMSync(ctx, provider, model, apiKey, prompt)
}
