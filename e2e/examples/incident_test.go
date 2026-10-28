//go:build e2e

package examples_e2e

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const incidentSummary = "TypeError spiking in the API since the last deploy, 128 events and urgency high - suggest rolling back the last release"

// TestIncident drives examples/incident-responder: a signed Sentry alert is
// summarized, announced in Slack, then parks at the approval node. Granting it
// posts a note on the PagerDuty incident; denying it fails the step and posts
// nothing.
func TestIncident(t *testing.T) {
	s := connect(t)
	s.installConnector(t, "sentry", "authToken")
	s.installConnector(t, "pagerduty", "apiKey")
	s.installConnector(t, "slack", "botToken")
	a := s.setupAgent(t, "e2e-incident", "incident-responder")
	sentry := s.createHook(t, a.Name, "incident-responder/trigger-sentry.json")
	pd := s.createHook(t, a.Name, "incident-responder/trigger-pagerduty.json")

	alert := readFile(t, "incident-responder/fixtures/sentry.alert.json")
	sentryHdr := func(secret, id string, body []byte) map[string]string {
		return map[string]string{"Sentry-Hook-Signature": hmacHex(secret, body), "Sentry-Hook-Resource": "event_alert", "Request-ID": id}
	}
	notes := func(reqs []replayReq) []replayReq { return find(reqs, "POST", "/incidents/PABC123/notes") }

	// parked starts a run from a Sentry alert and waits for it to reach the approval.
	parked := func(t *testing.T, body []byte) (runID string, since int) {
		since = len(fetchReplay(t, s.connector))
		llm0 := len(fetchReplay(t, s.llm))
		st, resp := deliver(t, sentry.ID, sentryHdr(sentry.Secret, uniq("sentry"), body), body)
		if st != http.StatusAccepted {
			t.Fatalf("HTTP %d: %v", st, resp)
		}
		runID, _ = resp["runId"].(string)
		s.awaitApproval(t, runID)

		reqs := newRequests(t, s.connector, since)
		if len(find(reqs, "GET", "/api/0/organizations/acme/issues/1001/")) != 1 || len(find(reqs, "GET", "/incidents/PABC123")) != 1 {
			t.Fatalf("sentry/pagerduty lookups missing: %v", reqs)
		}
		posts := find(reqs, "POST", "/api/chat.postMessage")
		if len(posts) != 1 || !strings.Contains(bodyJSON(t, posts[0])["text"].(string), incidentSummary) {
			t.Fatalf("slack summary post = %v", posts)
		}
		if len(notes(reqs)) != 0 {
			t.Fatal("PagerDuty note posted before approval")
		}
		if n := len(newRequests(t, s.llm, llm0)); n != 1 {
			t.Fatalf("LLM calls = %d, want 1", n)
		}
		if j := s.journal(t, runID); !contains(j, "step_waiting:approve") {
			t.Fatalf("journal lacks step_waiting:approve: %v", j)
		}
		return runID, since
	}

	t.Run("bad signature is 401 and starts nothing", func(t *testing.T) {
		before := len(fetchReplay(t, s.connector))
		if st, _ := deliver(t, sentry.ID, sentryHdr("not-the-secret", uniq("sentry"), alert), alert); st != http.StatusUnauthorized {
			t.Fatalf("sentry bad sig: HTTP %d, want 401", st)
		}
		if st, _ := deliver(t, pd.ID, map[string]string{"X-PagerDuty-Signature": "v1=" + hmacHex("not-the-secret", alert)}, alert); st != http.StatusUnauthorized {
			t.Fatalf("pagerduty bad sig: HTTP %d, want 401", st)
		}
		if n := len(newRequests(t, s.connector, before)); n != 0 {
			t.Fatalf("%d connector calls after rejected deliveries", n)
		}
	})

	t.Run("approve: parks, then grant posts the PagerDuty note", func(t *testing.T) {
		runID, since := parked(t, alert)
		id := s.awaitApproval(t, runID)
		if st, raw := s.kit.DoAuth(t, http.MethodPost, "/v1/runs/"+runID+"/takeover/"+id+"/grant", map[string]string{"notes": "go"}, nil); st != http.StatusOK {
			t.Fatalf("grant: HTTP %d: %s", st, raw)
		}
		s.waitStatus(t, runID, "succeeded")
		reqs := newRequests(t, s.connector, since)
		n := notes(reqs)
		if len(n) != 1 {
			t.Fatalf("PagerDuty notes = %d, want 1", len(n))
		}
		note := bodyJSON(t, n[0])["note"].(map[string]any)
		if c := note["content"].(string); !strings.Contains(c, "Rollback approved") || !strings.Contains(c, incidentSummary) {
			t.Fatalf("note content = %q", c)
		}
		if from := n[0].Header["From"]; len(from) != 1 || from[0] != "oncall@acme.test" {
			t.Fatalf("From header = %v", from)
		}
		j := s.journal(t, runID)
		for _, want := range []string{"step_completed:approve", "step_completed:note"} {
			if !contains(j, want) {
				t.Fatalf("journal lacks %s after resume: %v", want, j)
			}
		}
		// Resume must not redo the side effects that ran before the park.
		if len(find(reqs, "POST", "/api/chat.postMessage")) != 1 || len(find(reqs, "GET", "/incidents/PABC123")) != 1 {
			t.Fatalf("pre-approval steps ran again after grant: %v", reqs)
		}
	})

	t.Run("deny: step_failed, run failed, no note", func(t *testing.T) {
		body := []byte(strings.Replace(string(alert), `"action":"triggered"`, `"action":"triggered","n":2`, 1))
		runID, since := parked(t, body)
		id := s.awaitApproval(t, runID)
		if st, raw := s.kit.DoAuth(t, http.MethodPost, "/v1/runs/"+runID+"/takeover/"+id+"/deny", map[string]string{"notes": "not now"}, nil); st != http.StatusOK {
			t.Fatalf("deny: HTTP %d: %s", st, raw)
		}
		deadline := time.Now().Add(30 * time.Second)
		for s.getRun(t, runID)["status"] != "failed" {
			if time.Now().After(deadline) {
				t.Fatal("run never failed after deny")
			}
			time.Sleep(500 * time.Millisecond)
		}
		if j := s.journal(t, runID); !contains(j, "step_failed:approve") {
			t.Fatalf("journal lacks step_failed:approve: %v", j)
		}
		if n := notes(newRequests(t, s.connector, since)); len(n) != 0 {
			t.Fatalf("%d PagerDuty notes after a denial", len(n))
		}
		// A decided request cannot be decided again.
		if st, _ := s.kit.DoAuth(t, http.MethodPost, "/v1/runs/"+runID+"/takeover/"+id+"/grant", nil, nil); st != http.StatusNotFound {
			t.Fatalf("grant after deny: HTTP %d, want 404", st)
		}
	})

	t.Run("pagerduty-signed delivery starts a run", func(t *testing.T) {
		body := readFile(t, "incident-responder/fixtures/pagerduty.incident.triggered.json")
		st, resp := deliver(t, pd.ID, map[string]string{"X-PagerDuty-Signature": "v1=" + hmacHex(pd.Secret, body)}, body)
		if st != http.StatusAccepted {
			t.Fatalf("HTTP %d: %v", st, resp)
		}
		runID, _ := resp["runId"].(string)
		id := s.awaitApproval(t, runID)
		s.kit.DoAuth(t, http.MethodPost, "/v1/runs/"+runID+"/takeover/"+id+"/deny", nil, nil) // leave nothing parked
	})
}
