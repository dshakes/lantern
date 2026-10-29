package cli

// doctor_runtime.go — `lantern doctor` "Sandbox runtime" section.
//
// Soft checks (they never fail doctor): the sandbox is optional for a first
// agent, but when it is missing the user should learn exactly which piece is
// absent and the one command that adds it.

import (
	"net"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/dshakes/lantern/packages/cli/internal"
)

// runtimeEnv is the injectable environment for the runtime checks.
type runtimeEnv struct {
	restURL       string
	token         string
	goos          string
	kvmPath       string
	schedulerAddr string
	managerAddr   string
	lookPath      func(string) (string, error)
}

func defaultRuntimeEnv(restURL, token string) runtimeEnv {
	return runtimeEnv{
		restURL:       restURL,
		token:         token,
		goos:          runtime.GOOS,
		kvmPath:       "/dev/kvm",
		schedulerAddr: firstNonEmptyStr(os.Getenv("PAL_SCHEDULER_GRPC_ADDR"), "localhost:50055"),
		managerAddr:   firstNonEmptyStr(os.Getenv("PAL_DEFAULT_MANAGER_ADDR"), "localhost:50054"),
		lookPath:      exec.LookPath,
	}
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func dialOK(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// checkRuntime reports what a sandbox run needs: the API wired to a real
// scheduler, the scheduler and runtime-manager reachable, and KVM for
// Firecracker isolation.
func checkRuntime(env runtimeEnv) []checkResult {
	var out []checkResult

	// 1. Is the API wired to a real scheduler, or the synthesizing stub?
	wired := checkResult{label: "API → runtime scheduler"}
	if env.token == "" {
		wired.detail = "skipped — no auth token"
	} else {
		client := internal.NewRESTClient(env.restURL, "", env.token)
		var cluster map[string]any
		req, err := client.NewGETRequest("/v1/runtime/cluster")
		if err == nil {
			err = client.DoJSON(req, &cluster)
		}
		switch {
		case err != nil:
			wired.detail = "GET /v1/runtime/cluster: " + err.Error()
		case cluster["stub"] == true:
			wired.detail = "stub scheduler (sandbox runs spawn nothing) — start the API with LANTERN_SCHEDULER_GRPC_ADDR=" + env.schedulerAddr
		default:
			wired.passed = true
			wired.detail = "real scheduler"
		}
	}
	out = append(out, wired)

	// 2–3. Reachability, with the command that starts each piece.
	sched := checkResult{label: "runtime-scheduler (" + env.schedulerAddr + ")", passed: dialOK(env.schedulerAddr)}
	if !sched.passed {
		sched.detail = "unreachable — run: make run-scheduler"
	}
	mgr := checkResult{label: "runtime-manager (" + env.managerAddr + ")", passed: dialOK(env.managerAddr)}
	if !mgr.passed {
		mgr.detail = "unreachable — run: make run-runtime-manager (and set LANTERN_DEFAULT_MANAGER_ADDR on the scheduler)"
	}
	out = append(out, sched, mgr)

	// 4. Isolation hint: Firecracker needs KVM.
	out = append(out, checkKVM(env))
	return out
}

func checkKVM(env runtimeEnv) checkResult {
	r := checkResult{label: "microVM isolation (KVM / Firecracker)"}
	if env.goos != "linux" {
		r.detail = "no KVM on " + env.goos + " — the runtime-manager uses its Docker backend locally (trusted/standard isolation); untrusted workloads need a Linux host with /dev/kvm"
		return r
	}
	f, err := os.OpenFile(env.kvmPath, os.O_RDWR, 0)
	if err != nil {
		if os.IsNotExist(err) {
			r.detail = env.kvmPath + " missing — enable virtualization (nested virt on cloud VMs, e.g. GCP --enable-nested-virtualization) or use a bare-metal host"
		} else {
			r.detail = env.kvmPath + " not accessible (" + err.Error() + ") — add your user to the kvm group: sudo usermod -aG kvm $USER"
		}
		return r
	}
	_ = f.Close()
	if _, err := env.lookPath("firecracker"); err != nil {
		r.detail = "KVM ok, but the firecracker binary is not on PATH — install it from github.com/firecracker-microvm/firecracker/releases"
		return r
	}
	r.passed = true
	r.detail = "KVM ok, firecracker on PATH"
	return r
}
