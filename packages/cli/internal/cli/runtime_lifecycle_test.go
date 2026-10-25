package cli

// runtime_lifecycle_test.go — `lantern vm pause|resume|fork` against a mock
// control-plane mirroring the real REST shapes.

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVmLifecycleCommands(t *testing.T) {
	var gotBody string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/runtime/vms/{id}/pause", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"vmId":"` + r.PathValue("id") + `","snapshotId":"snap-1","state":"paused"}`))
	})
	mux.HandleFunc("POST /v1/runtime/vms/{id}/resume", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "vm-busy" {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"conflict","reason":"vm is RUNNING"}`))
			return
		}
		_, _ = w.Write([]byte(`{"vmId":"vm-1","snapshotId":"snap-1","state":"running"}`))
	})
	mux.HandleFunc("POST /v1/runtime/vms/{id}/fork", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		if strings.Contains(gotBody, `"count":2`) {
			_, _ = w.Write([]byte(`{"sourceVmId":"vm-1","snapshotId":"snap-2","forks":[{"vmId":"vm-a","state":"running"},{"vmId":"vm-b","state":"failed","error":"boot failed"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"sourceVmId":"vm-1","snapshotId":"snap-2","forks":[{"vmId":"vm-a","state":"running"}]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	tests := []struct {
		name     string
		args     []string
		wantErr  string
		wantOut  []string
		wantBody string
	}{
		{"pause", []string{"pause", "vm-1"}, "", []string{"vm-1", "paused", "snap-1"}, ""},
		{"resume", []string{"resume", "vm-1"}, "", []string{"vm-1", "running"}, ""},
		{"resume wrong state surfaces 409", []string{"resume", "vm-busy"}, "409", nil, ""},
		{"fork default count", []string{"fork", "vm-1"}, "", []string{"snap-2", "vm-a"}, `{"count":1}`},
		{"fork partial failure exits non-zero", []string{"fork", "vm-1", "--count", "2"}, "1 of 2 forks failed", []string{"vm-b", "boot failed"}, `{"count":2}`},
		{"fork count out of range", []string{"fork", "vm-1", "--count", "11"}, "between 1 and 10", nil, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotBody = ""
			cmd := newVmCommand()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
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
			if gotBody != tc.wantBody {
				t.Errorf("request body = %q, want %q", gotBody, tc.wantBody)
			}
		})
	}
}

func TestServiceTokenCreds(t *testing.T) {
	md, _ := serviceTokenCreds("s3cret").GetRequestMetadata(context.Background())
	if md["x-lantern-service-token"] != "s3cret" {
		t.Fatalf("metadata = %v", md)
	}
}
