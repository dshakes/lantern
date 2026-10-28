//go:build e2e

package examples_e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// X4: a schedule fires -> the scheduler creates a run -> the workflow reads
// GitHub, writes the digest with the (fixture) LLM and posts it to Slack.
func TestDigest_ScheduleFiresAndPostsToSlack(t *testing.T) {
	k := connect(t)
	db := openDB(t)
	need(t, "LANTERN_E2E_REPLAY_URL")

	installConnector(t, k, "slack", map[string]any{"botToken": "xoxb-fixture"})
	installConnector(t, k, "github", map[string]any{"personalAccessToken": "ghp_fixture"})

	k.CreateAgent(t, "e2e-digest", readJSON(t, "../../examples/daily-digest/spec.json"))
	putWorkflow(t, k, "e2e-digest", readJSON(t, "../../examples/daily-digest/workflow.json"))

	// Create the schedule from the committed example, pointed at the e2e agent.
	sched := readJSON(t, "../../examples/daily-digest/schedule.json")
	sched["agentName"] = "e2e-digest"
	var created struct {
		ID         string    `json:"id"`
		NextFireAt time.Time `json:"nextFireAt"`
	}
	st, raw := k.DoAuth(t, http.MethodPost, "/v1/schedules", sched, &created)
	if st != http.StatusCreated || created.ID == "" {
		t.Fatalf("create schedule: HTTP %d: %s", st, raw)
	}
	// Registered AFTER the agent, so it runs first on cleanup: a schedule left
	// behind would make the scheduler auto-create the agent again.
	t.Cleanup(func() { k.DoAuth(t, http.MethodDelete, "/v1/schedules/"+created.ID, nil, nil) })

	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load tz: %v", err)
	}
	assertNineNY := func(label string, at time.Time) {
		t.Helper()
		l := at.In(ny)
		if l.Hour() != 9 || l.Minute() != 0 || l.Weekday() == time.Saturday || l.Weekday() == time.Sunday {
			t.Fatalf("%s = %s, want a weekday 09:00 America/New_York", label, l.Format(time.RFC3339))
		}
	}
	assertNineNY("nextFireAt (create)", created.NextFireAt)

	before := replayRequests(t)

	// "Fire now": make the row due. The scheduler polls every 60s.
	if _, err := db.Exec(context.Background(),
		`UPDATE schedules SET next_fire_at = now() - interval '1 second' WHERE id = $1`, created.ID); err != nil {
		t.Fatalf("make schedule due: %v", err)
	}

	var run map[string]any
	waitFor(t, 100*time.Second, "scheduler-created run to succeed", func() bool {
		for _, r := range runsFor(t, k, "e2e-digest") {
			switch r["status"] {
			case "succeeded":
				run = r
				return true
			case "failed", "cancelled":
				t.Fatalf("scheduled run ended %v: %v", r["status"], r["error"])
			}
		}
		return false
	})
	if run == nil {
		t.Fatal("no run")
	}

	// The Slack post is recorded by connector-replay, with the digest as text.
	after := replayRequests(t)
	if got := countReplay(after, "POST", "/api/chat.postMessage") - countReplay(before, "POST", "/api/chat.postMessage"); got != 1 {
		t.Fatalf("chat.postMessage calls during run = %d, want exactly 1", got)
	}
	if countReplay(after, "GET", "/repos/acme/api/pulls") <= countReplay(before, "GET", "/repos/acme/api/pulls") {
		t.Fatal("workflow never listed the PRs from GitHub")
	}
	var post replayRequest
	for _, r := range after {
		if r.Method == "POST" && r.Path == "/api/chat.postMessage" {
			post = r
		}
	}
	var body struct {
		Channel string `json:"channel"`
		Text    string `json:"text"`
	}
	if err := json.Unmarshal([]byte(post.Body), &body); err != nil {
		t.Fatalf("slack body not JSON: %v: %s", err, post.Body)
	}
	if body.Channel != "C0123" || !post.HasAuth {
		t.Fatalf("slack post = %+v (hasAuth %v), want channel C0123 with auth", body, post.HasAuth)
	}
	// llm-replay's scripted digest (testdata/llm-rules.json) is multi-line and
	// contains quotes; it must arrive intact (regression for JSON-escaping of
	// templated free text into inputMapping).
	for _, want := range []string{"Morning digest", "\n", "\"Fix retry storm\""} {
		if !strings.Contains(body.Text, want) {
			t.Fatalf("slack text %q missing %q", body.Text, want)
		}
	}

	// The schedule advanced to the next 09:00 New York weekday.
	var list []struct {
		ID          string     `json:"id"`
		NextFireAt  time.Time  `json:"nextFireAt"`
		LastFiredAt *time.Time `json:"lastFiredAt"`
	}
	k.DoAuth(t, http.MethodGet, "/v1/schedules", nil, &list)
	found := false
	for _, s := range list {
		if s.ID != created.ID {
			continue
		}
		found = true
		if s.LastFiredAt == nil {
			t.Fatal("lastFiredAt not stamped")
		}
		if !s.NextFireAt.After(time.Now()) {
			t.Fatalf("nextFireAt %s not in the future", s.NextFireAt)
		}
		assertNineNY("nextFireAt (after fire)", s.NextFireAt)
	}
	if !found {
		t.Fatal("schedule missing from GET /v1/schedules")
	}
}

// An invalid IANA timezone is a 400, never a silently-UTC schedule.
func TestDigest_InvalidTimezoneIsRejected(t *testing.T) {
	k := connect(t)
	st, _ := k.DoAuth(t, http.MethodPost, "/v1/schedules", map[string]any{
		"agentName": "e2e-digest", "cronExpr": "0 9 * * *", "timezone": "Mars/Olympus",
	}, nil)
	if st != http.StatusBadRequest {
		t.Fatalf("invalid timezone: HTTP %d, want 400", st)
	}
}
