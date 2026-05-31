// Twilio-number-as-private-agent handler.
//
// The owner's Twilio number is a private interface to their agent —
// NOT a public-facing chat surface. Only the owner texts/calls this
// number. Everyone else texts/calls the owner's personal number (which
// is already handled by the WhatsApp + iMessage bridges).
//
// Two endpoints:
//
//   POST /v1/sms/twilio/webhook
//     Twilio fires this when an SMS arrives at the owner's Twilio
//     number. We verify the sender is the owner (LANTERN_OWNER_PHONE),
//     run the body through the agent loop with full tools (same
//     authenticity stack as iMessage/WhatsApp self-chat), and reply
//     via Twilio's send_sms. Senders OTHER than the owner → silent
//     drop (no one else should be reaching the agent here).
//
//   POST /v1/voice/twilio/webhook
//     Twilio fires this when a voice call arrives. We reply with
//     TwiML that <Gather>s speech input, transcribes, runs through
//     the agent, and speaks the answer back. Owner can have a
//     hands-free conversation with their agent from any phone.
//
// Twilio Console wiring (one-time, both endpoints):
//   Phone Numbers → manage → click your Twilio number
//   • Messaging → "A message comes in" → Webhook → <public-url>/v1/sms/twilio/webhook
//   • Voice    → "A call comes in"     → Webhook → <public-url>/v1/voice/twilio/webhook
//   HTTP method POST for both.
//
// For local dev: tunnel localhost:8080 via Cloudflare Tunnel
// (free, persistent URL with auth) or ngrok (free, ephemeral URL).
// Point the Twilio webhooks at the tunnel URL.
//
// Security:
//   - Sender phone MUST match LANTERN_OWNER_PHONE (normalized to
//     digits-only). Mismatches are silently dropped.
//   - Twilio HMAC-SHA1 signature verification on every request,
//     skipped only when LANTERN_TWILIO_WEBHOOK_AUTH=off (dev).
//   - The agent runs with full tools because the only caller is the
//     trusted owner.

package handlers

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SMSHandler routes Twilio inbound SMS + Voice from the owner to the
// agent pipeline via HTTP loopback to the control-plane's existing
// /v1/completions + /v1/connectors/twilio/execute routes.
type SMSHandler struct {
	logger        *zap.Logger
	apiBaseURL    string // self-loopback, e.g. http://127.0.0.1:8080
	twilioAuthOff bool
	// Cached Twilio auth token from the installed connector. Loaded
	// lazily; refreshed on signature-verification failures.
	authTokenMu sync.RWMutex
	authToken   string
	authTokenAt time.Time
}

// NewSMSHandler wires the handler.
func NewSMSHandler(logger *zap.Logger, apiBaseURL string) *SMSHandler {
	return &SMSHandler{
		logger:        logger.Named("sms"),
		apiBaseURL:    strings.TrimRight(apiBaseURL, "/"),
		twilioAuthOff: strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) == "off",
	}
}

// SMSWebhook is the POST /v1/sms/twilio/webhook handler.
func (h *SMSHandler) SMSWebhook(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeTwiML(w, "")
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	if err := r.ParseForm(); err != nil {
		writeTwiML(w, "")
		return
	}

	if !h.twilioAuthOff {
		if ok, why := h.verifyTwilioSignature(r, bodyBytes); !ok {
			h.logger.Warn("Twilio SMS signature invalid",
				zap.String("reason", why),
				zap.String("from", maskPhone(r.Form.Get("From"))))
			writeTwiML(w, "")
			return
		}
	}

	from := r.Form.Get("From")
	to := r.Form.Get("To")
	body := strings.TrimSpace(r.Form.Get("Body"))
	if from == "" || to == "" || body == "" {
		writeTwiML(w, "")
		return
	}

	// Owner-only gate.
	ownerPhone := strings.TrimSpace(os.Getenv("LANTERN_OWNER_PHONE"))
	if normalizePhone(from) != normalizePhone(ownerPhone) {
		h.logger.Warn("SMS from non-owner — silent drop",
			zap.String("from", maskPhone(from)))
		writeTwiML(w, "")
		return
	}

	h.logger.Info("owner SMS inbound via Twilio",
		zap.String("from", maskPhone(from)),
		zap.String("body", smsTruncate(body, 80)))

	// Reply 200 immediately so Twilio doesn't time out; agent runs async.
	writeTwiML(w, "")
	go h.processSMSAsync(to, from, body)
}

func (h *SMSHandler) processSMSAsync(twilioNumber, ownerPhone, body string) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	reply, err := h.askOwnerAgent(ctx, body)
	if err != nil {
		h.logger.Warn("SMS agent failed", zap.Error(err))
		return
	}
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return
	}
	// Hard SMS length cap: Twilio segments at 160 chars (GSM-7) or 70
	// (UCS-2). 300 chars ≈ 2 SMS segments. Long replies get truncated
	// with a "see WhatsApp for more" tail.
	if len(reply) > 300 {
		reply = reply[:295] + " […]"
	}

	// Outbound via the existing Twilio executor's send_sms action.
	if err := h.sendSMS(ctx, twilioNumber, ownerPhone, reply); err != nil {
		h.logger.Error("SMS reply failed", zap.Error(err))
		return
	}
	h.logger.Info("SMS reply sent",
		zap.String("to", maskPhone(ownerPhone)),
		zap.String("preview", smsTruncate(reply, 80)))
}

// VoiceWebhook is the POST /v1/voice/twilio/webhook handler. When the
// owner CALLS their Twilio number, this returns TwiML that:
//   - Greets them
//   - Gathers their speech for up to 6 seconds
//   - Forwards the transcribed speech to /v1/voice/twilio/turn
//
// The turn endpoint runs the agent + speaks the reply back, looping
// until the caller hangs up.
func (h *SMSHandler) VoiceWebhook(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeTwiML(w, "")
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	if err := r.ParseForm(); err != nil {
		writeTwiML(w, "")
		return
	}
	if !h.twilioAuthOff {
		if ok, _ := h.verifyTwilioSignature(r, bodyBytes); !ok {
			writeTwiML(w, "")
			return
		}
	}

	from := r.Form.Get("From")
	ownerPhone := strings.TrimSpace(os.Getenv("LANTERN_OWNER_PHONE"))
	if normalizePhone(from) != normalizePhone(ownerPhone) {
		// Non-owner calls get a polite "wrong number" + hang up.
		writeTwiML(w, `<Say voice="Polly.Joanna">Sorry, you've reached a private line. Goodbye.</Say><Hangup/>`)
		return
	}

	// Public base URL the bridge serves at (the SAME URL Twilio is
	// hitting now). We need it as the action of the <Gather> so Twilio
	// posts the transcribed speech back to /v1/voice/twilio/turn.
	publicURL := h.deriveOwnPublicURL(r)
	turnURL := publicURL + "/v1/voice/twilio/turn"

	h.logger.Info("owner voice call inbound via Twilio",
		zap.String("from", maskPhone(from)))

	greet := `<Say voice="Polly.Joanna">Hey, what's up?</Say>` +
		fmt.Sprintf(`<Gather input="speech" action="%s" method="POST" speechTimeout="auto" timeout="10"></Gather>`, escapeXML(turnURL)) +
		`<Say voice="Polly.Joanna">Didn't catch that. Try again or text me instead. Bye.</Say><Hangup/>`
	writeTwiML(w, greet)
}

// VoiceTurn is the POST /v1/voice/twilio/turn handler. Called by
// Twilio after <Gather> captured speech. We run the agent + speak
// the reply + re-Gather for the next turn.
func (h *SMSHandler) VoiceTurn(w http.ResponseWriter, r *http.Request) {
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeTwiML(w, "<Hangup/>")
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	if err := r.ParseForm(); err != nil {
		writeTwiML(w, "<Hangup/>")
		return
	}
	if !h.twilioAuthOff {
		if ok, _ := h.verifyTwilioSignature(r, bodyBytes); !ok {
			writeTwiML(w, "<Hangup/>")
			return
		}
	}

	from := r.Form.Get("From")
	ownerPhone := strings.TrimSpace(os.Getenv("LANTERN_OWNER_PHONE"))
	if normalizePhone(from) != normalizePhone(ownerPhone) {
		writeTwiML(w, "<Hangup/>")
		return
	}

	transcript := strings.TrimSpace(r.Form.Get("SpeechResult"))
	if transcript == "" {
		// No speech — graceful exit.
		writeTwiML(w, `<Say voice="Polly.Joanna">Didn't hear anything. Talk to you later.</Say><Hangup/>`)
		return
	}
	h.logger.Info("voice turn",
		zap.String("from", maskPhone(from)),
		zap.String("transcript", smsTruncate(transcript, 80)))

	// Quick exit phrases.
	if matchesExit(transcript) {
		writeTwiML(w, `<Say voice="Polly.Joanna">Got it. Bye.</Say><Hangup/>`)
		return
	}

	// Run agent — synchronous since Twilio holds the call open for
	// the duration of our HTTP response.
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	reply, err := h.askOwnerAgent(ctx, transcript)
	if err != nil || strings.TrimSpace(reply) == "" {
		writeTwiML(w, `<Say voice="Polly.Joanna">Hmm, didn't catch that. Try again.</Say><Hangup/>`)
		return
	}

	// Voice replies stay short (TTS is slow, owner is on the phone).
	if len(reply) > 600 {
		reply = reply[:580] + ". more on the text channel."
	}

	publicURL := h.deriveOwnPublicURL(r)
	turnURL := publicURL + "/v1/voice/twilio/turn"
	twiml := fmt.Sprintf(
		`<Say voice="Polly.Joanna">%s</Say><Gather input="speech" action="%s" method="POST" speechTimeout="auto" timeout="10"></Gather><Say voice="Polly.Joanna">Talk to you later.</Say><Hangup/>`,
		escapeXML(reply), escapeXML(turnURL))
	writeTwiML(w, twiml)
}

// askOwnerAgent runs the LLM with the owner-agent persona. Uses an
// HTTP loopback to /v1/completions so we benefit from the same
// failover routing the dashboard uses.
func (h *SMSHandler) askOwnerAgent(ctx context.Context, userText string) (string, error) {
	ownerName := getEnvOr("LANTERN_OWNER_NAME", "Shekhar")
	system := strings.Join([]string{
		"You are " + ownerName + "'s private agent, reached via his Twilio number.",
		"This is HIS personal command channel — treat every message as coming from him.",
		"Be terse, factual, useful. SMS replies under 30 words; voice replies under 60 words.",
		"You can answer questions about his schedule, contacts, emails, files, recent messages — same as his self-chat on WhatsApp/iMessage.",
		"Plain text only. No markdown. Lowercase ok. Use contractions.",
		"Never say 'I'm an AI/bot/assistant'. If asked, you're his helper.",
		"When you don't know, say 'not sure'. Don't invent.",
	}, "\n")

	payload := map[string]any{
		"model": "auto",
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": userText},
		},
		"max_tokens": 200,
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", h.apiBaseURL+"/v1/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// Loopback — control-plane normally requires auth, but the SMS
	// handler runs inside the same process. We synth an internal-auth
	// header that the auth middleware accepts.
	if internalKey := os.Getenv("LANTERN_INTERNAL_SECRET"); internalKey != "" {
		req.Header.Set("X-Internal-Secret", internalKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("completions HTTP %d: %s", resp.StatusCode, smsTruncate(string(respBody), 200))
	}
	// Tolerant parser — handle the OpenAI-shaped + content-shaped
	// responses both. We don't depend on a single key.
	return extractReplyText(respBody), nil
}

// sendSMS fires Twilio's send_sms via the existing connector
// executor route through HTTP loopback. Both numbers in E.164.
func (h *SMSHandler) sendSMS(ctx context.Context, fromTwilio, toOwner, body string) error {
	payload := map[string]any{
		"to":   toOwner,
		"from": fromTwilio,
		"body": body,
	}
	bodyJSON, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST",
		h.apiBaseURL+"/v1/connectors/twilio/execute?action=send_sms",
		bytes.NewReader(bodyJSON))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if internalKey := os.Getenv("LANTERN_INTERNAL_SECRET"); internalKey != "" {
		req.Header.Set("X-Internal-Secret", internalKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("twilio send_sms HTTP %d: %s", resp.StatusCode, smsTruncate(string(respBody), 200))
	}
	return nil
}

// verifyTwilioSignature does the standard X-Twilio-Signature HMAC
// check.
func (h *SMSHandler) verifyTwilioSignature(r *http.Request, bodyBytes []byte) (bool, string) {
	sig := r.Header.Get("X-Twilio-Signature")
	if sig == "" {
		return false, "missing X-Twilio-Signature"
	}
	token := h.getTwilioAuthToken(r.Context())
	if token == "" {
		return false, "Twilio auth token unavailable"
	}
	publicURL := h.deriveOwnPublicURL(r) + r.URL.Path
	form, err := url.ParseQuery(string(bodyBytes))
	if err != nil {
		return false, "parse failed"
	}
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(publicURL)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(form.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(token))
	mac.Write([]byte(b.String()))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if hmac.Equal([]byte(expected), []byte(sig)) {
		return true, ""
	}
	return false, "signature mismatch"
}

// getTwilioAuthToken pulls authToken from the installed Twilio
// connector via HTTP loopback. Cached for 5 min — auth tokens are
// stable enough to cache without refresh penalty.
func (h *SMSHandler) getTwilioAuthToken(ctx context.Context) string {
	h.authTokenMu.RLock()
	if h.authToken != "" && time.Since(h.authTokenAt) < 5*time.Minute {
		t := h.authToken
		h.authTokenMu.RUnlock()
		return t
	}
	h.authTokenMu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, "GET", h.apiBaseURL+"/v1/connectors", nil)
	if err != nil {
		return ""
	}
	if internalKey := os.Getenv("LANTERN_INTERNAL_SECRET"); internalKey != "" {
		req.Header.Set("X-Internal-Secret", internalKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return ""
	}
	body, _ := io.ReadAll(resp.Body)
	var installs []struct {
		ConnectorID string         `json:"connectorId"`
		Config      map[string]any `json:"config"`
	}
	if err := json.Unmarshal(body, &installs); err != nil {
		return ""
	}
	for _, i := range installs {
		if i.ConnectorID == "twilio" {
			if v, ok := i.Config["authToken"].(string); ok && v != "" {
				h.authTokenMu.Lock()
				h.authToken = v
				h.authTokenAt = time.Now()
				h.authTokenMu.Unlock()
				return v
			}
		}
	}
	return ""
}

// deriveOwnPublicURL reconstructs the URL Twilio is calling — used
// for signature verification + composing <Gather action> URLs. Falls
// back to LANTERN_PUBLIC_BASE_URL when X-Forwarded headers absent.
func (h *SMSHandler) deriveOwnPublicURL(r *http.Request) string {
	if override := strings.TrimSpace(os.Getenv("LANTERN_PUBLIC_BASE_URL")); override != "" {
		return strings.TrimRight(override, "/")
	}
	scheme := "https"
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if r.TLS == nil {
		scheme = "http"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host
}

// ─────────────────────────────────────────────────────
// utilities
// ─────────────────────────────────────────────────────

func writeTwiML(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/xml")
	if body == "" {
		fmt.Fprint(w, `<Response></Response>`)
		return
	}
	fmt.Fprint(w, `<Response>`+body+`</Response>`)
}

func escapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	if len(s) > 1500 {
		s = s[:1500]
	}
	return s
}

func matchesExit(transcript string) bool {
	t := strings.ToLower(strings.TrimSpace(transcript))
	if t == "" {
		return false
	}
	for _, p := range []string{"bye", "goodbye", "hang up", "that's all", "thanks bye", "done", "stop", "end call"} {
		if strings.Contains(t, p) {
			return true
		}
	}
	return false
}

func normalizePhone(s string) string {
	out := strings.Builder{}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func maskPhone(s string) string {
	if len(s) < 6 {
		return "***"
	}
	return s[:4] + "***" + s[len(s)-2:]
}

// smsTruncate is the SMS-handler-local shortener (avoids colliding
// with template_prefetch.go's `truncate`).
func smsTruncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func getEnvOr(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}

func extractReplyText(b []byte) string {
	type completionsResp struct {
		Content string `json:"content"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	var d completionsResp
	if err := json.Unmarshal(b, &d); err == nil {
		if s := strings.TrimSpace(d.Content); s != "" {
			return s
		}
		if s := strings.TrimSpace(d.Message.Content); s != "" {
			return s
		}
		if len(d.Choices) > 0 {
			if s := strings.TrimSpace(d.Choices[0].Message.Content); s != "" {
				return s
			}
		}
	}
	return ""
}
