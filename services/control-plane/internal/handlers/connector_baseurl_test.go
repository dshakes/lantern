package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dshakes/lantern/services/control-plane/internal/connectorreplay"
)

const replayToken = "tok-secret-do-not-leak"

// replayEnv starts the replay server and points every overridable connector at it.
func replayEnv(t *testing.T) *connectorreplay.Server {
	t.Helper()
	t.Setenv("LANTERN_ENV", "")
	rs, err := connectorreplay.New()
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(rs)
	t.Cleanup(ts.Close)
	for _, name := range connectorHosts {
		t.Setenv(connectorBaseURLPrefix+name, ts.URL)
	}
	return rs
}

func TestCheckConnectorBaseURLOverrides(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	tests := []struct {
		name      string
		prod      bool
		env       map[string]string
		wantFatal bool
		wantMsg   string
	}{
		{"prod unset", true, nil, false, ""},
		{"prod set", true, map[string]string{"LANTERN_CONNECTOR_BASEURL_SLACK": "http://127.0.0.1:1"}, true, "LANTERN_CONNECTOR_BASEURL_SLACK"},
		{"dev unset", false, nil, false, ""},
		{"dev valid", false, map[string]string{"LANTERN_CONNECTOR_BASEURL_GITHUB": "http://127.0.0.1:1"}, false, ""},
		{"dev malformed", false, map[string]string{"LANTERN_CONNECTOR_BASEURL_GITHUB": "not-a-url"}, true, "malformed"},
		{"dev non-http scheme", false, map[string]string{"LANTERN_CONNECTOR_BASEURL_GITHUB": "file:///etc"}, true, "malformed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := CheckConnectorBaseURLOverrides(tc.prod, env(tc.env))
			if fatal != tc.wantFatal || !strings.Contains(msg, tc.wantMsg) {
				t.Fatalf("fatal=%v msg=%q, want fatal=%v containing %q", fatal, msg, tc.wantFatal, tc.wantMsg)
			}
		})
	}
}

type captureRT struct{ host string }

func (c *captureRT) RoundTrip(r *http.Request) (*http.Response, error) {
	c.host = r.URL.Host
	return &http.Response{StatusCode: 200, Body: http.NoBody, Header: http.Header{}}, nil
}

func TestBaseURLTransport_IgnoredInProd(t *testing.T) {
	t.Setenv("LANTERN_CONNECTOR_BASEURL_SLACK", "http://127.0.0.1:1")
	for env, want := range map[string]string{"production": "slack.com", "": "127.0.0.1:1"} {
		t.Run("env="+env, func(t *testing.T) {
			t.Setenv("LANTERN_ENV", env)
			c := &captureRT{}
			req, _ := http.NewRequest("GET", "https://slack.com/api/x", nil)
			if _, err := (baseURLTransport{next: c}).RoundTrip(req); err != nil {
				t.Fatal(err)
			}
			if c.host != want {
				t.Fatalf("host=%q want %q", c.host, want)
			}
			if req.URL.Host != "slack.com" {
				t.Fatal("original request was mutated")
			}
		})
	}
}

func TestConnectorActionsAgainstReplay(t *testing.T) {
	rs := replayEnv(t)
	tokCfg := func(field string) map[string]any { return map[string]any{field: replayToken} }

	tests := []struct {
		name     string
		run      func() (any, error)
		wantPath string
		wantBody map[string]any // subset of the outbound JSON body
		wantOut  string         // substring of the JSON result
	}{
		{"slack reply_thread", func() (any, error) {
			return executeSlack(tokCfg("botToken"), "reply_thread", map[string]any{"channel": "C0123", "text": "hi", "thread_ts": "1700000000.000100"})
		}, "/api/chat.postMessage", map[string]any{"channel": "C0123", "thread_ts": "1700000000.000100"}, `"ts":"1700000001.000200"`},
		{"slack post_message no thread", func() (any, error) {
			return executeSlack(tokCfg("botToken"), "post_message", map[string]any{"channel": "C0123", "text": "hi"})
		}, "/api/chat.postMessage", map[string]any{"text": "hi"}, `"ok":true`},
		{"github comment_pr", func() (any, error) {
			return executeGitHub(tokCfg("personalAccessToken"), "comment_pr", map[string]any{"owner": "acme", "repo": "api", "number": float64(42), "body": "LGTM"})
		}, "/repos/acme/api/issues/42/comments", map[string]any{"body": "LGTM"}, `"id":9001`},
		{"sentry get_issue", func() (any, error) {
			return executeSentry(tokCfg("authToken"), "get_issue", map[string]any{"organization": "acme", "issue_id": "1001"})
		}, "/api/0/organizations/acme/issues/1001/", nil, `"lastSeen"`},
		{"pagerduty list_incidents", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "list_incidents", map[string]any{"status": "triggered"})
		}, "/incidents", nil, `"PABC123"`},
		{"pagerduty get_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "get_incident", map[string]any{"incident_id": "PABC123"})
		}, "/incidents/PABC123", nil, `"urgency":"high"`},
		{"pagerduty create_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "create_incident", map[string]any{"title": "boom", "service_id": "PSVC1", "from": "oncall@acme.test", "details": "d"})
		}, "/incidents", map[string]any{"incident": map[string]any{"title": "boom", "type": "incident"}}, `"PNEW456"`},
		{"pagerduty update_incident", func() (any, error) {
			return executePagerDuty(tokCfg("apiKey"), "update_incident", map[string]any{"incident_id": "PABC123", "status": "acknowledged", "from": "oncall@acme.test"})
		}, "/incidents/PABC123", map[string]any{"incident": map[string]any{"status": "acknowledged"}}, `"acknowledged"`},
		{"gcal create_event", func() (any, error) {
			return executeGoogleCalendar(tokCfg("accessToken"), "create_event", map[string]any{
				"summary": "Sync", "start": "2026-11-02T15:00:00-08:00", "end": "2026-11-02T15:30:00-08:00",
				"timeZone": "America/Los_Angeles", "attendees": []any{"a@acme.test"}})
		}, "/calendar/v3/calendars/primary/events", map[string]any{"summary": "Sync"}, `"evt2"`},
	}
	for i, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out, err := tc.run()
			if err != nil {
				t.Fatal(err)
			}
			if b, _ := json.Marshal(out); !strings.Contains(string(b), tc.wantOut) {
				t.Fatalf("result %s missing %s", b, tc.wantOut)
			}
			reqs := rs.Requests()
			if len(reqs) != i+1 {
				t.Fatalf("recorded %d requests, want %d", len(reqs), i+1)
			}
			got := reqs[i]
			if got.Path != tc.wantPath || !got.Matched || !got.HasAuth {
				t.Fatalf("recorded %+v, want matched authed %s", got, tc.wantPath)
			}
			if got.Header.Get("Authorization") != "" || strings.Contains(got.Body, replayToken) {
				t.Fatal("token leaked into recorded request")
			}
			if tc.wantBody != nil {
				var body map[string]any
				if err := json.Unmarshal([]byte(got.Body), &body); err != nil {
					t.Fatalf("body not JSON: %v", err)
				}
				assertSubset(t, tc.wantBody, body)
			}
		})
	}
}

func assertSubset(t *testing.T, want, got map[string]any) {
	t.Helper()
	for k, w := range want {
		if wm, ok := w.(map[string]any); ok {
			gm, _ := got[k].(map[string]any)
			assertSubset(t, wm, gm)
		} else if got[k] != w {
			t.Fatalf("body[%q]=%v want %v", k, got[k], w)
		}
	}
}

func TestSlackThreadTSOmittedWhenEmpty(t *testing.T) {
	rs := replayEnv(t)
	if _, err := executeSlack(map[string]any{"botToken": replayToken}, "post_message", map[string]any{"channel": "C1", "text": "x"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rs.Requests()[0].Body, "thread_ts") {
		t.Fatal("thread_ts must be omitted for a plain post")
	}
}

func TestConnectorActionErrors(t *testing.T) {
	replayEnv(t)
	cfg := map[string]any{"token": replayToken}
	tests := []struct {
		name string
		run  func() (any, error)
		want string
	}{
		{"slack reply_thread missing thread_ts", func() (any, error) {
			return executeSlack(cfg, "reply_thread", map[string]any{"channel": "C", "text": "t"})
		}, "'thread_ts'"},
		{"github comment_pr missing body", func() (any, error) {
			return executeGitHub(cfg, "comment_pr", map[string]any{"owner": "a", "repo": "b", "number": "1"})
		}, "'body'"},
		{"github comment_pr unrecorded repo", func() (any, error) {
			return executeGitHub(cfg, "comment_pr", map[string]any{"owner": "x", "repo": "y", "number": "1", "body": "b"})
		}, "404"},
		{"sentry get_issue missing id", func() (any, error) {
			return executeSentry(cfg, "get_issue", map[string]any{"organization": "acme"})
		}, "'issue_id'"},
		{"gcal create_event missing end", func() (any, error) {
			return executeGoogleCalendar(cfg, "create_event", map[string]any{"summary": "s", "start": "x"})
		}, "'end'"},
		{"pagerduty create_incident missing from", func() (any, error) {
			return executePagerDuty(cfg, "create_incident", map[string]any{"title": "t", "service_id": "s"})
		}, "'from'"},
		{"pagerduty update_incident bad status", func() (any, error) {
			return executePagerDuty(cfg, "update_incident", map[string]any{"incident_id": "P", "from": "a@b.c", "status": "deleted"})
		}, "acknowledged|resolved"},
		{"pagerduty unknown action", func() (any, error) { return executePagerDuty(cfg, "nope", nil) }, "unknown PagerDuty action"},
		{"pagerduty no token", func() (any, error) { return executePagerDuty(map[string]any{}, "list_incidents", nil) }, "PagerDuty"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.run()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err=%v, want containing %q", err, tc.want)
			}
			if strings.Contains(err.Error(), replayToken) {
				t.Fatal("token leaked into error")
			}
		})
	}
}
