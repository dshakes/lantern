package cli

// sandbox_mode.go — which sandbox `dev` wires the control-plane to, and why.
//
// The API falls back to a stub scheduler client when no scheduler address is
// set: it fabricates vm ids and spawns nothing. That is fine for agent logic,
// but a developer must never mistake it for a sandbox. So `dev` and `doctor`
// share one decision, made from what is actually running on this machine:
//
//	firecracker  Linux + usable /dev/kvm + firecracker, manager on :50054
//	lima         macOS, Lima VM firecracker-dev Running, manager forwarded on :52054
//	docker       a runtime-manager on :50054 without KVM — containers, not microVMs
//	stub         nothing to wire; the line says the one command that fixes it
//
// A mode is only chosen when its runtime-manager answers on TCP; a host that
// could run microVMs but has no manager up is reported as stub with the reason.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type sandboxMode string

const (
	sandboxFirecracker sandboxMode = "firecracker"
	sandboxLima        sandboxMode = "lima"
	sandboxDocker      sandboxMode = "docker"
	sandboxStub        sandboxMode = "stub"
)

const (
	// hostManagerAddr is `make run-runtime-manager` (scripts/launchd/service-env.sh).
	hostManagerAddr = "localhost:50054"
	// limaManagerAddr is `make lima-runtime`: the manager listens on :52054 in
	// the VM and Lima's default port forwarding exposes it on the Mac's
	// loopback. Not :50054, so it never collides with a host manager or with
	// `make lima-e2e`, which uses :50054 inside the VM.
	limaManagerAddr = "localhost:52054"
	// devSchedulerAddr is the runtime-scheduler gRPC port (`make run-scheduler`).
	devSchedulerAddr = "localhost:50055"
)

// sandboxProbe is the injectable view of the machine.
type sandboxProbe struct {
	goos        string
	limaVM      string
	kvmUsable   func() bool
	firecracker func() bool            // firecracker binary on PATH
	limaStatus  func(vm string) string // "Running", "Stopped", or "" (no limactl / no VM)
	reachable   func(addr string) bool // TCP connect succeeds
}

type sandboxDecision struct {
	mode        sandboxMode
	managerAddr string // "" for stub
	reason      string
}

func defaultSandboxProbe() sandboxProbe {
	return sandboxProbe{
		goos:   runtime.GOOS,
		limaVM: firstNonEmptyStr(os.Getenv("LIMA_VM"), "firecracker-dev"),
		kvmUsable: func() bool {
			f, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
			if err != nil {
				return false
			}
			_ = f.Close()
			return true
		},
		firecracker: func() bool { _, err := exec.LookPath("firecracker"); return err == nil },
		limaStatus:  limaVMStatus,
		reachable:   dialOK,
	}
}

// limaVMStatus mirrors infra/lima/lima.sh vm_status. Read-only.
func limaVMStatus(vm string) string {
	if _, err := exec.LookPath("limactl"); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "limactl", "list", "--format", "{{.Status}}", vm).Output()
	return strings.TrimSpace(string(out))
}

func detectSandbox(p sandboxProbe) sandboxDecision {
	stub := func(reason string) sandboxDecision { return sandboxDecision{mode: sandboxStub, reason: reason} }
	hostUp := p.reachable(hostManagerAddr)

	switch p.goos {
	case "linux":
		kvm := p.kvmUsable() && p.firecracker()
		switch {
		case hostUp && kvm:
			return sandboxDecision{sandboxFirecracker, hostManagerAddr, "Firecracker microVMs on this host's KVM (manager " + hostManagerAddr + ")"}
		case hostUp:
			return sandboxDecision{sandboxDocker, hostManagerAddr, "runtime-manager on " + hostManagerAddr + " but no usable /dev/kvm + firecracker — container isolation, not microVMs"}
		case kvm:
			return stub("KVM is ready but no runtime-manager on " + hostManagerAddr + "; start one with RUNTIME_BACKEND=firecracker FC_KERNEL_PATH=… FC_ROOTFS_PATH=… (infra/firecracker/build-image.sh)")
		default:
			return stub("no microVMs — /dev/kvm or the firecracker binary is unavailable on this host")
		}
	case "darwin":
		st := p.limaStatus(p.limaVM)
		if st == "Running" && p.reachable(limaManagerAddr) {
			return sandboxDecision{sandboxLima, limaManagerAddr, "Firecracker microVMs in Lima VM " + p.limaVM + " (manager " + limaManagerAddr + ")"}
		}
		if hostUp {
			return sandboxDecision{sandboxDocker, hostManagerAddr, "runtime-manager on " + hostManagerAddr + " (Docker backend) — containers, not microVMs; run `make lima-up && make lima-runtime` for Firecracker"}
		}
		switch st {
		case "Running":
			return stub("Lima VM " + p.limaVM + " is running but no runtime-manager on " + limaManagerAddr + "; run `make lima-runtime`")
		case "":
			return stub("no microVMs; run `make lima-up` for real Firecracker")
		default:
			return stub("Lima VM " + p.limaVM + " is " + strings.ToLower(st) + "; run `make lima-up && make lima-runtime` for real Firecracker")
		}
	default:
		if hostUp {
			return sandboxDecision{sandboxDocker, hostManagerAddr, "runtime-manager on " + hostManagerAddr + " — containers, not microVMs"}
		}
		return stub("no microVMs on " + p.goos + "; microVM isolation needs Linux + KVM")
	}
}

func (d sandboxDecision) line() string { return fmt.Sprintf("sandbox: %s — %s", d.mode, d.reason) }

func (d sandboxDecision) check() checkResult {
	return checkResult{label: "Sandbox mode: " + string(d.mode), passed: d.mode != sandboxStub, detail: d.reason}
}

var tagSched = procTag{"sched", "\033[94m"} // bright blue

// wireSandbox prints the sandbox line and, when a real manager is up, makes
// sure a runtime-scheduler is running and returns the env the API needs to
// use it. Stub returns nil: the API keeps its stub client.
func wireSandbox(ctx context.Context, wg *sync.WaitGroup, repoRoot string, d sandboxDecision) []string {
	fmt.Fprintln(os.Stderr, tag(tagInfra, d.line()))
	if d.mode == sandboxStub {
		return nil
	}
	if dialOK(devSchedulerAddr) {
		// ponytail: reuse whatever scheduler owns :50055 (e.g. a LaunchAgent);
		// the Lima manager self-registers with it over host.lima.internal:8085.
		fmt.Fprintln(os.Stderr, tag(tagSched, "reusing runtime-scheduler already on "+devSchedulerAddr))
	} else {
		c := makeProc(ctx, repoRoot, tagSched, "go", "run", "./cmd/scheduler")
		c.Dir = filepath.Join(repoRoot, "services", "runtime-scheduler")
		c.Env = append(os.Environ(), "PAL_DEFAULT_MANAGER_ADDR="+d.managerAddr, "LOG_LEVEL=info")
		if err := startProc(wg, c, tagSched); err != nil {
			fmt.Fprintln(os.Stderr, tag(tagSched, "could not start runtime-scheduler: "+err.Error()+" — API stays on the stub"))
			return nil
		}
	}
	return []string{"PAL_SCHEDULER_GRPC_ADDR=" + devSchedulerAddr}
}
