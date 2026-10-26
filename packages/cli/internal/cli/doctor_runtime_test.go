package cli

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func clusterServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/cluster" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func listener(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l.Addr().String()
}

func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a := l.Addr().String()
	_ = l.Close()
	return a
}

func TestCheckRuntime_StubAndUnreachableGiveFixes(t *testing.T) {
	srv := clusterServer(t, `{"nodes":[],"stub":true}`, http.StatusOK)
	res := checkRuntime(runtimeEnv{
		restURL: srv.URL, token: "tok", goos: "darwin",
		schedulerAddr: closedAddr(t), managerAddr: closedAddr(t),
		lookPath: func(string) (string, error) { return "", errors.New("nope") },
	})
	if len(res) != 4 {
		t.Fatalf("want 4 results, got %d", len(res))
	}
	for _, r := range res {
		if r.hard {
			t.Errorf("%s: runtime checks must be soft", r.label)
		}
		if r.passed {
			t.Errorf("%s: should not pass", r.label)
		}
	}
	if !strings.Contains(res[0].detail, "LANTERN_SCHEDULER_GRPC_ADDR") {
		t.Errorf("stub detail lacks the fix: %q", res[0].detail)
	}
	if !strings.Contains(res[1].detail, "make run-scheduler") || !strings.Contains(res[2].detail, "make run-runtime-manager") {
		t.Errorf("reachability fixes missing: %q / %q", res[1].detail, res[2].detail)
	}
	if !strings.Contains(res[3].detail, "Docker backend") {
		t.Errorf("non-linux KVM hint: %q", res[3].detail)
	}
}

func TestCheckRuntime_AllGreenOnLinuxWithKVM(t *testing.T) {
	srv := clusterServer(t, `{"nodes":[{"name":"n1"}]}`, http.StatusOK)
	kvm := filepath.Join(t.TempDir(), "kvm")
	if err := os.WriteFile(kvm, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	res := checkRuntime(runtimeEnv{
		restURL: srv.URL, token: "tok", goos: "linux", kvmPath: kvm,
		schedulerAddr: listener(t), managerAddr: listener(t),
		lookPath: func(string) (string, error) { return "/usr/bin/firecracker", nil },
	})
	for _, r := range res {
		if !r.passed {
			t.Errorf("%s: expected pass, got %q", r.label, r.detail)
		}
	}
}

func TestCheckKVM_LinuxFailureHints(t *testing.T) {
	missing := checkKVM(runtimeEnv{goos: "linux", kvmPath: filepath.Join(t.TempDir(), "nope")})
	if missing.passed || !strings.Contains(missing.detail, "missing") {
		t.Errorf("missing /dev/kvm: %+v", missing)
	}
	kvm := filepath.Join(t.TempDir(), "kvm")
	_ = os.WriteFile(kvm, nil, 0o600)
	noFC := checkKVM(runtimeEnv{goos: "linux", kvmPath: kvm, lookPath: func(string) (string, error) { return "", errors.New("x") }})
	if noFC.passed || !strings.Contains(noFC.detail, "firecracker") {
		t.Errorf("no firecracker: %+v", noFC)
	}
}

func TestCheckRuntime_NoTokenAndAPIError(t *testing.T) {
	res := checkRuntime(runtimeEnv{goos: "darwin", schedulerAddr: closedAddr(t), managerAddr: closedAddr(t)})
	if !strings.Contains(res[0].detail, "no auth token") {
		t.Errorf("no token: %q", res[0].detail)
	}
	srv := clusterServer(t, `{"error":"forbidden"}`, http.StatusForbidden)
	res = checkRuntime(runtimeEnv{restURL: srv.URL, token: "t", goos: "darwin", schedulerAddr: closedAddr(t), managerAddr: closedAddr(t)})
	if res[0].passed || !strings.Contains(res[0].detail, "403") {
		t.Errorf("API error should surface: %q", res[0].detail)
	}
}
