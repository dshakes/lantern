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
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/dshakes/lantern/services/control-plane/internal/secrets"
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
	h.providers["livekit"] = &livekitProvider{}
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

	// VerifyWebhook authenticates an inbound webhook using the provider's
	// own scheme (Twilio: X-Twilio-Signature over the URL+params; LiveKit:
	// an Authorization JWT over the API secret + body hash). fullURL is the
	// absolute request URL; body is the raw request body. Returns nil when
	// the request is authentic. Returning an error fails the webhook closed.
	VerifyWebhook(config map[string]any, fullURL string, headers http.Header, body []byte) error

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

// VerifyWebhook checks the X-Twilio-Signature over the absolute URL + POST
// params using the install's auth token. Verification is performed by the
// generic webhook handler before this provider runs, but exposing it on the
// provider keeps the contract uniform and lets callers re-verify.
func (p *twilioProvider) VerifyWebhook(config map[string]any, fullURL string, headers http.Header, body []byte) error {
	token, _ := config["authToken"].(string)
	if token == "" {
		return fmt.Errorf("twilio authToken not configured")
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return fmt.Errorf("parse form: %w", err)
	}
	if !validTwilioSignature(token, fullURL, form, headers.Get("X-Twilio-Signature")) {
		return fmt.Errorf("invalid Twilio signature")
	}
	return nil
}

func (p *twilioProvider) HandleInboundWebhook(_ context.Context, _ map[string]any, _ []byte, headers http.Header) ([]byte, string, InboundCall, error) {
	// Twilio sends form-urlencoded params (CallSid, From, To, ...). The
	// generic webhook handler verifies the X-Twilio-Signature and injects
	// the relevant fields as X-Lantern-* headers before calling this.
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
			"error": fmt.Sprintf("unknown provider %q (built-in: twilio, livekit)", body.Provider),
		})
		return
	}
	if err := provider.Validate(body.ProviderConfig); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Provider configs hold secrets (Twilio authToken, LiveKit apiSecret),
	// so encrypt at rest (pass-through when no key is configured).
	rawConfigJSON, _ := json.Marshal(body.ProviderConfig)
	configJSON, err := secrets.EncryptString(string(rawConfigJSON))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to secure credentials"})
		return
	}
	var id string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
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
	})
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
	out := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id::text, agent_name, provider, phone_number,
			       COALESCE(display_name, ''), status, COALESCE(last_error, ''),
			       created_at, updated_at
			FROM voice_numbers
			WHERE tenant_id = $1
			ORDER BY created_at DESC
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
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
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
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
	var rowsAffected int64
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, `DELETE FROM voice_numbers WHERE id = $1 AND tenant_id = $2`, id, tenantID)
		if execErr != nil {
			return execErr
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}
	if rowsAffected == 0 {
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

	// Read the raw body once: providers verify against it (LiveKit hashes
	// it; Twilio signs over the parsed params) and we restore it for
	// ParseForm below.
	bodyBytes, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	// Parse form data into headers so form-based providers (Twilio) see a
	// uniform request shape. Non-form providers (LiveKit) post JSON; the
	// form is simply empty.
	_ = r.ParseForm()
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

	ctx := r.Context()
	var tenantID, numberID, agentName string
	var configRaw []byte

	// Resolve the voice_numbers row. Form-based providers identify the
	// dialed number directly (To); others (LiveKit SIP) don't carry it in
	// the webhook, so we resolve by the single active number for that
	// provider — the common one-project-per-deployment case.
	if to := headers.Get("X-Lantern-To"); to != "" {
		// rls-exempt: inbound webhook carries no JWT/tenant context — this is the
		// lookup that RESOLVES which tenant owns the dialed number (keyed by
		// phone_number across all tenants), so it must run on the privileged pool.
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
	} else {
		// rls-exempt: LiveKit SIP webhook carries no dialed number; resolve the
		// single active number for the provider across tenants (no tenant context
		// yet) on the privileged pool.
		err := h.srv.Pool.QueryRow(ctx, `
			SELECT tenant_id::text, id::text, agent_name,
			       COALESCE(provider_config, '{}'::jsonb)::text::bytea
			FROM voice_numbers
			WHERE provider = $1 AND status = 'active'
			ORDER BY created_at
			LIMIT 1
		`, providerName).Scan(&tenantID, &numberID, &agentName, &configRaw)
		if err != nil {
			h.logger().Warn("voice webhook: no active number for provider", zap.String("provider", providerName))
			http.Error(w, "no agent configured for this provider", http.StatusNotFound)
			return
		}
	}

	if dec, decErr := secrets.Decrypt(configRaw); decErr == nil {
		configRaw = dec
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(configRaw, &cfg)

	// Verify provider webhook authenticity before acting on it, using the
	// number's provider_config credentials. Twilio honors a dev-only bypass.
	skipVerify := providerName == "twilio" && strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) == "off"
	if !skipVerify {
		fullURL := derivePublicURL(r) + r.URL.Path
		if verr := provider.VerifyWebhook(cfg, fullURL, headers, bodyBytes); verr != nil {
			h.logger().Warn("voice webhook: verification failed",
				zap.String("provider", providerName), zap.Error(verr))
			http.Error(w, "invalid signature", http.StatusForbidden)
			return
		}
	}

	// Budget gate: voice spend counts against the agent's budget, the same
	// way LLM runs do. A hard-fail-blocked agent declines the call BEFORE it
	// connects so no carrier/media cost is incurred.
	// rls-exempt: shared budget helper takes a *Pool and self-scopes by the
	// resolved tenantID arg; reused identically across handlers.
	if bc := CheckBudget(ctx, h.srv.Pool, tenantID, agentName, estimatedInboundVoiceUsd); !bc.Allowed && bc.HardFail {
		h.logger().Warn("voice call blocked by budget",
			zap.String("agent", agentName), zap.String("reason", bc.Reason))
		if providerName == "twilio" {
			// <Reject> declines before answering, so Twilio does not bill it.
			w.Header().Set("Content-Type", "application/xml")
			_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>`))
			return
		}
		http.Error(w, "agent voice budget exhausted", http.StatusPaymentRequired)
		return
	}

	respBody, contentType, meta, err := provider.HandleInboundWebhook(ctx, cfg, bodyBytes, headers)
	if err != nil {
		h.logger().Error("voice provider failed", zap.Error(err))
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Record the call so the dashboard can surface it. duration + actual cost
	// are reconciled later via POST /v1/voice/calls/status/{provider}, which
	// the provider's status callback hits when the call ends. The tenant was
	// just resolved from the number lookup; inject it so the INSERT is RLS-scoped.
	insertCtx := middleware.InjectTenantID(ctx, tenantID)
	_ = h.srv.WithTenant(insertCtx, func(tx pgx.Tx) error {
		_, e := tx.Exec(insertCtx, `
			INSERT INTO voice_calls (tenant_id, voice_number_id, agent_name,
			                          direction, from_number, to_number,
			                          provider_call_id, status)
			VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'ringing')
		`, tenantID, numberID, agentName, meta.FromNumber, meta.ToNumber, meta.ProviderCallID)
		return e
	})

	// Accrue the estimated cost into the daily rollup immediately so the
	// budget reflects in-flight voice spend (reconciled to actual on call end).
	// rls-exempt: shared usage-rollup helper takes a *Pool and self-scopes by
	// the resolved tenantID arg; reused identically across handlers.
	if err := RecordUsage(ctx, h.srv.Pool, tenantID, agentName, 0, 0, estimatedInboundVoiceUsd, map[string]int{"voice_call": 1}); err != nil {
		h.logger().Warn("record voice usage failed", zap.Error(err))
	}

	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(respBody)
}

// estimatedInboundVoiceUsd is the pre-call cost reservation charged against an
// agent's budget when a voice call connects. It's deliberately a small flat
// estimate (a few minutes of PSTN + STT/TTS/LLM); actual per-call cost is
// reconciled into voice_calls.cost_usd when the call ends.
const estimatedInboundVoiceUsd = 0.05

// ---------- Access tokens (LiveKit) ----------

// MintToken handles POST /v1/voice/token. It issues a short-lived LiveKit
// access token so a browser client or the LiveKit Agents worker can join a
// room. This is the real handoff between the control-plane (token authority)
// and the media worker (the realtime audio loop). Owner/JWT-authenticated.
//
// Body: { "room": "...", "identity": "...", "name"?: "...", "provider"?: "livekit" }
// Returns: { "token": "<jwt>", "url": "wss://..." }
func (h *VoiceHandler) MintToken(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var body struct {
		Provider string `json:"provider"`
		Room     string `json:"room"`
		Identity string `json:"identity"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.Room == "" || body.Identity == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "room and identity are required"})
		return
	}
	providerName := body.Provider
	if providerName == "" {
		providerName = "livekit"
	}
	if providerName != "livekit" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token minting is only supported for the livekit provider"})
		return
	}

	var configRaw []byte
	var agentName string
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT agent_name, COALESCE(provider_config, '{}'::jsonb)::text::bytea
			FROM voice_numbers
			WHERE tenant_id = $1 AND provider = 'livekit' AND status = 'active'
			ORDER BY created_at
			LIMIT 1
		`, tenantID).Scan(&agentName, &configRaw)
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no active livekit voice number configured"})
		return
	}

	// Budget gate: deny the join token when the agent is over a hard-fail
	// budget. No token → the LiveKit Agents worker can't join → no media spend.
	// rls-exempt: shared budget helper takes a *Pool and self-scopes by tenantID.
	if bc := CheckBudget(ctx, h.srv.Pool, tenantID, agentName, estimatedInboundVoiceUsd); !bc.Allowed && bc.HardFail {
		h.logger().Warn("livekit token denied by budget",
			zap.String("agent", agentName), zap.String("reason", bc.Reason))
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": "agent voice budget exhausted: " + bc.Reason})
		return
	}

	if dec, decErr := secrets.Decrypt(configRaw); decErr == nil {
		configRaw = dec
	}
	cfg := map[string]any{}
	_ = json.Unmarshal(configRaw, &cfg)
	apiKey, _ := cfg["apiKey"].(string)
	apiSecret, _ := cfg["apiSecret"].(string)
	wsURL, _ := cfg["wsUrl"].(string)

	token, err := mintLiveKitToken(apiKey, apiSecret, body.Room, body.Identity, body.Name, 15*time.Minute)
	if err != nil {
		h.logger().Error("mint livekit token failed", zap.Error(err))
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to mint token"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token, "url": wsURL})
}

// ---------- Call-end cost reconciliation ----------

// CallStatus handles POST /v1/voice/calls/status/{provider}. The provider's
// platform POSTs here when a call's status changes — Twilio's "call status
// changes" callback (CallSid, CallStatus, CallDuration), or a LiveKit
// room_finished webhook. On a terminal status we reconcile the flat
// connect-time estimate to the actual duration-based cost: we persist
// cost_usd + duration on the voice_calls row and adjust the agent's daily
// budget rollup by (actual − estimate). A zero-duration call refunds the
// reservation in full.
//
// Wiring: point the number's status callback at
//
//	<public-url>/v1/voice/calls/status/twilio
//
// Idempotent: a duplicate terminal callback is a no-op (guarded in the UPDATE).
func (h *VoiceHandler) CallStatus(w http.ResponseWriter, r *http.Request) {
	providerName := r.PathValue("provider")
	bodyBytes, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	_ = r.ParseForm()

	// Extract the provider call id, duration, and whether the call reached a
	// terminal state, per provider.
	var providerCallID string
	var durationSec int
	var terminal bool
	switch providerName {
	case "twilio":
		providerCallID = r.FormValue("CallSid")
		durationSec, _ = strconv.Atoi(r.FormValue("CallDuration"))
		switch r.FormValue("CallStatus") {
		case "completed", "busy", "failed", "no-answer", "canceled":
			terminal = true
		}
	case "livekit":
		var ev struct {
			Event string `json:"event"`
			Room  struct {
				Sid      string  `json:"sid"`
				Duration float64 `json:"duration"`
			} `json:"room"`
		}
		_ = json.Unmarshal(bodyBytes, &ev)
		providerCallID = ev.Room.Sid
		durationSec = int(ev.Room.Duration)
		terminal = ev.Event == "room_finished"
	default:
		http.Error(w, "unknown provider", http.StatusBadRequest)
		return
	}
	if providerCallID == "" {
		http.Error(w, "missing provider call id", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	// Find the recorded call + its number's encrypted config (for sig verify).
	// Constrain by provider so a Twilio CallSid can't be reconciled by a
	// LiveKit callback (or vice-versa). reservationDay is the UTC date the
	// connect-time estimate was charged on, so the delta lands on the same day.
	var callID, tenantID, agentName, status, reservationDay string
	var cfgRaw []byte
	// rls-exempt: status callback carries no JWT/tenant context — this lookup
	// RESOLVES the tenant from the provider_call_id across tenants, so it runs
	// on the privileged pool.
	err := h.srv.Pool.QueryRow(ctx, `
		SELECT vc.id::text, vc.tenant_id::text, vc.agent_name, vc.status,
		       to_char(vc.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
		       COALESCE(vn.provider_config, '{}'::jsonb)::text::bytea
		FROM voice_calls vc
		JOIN voice_numbers vn ON vn.id = vc.voice_number_id
		WHERE vc.provider_call_id = $1 AND vn.provider = $2
		ORDER BY vc.started_at DESC
		LIMIT 1
	`, providerCallID, providerName).Scan(&callID, &tenantID, &agentName, &status, &reservationDay, &cfgRaw)
	if err != nil {
		// Unknown call — ack so the provider stops retrying.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Verify the provider's webhook authenticity before mutating state, using
	// the number's encrypted config. Twilio: X-Twilio-Signature (with a dev
	// bypass). LiveKit: the Authorization JWT over the API secret + body hash,
	// same scheme as inbound LiveKit webhooks — these callbacks adjust budget,
	// so they must be authenticated too.
	skipVerify := providerName == "twilio" && strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) == "off"
	if !skipVerify {
		if dec, decErr := secrets.Decrypt(cfgRaw); decErr == nil {
			cfgRaw = dec
		}
		cfg := map[string]any{}
		_ = json.Unmarshal(cfgRaw, &cfg)
		var verr error
		switch providerName {
		case "twilio":
			token, _ := cfg["authToken"].(string)
			fullURL := derivePublicURL(r) + r.URL.Path
			if !validTwilioSignature(token, fullURL, r.PostForm, r.Header.Get("X-Twilio-Signature")) {
				verr = fmt.Errorf("invalid Twilio signature")
			}
		case "livekit":
			secret, _ := cfg["apiSecret"].(string)
			verr = verifyLiveKitWebhook(secret, r.Header.Get("Authorization"), bodyBytes)
		}
		if verr != nil {
			h.logger().Warn("voice status callback: verification failed",
				zap.String("provider", providerName), zap.Error(verr))
			http.Error(w, "invalid signature", http.StatusForbidden)
			return
		}
	}

	if !terminal {
		// Non-terminal update (ringing/in-progress) — nothing to reconcile.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if status == "completed" || status == "failed" {
		w.WriteHeader(http.StatusNoContent) // already reconciled
		return
	}

	actual := voiceCallCostUsd(providerName, durationSec)
	newStatus := "completed"
	if durationSec <= 0 {
		newStatus = "failed"
	}

	// Persist actual cost + duration. The WHERE guard makes a concurrent or
	// duplicate callback a no-op (atomic idempotency). The tenant was resolved
	// from the call lookup above; inject it so the UPDATE is RLS-scoped.
	updateCtx := middleware.InjectTenantID(ctx, tenantID)
	var rowsAffected int64
	err = h.srv.WithTenant(updateCtx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(updateCtx, `
			UPDATE voice_calls
			SET status = $2, duration_ms = $3, cost_usd = $4, ended_at = now()
			WHERE id = $1 AND status NOT IN ('completed','failed')
		`, callID, newStatus, int64(durationSec)*1000, actual)
		if e != nil {
			return e
		}
		rowsAffected = tag.RowsAffected()
		return nil
	})
	if err != nil || rowsAffected == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Reconcile the budget on the call's reservation day: estimatedInboundVoiceUsd
	// was charged at connect. Apply the delta (negative on short/declined calls
	// = a refund).
	// rls-exempt: shared usage-rollup helper takes a *Pool and self-scopes by tenantID.
	if err := AdjustUsageCost(ctx, h.srv.Pool, tenantID, agentName, reservationDay, actual-estimatedInboundVoiceUsd); err != nil {
		h.logger().Warn("reconcile voice usage failed", zap.Error(err))
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Recent calls ----------

func (h *VoiceHandler) ListCalls(w http.ResponseWriter, r *http.Request) {
	ctx, tenantID, err := authCtx(h.auth, r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	out := make([]map[string]any, 0)
	err = h.srv.WithTenant(ctx, func(tx pgx.Tx) error {
		rows, qErr := tx.Query(ctx, `
			SELECT id::text, agent_name, direction, from_number, to_number,
			       status, COALESCE(duration_ms, 0), cost_usd,
			       started_at, ended_at
			FROM voice_calls
			WHERE tenant_id = $1
			ORDER BY started_at DESC
			LIMIT 100
		`, tenantID)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
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
		return rows.Err()
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}
