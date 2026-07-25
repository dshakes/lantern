package cli

// runtime_run_stub_test.go — regression test for the silent-no-op bug.
//
// When the control-plane runs without LANTERN_SCHEDULER_GRPC_ADDR it falls
// back to stubSchedulerClient, which SYNTHESIZES a vm_id and spawns nothing.
// `lantern run` used to print "scheduled vm_id=..." and exit 0 in that state,
// so a misconfigured stack was indistinguishable from a working one. The
// control-plane now returns {"stub":true,...}; the CLI must fail loudly.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSpec drops a minimal runtime-shaped agent.yaml into a temp dir.
func writeSpec(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.yaml")
	body := "apiVersion: lantern.dev/v1\nkind: AgentSpec\nspec:\n  image_digest: demo:latest\n  isolation: trusted\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write spec: %v", err)
	}
	return path
}

// runWithScheduleResponse points the CLI at a fake control-plane that returns
// the given /v1/runtime/schedule body, then runs `lantern run <spec>`.
func runWithScheduleResponse(t *testing.T, body string) (string, string, error) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/runtime/schedule", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(body))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	withAPIURL(t, srv.URL)

	cmd := newRunCommand()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs([]string{writeSpec(t)})
	err := cmd.Execute()
	return out.String(), errOut.String(), err
}

func TestRun_StubScheduleIsAnError(t *testing.T) {
	stdout, stderr, err := runWithScheduleResponse(t,
		`{"vmId":"vm-synthetic","node":"node-stub","az":"az-stub","stub":true,"warning":"no scheduler wired"}`)

	if err == nil {
		t.Fatal("stubbed schedule must be an error — silent success is the bug this guards")
	}
	if strings.Contains(stdout, "scheduled vm_id=") {
		t.Fatalf("must not report success on a stub schedule; stdout was:\n%s", stdout)
	}
	if !strings.Contains(stderr, "NOT SCHEDULED") {
		t.Fatalf("stderr must explain nothing was spawned; got:\n%s", stderr)
	}
	if !strings.Contains(stderr, "LANTERN_SCHEDULER_GRPC_ADDR") {
		t.Fatalf("stderr must name the missing env var; got:\n%s", stderr)
	}
}

func TestRun_RealScheduleStillSucceeds(t *testing.T) {
	stdout, _, err := runWithScheduleResponse(t,
		`{"vmId":"vm-real","node":"local-dev","az":"dev"}`)

	if err != nil {
		t.Fatalf("real schedule must succeed: %v", err)
	}
	if !strings.Contains(stdout, "scheduled vm_id=vm-real") {
		t.Fatalf("want success line, got:\n%s", stdout)
	}
}
