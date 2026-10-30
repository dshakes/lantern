//go:build e2e

// Package examples_e2e exercises examples/support-desk/ against a LIVE local
// stack under the §0 spend policy (ga-program-plan.md §0), through e2ekit.
//
// Acceptance (plan §3 X1): a KB question is answered with a citation to a seeded
// document; a refund question the agent cannot answer hands the session off,
// pings Slack, and the operator's reply arrives on the session's SSE stream.
//
// Two tiers, same assertions:
//
//	real LLM:  a provider key configured for the dev tenant; nothing else.
//	fixture:   start the stack against cmd/llm-replay with the example's rules
//	           (see e2e/README.md, "Support desk"), and set
//	           PAL_E2E_FIXTURE_LLM=1 so the reply text itself is asserted to
//	           cite the document.
//
// The Slack ping is asserted when PAL_E2E_SLACK_FIXTURE_ADDR (e.g.
// 127.0.0.1:9193) is set; start the API with PAL_CONNECTOR_BASEURL_SLACK
// pointing at it. Without it the ping is not checked (and no Slack connector is
// installed — an existing install is never touched either way).
package examples_e2e

import (
	"bufio"
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dshakes/pal/e2e/internal/e2ekit"
)

const (
	agentName     = "e2e-support" // e2ekit's reserved slot for the support example
	slackChannel  = "support-handoffs"
	eventDeadline = 120 * time.Second
	// Placeholder token for the fixture Slack server; never a real credential.
	fixtureSlackToken = "xoxb-e2e-fixture" // allowlist secret
)

func exampleDir() string { return filepath.Join("..", "..", "examples", "support-desk") }

func readSupportJSON(t *testing.T, name string, out any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(exampleDir(), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

// ---------- fixture Slack ----------

type slackFixture struct {
	mu    sync.Mutex
	posts []map[string]any
}

func (s *slackFixture) received() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.posts...)
}

func startSlack(t *testing.T, addr string) *slackFixture {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("slack fixture listen %s: %v", addr, err)
	}
	f := &slackFixture{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		f.mu.Lock()
		f.posts = append(f.posts, body)
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{"ok":true,"ts":"1.0"}`)
	}), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return f
}

// ---------- SSE ----------

type sseEvent struct {
	Name string
	Data map[string]any
}

// openSSE subscribes to the session stream and returns once the server has
// confirmed the connection, so nothing published afterwards can be missed.
func openSSE(t *testing.T, base, sessionID, token string) <-chan sseEvent {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, base+"/v1/sessions/"+sessionID+"/events?token="+url.QueryEscape(token), nil)
	resp, err := (&http.Client{}).Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("open SSE: %v (resp %v)", err, resp)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	out := make(chan sseEvent, 64)
	connected := make(chan struct{})
	go func() {
		defer close(out)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
		name := ""
		var once sync.Once
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var d map[string]any
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &d) != nil {
					continue
				}
				ev := sseEvent{Name: name, Data: d}
				if ev.Name == "" {
					ev.Name, _ = d["type"].(string)
				}
				name = ""
				if ev.Name == "connected" {
					once.Do(func() { close(connected) })
					continue
				}
				out <- ev
			}
		}
	}()
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Fatal("SSE stream did not confirm the connection")
	}
	time.Sleep(300 * time.Millisecond) // the server subscribes to Redis right after the connected event
	return out
}

func waitFor(t *testing.T, ch <-chan sseEvent, name string) sseEvent {
	t.Helper()
	deadline := time.After(eventDeadline)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("SSE closed while waiting for %q", name)
			}
			if ev.Name == name {
				return ev
			}
		case <-deadline:
			t.Fatalf("timed out after %v waiting for SSE event %q", eventDeadline, name)
		}
	}
}

func login(t *testing.T, base string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"email": e2ekit.DefaultEmail(), "password": e2ekit.DefaultPassword()})
	resp, err := http.Post(base+"/auth/login", "application/json", strings.NewReader(string(b)))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		t.Fatalf("login: HTTP %d, token %q, err %v", resp.StatusCode, out.Token, err)
	}
	return out.Token
}

// ---------- the test ----------

func TestSupportDesk_KBAnswerThenHumanHandoff(t *testing.T) {
	k := e2ekit.Connect(t)
	base, token := e2ekit.DefaultBase(), login(t, e2ekit.DefaultBase())

	var spec map[string]any
	readSupportJSON(t, "spec.json", &spec)
	if labels, _ := spec["labels"].(map[string]any); labels["handoff"] != "human" || labels["handoff_slack_channel"] != slackChannel {
		t.Fatalf("spec.json labels = %v, want handoff=human and handoff_slack_channel=%s", labels, slackChannel)
	}
	if yml, _ := os.ReadFile(filepath.Join(exampleDir(), "agent.yaml")); !strings.Contains(string(yml), "handoff: human") ||
		!strings.Contains(string(yml), "handoff_slack_channel: "+slackChannel) {
		t.Fatal("agent.yaml and spec.json have drifted: agent.yaml must declare the same handoff labels")
	}
	k.CreateAgent(t, agentName, spec)

	// Seed the knowledge base with the example's documents (fixed ids).
	var docs []struct{ ID, Title, File string }
	readSupportJSON(t, "knowledge.json", &docs)
	for _, d := range docs {
		raw, err := os.ReadFile(filepath.Join(exampleDir(), d.File))
		if err != nil {
			t.Fatal(err)
		}
		st, body := k.DoAuth(t, "POST", "/v1/agents/"+agentName+"/documents",
			map[string]string{"id": d.ID, "title": d.Title, "content": string(raw)}, nil)
		if st != http.StatusCreated {
			t.Fatalf("upload %s: HTTP %d: %s", d.Title, st, body)
		}
		id := d.ID
		t.Cleanup(func() { k.DoAuth(t, "DELETE", "/v1/agents/"+agentName+"/documents/"+id, nil, nil) })
	}
	resetDocID := docs[0].ID

	// Slack handoff ping (optional; see the package comment).
	var slack *slackFixture
	if addr := cmp.Or(os.Getenv("PAL_E2E_SLACK_FIXTURE_ADDR"), os.Getenv("PAL_E2E_SLACK_FIXTURE_ADDR")); addr != "" {
		var existing []struct{ ID, ConnectorID string }
		k.DoAuth(t, "GET", "/v1/connectors", nil, &existing)
		for _, c := range existing {
			if c.ConnectorID == "slack" {
				t.Skip("tenant already has a Slack connector installed; refusing to replace it with a fixture")
			}
		}
		slack = startSlack(t, addr)
		var inst struct{ ID string }
		if st, body := k.DoAuth(t, "POST", "/v1/connectors/install", map[string]any{
			"connectorId": "slack", "displayName": "Slack (e2e fixture)", "config": map[string]string{"botToken": fixtureSlackToken},
		}, &inst); st != http.StatusCreated {
			t.Fatalf("install slack: HTTP %d: %s", st, body)
		}
		t.Cleanup(func() { k.DoAuth(t, "DELETE", "/v1/connectors/"+inst.ID, nil, nil) })
	}

	var sess struct{ ID string }
	if st, body := k.DoAuth(t, "POST", "/v1/sessions", map[string]string{"agentName": agentName}, &sess); st != http.StatusCreated || sess.ID == "" {
		t.Fatalf("create session: HTTP %d: %s", st, body)
	}
	t.Cleanup(func() { k.DoAuth(t, "DELETE", "/v1/sessions/"+sess.ID, nil, nil) })
	events := openSSE(t, base, sess.ID, token)
	send := func(text string) {
		t.Helper()
		if st, body := k.DoAuth(t, "POST", "/v1/sessions/"+sess.ID+"/messages", map[string]string{"content": text}, nil); st != http.StatusAccepted {
			t.Fatalf("send %q: HTTP %d: %s", text, st, body)
		}
	}

	// 1. A question the docs answer: cited answer, no handoff.
	send("How do I reset my password?")
	done := waitFor(t, events, "message_completed")
	srcs, _ := json.Marshal(done.Data["sources"])
	if !strings.Contains(string(srcs), resetDocID) {
		t.Fatalf("message_completed sources = %s, want the seeded password-reset doc %s", srcs, resetDocID)
	}
	if cmp.Or(os.Getenv("PAL_E2E_FIXTURE_LLM"), os.Getenv("PAL_E2E_FIXTURE_LLM")) == "1" {
		if text, _ := done.Data["text"].(string); !strings.Contains(text, "[doc:"+resetDocID+"]") {
			t.Fatalf("fixture answer %q does not cite [doc:%s]", text, resetDocID)
		}
	}
	waitFor(t, events, "session.status_idle")

	// 2. A refund question: handoff, Slack ping, and the session is parked.
	send("I want a refund for last month's invoice")
	waitFor(t, events, "session.handoff")
	waitFor(t, events, "session.status_idle")
	var got struct{ Status string }
	k.DoAuth(t, "GET", "/v1/sessions/"+sess.ID, nil, &got)
	if got.Status != "handoff" {
		t.Fatalf("session status = %q, want handoff", got.Status)
	}
	if slack != nil {
		posts := slack.received()
		if len(posts) != 1 || posts[0]["channel"] != slackChannel || !strings.Contains(fmt.Sprint(posts[0]["text"]), sess.ID) {
			t.Fatalf("slack posts = %v, want exactly one to #%s naming session %s", posts, slackChannel, sess.ID)
		}
	}

	// 3. The operator answers from the dashboard/API; it reaches the customer's stream.
	if st, body := k.DoAuth(t, "POST", "/v1/sessions/"+sess.ID+"/operator-messages", map[string]string{"content": "Hi! I've started your refund."}, nil); st != http.StatusOK {
		t.Fatalf("operator reply: HTTP %d: %s", st, body)
	}
	op := waitFor(t, events, "operator.message")
	if data, _ := op.Data["data"].(map[string]any); data["content"] != "Hi! I've started your refund." {
		t.Fatalf("operator.message = %v", op.Data)
	}
}
