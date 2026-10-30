//go:build e2e

package examples_e2e

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const triageReply = "risk: low - small retry-backoff change; check the jitter bounds in retry.go"

// TestPRTriage drives examples/pr-triage-webhook: a signed pull_request.opened
// becomes a run whose connector calls (GitHub comment, Slack thread) are
// recorded by connector-replay; replays, bad signatures and an exhausted budget
// never start or spend a second run.
func TestPRTriage(t *testing.T) {
	s := connect(t)
	s.installConnector(t, "github", "personalAccessToken")
	s.installConnector(t, "slack", "botToken")
	a := s.setupAgent(t, "e2e-pr-triage", "pr-triage-webhook")
	h := s.createHook(t, a.Name, "pr-triage-webhook/trigger.json")

	payload := readFile(t, "pr-triage-webhook/fixtures/pull_request.opened.json")
	headers := func(secret, delivery string, body []byte) map[string]string {
		return map[string]string{
			"X-GitHub-Event": "pull_request", "X-GitHub-Delivery": delivery,
			"X-Hub-Signature-256": "sha256=" + hmacHex(secret, body),
		}
	}
	conn0 := len(fetchReplay(t, s.connector))
	delivery := uniq("gh")

	var runID string
	t.Run("bad signature is 401 and starts nothing", func(t *testing.T) {
		for name, hdr := range map[string]map[string]string{
			"wrong secret": headers("not-the-secret", uniq("gh"), payload),
			"no signature": {"X-GitHub-Event": "pull_request", "X-GitHub-Delivery": uniq("gh")},
		} {
			if st, _ := deliver(t, h.ID, hdr, payload); st != http.StatusUnauthorized {
				t.Fatalf("%s: HTTP %d, want 401", name, st)
			}
		}
		if n := len(newRequests(t, s.connector, conn0)); n != 0 {
			t.Fatalf("%d connector calls after rejected deliveries", n)
		}
	})

	t.Run("signed delivery runs and posts to GitHub + Slack", func(t *testing.T) {
		llm0 := len(fetchReplay(t, s.llm))
		st, resp := deliver(t, h.ID, headers(h.Secret, delivery, payload), payload)
		if st != http.StatusAccepted {
			t.Fatalf("HTTP %d: %v", st, resp)
		}
		runID, _ = resp["runId"].(string)
		s.waitStatus(t, runID, "succeeded")

		reqs := newRequests(t, s.connector, conn0)
		if got := find(reqs, "GET", "/repos/acme/api/pulls/42"); len(got) != 1 {
			t.Fatalf("get_pr calls = %d, want 1", len(got))
		}
		comments := find(reqs, "POST", "/repos/acme/api/issues/42/comments")
		if len(comments) != 1 {
			t.Fatalf("PR comments = %d, want 1", len(comments))
		}
		if body := bodyJSON(t, comments[0])["body"]; body != "PAL triage: "+triageReply {
			t.Fatalf("comment body = %q", body)
		}
		posts := find(reqs, "POST", "/api/chat.postMessage")
		if len(posts) != 2 {
			t.Fatalf("slack posts = %d, want 2 (announce + threaded verdict)", len(posts))
		}
		announce, thread := bodyJSON(t, posts[0]), bodyJSON(t, posts[1])
		if announce["thread_ts"] != nil || !strings.Contains(announce["text"].(string), "New PR #42: Fix retry storm") || announce["channel"] != "C0123" {
			t.Fatalf("announce = %v", announce)
		}
		if thread["thread_ts"] != "1700000001.000200" || thread["text"] != triageReply {
			t.Fatalf("threaded verdict = %v", thread)
		}
		if n := len(newRequests(t, s.llm, llm0)); n != 1 {
			t.Fatalf("LLM calls = %d, want 1 (fixture, no provider)", n)
		}
		j := s.journal(t, runID)
		for _, want := range []string{"step_completed:fetch", "step_completed:triage", "step_completed:comment", "step_completed:thread"} {
			if !contains(j, want) {
				t.Fatalf("journal lacks %s: %v", want, j)
			}
		}
	})

	t.Run("replayed delivery id is deduplicated", func(t *testing.T) {
		before := len(fetchReplay(t, s.connector))
		for name, d := range map[string]string{"same id": delivery, "forged new id, same bytes": uniq("gh")} {
			st, resp := deliver(t, h.ID, headers(h.Secret, d, payload), payload)
			if st != http.StatusOK || resp["duplicate"] != true || resp["runId"] != runID {
				t.Fatalf("%s: HTTP %d %v, want 200 duplicate of %s", name, st, resp, runID)
			}
		}
		time.Sleep(2 * time.Second) // a (wrong) second run would be calling connectors by now
		if n := len(newRequests(t, s.connector, before)); n != 0 {
			t.Fatalf("%d connector calls after duplicates - a second run started", n)
		}
	})

	t.Run("over-budget agent gets 402 and no run", func(t *testing.T) {
		// One run already counted today; cap the agent at one.
		if st, raw := s.kit.DoAuth(t, http.MethodPut, "/v1/agents/"+a.Name+"/budget",
			map[string]any{"maxCostUsdPerDay": 0.5, "maxRunsPerDay": 1, "hardFail": true}, nil); st != http.StatusOK && st != http.StatusCreated {
			t.Fatalf("PUT budget: HTTP %d: %s", st, raw)
		}
		before := len(fetchReplay(t, s.connector))
		next := []byte(strings.Replace(string(payload), `"number":42`, `"number":43`, 2))
		st, resp := deliver(t, h.ID, headers(h.Secret, uniq("gh"), next), next)
		if st != http.StatusPaymentRequired {
			t.Fatalf("HTTP %d %v, want 402", st, resp)
		}
		if n := len(newRequests(t, s.connector, before)); n != 0 {
			t.Fatalf("%d connector calls on a refused run", n)
		}
	})
}
