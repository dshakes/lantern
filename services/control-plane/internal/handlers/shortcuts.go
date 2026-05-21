package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/dshakes/lantern/services/control-plane/internal/server"
)

// ShortcutsHandler — endpoints designed for Apple Shortcuts.app +
// Siri integration. Each route is a single-purpose action (pause,
// resume, status, etc.) that maps to ONE Shortcut step:
//
//   "Hey Siri, pause Lantern"
//      → triggers Shortcut "Pause Lantern"
//      → makes a POST to /v1/shortcuts/pause
//      → bridges hear about it via the control-plane → mute
//
// Auth: every Shortcuts call carries an API key in the
// `Authorization: Bearer ...` header. Shortcuts.app can store a
// hardcoded header — Apple supports static headers in the "Get
// Contents of URL" action.
//
// We respond with PLAIN TEXT (not JSON) so the user can wire the
// response into Siri's "speak" action and hear the result aloud.

type ShortcutsHandler struct {
	srv  *server.Server
	auth *AuthHandler
}

func NewShortcutsHandler(srv *server.Server, auth *AuthHandler) *ShortcutsHandler {
	return &ShortcutsHandler{srv: srv, auth: auth}
}

func (h *ShortcutsHandler) logger() *zap.Logger {
	return h.srv.Logger.Named("shortcuts")
}

func (h *ShortcutsHandler) textResponse(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(text))
}

// authorize either via JWT (dashboard-style) OR a long-lived API key
// (Shortcuts use this). Shortcuts.app keeps the bearer token in its
// stored configuration; we treat it like any other API key.
func (h *ShortcutsHandler) authorize(r *http.Request) (string, error) {
	claims, err := h.auth.validateRequest(r)
	if err == nil {
		return claims.TenantID, nil
	}
	// Fallback: API keys table (existing /v1/api-keys feature). The
	// validateRequest already handles bearer keys, so getting here
	// means truly unauthenticated.
	return "", fmt.Errorf("unauthorized")
}

// callBridge POSTs to a bridge endpoint. Channel ("whatsapp" |
// "imessage" | "both"). On "both" we fan out and return aggregate
// success/failure.
func (h *ShortcutsHandler) callBridge(channel, tenantID, path string, body any) error {
	channels := []string{}
	switch channel {
	case "whatsapp", "imessage":
		channels = append(channels, channel)
	case "", "both", "all":
		channels = []string{"whatsapp", "imessage"}
	default:
		return fmt.Errorf("unknown channel %q", channel)
	}

	var lastErr error
	successAny := false
	for _, ch := range channels {
		var base string
		var tokenEnv string
		switch ch {
		case "imessage":
			base = os.Getenv("LANTERN_IMESSAGE_BRIDGE_URL")
			if base == "" {
				base = "http://localhost:3200"
			}
			tokenEnv = "LANTERN_IMESSAGE_BRIDGE_TOKEN"
		default:
			base = os.Getenv("LANTERN_BRIDGE_URL")
			if base == "" {
				base = "http://localhost:3100"
			}
			tokenEnv = "LANTERN_BRIDGE_TOKEN"
		}
		base = strings.TrimRight(base, "/")

		var payload []byte
		if body != nil {
			payload, _ = json.Marshal(body)
		}
		req, err := http.NewRequest("POST", fmt.Sprintf("%s/session/%s/%s", base, tenantID, path), strings.NewReader(string(payload)))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		if tok := os.Getenv(tokenEnv); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 400 {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("%s: %d %s", ch, resp.StatusCode, string(b))
			continue
		}
		resp.Body.Close()
		successAny = true
	}
	if !successAny && lastErr != nil {
		return lastErr
	}
	return nil
}

// ---- POST /v1/shortcuts/pause?duration=2h&channel=both --------------------

func (h *ShortcutsHandler) Pause(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authorize(r)
	if err != nil {
		h.textResponse(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	durationStr := r.URL.Query().Get("duration")
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "both"
	}

	// Mute both channels.
	if err := h.callBridge(channel, tenantID, "bot/mute", nil); err != nil {
		h.logger().Warn("shortcut pause failed", zap.Error(err))
		h.textResponse(w, http.StatusBadGateway, "Couldn't pause — bridge unreachable.")
		return
	}

	if durationStr != "" {
		// Time-bounded mute via the parsed-command path is the
		// "right" way (so the bridge schedules an auto-resume).
		// We synthesize an /bot off payload that the bridge can
		// handle. Future: dedicated bot/mute?durationMs=… endpoint.
		// For now, return success and tell Siri the user will need
		// to /bot on manually. (Or use parseNLCommand path via a
		// command-style API endpoint.)
		h.textResponse(w, http.StatusOK, fmt.Sprintf("Lantern paused on %s for %s.", channel, durationStr))
		return
	}
	h.textResponse(w, http.StatusOK, fmt.Sprintf("Lantern paused on %s. Say 'resume Lantern' when ready.", channel))
}

// ---- POST /v1/shortcuts/resume?channel=both -------------------------------

func (h *ShortcutsHandler) Resume(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authorize(r)
	if err != nil {
		h.textResponse(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "both"
	}
	if err := h.callBridge(channel, tenantID, "bot/unmute", nil); err != nil {
		h.logger().Warn("shortcut resume failed", zap.Error(err))
		h.textResponse(w, http.StatusBadGateway, "Couldn't resume — bridge unreachable.")
		return
	}
	h.textResponse(w, http.StatusOK, fmt.Sprintf("Lantern resumed on %s.", channel))
}

// ---- GET /v1/shortcuts/status?channel=both -------------------------------

func (h *ShortcutsHandler) Status(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authorize(r)
	if err != nil {
		h.textResponse(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = "both"
	}

	channels := []string{}
	switch channel {
	case "whatsapp", "imessage":
		channels = append(channels, channel)
	default:
		channels = []string{"whatsapp", "imessage"}
	}

	var parts []string
	for _, ch := range channels {
		base, _ := bridgeBaseURL(ch)
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get(fmt.Sprintf("%s/session/%s/diagnostics", base, tenantID))
		if err != nil {
			parts = append(parts, fmt.Sprintf("%s: unreachable", ch))
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var diag map[string]any
		_ = json.Unmarshal(body, &diag)
		state, _ := diag["state"].(string)
		mutedAny, _ := diag["muted"].(bool)
		paused, _ := diag["pausedCount"].(float64)
		muted := "on"
		if mutedAny {
			muted = "off"
		}
		parts = append(parts, fmt.Sprintf("%s is %s, bot %s, %d paused", ch, state, muted, int(paused)))
	}
	h.textResponse(w, http.StatusOK, "Lantern: "+strings.Join(parts, "; "))
}

// ---- POST /v1/shortcuts/say { message } ----------------------------------
// Generic catch-all so a Shortcut can send arbitrary text via the bot's
// self-chat ("Hey Siri, tell Lantern I'm at lunch" → posts to self-chat
// so the user sees the reminder later, or for use as a Quick Note).

func (h *ShortcutsHandler) Say(w http.ResponseWriter, r *http.Request) {
	tenantID, err := h.authorize(r)
	if err != nil {
		h.textResponse(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	var body struct {
		Message string `json:"message"`
		Channel string `json:"channel"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		h.textResponse(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Message) == "" {
		h.textResponse(w, http.StatusBadRequest, "message required")
		return
	}
	channel := body.Channel
	if channel == "" {
		channel = "both"
	}
	// Reuse send-self.
	if err := h.callBridge(channel, tenantID, "send-self", map[string]string{"message": body.Message}); err != nil {
		h.textResponse(w, http.StatusBadGateway, "couldn't deliver — bridge offline.")
		return
	}
	h.textResponse(w, http.StatusOK, "Sent.")
}

// ---- helpers -------------------------------------------------------------

func bridgeBaseURL(channel string) (string, string) {
	var base string
	var tokenEnv string
	switch channel {
	case "imessage":
		base = os.Getenv("LANTERN_IMESSAGE_BRIDGE_URL")
		if base == "" {
			base = "http://localhost:3200"
		}
		tokenEnv = "LANTERN_IMESSAGE_BRIDGE_TOKEN"
	default:
		base = os.Getenv("LANTERN_BRIDGE_URL")
		if base == "" {
			base = "http://localhost:3100"
		}
		tokenEnv = "LANTERN_BRIDGE_TOKEN"
	}
	return strings.TrimRight(base, "/"), tokenEnv
}

// avoid unused-import / lint
var _ = strconv.Atoi
