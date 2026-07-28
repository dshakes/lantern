package handlers

// End-to-end validation of the control-plane → scheduler → runtime-manager
// exec path against a LIVE runtime stack. This is the test that catches what
// mocks cannot: that `grpcSchedulerClient.Exec` actually opens the bidi
// stream, sends a well-formed first frame, and reassembles the response
// frames into (stdout, stderr, exit_code).
//
// Opt-in — it needs real services, so it is skipped unless you set:
//
//	LANTERN_RUNTIME_E2E=1
//	LANTERN_SCHEDULER_GRPC_ADDR=localhost:50055   (runtime-scheduler)
//	LANTERN_DEFAULT_MANAGER_ADDR=localhost:50054  (runtime-manager)
//
// Locally that means a runtime-manager on RUNTIME_BACKEND=docker plus a
// runtime-scheduler; see docs/architecture/04b-microvm-productionization.md.
// Firecracker is NOT required — the manager's route_exec sends non-Firecracker
// VMs through the backend exec path (docker exec), which is what this asserts.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"
)

// e2eImage is a small public image with a shell; the container is kept alive
// with `sleep` so there is something to exec into.
const e2eImage = "python:3.11-slim"

func runtimeE2EOrSkip(t *testing.T) (schedAddr string) {
	t.Helper()
	if os.Getenv("LANTERN_RUNTIME_E2E") != "1" {
		t.Skip("LANTERN_RUNTIME_E2E != 1 — skipping live runtime exec e2e")
	}
	schedAddr = os.Getenv("LANTERN_SCHEDULER_GRPC_ADDR")
	if schedAddr == "" {
		t.Skip("LANTERN_SCHEDULER_GRPC_ADDR unset — skipping live runtime exec e2e")
	}
	if os.Getenv("LANTERN_DEFAULT_MANAGER_ADDR") == "" {
		t.Skip("LANTERN_DEFAULT_MANAGER_ADDR unset — Exec dials the manager directly")
	}
	return schedAddr
}

// scheduleE2EVM spawns a long-lived workload and returns its wire vm_id,
// registering termination for cleanup.
func scheduleE2EVM(ctx context.Context, t *testing.T, c *grpcSchedulerClient, tenantID string) string {
	t.Helper()

	vmID, node, _, err := c.Schedule(ctx, map[string]any{
		"tenant_id":    tenantID,
		"image_digest": e2eImage,
		"isolation":    "docker",
		// Without a long-running command the container exits immediately and
		// the manager's reaper deregisters it before we can exec.
		//
		// []any, NOT []string: agentSpecFromMap reads spec["command"].([]any)
		// because in production this map is always JSON-decoded. A []string
		// silently fails that assertion and the command is dropped.
		"command": []any{"sleep", "300"},
	})
	if err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	if vmID == "" {
		t.Fatal("Schedule returned an empty vm_id")
	}
	if strings.Contains(vmID, "stub") || node == "node-stub" {
		t.Fatalf("got the STUB scheduler (vm=%q node=%q) — this test must run against a real scheduler", vmID, node)
	}
	t.Logf("scheduled vm=%s node=%s", vmID, node)

	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := c.Terminate(withTenant(cctx, tenantID), vmID, "e2e test cleanup"); err != nil {
			t.Logf("cleanup: terminate %s: %v", vmID, err)
		}
	})

	// Spawn is dispatched asynchronously; give the workload a moment to be
	// registered and running before exec'ing into it.
	time.Sleep(3 * time.Second)
	return vmID
}

func newE2EClient(t *testing.T, schedAddr string) *grpcSchedulerClient {
	t.Helper()
	c, err := NewGRPCSchedulerClient(schedAddr, os.Getenv("LANTERN_GRPC_SERVICE_TOKEN"), zap.NewNop())
	if err != nil {
		t.Fatalf("NewGRPCSchedulerClient: %v", err)
	}
	return c
}

// TestRuntimeExecE2E_RealVM is the regression guard for the bug this replaced:
// Exec used to return a canned "not yet wired through proto stub" string with
// exit code 0 — a silent fake success.
func TestRuntimeExecE2E_RealVM(t *testing.T) {
	schedAddr := runtimeE2EOrSkip(t)
	const tenantID = "00000000-0000-0000-0000-000000000001"

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	tctx := withTenant(ctx, tenantID)

	c := newE2EClient(t, schedAddr)
	vmID := scheduleE2EVM(tctx, t, c, tenantID)

	t.Run("stdout is real command output", func(t *testing.T) {
		stdout, stderr, exit, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "echo lantern-e2e-marker"})
		if err != nil {
			t.Fatalf("Exec: %v (stderr=%q)", err, stderr)
		}
		if exit != 0 {
			t.Errorf("exit = %d, want 0 (stderr=%q)", exit, stderr)
		}
		if !strings.Contains(stdout, "lantern-e2e-marker") {
			t.Errorf("stdout = %q, want it to contain the echoed marker", stdout)
		}
		// The old stub answered every exec with this, and claimed success.
		if strings.Contains(stderr, "not yet wired") {
			t.Errorf("exec is still returning the proto-stub placeholder: %q", stderr)
		}
	})

	t.Run("command really runs inside the VM", func(t *testing.T) {
		// Proves we reached the workload image, not the host: this python
		// lives in the container.
		stdout, stderr, exit, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "python3 -c 'print(6*7)'"})
		if err != nil {
			t.Fatalf("Exec: %v (stderr=%q)", err, stderr)
		}
		if exit != 0 {
			t.Errorf("exit = %d, want 0 (stderr=%q)", exit, stderr)
		}
		if !strings.Contains(stdout, "42") {
			t.Errorf("stdout = %q, want it to contain 42", stdout)
		}
	})

	t.Run("nonzero exit code is propagated", func(t *testing.T) {
		// The stub always returned 0; a real failure must surface as nonzero
		// or callers cannot tell success from failure.
		_, stderr, exit, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "exit 7"})
		if err != nil {
			t.Fatalf("Exec: %v (stderr=%q)", err, stderr)
		}
		if exit != 7 {
			t.Errorf("exit = %d, want 7", exit)
		}
	})

	t.Run("stderr is captured separately", func(t *testing.T) {
		stdout, stderr, _, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "echo to-err >&2"})
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
		if !strings.Contains(stderr, "to-err") {
			t.Errorf("stderr = %q, want it to contain 'to-err'", stderr)
		}
		if strings.Contains(stdout, "to-err") {
			t.Errorf("stderr leaked into stdout: %q", stdout)
		}
	})

	t.Run("filesystem writes persist across execs", func(t *testing.T) {
		// This is the property the deepagents sandbox backend depends on:
		// write in one exec, read it back in the next.
		if _, stderr, exit, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "echo persisted > /tmp/lantern-e2e.txt"}); err != nil || exit != 0 {
			t.Fatalf("write exec: err=%v exit=%d stderr=%q", err, exit, stderr)
		}
		stdout, stderr, exit, err := c.Exec(tctx, vmID, "/bin/sh", []string{"-c", "cat /tmp/lantern-e2e.txt"})
		if err != nil || exit != 0 {
			t.Fatalf("read exec: err=%v exit=%d stderr=%q", err, exit, stderr)
		}
		if !strings.Contains(stdout, "persisted") {
			t.Errorf("stdout = %q, want the previously written content", stdout)
		}
	})
}

// TestRuntimeExecE2E_UnknownVM asserts a bogus vm_id is reported as an error
// rather than a fabricated success.
func TestRuntimeExecE2E_UnknownVM(t *testing.T) {
	schedAddr := runtimeE2EOrSkip(t)
	const tenantID = "00000000-0000-0000-0000-000000000001"

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	tctx := withTenant(ctx, tenantID)

	c := newE2EClient(t, schedAddr)

	stdout, _, exit, err := c.Exec(tctx, "vm-does-not-exist", "/bin/sh", []string{"-c", "echo hi"})
	if err == nil && exit == 0 && strings.Contains(stdout, "hi") {
		t.Fatal("exec against an unknown vm reported success — it must fail")
	}
}
