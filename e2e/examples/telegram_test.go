//go:build e2e

package examples_e2e

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dshakes/pal/e2e/internal/e2ekit"
)

// telegramFixture stands in for api.telegram.org (the gateway is started with
// TELEGRAM_API_BASE_URL pointing here) and records every Bot API call.
type telegramFixture struct {
	mu   sync.Mutex
	sent []map[string]any // sendMessage bodies
}

func startTelegramFixture(t *testing.T) *telegramFixture {
	t.Helper()
	ln, err := net.Listen("tcp", need(t, "PAL_E2E_TELEGRAM_FIXTURE_ADDR"))
	if err != nil {
		t.Fatalf("listen telegram fixture: %v", err)
	}
	f := &telegramFixture{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if strings.HasSuffix(r.URL.Path, "/sendMessage") {
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			f.mu.Lock()
			f.sent = append(f.sent, body)
			f.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":7}}`))
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return f
}

func (f *telegramFixture) messages() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.sent...)
}

func postTelegram(t *testing.T, secret string, update string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, need(t, "PAL_E2E_GATEWAY_URL")+"/webhooks/telegram", bytes.NewReader([]byte(update)))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST telegram webhook: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// X6: a signed Telegram update through surface-gateway runs the agent and the
// answer comes back as a Bot API sendMessage to the same chat.
func TestTelegram_SignedWebhookGetsAReply(t *testing.T) {
	s := connect(t)
	k := s.kit
	secret := e2ekit.EnvOr("PAL_E2E_TELEGRAM_SECRET", "e2e-telegram-secret")
	need(t, "PAL_E2E_REPLAY_URL")
	fx := startTelegramFixture(t)

	s.installConnector(t, "google-calendar", "accessToken")
	a := agentFromManifest(t, k, "e2e-assistant", "telegram-assistant")
	// An agent gets its first promoted version from its first REST run; the
	// gateway creates runs over gRPC, which refuses an unpromoted agent
	// ("agent has no promoted version"). Prime it once, as the README says.
	a.Run(t, map[string]any{"input": map[string]any{"text": "ping"}})

	// A fresh chat id per run so a stale Redis session can't leak between runs.
	chat := time.Now().UnixNano()%1_000_000_000 + 1_000_000_000
	update := func(text string) string {
		b, _ := json.Marshal(map[string]any{
			"update_id": 1,
			"message": map[string]any{
				"message_id": 10, "text": text,
				"from": map[string]any{"id": chat, "is_bot": false},
				"chat": map[string]any{"id": chat, "type": "private"},
			},
		})
		return string(b)
	}
	const ask = "what's on tomorrow, and is it raining?"

	// Signature negatives: nothing may run, nothing may be sent.
	if st := postTelegram(t, "", update(ask)); st != http.StatusUnauthorized {
		t.Fatalf("no secret header: HTTP %d, want 401", st)
	}
	if st := postTelegram(t, "wrong-secret", update(ask)); st != http.StatusUnauthorized {
		t.Fatalf("wrong secret: HTTP %d, want 401", st)
	}
	time.Sleep(2 * time.Second)
	if n := len(fx.messages()); n != 0 {
		t.Fatalf("forged updates produced %d replies", n)
	}

	before := countReplay(replayRequests(t), "GET", "/calendar/v3/calendars/primary/events")
	if st := postTelegram(t, secret, update(ask)); st != http.StatusOK {
		t.Fatalf("signed update: HTTP %d, want 200", st)
	}

	// The gateway creates the run over gRPC; the control plane's recovery sweep
	// (PAL_RECOVERY_INTERVAL in the stack script) drives it; the gateway
	// polls it to completion and replies.
	var reply map[string]any
	waitUntil(t, 60*time.Second, "Telegram sendMessage", func() bool {
		if m := fx.messages(); len(m) > 0 {
			reply = m[0]
			return true
		}
		return false
	})
	if id, _ := reply["chat_id"].(string); id != strconv.FormatInt(chat, 10) {
		t.Fatalf("reply chat_id = %v, want %d", reply["chat_id"], chat)
	}
	text, _ := reply["text"].(string)
	if !strings.Contains(text, "Design review") {
		t.Fatalf("reply %q does not carry the calendar answer", text)
	}
	if countReplay(replayRequests(t), "GET", "/calendar/v3/calendars/primary/events") <= before {
		t.Fatal("assistant never read the calendar")
	}

	// The session is free again: a second message starts a second run and gets
	// its own reply (the active run was cleared after the first answer).
	if st := postTelegram(t, secret, update(ask)); st != http.StatusOK {
		t.Fatalf("second update: HTTP %d", st)
	}
	waitUntil(t, 60*time.Second, "second reply", func() bool { return len(fx.messages()) >= 2 })
}
