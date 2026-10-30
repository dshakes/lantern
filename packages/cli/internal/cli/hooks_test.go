package cli

// hooks_test.go — `pal hooks …` against a mock control-plane mirroring
// the real /v1/agents/{name}/triggers and /v1/triggers/{id} shapes.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHooksCommands(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	const tr = `{"id":"t1","agentName":"triage","provider":"github","enabled":true,"hookPath":"/v1/hooks/t1","createdAt":"now"}`
	mux := http.NewServeMux()
	record := func(r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotMethod, gotPath, gotBody = r.Method, r.URL.Path, string(b)
	}
	mux.HandleFunc("POST /v1/agents/{name}/triggers", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(strings.TrimSuffix(tr, "}") + `,"secret":"whsec_abc"}`))
	})
	mux.HandleFunc("GET /v1/agents/{name}/triggers", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		_, _ = w.Write([]byte("[" + tr + "]"))
	})
	mux.HandleFunc("GET /v1/triggers/{id}", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		if r.PathValue("id") == "missing" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"trigger not found"}`))
			return
		}
		_, _ = w.Write([]byte(tr))
	})
	mux.HandleFunc("PATCH /v1/triggers/{id}", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		_, _ = w.Write([]byte(strings.Replace(tr, `"enabled":true`, `"enabled":false`, 1)))
	})
	mux.HandleFunc("DELETE /v1/triggers/{id}", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	tests := []struct {
		name               string
		args               []string
		stdin              string
		wantErr            string
		wantOut            []string
		wantMethod, wantPa string
		wantBody           string
	}{
		{"create prints url and one-time secret", []string{"create", "triage", "--provider", "github"}, "", "",
			[]string{"/v1/hooks/t1", "whsec_abc", "shown once"}, "POST", "/v1/agents/triage/triggers", `{"provider":"github"}`},
		{"create with template and stdin secret", []string{"create", "triage", "--provider", "sentry", "--template", `{"x":"{{event}}"}`, "--secret-stdin"},
			"sentry-client-secret-123\n", "", nil, "POST", "/v1/agents/triage/triggers",
			`{"inputTemplate":{"x":"{{event}}"},"provider":"sentry","secret":"sentry-client-secret-123"}`},
		{"create rejects invalid template locally", []string{"create", "triage", "--template", "{nope"}, "", "not valid JSON", nil, "", "", ""},
		{"list", []string{"list", "triage"}, "", "", []string{"t1", "github", "enabled"}, "GET", "/v1/agents/triage/triggers", ""},
		{"get 404 surfaces", []string{"get", "missing"}, "", "404", nil, "GET", "/v1/triggers/missing", ""},
		{"disable", []string{"update", "t1", "--disable"}, "", "", []string{"disabled"}, "PATCH", "/v1/triggers/t1", `{"enabled":false}`},
		{"clear template", []string{"update", "t1", "--clear-template"}, "", "", nil, "PATCH", "/v1/triggers/t1", `{"inputTemplate":null}`},
		{"update needs a flag", []string{"update", "t1"}, "", "nothing to update", nil, "", "", ""},
		{"enable+disable conflict", []string{"update", "t1", "--enable", "--disable"}, "", "mutually exclusive", nil, "", "", ""},
		{"delete", []string{"delete", "t1"}, "", "", []string{"deleted"}, "DELETE", "/v1/triggers/t1", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotMethod, gotPath, gotBody = "", "", ""
			cmd := newHooksCommand()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetIn(strings.NewReader(tc.stdin))
			cmd.SetArgs(tc.args)
			err := cmd.ExecuteContext(context.Background())
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
			if gotMethod != tc.wantMethod || gotPath != tc.wantPa || gotBody != tc.wantBody {
				t.Errorf("request = %s %s %s, want %s %s %s", gotMethod, gotPath, gotBody, tc.wantMethod, tc.wantPa, tc.wantBody)
			}
		})
	}
}
