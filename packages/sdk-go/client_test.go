package pal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDo_RetriesOnServiceUnavailableThenSucceeds(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"a1","name":"triage"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	agent, err := c.GetAgent(context.Background(), "a1")
	if err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected 2 calls (1 failure + 1 retry), got %d", calls)
	}
	if agent.ID != "a1" || agent.Name != "triage" {
		t.Fatalf("unexpected agent: %+v", agent)
	}
}

func TestDo_RetriesOnTooManyRequests(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"a1"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	if _, err := c.GetAgent(context.Background(), "a1"); err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestDo_DoesNotRetryOnBadRequest(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"bad request"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	if _, err := c.GetAgent(context.Background(), "a1"); err == nil {
		t.Fatal("expected error")
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 call (no retry on 400), got %d", calls)
	}
}

func TestDo_ExhaustsRetriesAndReturnsLastError(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL), WithMaxRetries(2))
	_, err := c.GetAgent(context.Background(), "a1")
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected *APIError 503, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected exactly 2 calls (WithMaxRetries(2)), got %d", calls)
	}
}

func TestDeleteBudget_CallsDeleteMethod(t *testing.T) {
	var gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		if r.URL.Path != "/v1/agents/my-agent/budget" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	if err := c.DeleteBudget(context.Background(), "my-agent"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != http.MethodDelete {
		t.Fatalf("expected DELETE, got %s", gotMethod)
	}
}

func TestTriggers_WireContract(t *testing.T) {
	type call struct{ method, path, body string }
	var got []call
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, call{r.Method, r.URL.Path, strings.TrimSpace(string(b))})
		switch {
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/triggers"):
			w.Write([]byte(`[{"id":"t1","provider":"github","hookPath":"/v1/hooks/t1"}]`))
		default:
			w.Write([]byte(`{"id":"t1","provider":"github","hookPath":"/v1/hooks/t1","secret":"whsec_x"}`))
		}
	}))
	defer srv.Close()
	c := New(WithBaseURL(srv.URL))
	ctx := context.Background()

	tr, err := c.CreateTrigger(ctx, "triage", TriggerCreate{Provider: "github"})
	if err != nil || tr.Secret != "whsec_x" || tr.HookPath != "/v1/hooks/t1" {
		t.Fatalf("CreateTrigger = %+v, %v", tr, err)
	}
	list, err := c.ListTriggers(ctx, "triage")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListTriggers = %+v, %v", list, err)
	}
	if _, err := c.GetTrigger(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	off := false
	if _, err := c.UpdateTrigger(ctx, "t1", TriggerUpdate{Enabled: &off, InputTemplate: json.RawMessage("null")}); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteTrigger(ctx, "t1"); err != nil {
		t.Fatal(err)
	}

	want := []call{
		{http.MethodPost, "/v1/agents/triage/triggers", `{"provider":"github"}`},
		{http.MethodGet, "/v1/agents/triage/triggers", ""},
		{http.MethodGet, "/v1/triggers/t1", ""},
		{http.MethodPatch, "/v1/triggers/t1", `{"enabled":false,"inputTemplate":null}`},
		{http.MethodDelete, "/v1/triggers/t1", ""},
	}
	if len(got) != len(want) {
		t.Fatalf("calls = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("call %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestListEvalSuites_FiltersAndReturns(t *testing.T) {
	cases := []struct {
		name      string
		agentName string
		wantQuery string
	}{
		{"no filter", "", ""},
		{"with agent", "my-agent", "agentName=my-agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/eval-suites" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				if tc.wantQuery != "" && r.URL.RawQuery != tc.wantQuery {
					t.Errorf("expected query %q, got %q", tc.wantQuery, r.URL.RawQuery)
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode([]EvalSuite{{ID: "s1", AgentName: "my-agent", Name: "suite"}})
			}))
			defer srv.Close()

			c := New(WithBaseURL(srv.URL))
			suites, err := c.ListEvalSuites(context.Background(), tc.agentName)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(suites) != 1 || suites[0].ID != "s1" {
				t.Fatalf("unexpected suites: %+v", suites)
			}
		})
	}
}

func TestVMLifecycle(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.Method + " " + r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		switch {
		case strings.HasSuffix(r.URL.Path, "/pause"):
			w.Write([]byte(`{"vmId":"vm-1","snapshotId":"snap-1","state":"paused"}`))
		case strings.HasSuffix(r.URL.Path, "/resume"):
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error":"conflict"}`))
		case strings.HasSuffix(r.URL.Path, "/fork"):
			w.Write([]byte(`{"sourceVmId":"vm-1","snapshotId":"snap-2","forks":[{"vmId":"vm-a","state":"running"},{"vmId":"vm-b","state":"failed","error":"boot"}]}`))
		}
	}))
	defer srv.Close()
	c := New(WithBaseURL(srv.URL))
	ctx := context.Background()

	p, err := c.PauseVM(ctx, "vm-1")
	if err != nil || gotPath != "POST /v1/runtime/vms/vm-1/pause" || p.SnapshotID != "snap-1" || p.State != "paused" {
		t.Fatalf("PauseVM = %+v, %v (%s)", p, err, gotPath)
	}

	_, err = c.ResumeVM(ctx, "vm-1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || gotPath != "POST /v1/runtime/vms/vm-1/resume" {
		t.Fatalf("ResumeVM err = %v (%s), want 409 APIError", err, gotPath)
	}

	f, err := c.ForkVM(ctx, "vm-1", 2)
	if err != nil || gotPath != "POST /v1/runtime/vms/vm-1/fork" || gotBody != `{"count":2}` {
		t.Fatalf("ForkVM = %v (%s %s)", err, gotPath, gotBody)
	}
	if f.SnapshotID != "snap-2" || len(f.Forks) != 2 || f.Forks[1].Error != "boot" {
		t.Fatalf("ForkVM result = %+v", f)
	}
}

func TestVMFiles(t *testing.T) {
	var gotMethod, gotPath, gotQuery, gotBody, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotQuery, gotCT = r.Method, r.URL.Path, r.URL.Query().Get("path"), r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		switch {
		case r.URL.Path == "/v1/runtime/vms/vm-1/files":
			w.Write([]byte(`{"path":".","entries":[{"name":"a.txt","type":"file","size":2}],"truncated":false}`))
		case r.Method == http.MethodGet && gotQuery == "missing":
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"no such file"}`))
		case r.Method == http.MethodGet:
			w.Header().Set("X-Pal-Truncated", "true")
			w.Write([]byte("héllo"))
		default:
			w.Write([]byte(`{"path":"a b.txt","bytesWritten":2}`))
		}
	}))
	defer srv.Close()
	c := New(WithBaseURL(srv.URL))
	ctx := context.Background()

	l, err := c.ListFiles(ctx, "vm-1", "")
	if err != nil || gotPath != "/v1/runtime/vms/vm-1/files" || len(l.Entries) != 1 || l.Entries[0].Name != "a.txt" {
		t.Fatalf("ListFiles = %+v, %v (%s)", l, err, gotPath)
	}

	f, err := c.ReadFile(ctx, "vm-1", "dir/a b.txt")
	if err != nil || gotPath != "/v1/runtime/vms/vm-1/files/content" || gotQuery != "dir/a b.txt" || f.Content != "héllo" || !f.Truncated {
		t.Fatalf("ReadFile = %+v, %v (%s ?path=%s)", f, err, gotPath, gotQuery)
	}

	_, err = c.ReadFile(ctx, "vm-1", "missing")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("ReadFile missing err = %v, want 404 APIError", err)
	}

	n, err := c.WriteFile(ctx, "vm-1", "a b.txt", []byte("hi"))
	if err != nil || n != 2 || gotMethod != http.MethodPut || gotBody != "hi" || gotCT != "text/plain; charset=utf-8" || gotQuery != "a b.txt" {
		t.Fatalf("WriteFile = %d, %v (%s %q %q)", n, err, gotMethod, gotBody, gotCT)
	}
}

// ADR 0026: ScheduleVM sends egressRules[].inject in the control-plane's
// REST shape {header, secretRef, valuePrefix}.
func TestScheduleVM_SendsEgressInject(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/schedule" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"vmId":"vm-1"}`))
	}))
	defer srv.Close()

	c := New(WithBaseURL(srv.URL))
	out, err := c.ScheduleVM(context.Background(), VMScheduleSpec{
		ImageDigest: "sha256:abc",
		EgressRules: []EgressRule{{
			Pattern: "api.openai.com",
			Inject:  []CredentialInjection{{Header: "Authorization", SecretRef: "pal.secret/llm/openai", ValuePrefix: "Bearer "}},
		}},
		RunID: "r-1",
	})
	if err != nil || out.VMID != "vm-1" {
		t.Fatalf("ScheduleVM: %v %v", out, err)
	}
	inj := got["egressRules"].([]any)[0].(map[string]any)["inject"].([]any)[0].(map[string]any)
	if inj["header"] != "Authorization" || inj["secretRef"] != "pal.secret/llm/openai" || inj["valuePrefix"] != "Bearer " {
		t.Fatalf("inject wire shape wrong: %v", inj)
	}
	if got["runId"] != "r-1" || got["imageDigest"] != "sha256:abc" {
		t.Fatalf("spec fields lost: %v", got)
	}
}

// ReadFile honours X-Pal-Truncated.
func TestReadFile_TruncatedHeaderNames(t *testing.T) {
	for header, want := range map[string]bool{"X-Pal-Truncated": true, "X-Other": false} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set(header, "true")
			w.Write([]byte("x"))
		}))
		f, err := New(WithBaseURL(srv.URL)).ReadFile(context.Background(), "vm-1", "a")
		srv.Close()
		if err != nil || f.Truncated != want {
			t.Errorf("%s: ReadFile = %+v, %v; want Truncated=%v", header, f, err, want)
		}
	}
}

func TestRunEvalSuite(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		wantErr    bool
		wantStatus int
		wantNil    bool
		regressed  bool
	}{
		{"ok", 200, `{"id":"r1","passed":true,"score":1,"casesTotal":1,"casesPassed":1,"caseResults":[{"name":"a","passed":true,"score":1,"passRate":1,"assertions":[{"kind":"judge","passed":true,"score":1}]}]}`, false, 0, false, false},
		{"regression 422 returns parsed result and error", 422, `{"id":"r2","passed":false,"score":0.4,"regressed":true,"regressedCases":["a"],"caseResults":[]}`, true, 422, false, true},
		{"422 unparseable body", 422, `nope`, true, 422, true, false},
		{"402 budget", 402, `{"error":"budget exceeded","code":"budget_exceeded"}`, true, 402, true, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath string
			var gotBody RunEvalSuiteRequest
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			res, err := New(WithBaseURL(srv.URL)).RunEvalSuite(context.Background(), "s1", RunEvalSuiteRequest{Branch: "main", Samples: 2})
			if gotPath != "/v1/eval-suites/s1/run" || gotBody.Branch != "main" || gotBody.Samples != 2 {
				t.Fatalf("bad request: %s %+v", gotPath, gotBody)
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantStatus != 0 {
				var apiErr *APIError
				if !errors.As(err, &apiErr) || apiErr.Status != tc.wantStatus {
					t.Fatalf("want APIError %d, got %v", tc.wantStatus, err)
				}
			}
			if (res == nil) != tc.wantNil {
				t.Fatalf("res nil = %v, want %v", res == nil, tc.wantNil)
			}
			if res != nil && res.Regressed != tc.regressed {
				t.Fatalf("regressed = %v", res.Regressed)
			}
		})
	}
}

func TestGenerateAndCalibrateEval(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/eval-suites/generate":
			w.Write([]byte(`{"draft":{"agentName":"a","name":"s","cases":[{"name":"c","input":"hi","samples":2,"mocks":[{"tool":"t","result":{"x":1},"synthetic":true}]}]},"provenance":[{"case":"c","source":"run:1","grounding":"rubric-only"}],"dropped":[{"name":"d","reason":"x"}],"requiresApproval":true}`))
		case "/v1/eval-judge/calibrate":
			w.Write([]byte(`{"stats":{"n":5,"labeled":4,"agreement":0.75,"kappa":0.5,"mae":0.1},"pairs":[{"runId":"r","humanScore":5,"judgeScore":0.9,"judgePassed":true}],"verdict":"v","rubric":"r","costUsd":0.01}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(WithBaseURL(srv.URL))
	g, err := c.GenerateEvalSuite(context.Background(), GenerateEvalSuiteRequest{AgentName: "a", MaxCases: 3})
	if err != nil || !g.RequiresApproval || g.Draft.Cases[0].Samples != 2 || !g.Draft.Cases[0].Mocks[0].Synthetic || len(g.Dropped) != 1 {
		t.Fatalf("generate: %+v %v", g, err)
	}
	cal, err := c.CalibrateEvalJudge(context.Background(), CalibrateEvalJudgeRequest{AgentName: "a"})
	if err != nil || cal.Stats.Kappa != 0.5 || cal.Pairs[0].HumanScore != 5 {
		t.Fatalf("calibrate: %+v %v", cal, err)
	}
}
