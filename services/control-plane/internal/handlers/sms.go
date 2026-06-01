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

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// SMSHandler routes Twilio inbound SMS + Voice from the owner to the
// agent pipeline using INTERNAL Go calls (no HTTP loopback, no JWT
// dance). The control-plane already has executeConnectorAction at
// package scope + the LLM proxy exposes an internal completions
// method, so we depend on both directly.
type SMSHandler struct {
	logger        *zap.Logger
	pool          *pgxpool.Pool
	llm           *LlmProxyHandler
	defaultTenant string
	twilioAuthOff bool

	// Caller-ID spoof defense. Twilio's signature proves the request
	// came from Twilio, but the `From` value can still be spoofed at
	// the telco level — so caller ID alone must not authorize the
	// full-tool owner agent. When ownerPIN is set, the owner unlocks a
	// verified window (verifyTTL) by texting the PIN or entering it via
	// DTMF on a call. When unset, behavior is unchanged (caller-ID gate
	// only) and a warning is logged at startup.
	ownerPIN  string
	verifyTTL time.Duration

	verifyMu      sync.Mutex
	verifiedUntil time.Time

	// In-memory inbound rate limiter — bounds LLM + SMS cost and blunts
	// a spoofed-owner flood. Sliding 1-minute window.
	rlMu   sync.Mutex
	rlHits []time.Time

	// Cached Twilio auth token from the installed connector. Loaded
	// lazily from the DB; refreshed when the cache TTL expires.
	authTokenMu sync.RWMutex
	authToken   string
	authTokenAt time.Time
}

// smsInboundPerMinute caps owner-line inbound processed per rolling minute.
const smsInboundPerMinute = 20

// NewSMSHandler constructs the handler with all internal dependencies.
// llm is used for completion calls; pool for direct connector lookups.
func NewSMSHandler(logger *zap.Logger, pool *pgxpool.Pool, llm *LlmProxyHandler) *SMSHandler {
	ttl := 12 * time.Hour
	if v := strings.TrimSpace(os.Getenv("LANTERN_OWNER_VERIFY_TTL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			ttl = d
		}
	}
	h := &SMSHandler{
		logger:        logger.Named("sms"),
		pool:          pool,
		llm:           llm,
		defaultTenant: getEnvOr("LANTERN_DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001"),
		twilioAuthOff: strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) == "off",
		ownerPIN:      strings.TrimSpace(os.Getenv("LANTERN_OWNER_VERIFY_PIN")),
		verifyTTL:     ttl,
	}
	if h.ownerPIN == "" {
		h.logger.Warn("LANTERN_OWNER_VERIFY_PIN unset — owner Twilio line authorizes on caller ID alone (spoofable); set a PIN for spoof-resistant access")
	}
	return h
}

// allowInbound is the sliding-window rate limiter for owner-line inbound.
func (h *SMSHandler) allowInbound() bool {
	h.rlMu.Lock()
	defer h.rlMu.Unlock()
	now := time.Now()
	cutoff := now.Add(-time.Minute)
	kept := h.rlHits[:0]
	for _, t := range h.rlHits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	h.rlHits = kept
	if len(h.rlHits) >= smsInboundPerMinute {
		return false
	}
	h.rlHits = append(h.rlHits, now)
	return true
}

// isVerified reports whether the owner has an active verified window. When
// no PIN is configured the channel falls back to the caller-ID gate only.
func (h *SMSHandler) isVerified() bool {
	if h.ownerPIN == "" {
		return true
	}
	h.verifyMu.Lock()
	defer h.verifyMu.Unlock()
	return time.Now().Before(h.verifiedUntil)
}

func (h *SMSHandler) markVerified() {
	h.verifyMu.Lock()
	h.verifiedUntil = time.Now().Add(h.verifyTTL)
	h.verifyMu.Unlock()
}

// pinMatches accepts a bare PIN or "pin <PIN>" / "unlock <PIN>", compared
// constant-time. Returns false when no PIN is configured.
func (h *SMSHandler) pinMatches(s string) bool {
	if h.ownerPIN == "" {
		return false
	}
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "pin ")
	s = strings.TrimPrefix(s, "unlock ")
	s = strings.TrimSpace(s)
	return hmac.Equal([]byte(s), []byte(strings.ToLower(h.ownerPIN)))
}

// sendSMSAsync fires an owner-line reply with its own short-lived context.
func (h *SMSHandler) sendSMSAsync(fromTwilio, toOwner, body string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := h.sendSMS(ctx, fromTwilio, toOwner, body); err != nil {
		h.logger.Warn("async SMS send failed", zap.Error(err))
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

	// Rate limit — bounds cost and blunts a spoofed-owner flood.
	if !h.allowInbound() {
		h.logger.Warn("owner SMS rate-limited — dropping", zap.String("from", maskPhone(from)))
		writeTwiML(w, "")
		return
	}

	// PIN gate (caller-ID spoof defense). A PIN message unlocks the
	// verified window; while locked, the agent never runs.
	if h.ownerPIN != "" {
		if h.pinMatches(body) {
			h.markVerified()
			h.logger.Info("owner verified via PIN (SMS)")
			writeTwiML(w, "")
			go h.sendSMSAsync(to, from, "✓ unlocked")
			return
		}
		if !h.isVerified() {
			h.logger.Warn("owner SMS while locked — prompting for PIN", zap.String("from", maskPhone(from)))
			writeTwiML(w, "")
			go h.sendSMSAsync(to, from, "🔒 locked — reply with your PIN to unlock.")
			return
		}
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

	// PIN gate (caller-ID spoof defense). If locked, collect the PIN via
	// DTMF and verify it on the turn endpoint before the agent runs.
	if h.ownerPIN != "" && !h.isVerified() {
		pinPrompt := `<Say voice="Polly.Joanna">Enter your PIN, then press pound.</Say>` +
			fmt.Sprintf(`<Gather input="dtmf" finishOnKey="#" timeout="15" action="%s" method="POST"></Gather>`, escapeXML(turnURL)) +
			`<Say voice="Polly.Joanna">No PIN entered. Goodbye.</Say><Hangup/>`
		writeTwiML(w, pinPrompt)
		return
	}

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

	// DTMF PIN entry (voice unlock). Twilio posts Digits when a dtmf
	// Gather completes.
	if digits := strings.TrimSpace(r.Form.Get("Digits")); digits != "" {
		if h.pinMatches(digits) {
			h.markVerified()
			h.logger.Info("owner verified via PIN (voice DTMF)")
			turnURL := h.deriveOwnPublicURL(r) + "/v1/voice/twilio/turn"
			ok := `<Say voice="Polly.Joanna">Unlocked. What's up?</Say>` +
				fmt.Sprintf(`<Gather input="speech" action="%s" method="POST" speechTimeout="auto" timeout="10"></Gather>`, escapeXML(turnURL)) +
				`<Say voice="Polly.Joanna">Talk to you later.</Say><Hangup/>`
			writeTwiML(w, ok)
			return
		}
		writeTwiML(w, `<Say voice="Polly.Joanna">Wrong PIN. Goodbye.</Say><Hangup/>`)
		return
	}

	// No agent access until the session is verified.
	if h.ownerPIN != "" && !h.isVerified() {
		writeTwiML(w, `<Say voice="Polly.Joanna">Locked. Text your PIN first. Goodbye.</Say><Hangup/>`)
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

// askOwnerAgent runs the LLM with the owner-agent persona. Uses the
// LLM proxy's internal completions method — no HTTP, no JWT.
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
	if h.llm == nil {
		return "", fmt.Errorf("LLM proxy unavailable")
	}
	// Make Jarvis memory-aware: inject the owner's upcoming calendar +
	// the memories most relevant to what he just asked, drawn from the
	// unified cross-channel timeline.
	system += h.ownerMemoryBlock(ctx, userText)
	return h.llm.CompleteInternal(ctx, h.defaultTenant, system, userText, 200)
}

// ownerMemoryBlock builds a context block for the owner agent from the
// unified timeline: upcoming calendar events (always) + the events most
// semantically relevant to the query (vector recall). Best-effort —
// returns "" on any failure so the agent still answers.
func (h *SMSHandler) ownerMemoryBlock(ctx context.Context, query string) string {
	if h.llm == nil || h.pool == nil {
		return ""
	}
	var b strings.Builder

	// Upcoming calendar (kind='event', not yet past).
	if rows, err := h.pool.Query(ctx, `
		SELECT content FROM memory_events
		WHERE tenant_id = $1 AND kind = 'event' AND occurred_at >= now() - interval '1 hour'
		ORDER BY occurred_at ASC LIMIT 5
	`, h.defaultTenant); err == nil {
		var cals []string
		for rows.Next() {
			var c string
			if rows.Scan(&c) == nil {
				cals = append(cals, c)
			}
		}
		rows.Close()
		if len(cals) > 0 {
			b.WriteString("\n\nupcoming on your calendar:\n- " + strings.Join(cals, "\n- "))
		}
	}

	// Semantically-relevant memories for this query.
	if vec, err := h.llm.EmbedText(ctx, h.defaultTenant, query); err == nil {
		if rows, err := h.pool.Query(ctx, `
			SELECT me.channel, COALESCE(p.display_name, ''), me.content
			FROM memory_events me LEFT JOIN people p ON p.id = me.person_id
			WHERE me.tenant_id = $1 AND me.embedding IS NOT NULL AND me.kind <> 'event'
			ORDER BY me.embedding <=> $2::vector LIMIT 6
		`, h.defaultTenant, vectorLiteral(vec)); err == nil {
			var lines []string
			for rows.Next() {
				var ch, nm, ct string
				if rows.Scan(&ch, &nm, &ct) == nil {
					who := nm
					if who == "" {
						who = "?"
					}
					lines = append(lines, fmt.Sprintf("[%s] %s: %s", ch, who, smsTruncate(ct, 140)))
				}
			}
			rows.Close()
			if len(lines) > 0 {
				b.WriteString("\n\nrelevant from your memory:\n- " + strings.Join(lines, "\n- "))
			}
		}
	}
	return b.String()
}

// sendSMS fires Twilio's send_sms via the in-process connector
// executor. No HTTP loopback, no auth dance.
func (h *SMSHandler) sendSMS(ctx context.Context, fromTwilio, toOwner, body string) error {
	if h.pool == nil {
		return fmt.Errorf("DB pool unavailable")
	}
	params := map[string]any{
		"to":   toOwner,
		"from": fromTwilio,
		"body": body,
	}
	_, err := executeConnectorAction(ctx, h.pool, h.defaultTenant, "twilio", "send_sms", params)
	return err
}

// verifyTwilioSignature does the standard X-Twilio-Signature HMAC
// check for the owner SMS/voice line.
func (h *SMSHandler) verifyTwilioSignature(r *http.Request, bodyBytes []byte) (bool, string) {
	sig := r.Header.Get("X-Twilio-Signature")
	if sig == "" {
		return false, "missing X-Twilio-Signature"
	}
	token := h.getTwilioAuthToken(r.Context())
	if token == "" {
		return false, "Twilio auth token unavailable"
	}
	form, err := url.ParseQuery(string(bodyBytes))
	if err != nil {
		return false, "parse failed"
	}
	fullURL := h.deriveOwnPublicURL(r) + r.URL.Path
	if validTwilioSignature(token, fullURL, form, sig) {
		return true, ""
	}
	return false, "signature mismatch"
}

// validTwilioSignature verifies the X-Twilio-Signature header per Twilio's
// scheme: HMAC-SHA1 over (fullURL + each sorted form key+value), keyed by
// the account auth token, base64-encoded, constant-time compared. Shared
// by the owner line (sms.go) and the W11d voice webhook (voice.go).
func validTwilioSignature(authToken, fullURL string, form url.Values, providedSig string) bool {
	if providedSig == "" || authToken == "" {
		return false
	}
	keys := make([]string, 0, len(form))
	for k := range form {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(fullURL)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(form.Get(k))
	}
	mac := hmac.New(sha1.New, []byte(authToken))
	mac.Write([]byte(b.String()))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(providedSig))
}

// getTwilioAuthToken reads authToken directly from the
// connector_installs table. Cached for 5 min — Twilio auth tokens
// are stable; a 5-min window catches a rotation within the same
// process lifetime without per-request DB hits.
func (h *SMSHandler) getTwilioAuthToken(ctx context.Context) string {
	h.authTokenMu.RLock()
	if h.authToken != "" && time.Since(h.authTokenAt) < 5*time.Minute {
		t := h.authToken
		h.authTokenMu.RUnlock()
		return t
	}
	h.authTokenMu.RUnlock()

	if h.pool == nil {
		return ""
	}
	var configJSON []byte
	err := h.pool.QueryRow(ctx, `
		SELECT config FROM connector_installs
		WHERE tenant_id = $1 AND connector_id = 'twilio' AND status = 'connected'
		LIMIT 1
	`, h.defaultTenant).Scan(&configJSON)
	if err != nil {
		return ""
	}
	var cfg map[string]any
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return ""
	}
	tok, _ := cfg["authToken"].(string)
	if tok == "" {
		return ""
	}
	h.authTokenMu.Lock()
	h.authToken = tok
	h.authTokenAt = time.Now()
	h.authTokenMu.Unlock()
	return tok
}

// deriveOwnPublicURL reconstructs the URL Twilio is calling — used
// for signature verification + composing <Gather action> URLs.
func (h *SMSHandler) deriveOwnPublicURL(r *http.Request) string {
	return derivePublicURL(r)
}

// derivePublicURL reconstructs the externally-visible base URL of a
// request. Prefers LANTERN_PUBLIC_BASE_URL, then X-Forwarded-* headers,
// then the raw Host. Shared across Twilio webhook handlers.
func derivePublicURL(r *http.Request) string {
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
