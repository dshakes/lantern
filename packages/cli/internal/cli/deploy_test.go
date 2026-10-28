package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
)

type reqRec struct {
	Method, Path string
	Body         map[string]any
}

// fakeAPI records requests; status maps "METHOD path" to a forced status.
func fakeAPI(t *testing.T, agentExists bool, status map[string]int) (*httptest.Server, *[]reqRec) {
	t.Helper()
	var recs []reqRec
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		b, _ := io.ReadAll(r.Body)
		if len(b) > 0 {
			_ = json.Unmarshal(b, &body)
		}
		recs = append(recs, reqRec{r.Method, r.URL.Path, body})
		key := r.Method + " " + r.URL.Path
		if st, ok := status[key]; ok {
			w.WriteHeader(st)
			_, _ = w.Write([]byte(`{"error":"forced"}`))
			return
		}
		switch key {
		case "GET /v1/agents/bot":
			if !agentExists {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"error":"agent not found"}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"a1","name":"bot"}`))
		case "POST /v1/agents/bot/deploy":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"id":"d1","agentName":"bot","status":"live","url":"http://x/a2a"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &recs
}

const manifestYAML = `name: bot
description: d
model: auto
system_prompt: be nice
labels: {team: x}
workflow: {nodes: [], edges: []}
`

func runCLI(t *testing.T, srvURL string, args ...string) (stdout string, err error) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	old, _ := os.Getwd()
	if e := os.Chdir(dir); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	if e := os.WriteFile("agent.yaml", []byte(manifestYAML), 0o600); e != nil {
		t.Fatal(e)
	}
	pr, pw, _ := os.Pipe()
	oldOut := os.Stdout
	os.Stdout = pw
	root := NewRootCommand("t", "c", "d")
	root.SetArgs(append([]string{"--api-url", srvURL, "--api-key", "k"}, args...))
	err = root.Execute()
	pw.Close()
	os.Stdout = oldOut
	b, _ := io.ReadAll(pr)
	return string(b), err
}

func TestDeploySequence(t *testing.T) {
	tests := []struct {
		name   string
		exists bool
		want   []reqRec
	}{
		{"create", false, []reqRec{
			{"GET", "/v1/agents/bot", nil},
			{"POST", "/v1/agents", map[string]any{"name": "bot", "description": "d", "labels": map[string]any{"team": "x"}, "systemPrompt": "be nice", "model": "auto"}},
			{"PUT", "/v1/agents/bot/workflow", map[string]any{"nodes": []any{}, "edges": []any{}}},
			{"POST", "/v1/agents/bot/deploy", nil},
		}},
		{"update", true, []reqRec{
			{"GET", "/v1/agents/bot", nil},
			{"PATCH", "/v1/agents/bot", map[string]any{"systemPrompt": "be nice", "model": "auto"}},
			{"PUT", "/v1/agents/bot/workflow", map[string]any{"nodes": []any{}, "edges": []any{}}},
			{"POST", "/v1/agents/bot/deploy", nil},
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv, recs := fakeAPI(t, tc.exists, nil)
			out, err := runCLI(t, srv.URL, "deploy", "--json")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(*recs, tc.want) {
				t.Fatalf("requests:\n got %+v\nwant %+v", *recs, tc.want)
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("stdout not JSON: %q", out)
			}
			if got["id"] != "d1" || got["status"] != "live" || got["agent"] != tc.name+"d" {
				t.Fatalf("json shape: %v", got)
			}
		})
	}
}

func TestDeployDryRunCallsNoMutators(t *testing.T) {
	srv, recs := fakeAPI(t, false, nil)
	out, err := runCLI(t, srv.URL, "deploy", "--dry-run", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if len(*recs) != 1 || (*recs)[0].Method != "GET" {
		t.Fatalf("dry-run must only GET: %+v", *recs)
	}
	if !strings.Contains(out, `"agent": "create"`) {
		t.Fatalf("out: %s", out)
	}
}

func TestDeployErrorMapping(t *testing.T) {
	tests := []struct {
		name   string
		status map[string]int
		code   int
		msg    string
	}{
		{"401", map[string]int{"GET /v1/agents/bot": 401}, exitAuth, "lantern login"},
		{"402 on deploy", map[string]int{"POST /v1/agents/bot/deploy": 402}, exitBudget, "quota or budget"},
		{"404 on deploy", map[string]int{"POST /v1/agents/bot/deploy": 404}, exitMissing, "not found"},
		{"500 on create", map[string]int{"POST /v1/agents": 500, "GET /v1/agents/bot": 404}, exitServer, "control plane error"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv, _ := fakeAPI(t, true, tc.status)
			_, err := runCLI(t, srv.URL, "deploy")
			var ee *ExitError
			if !errors.As(err, &ee) || ee.Code != tc.code || !strings.Contains(err.Error(), tc.msg) {
				t.Fatalf("err=%v want code %d containing %q", err, tc.code, tc.msg)
			}
		})
	}
}

func TestDeployMissingManifestName(t *testing.T) {
	dir := t.TempDir()
	old, _ := os.Getwd()
	_ = os.Chdir(dir)
	t.Cleanup(func() { _ = os.Chdir(old) })
	_ = os.WriteFile("agent.yaml", []byte("description: x\n"), 0o600)
	root := NewRootCommand("t", "c", "d")
	root.SetArgs([]string{"deploy"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("err=%v", err)
	}
}
