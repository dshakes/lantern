package cli

// runtime_list_test.go — regression tests for `lantern vm list`.
//
// The control-plane REST endpoint /v1/runtime/vms returns a BARE JSON array
// with camelCase fields. `vm list` previously read res["items"] via apiDo
// (which unmarshals into a map, silently yielding empty for an array body)
// and snake_case field names, so it always printed "(no VMs)" even when VMs
// existed. These tests lock in the array-aware parse + correct field names.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withAPIURL(t *testing.T, url string) {
	t.Helper()
	prev := flags.apiURL
	flags.apiURL = url
	t.Cleanup(func() { flags.apiURL = prev })
}

// TestAPIGetArray_ParsesBareArray proves apiGetArray reads a bare JSON array,
// where apiDo returns an empty map for the same body.
func TestAPIGetArray_ParsesBareArray(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runtime/vms", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"vmId":"vm-a"},{"vmId":"vm-b"}]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	items, err := apiGetArray("/v1/runtime/vms")
	if err != nil {
		t.Fatalf("apiGetArray: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}

	// apiDo (map-typed) silently drops an array body — the original trap.
	m, err := apiDo("GET", "/v1/runtime/vms", nil)
	if err != nil {
		t.Fatalf("apiDo: %v", err)
	}
	if _, ok := m["items"].([]any); ok {
		t.Error("apiDo unexpectedly produced items from a bare array")
	}
}

// TestVmList_RendersCamelCaseArray runs the command end-to-end against a mock
// that mirrors the real server shape and asserts a row is rendered.
func TestVmList_RendersCamelCaseArray(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runtime/vms", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"vmId":"vm-61be8a2b","state":"running","isolationClass":"trusted","node":"local-dev","createdAt":"2026-07-24T00:00:00Z"}]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	cmd := newVmListCommand()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("vm list: %v", err)
	}

	got := out.String()
	if strings.Contains(got, "(no VMs)") {
		t.Fatalf("vm list printed empty state for a non-empty array:\n%s", got)
	}
	for _, want := range []string{"vm-61be8a2b", "running", "trusted", "local-dev"} {
		if !strings.Contains(got, want) {
			t.Errorf("vm list output missing %q:\n%s", want, got)
		}
	}
}
