package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type evalCalls struct {
	mu    sync.Mutex
	calls []string
}

func (c *evalCalls) add(s string) { c.mu.Lock(); c.calls = append(c.calls, s); c.mu.Unlock() }
func (c *evalCalls) has(s string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, x := range c.calls {
		if x == s {
			return true
		}
	}
	return false
}

func evalTestServer(t *testing.T, runStatus int, runBody string, rec *evalCalls) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.add(r.Method + " " + r.URL.Path)
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/eval-suites":
			w.Write([]byte(`[{"id":"s1","agentName":"a","name":"core","cases":[{"name":"c","input":"hi"}]}]`))
		case r.URL.Path == "/v1/eval-suites/s1/run":
			w.WriteHeader(runStatus)
			w.Write([]byte(runBody))
		case r.URL.Path == "/v1/eval-suites/generate":
			w.Write([]byte(`{"draft":{"agentName":"a","name":"gen","cases":[{"name":"c1","input":"hello"}]},"provenance":[{"case":"c1","source":"run:1","grounding":"rubric-only","notes":["stripped regex"]}],"dropped":[{"name":"bad","reason":"ungrounded"}],"costUsd":0.01,"requiresApproval":true}`))
		case r.Method == "POST" && r.URL.Path == "/v1/eval-suites":
			w.Write([]byte(`{"id":"new1"}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestRunEval(t *testing.T) {
	okBody := `{"id":"r1","passed":true,"score":1,"casesTotal":1,"casesPassed":1,"caseResults":[{"name":"c","passed":true,"score":1}]}`
	failBody := `{"id":"r2","passed":false,"score":0.5,"casesTotal":1,"casesPassed":0,"caseResults":[{"name":"c","passed":false,"score":0.5,"stddev":0.1,"assertions":[{"kind":"judge","passed":false,"detail":"mean 0.4 < 0.75","rationale":"missed the 30 day window"}]}]}`
	regBody := `{"id":"r3","passed":true,"score":0.5,"casesTotal":1,"casesPassed":1,"regressed":true,"baselineScore":0.9,"regressedCases":["c"],"caseDeltas":[{"name":"c","score":0.5,"baselineScore":0.9,"delta":-0.4,"regressed":true}],"caseResults":[{"name":"c","passed":true,"score":0.5}]}`
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr string
		wantOut []string
	}{
		{"happy", 200, okBody, "", []string{"[PASS] c", "Score: 1.00"}},
		{"failing case prints assertion and rationale", 200, failBody, "eval failed: 0/1", []string{"[FAIL] c", "x judge: mean 0.4", "missed the 30 day window"}},
		{"422 regression", 422, regBody, "regression vs. baseline", []string{"regressed: c", "Baseline"}},
		{"402 budget", 402, `{"error":"budget exceeded","code":"budget_exceeded"}`, "budget exceeded (budget_exceeded)", nil},
		{"503 no llm", 503, `{"error":"eval runner not configured","code":"no_llm"}`, "no_llm", nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := &evalCalls{}
			srv := evalTestServer(t, tc.status, tc.body, rec)
			defer srv.Close()
			var out bytes.Buffer
			err := runEval(context.Background(), srv.URL, "tok", evalRunOpts{agent: "a", suite: "core", branch: "main"}, &out)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
			for _, w := range tc.wantOut {
				if !strings.Contains(out.String(), w) {
					t.Errorf("output missing %q:\n%s", w, out.String())
				}
			}
		})
	}
}

func TestEvalGenerateNeverSavesWithoutApprove(t *testing.T) {
	rec := &evalCalls{}
	srv := evalTestServer(t, 200, `{}`, rec)
	defer srv.Close()
	oldURL, oldKey := flags.apiURL, flags.apiKey
	flags.apiURL, flags.apiKey = srv.URL, "tok"
	defer func() { flags.apiURL, flags.apiKey = oldURL, oldKey }()

	outFile := filepath.Join(t.TempDir(), "draft.json")
	run := func(args ...string) (string, error) {
		cmd := newEvalCommand()
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(&out)
		cmd.SetArgs(args)
		err := cmd.Execute()
		return out.String(), err
	}

	out, err := run("generate", "--agent", "a", "--out", outFile)
	if err != nil {
		t.Fatal(err)
	}
	if rec.has("POST /v1/eval-suites") {
		t.Fatal("generate without --approve saved a suite")
	}
	for _, w := range []string{"NOT saved", "rubric-only", "stripped regex", "dropped bad"} {
		if !strings.Contains(out, w) {
			t.Errorf("output missing %q:\n%s", w, out)
		}
	}

	// --approve with a non-"y" answer must not save either.
	cmd := newEvalCommand()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetIn(strings.NewReader("n\n"))
	cmd.SetArgs([]string{"generate", "--agent", "a", "--approve"})
	if err := cmd.Execute(); err == nil {
		t.Fatal("declined approval should error")
	}
	if rec.has("POST /v1/eval-suites") {
		t.Fatal("declined approval saved a suite")
	}

	// approve file round-trip: the file written by --out is what gets POSTed.
	if _, err := os.Stat(outFile); err != nil {
		t.Fatal(err)
	}
	out, err = run("approve", "--file", outFile)
	if err != nil || !strings.Contains(out, "new1") {
		t.Fatalf("approve: %v %q", err, out)
	}
	if !rec.has("POST /v1/eval-suites") {
		t.Fatal("approve did not save")
	}

	// --approve --yes saves directly.
	if _, err := run("generate", "--agent", "a", "--approve", "--yes"); err != nil {
		t.Fatal(err)
	}

	// A non-draft file is rejected before any request.
	bad := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(bad, []byte(`{"x":1}`), 0o600)
	if _, err := run("approve", "--file", bad); err == nil {
		t.Fatal("expected rejection of non-draft file")
	}
}
