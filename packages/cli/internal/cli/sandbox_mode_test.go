package cli

import (
	"strings"
	"testing"
)

func probe(goos, lima string, kvm bool, up ...string) sandboxProbe {
	open := map[string]bool{}
	for _, a := range up {
		open[a] = true
	}
	return sandboxProbe{
		goos:        goos,
		limaVM:      "firecracker-dev",
		kvmUsable:   func() bool { return kvm },
		firecracker: func() bool { return kvm },
		limaStatus:  func(string) string { return lima },
		reachable:   func(a string) bool { return open[a] },
	}
}

func TestDetectSandbox(t *testing.T) {
	cases := []struct {
		name     string
		p        sandboxProbe
		mode     sandboxMode
		addr     string
		inReason string
	}{
		{"linux kvm + manager", probe("linux", "", true, hostManagerAddr), sandboxFirecracker, hostManagerAddr, "KVM"},
		{"linux manager, no kvm", probe("linux", "", false, hostManagerAddr), sandboxDocker, hostManagerAddr, "not microVMs"},
		{"linux kvm, no manager", probe("linux", "", true), sandboxStub, "", "RUNTIME_BACKEND=firecracker"},
		{"linux nothing", probe("linux", "", false), sandboxStub, "", "/dev/kvm"},
		{"mac lima running + manager", probe("darwin", "Running", false, limaManagerAddr), sandboxLima, limaManagerAddr, "Lima VM firecracker-dev"},
		{"mac lima beats docker", probe("darwin", "Running", false, limaManagerAddr, hostManagerAddr), sandboxLima, limaManagerAddr, "Lima"},
		{"mac lima running, no manager", probe("darwin", "Running", false), sandboxStub, "", "make lima-runtime"},
		{"mac lima running, no manager, docker up", probe("darwin", "Running", false, hostManagerAddr), sandboxDocker, hostManagerAddr, "Docker backend"},
		{"mac lima stopped", probe("darwin", "Stopped", false), sandboxStub, "", "make lima-up && make lima-runtime"},
		{"mac no lima", probe("darwin", "", false), sandboxStub, "", "make lima-up"},
		// A forwarded port alone is not Lima: the VM must be Running.
		{"mac stale port, lima absent", probe("darwin", "", false, limaManagerAddr), sandboxStub, "", "make lima-up"},
		{"other os", probe("windows", "", false), sandboxStub, "", "Linux + KVM"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := detectSandbox(c.p)
			if d.mode != c.mode || d.managerAddr != c.addr || !strings.Contains(d.reason, c.inReason) {
				t.Fatalf("got %+v, want mode=%s addr=%q reason~%q", d, c.mode, c.addr, c.inReason)
			}
			if got := d.check().passed; got != (c.mode != sandboxStub) {
				t.Fatalf("check().passed = %v for %s", got, c.mode)
			}
		})
	}
}

// The bare-macOS line is the one a new developer sees first; pin it verbatim.
func TestSandboxStubLine(t *testing.T) {
	got := detectSandbox(probe("darwin", "", false)).line()
	want := "sandbox: stub — no microVMs; run `make lima-up` for real Firecracker"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}
