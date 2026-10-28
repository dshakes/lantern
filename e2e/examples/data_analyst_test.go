//go:build e2e

// Package examples_e2e exercises examples/data-analyst (X5): schedule a sandbox
// VM, put a CSV in it, run pandas via exec, read JSON + a chart back, prove
// egress is denied, and have a fixture-LLM agent explain the result.
//
// Tiers (LANTERN_E2E_ANALYST_TIER):
//
//	docker       (default) runtime-manager docker backend, network none. The files
//	             API and ExecTool are Firecracker-only there (503), so the CSV goes
//	             in via exec and the files-API 503 is pinned as the known gap.
//	firecracker  KVM nightly: CSV via PUT files/content, egress deny in the audit.
//
// Preconditions: a stack with scheduler + runtime-manager (AGENT_IMAGE =
// lantern-analyst:dev for the docker tier, built from examples/data-analyst),
// cmd/llm-replay with examples/data-analyst/replay-rules.json behind
// LANTERN_LLM_BASEURL_OPENAI, and an openai provider key seeded. See the README.
// Never point this at the owner's live :8080 stack.
package examples_e2e

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

func exampleFile(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "examples", "data-analyst", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return b
}

type execOut struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

func TestDataAnalystSandbox(t *testing.T) {
	k := e2ekit.Connect(t)
	tier := e2ekit.EnvOr("LANTERN_E2E_ANALYST_TIER", "docker")
	fc := tier == "firecracker"

	spec := map[string]any{
		"imageDigest": e2ekit.EnvOr("LANTERN_E2E_ANALYST_IMAGE",
			"sha256:0000000000000000000000000000000000000000000000000000000000000005"),
		"isolation": "standard",
		"network":   "none",
		"labels":    map[string]string{"e2e": "data-analyst"},
	}
	if fc {
		spec["isolation"] = "untrusted"
		spec["network"] = "allowlist_domain"
		spec["egressRules"] = []map[string]any{{"pattern": "pypi.org", "http_methods": []string{"GET"}}}
	}

	var sched struct {
		VmID string `json:"vmId"`
		Stub bool   `json:"stub"`
	}
	st, raw := k.DoAuth(t, http.MethodPost, "/v1/runtime/schedule", spec, &sched)
	if st != http.StatusCreated || sched.VmID == "" {
		t.Fatalf("schedule: HTTP %d: %s", st, raw)
	}
	if sched.Stub {
		t.Fatal("schedule hit the stub scheduler: nothing was spawned (wire LANTERN_SCHEDULER_GRPC_ADDR)")
	}
	vm := sched.VmID
	t.Cleanup(func() { k.DoAuth(t, http.MethodDelete, "/v1/runtime/vms/"+vm+"?grace=2s", nil, nil) })

	run := func(command string, argv ...string) execOut {
		t.Helper()
		var o execOut
		st, raw := k.DoAuth(t, http.MethodPost, "/v1/runtime/vms/"+vm+"/exec",
			map[string]any{"command": command, "argv": argv}, &o)
		if st != http.StatusOK {
			t.Fatalf("exec %s: HTTP %d: %s", command, st, raw)
		}
		return o
	}

	// Wait until the sandbox accepts exec.
	deadline := time.Now().Add(90 * time.Second)
	for {
		var o execOut
		st, _ := k.DoAuth(t, http.MethodPost, "/v1/runtime/vms/"+vm+"/exec",
			map[string]any{"command": "true"}, &o)
		if st == http.StatusOK && o.ExitCode == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sandbox %s never accepted exec (last HTTP %d)", vm, st)
		}
		time.Sleep(2 * time.Second)
	}

	csv := exampleFile(t, "sales.csv")
	if fc {
		st, raw := k.DoAuth(t, http.MethodPut, "/v1/runtime/vms/"+vm+"/files/content?path=sales.csv", string(csv), nil)
		if st != http.StatusOK {
			t.Fatalf("files upload: HTTP %d: %s", st, raw)
		}
	} else {
		// Known gap, pinned: the docker backend has no harness tool registry.
		st, raw := k.DoAuth(t, http.MethodPut, "/v1/runtime/vms/"+vm+"/files/content?path=sales.csv", string(csv), nil)
		if st != http.StatusServiceUnavailable || !strings.Contains(string(raw), "docker") {
			t.Fatalf("files API on docker backend: HTTP %d %s (want 503 naming docker)", st, raw)
		}
		o := run("sh", "-c", "printf %s '"+base64.StdEncoding.EncodeToString(csv)+"' | base64 -d > /workspace/sales.csv")
		if o.ExitCode != 0 {
			t.Fatalf("exec upload: %+v", o)
		}
	}

	// Analysis ran in the sandbox: JSON out.
	o := run("python", "/opt/analyze.py", "/workspace/sales.csv")
	if o.ExitCode != 0 {
		t.Fatalf("analyze.py: %+v", o)
	}
	var res struct {
		Region string  `json:"dropped_region"`
		Delta  float64 `json:"delta"`
	}
	if err := json.Unmarshal([]byte(o.Stdout), &res); err != nil {
		t.Fatalf("analysis output is not JSON: %q (%v)", o.Stdout, err)
	}
	if res.Region != "EMEA" || res.Delta != -360 {
		t.Fatalf("analysis result = %+v, want EMEA/-360", res)
	}

	// ...and a real PNG chart.
	if c := run("sh", "-c", "head -c 4 /workspace/chart.png | od -An -c"); !strings.Contains(c.Stdout, "P   N   G") {
		t.Fatalf("chart.png is not a PNG: %+v", c)
	}

	// Egress: a non-allowlisted host must fail.
	probe := `import urllib.request,sys
try:
    urllib.request.urlopen("https://example.com", timeout=5); sys.exit(0)
except Exception as e:
    print(e); sys.exit(1)`
	if p := run("python", "-c", probe); p.ExitCode == 0 {
		t.Fatalf("egress to example.com succeeded from the sandbox: %+v", p)
	}
	var audit struct {
		Events []struct {
			Action string          `json:"action"`
			VmID   string          `json:"vmId"`
			Attrs  json.RawMessage `json:"attrs"`
		} `json:"events"`
	}
	k.DoAuth(t, http.MethodGet, "/v1/runtime/audit?limit=200", nil, &audit)
	execAudited, egressDenied := false, false
	for _, e := range audit.Events {
		if e.VmID != vm {
			continue
		}
		execAudited = execAudited || e.Action == "exec"
		egressDenied = egressDenied || (strings.Contains(e.Action, "egress") && strings.Contains(string(e.Attrs), "example.com"))
	}
	if !execAudited {
		t.Error("audit log has no exec event for the sandbox")
	}
	if fc && !egressDenied {
		t.Error("firecracker tier: no egress deny event for example.com in the audit log")
	}
	if !fc {
		t.Log("docker tier: egress denied by network=none; per-host egress audit needs the Firecracker harness (not asserted)")
	}

	// Fixture-LLM agent explains the sandbox result.
	var agentSpec map[string]any
	if err := json.Unmarshal(exampleFile(t, "spec.json"), &agentSpec); err != nil {
		t.Fatal(err)
	}
	a := k.CreateAgent(t, "e2e-analyst", agentSpec)
	out := a.Run(t, map[string]any{"input": map[string]any{
		"question": "Which region dropped?",
		"analysis": json.RawMessage(o.Stdout),
	}})
	if got, _ := json.Marshal(out["output"]); !strings.Contains(string(got), "EMEA") {
		t.Fatalf("agent answer does not name EMEA: %s", got)
	}
}
