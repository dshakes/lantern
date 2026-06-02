// Contact-facing RCS / SMS lane (Twilio).
//
// This is the OUTSIDE-IN counterpart to sms.go. sms.go is the owner's
// private command line — only the owner texts it, and it runs the full-tool
// agent. THIS handler is the opposite direction: a contact (not the owner)
// messages the owner's branded Twilio RCS/SMS number, and the agent answers
// on the owner's behalf — the same "assistant replies to your contacts" role
// the iMessage/WhatsApp bridges already play on the owner's Mac, but reached
// over the carrier RCS lane instead of a paired device.
//
// Why a separate Go lane at all (the bridges already do this):
//   - True RCS can only originate from a Google-verified RBM business agent
//     behind a Twilio Messaging Service. macOS does not send/sync RCS, so the
//     iMessage bridge can never answer an RCS thread. The carrier lane has to
//     live server-side.
//   - The send path (executeTwilio "send_message" → Messaging Service →
//     RCS with automatic SMS fallback) already landed; this is the inbound
//     half that closes the loop.
//
// Provisioning is EXTERNAL and gated: an RBM agent + an RCS sender attached
// to a Messaging Service must be approved by Google before a single RCS
// message can flow. Until the operator has that and flips LANTERN_RCS_INBOUND
// on, this endpoint verifies + drops so a misconfigured Twilio webhook can
// never make the agent speak to a stranger.
//
// Twilio Console wiring (once RBM is approved):
//   Messaging Service → Integration → "Send a webhook" →
//     Request URL: <public-url>/v1/messaging/twilio/inbound  (HTTP POST)
//
// Safety: every drafted reply passes through shouldSendOutbound() before it
// leaves the building — the Go port of the bridges' reasoning-leak / bot-tell
// suppression. A draft that is empty, a bare no-reply token, or that leaks the
// model's internal deliberation (or "I'm an AI") makes the lane stay silent
// rather than send.

package handlers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// MessagingHandler answers inbound RCS/SMS from CONTACTS on the owner's
// branded Twilio number. It reuses the package-scope Twilio executor for
// sending and the LLM proxy for drafting — no HTTP loopback.
type MessagingHandler struct {
	logger        *zap.Logger
	pool          *pgxpool.Pool
	llm           *LlmProxyHandler
	defaultTenant string
	twilioAuthOff bool

	// enabled gates the whole lane. Default OFF: the RBM business agent +
	// RCS sender must be Google-approved before real RCS can flow, and we
	// never want a stray Twilio webhook to make the agent text a stranger.
	enabled bool

	rlMu   sync.Mutex
	rlHits []time.Time
}

// messagingInboundPerMinute caps contact-lane inbound processed per rolling
// minute — bounds LLM + carrier cost and blunts an inbound flood.
const messagingInboundPerMinute = 30

// NewMessagingHandler constructs the contact-facing RCS/SMS handler.
func NewMessagingHandler(logger *zap.Logger, pool *pgxpool.Pool, llm *LlmProxyHandler) *MessagingHandler {
	h := &MessagingHandler{
		logger:        logger.Named("messaging"),
		pool:          pool,
		llm:           llm,
		defaultTenant: getEnvOr("LANTERN_DEFAULT_TENANT_ID", "00000000-0000-0000-0000-000000000001"),
		twilioAuthOff: strings.ToLower(os.Getenv("LANTERN_TWILIO_WEBHOOK_AUTH")) == "off",
		enabled:       strings.ToLower(strings.TrimSpace(os.Getenv("LANTERN_RCS_INBOUND"))) == "on",
	}
	if !h.enabled {
		h.logger.Info("contact RCS/SMS lane disabled — set LANTERN_RCS_INBOUND=on after the Twilio RBM agent is approved")
	}
	return h
}

// allowInbound is the sliding-window rate limiter for the contact lane.
func (h *MessagingHandler) allowInbound() bool {
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
	if len(h.rlHits) >= messagingInboundPerMinute {
		return false
	}
	h.rlHits = append(h.rlHits, now)
	return true
}

// InboundWebhook is POST /v1/messaging/twilio/inbound — Twilio posts here when
// a contact messages the owner's branded RCS/SMS number.
func (h *MessagingHandler) InboundWebhook(w http.ResponseWriter, r *http.Request) {
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

	// Load the Twilio connector config once — used for both signature
	// verification and confirming the message was addressed to OUR sender.
	cfg := loadDecryptedConfig(r.Context(), h.pool, h.defaultTenant, "twilio")

	// Verify the request really came from Twilio BEFORE the enable gate, so a
	// forged request can never even probe whether the lane is on.
	if !h.twilioAuthOff {
		token, _ := cfg["authToken"].(string)
		if ok, why := h.verifyTwilioSignature(r, bodyBytes, token); !ok {
			h.logger.Warn("Twilio inbound signature invalid",
				zap.String("reason", why),
				zap.String("from", maskPhone(r.Form.Get("From"))))
			writeTwiML(w, "")
			return
		}
	}

	if !h.enabled {
		// Provisioned-but-not-enabled: ack 200 so Twilio stops retrying, drop.
		writeTwiML(w, "")
		return
	}

	from := r.Form.Get("From")
	to := r.Form.Get("To")
	body := strings.TrimSpace(r.Form.Get("Body"))
	if from == "" || to == "" || body == "" {
		writeTwiML(w, "")
		return
	}

	// A valid Twilio signature only proves the request came from our Twilio
	// ACCOUNT — a webhook for any other number/service on that same account
	// would also verify. Confirm the message was addressed to THIS lane's
	// configured branded sender (To = phoneNumber, or MessagingServiceSid),
	// so the agent never replies to a contact on an unrelated sender. Skipped
	// only in the dev escape hatch where signature checking itself is off.
	if !h.twilioAuthOff && !addressedToConfiguredSender(r.Form, cfg) {
		h.logger.Warn("inbound not addressed to configured sender — dropping",
			zap.String("from", maskPhone(from)))
		writeTwiML(w, "")
		return
	}

	// The owner's own line is handled by sms.go (full-tool command channel).
	// If the owner happens to text this branded number, don't double-handle.
	if ownerPhone := strings.TrimSpace(os.Getenv("LANTERN_OWNER_PHONE")); ownerPhone != "" &&
		normalizePhone(from) == normalizePhone(ownerPhone) {
		writeTwiML(w, "")
		return
	}

	if !h.allowInbound() {
		h.logger.Warn("contact lane rate-limited — dropping", zap.String("from", maskPhone(from)))
		writeTwiML(w, "")
		return
	}

	// This is a third-party-facing lane: a contact's message body may carry
	// arbitrary PII, so log only masked identity + length, never content.
	h.logger.Info("contact RCS/SMS inbound via Twilio",
		zap.String("from", maskPhone(from)),
		zap.Int("body_len", len(body)))

	// Ack immediately (Twilio times out ~10s); draft + send async.
	writeTwiML(w, "")
	go h.processInboundAsync(to, from, body)
}

func (h *MessagingHandler) processInboundAsync(brandedNumber, contactPhone, body string) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	draft, err := h.askContactAgent(ctx, body)
	if err != nil {
		h.logger.Warn("contact agent failed", zap.Error(err))
		return
	}
	draft = strings.TrimSpace(draft)

	// The safety gate: never let internal deliberation, a no-reply token, or
	// an AI self-identification reach a contact. Mirrors the bridges' guard.
	if ok, reason := shouldSendOutbound(draft); !ok {
		h.logger.Info("contact reply suppressed", zap.String("reason", reason),
			zap.String("to", maskPhone(contactPhone)))
		return
	}

	// SMS-fallback length cap (RCS itself is long-form, but if the recipient
	// can't do RCS the Messaging Service downgrades to SMS).
	if len(draft) > 300 {
		draft = draft[:295] + " […]"
	}

	// Send via the Messaging Service (RCS + automatic SMS fallback). "to" is
	// the contact; the branded sender is resolved from the connector's
	// messagingServiceSid by the executor.
	params := map[string]any{
		"to":   contactPhone,
		"body": draft,
	}
	if _, err := executeConnectorAction(ctx, h.pool, h.defaultTenant, "twilio", "send_message", params); err != nil {
		h.logger.Error("contact reply send failed", zap.Error(err))
		return
	}
	h.logger.Info("contact reply sent",
		zap.String("to", maskPhone(contactPhone)),
		zap.Int("len", len(draft)))
}

// askContactAgent drafts a reply to a CONTACT on the owner's behalf. This is
// the assistant-answering-your-people role — terse, human, and it must never
// reveal that it's an agent. The shouldSendOutbound gate is the backstop.
func (h *MessagingHandler) askContactAgent(ctx context.Context, contactText string) (string, error) {
	if h.llm == nil {
		return "", fmt.Errorf("LLM proxy unavailable")
	}
	ownerName := getEnvOr("LANTERN_OWNER_NAME", "Shekhar")
	system := strings.Join([]string{
		"You are " + ownerName + "'s personal assistant, replying to one of his contacts over text (RCS/SMS).",
		"Write the reply EXACTLY as it should be sent — no preamble, no narration, no explanation of your reasoning.",
		"If a message needs no reply, output an empty string and nothing else.",
		"Be warm, brief, human. Plain text only. Contractions are fine. Under 40 words.",
		"Never say you're an AI, a bot, an assistant, or a language model. Never describe what 'the contact' wants.",
		"Don't invent facts about " + ownerName + "'s plans. If you don't know, keep it light and noncommittal.",
	}, "\n")
	reply, err := h.llm.CompleteInternal(ctx, h.defaultTenant, system, contactText, 200)
	if err != nil {
		return "", err
	}
	return stripAssistantPreamble(reply), nil
}

// verifyTwilioSignature does the standard X-Twilio-Signature HMAC check for
// the contact lane against the supplied account auth token.
func (h *MessagingHandler) verifyTwilioSignature(r *http.Request, bodyBytes []byte, token string) (bool, string) {
	sig := r.Header.Get("X-Twilio-Signature")
	if sig == "" {
		return false, "missing X-Twilio-Signature"
	}
	if token == "" {
		return false, "Twilio auth token unavailable"
	}
	form, err := url.ParseQuery(string(bodyBytes))
	if err != nil {
		return false, "parse failed"
	}
	fullURL := derivePublicURL(r) + r.URL.Path
	if validTwilioSignature(token, fullURL, form, sig) {
		return true, ""
	}
	return false, "signature mismatch"
}

// addressedToConfiguredSender confirms an inbound webhook was sent to THIS
// lane's branded sender — the Twilio signature alone only proves it came from
// our account. Matches the inbound MessagingServiceSid or To against the
// connector's configured messagingServiceSid / phoneNumber. Returns false when
// nothing is configured to match against (can't confirm it's us → drop).
func addressedToConfiguredSender(form url.Values, cfg map[string]any) bool {
	cfgMsgSvc, _ := cfg["messagingServiceSid"].(string)
	cfgNumber, _ := cfg["phoneNumber"].(string)
	if cfgMsgSvc != "" && form.Get("MessagingServiceSid") == cfgMsgSvc {
		return true
	}
	if cfgNumber != "" && normalizePhone(form.Get("To")) == normalizePhone(cfgNumber) {
		return true
	}
	return false
}
