package handlers

// W11d — Voice channel.
//
// Lantern agents can now also answer phone calls. The control-plane owns
// the channel config (phone number → agent mapping, provider credentials,
// greeting) and per-call state; the heavy lifting (audio in/out, ASR,
// TTS) is delegated to a pluggable VoiceProvider. Today we ship the
// adapter contract + a Twilio adapter that handles webhook signing and
// TwiML responses — the user provides their Twilio credentials and the
// integration goes live without further code changes here.
//
// Why this is build-to-the-boundary: real bidirectional audio requires
// a media server (LiveKit, Daily, or Twilio Media Streams) and STT/TTS
// providers. We ship the full control + state surface; the audio
// pipeline plugs in via VoiceProvider implementations.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

type VoiceHandler struct {
	srv       *server.Server
	auth      *AuthHandler
	providers map[string]VoiceProvider
}

func NewVoiceHandler(srv *server.Server, auth *AuthHandler) *VoiceHandler {
	h := &VoiceHandler{
		srv:       srv,
		auth:      auth,
		providers: make(map[string]VoiceProvider),
	}
	// Register the built-in providers. Adding a new provider is two
	// lines: implement VoiceProvider and register it here.
	h.providers["twilio"] = &twilioProvider{}
	return h
}

func (h *VoiceHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("voice")
}

// ---------- VoiceProvider interface ----------

// VoiceProvider is the per-vendor adapter. Implementations are stateless;
// per-call state lives in voice_calls. Methods take the relevant config
// blob from voice_numbers.provider_config so credentials don't leak
// across calls.
type VoiceProvider interface {
	// Validate returns an error if the provider_config is missing
	// required fields. Called when the user saves a voice number, so
	// invalid configs never make it to "active" status.
	Validate(config map[string]any) error

	// HandleInboundWebhook is called by the provider's webhook (e.g.
	// Twilio POSTs to /v1/voice/webhook/twilio when a call arrives).
	// The provider extracts call metadata + returns the response body
	// the provider's webhook expects (TwiML XML for Twilio, JSON for
	// LiveKit, etc.).
	HandleInboundWebhook(ctx context.Context, config map[string]any, body []byte, headers http.Header) (responseBody []byte, contentType string, callMeta InboundCall, err error)
}

// InboundCall is the normalized cross-provider call descriptor the
// control-plane stores in voice_calls.
type InboundCall struct {
	ProviderCallID string
	FromNumber     string
	ToNumber       string
}

// ---------- Twilio provider (real, but inert until credentials provided) ----------

type twilioProvider struct{}

func (p *twilioProvider) Validate(config map[string]any) error {
	if _, ok := config["accountSid"].(string); !ok {
		return fmt.Errorf("twilio.accountSid is required")
	}
	if _, ok := config["authToken"].(string); !ok {
		return fmt.Errorf("twilio.authToken is required")
	}
	return nil
}

func (p *twilioProvider) HandleInboundWebhook(_ context.Context, _ map[string]any, _ []byte, headers http.Header) ([]byte, string, InboundCall, error) {
	// Twilio sends form-urlencoded params: CallSid, From, To, etc.
	// In real production we'd verify the X-Twilio-Signature header
	// against the auth token + URL. For now we extract the form
	// fields directly from the parsed request.
	meta := InboundCall{
		ProviderCallID: headers.Get("X-Lantern-Call-Sid"),
		FromNumber:     headers.Get("X-Lantern-From"),
		ToNumber:       headers.Get("X-Lantern-To"),
	}
	// Return TwiML that says the greeting, then opens a media stream
	// back to our /v1/voice/stream/{callId} endpoint. The media-stream
	// wiring is the last mile (LiveKit / Twilio Media Streams) — without
	// it, calls just play the greeting + hang up.
	twiml := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to the Lantern agent now.</Say>
  <Pause length="1"/>
  <Say voice="alice">Audio streaming is not yet configured. Please follow up with the operator.</Say>
</Response>`)
	return twiml, "application/xml", meta, nil
}

// ---------- Number management ----------

type voiceNumberPayload struct {
	AgentName      string         `json:"agentName"`
	Provider       string         `json:"provider"`
	PhoneNumber    string         `json:"phoneNumber"`
	DisplayName    string         `json:"displayName,omitempty"`
	ProviderConfig map[string]any `json:"providerConfig"`
	VoiceID        string         `json:"voiceId,omitempty"`
	Greeting       string         `json:"greeting,omitempty"`
}

// CreateNumber handles POST /v1/voice/numbers.
func (h *VoiceHandler) CreateNumber(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body voiceNumberPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.AgentName == "" || body.PhoneNumber == "" || body.Provider == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agentName, provider, phoneNumber required"})
		return
	}
	provider, ok := h.providers[body.Provider]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("unknown provider %q (built-in: twilio)", body.Provider),
		})
		return
	}
	if err := provider.Validate(body.ProviderConfig); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	configJSON, _ := json.Marshal(body.ProviderConfig)
	var id string
	err = h.srv.Pool.QueryRow(ctx, `
		INSERT INTO voice_numbers
			(tenant_id, agent_name, provider, phone_number, display_name,
			 provider_config, voice_id, greeting, status)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'active')
		ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
			agent_name = EXCLUDED.agent_name,
			provider = EXCLUDED.provider,
			display_name = EXCLUDED.display_name,
			provider_config = EXCLUDED.provider_config,
			voice_id = EXCLUDED.voice_id,
			greeting = EXCLUDED.greeting,
			status = 'active',
			updated_at = now()
		RETURNING id::text
	`,
		tenantID, body.AgentName, body.Provider, body.PhoneNumber, body.DisplayName,
		string(configJSON), body.VoiceID, body.Greeting,
	).Scan(&id)
	if err != nil {
		h.logger().Error("save voice number failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save number"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":          id,
		"agentName":   body.AgentName,
		"provider":    body.Provider,
		"phoneNumber": body.PhoneNumber,
		"status":      "active",
	})
}

// ListNumbers handles GET /v1/voice/numbers.
func (h *VoiceHandler) ListNumbers(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id::text, agent_name, provider, phone_number,
		       COALESCE(display_name, ''), status, COALESCE(last_error, ''),
		       created_at, updated_at
		FROM voice_numbers
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, agent, provider, phone, displayName, status, lastErr string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &agent, &provider, &phone, &displayName, &status, &lastErr, &createdAt, &updatedAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":          id,
			"agentName":   agent,
			"provider":    provider,
			"phoneNumber": phone,
			"displayName": displayName,
			"status":      status,
			"lastError":   lastErr,
			"createdAt":   createdAt,
			"updatedAt":   updatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteNumber handles DELETE /v1/voice/numbers/{id}.
func (h *VoiceHandler) DeleteNumber(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	tag, err := h.srv.Pool.Exec(ctx, `DELETE FROM voice_numbers WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Provider webhooks ----------

// Webhook handles POST /v1/voice/webhook/{provider}. The provider's
// platform calls this URL when a call arrives; we look up the number,
// record the call, and ask the provider to handle the response.
//
// Auth: per-provider signature verification (X-Twilio-Signature etc.),
// using the credentials from the looked-up number's provider_config.
// Fails closed unless LANTERN_TWILIO_WEBHOOK_AUTH=off (dev only).
func (h *VoiceHandler) Webhook(w http.ResponseWriter, r *http.Request) {
	providerName := r.PathValue("provider")
	provider, ok := h.providers[providerName]
	if !ok {
		http.Error(w, "unknown provider", http.StatusBadRequest)
		return
	}

	// Parse form data into headers so the provider adapter sees a
	// uniform request shape. Real providers POST x-www-form-urlencoded.
	_ = r.ParseForm()
	// Re-inject the form values as headers (X-Lantern-*) so providers
	// can read them with the headers map alone — keeps the adapter
	// interface narrow.
	headers := r.Header.Clone()
	if v := r.FormValue("CallSid"); v != "" {
		headers.Set("X-Lantern-Call-Sid", v)
	}
	if v := r.FormValue("From"); v != "" {
		headers.Set("X-Lantern-From", v)
	}
	if v := r.FormValue("To"); v != "" {
		headers.Set("X-Lantern-To", v)
	}

	// Look up the matching voice_numbers row by the dialed number.
	to := headers.Get("X-Lantern-To")
	if to == "" {
		http.Error(w, "missing destination number", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	var tenantID, numberID, agentName string
	var configRaw []byte
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT tenant_id::text, id::text, agent_name,
		       COALESCE(provider_config, '{}'::jsonb)::text::bytea
		FROM voice_numbers
		WHERE phone_number = $1 AND status = 'active'
		LIMIT 1
	`, to).Scan(&tenantID, &numberID, &agentName, &configRaw)
	if err != nil {
		h.logger().Warn("voice webhook: unknown number", zap.String("to", to))
		http.Error(w, "no agent configured for this number", http.StatusNotFound)
		return
	}

	cfg := map[string]any{}
	_ = json.Unmarshal(configRaw, &cfg)

	// Verify provider webhook authenticity before acting on it. The
	// number's provider_config holds the credentials we sign against.
	if providerName == "twilio" && strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) != "off" {
		token, _ := cfg["authToken"].(string)
		fullURL := derivePublicURL(r) + r.URL.Path
		if !validTwilioSignature(token, fullURL, r.PostForm, r.Header.Get("X-Twilio-Signature")) {
			h.logger().Warn("voice webhook: invalid Twilio signature", zap.String("to", to))
			http.Error(w, "invalid signature", http.StatusForbidden)
			return
		}
	}

	respBody, contentType, meta, err := provider.HandleInboundWebhook(ctx, cfg, nil, headers)
	if err != nil {
		h.logger().Error("voice provider failed", zap.Error(err))
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Record the call so the dashboard can surface it. duration + cost
	// land later via /v1/voice/calls/{id}/end emitted by the provider
	// when the call hangs up.
	_, _ = h.srv.Pool.Exec(ctx, `
		INSERT INTO voice_calls (tenant_id, voice_number_id, agent_name,
		                          direction, from_number, to_number,
		                          provider_call_id, status)
		VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'ringing')
	`, tenantID, numberID, agentName, meta.FromNumber, meta.ToNumber, meta.ProviderCallID)

	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(respBody)
}

// ---------- Recent calls ----------

func (h *VoiceHandler) ListCalls(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	rows, err := h.srv.Pool.Query(ctx, `
		SELECT id::text, agent_name, direction, from_number, to_number,
		       status, COALESCE(duration_ms, 0), cost_usd,
		       started_at, ended_at
		FROM voice_calls
		WHERE tenant_id = $1
		ORDER BY started_at DESC
		LIMIT 100
	`, tenantID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var id, agent, direction, from, to, status string
		var durationMs int64
		var costUsd float64
		var startedAt time.Time
		var endedAt *time.Time
		if err := rows.Scan(&id, &agent, &direction, &from, &to, &status, &durationMs, &costUsd, &startedAt, &endedAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":         id,
			"agentName":  agent,
			"direction":  direction,
			"from":       from,
			"to":         to,
			"status":     status,
			"durationMs": durationMs,
			"costUsd":    costUsd,
			"startedAt":  startedAt,
			"endedAt":    endedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
