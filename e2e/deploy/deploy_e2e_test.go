//go:build e2e

// Package deploy_e2e drives the real `pal deploy` binary against a live
// control plane (PAL_E2E_API_URL). No LLM is involved: deploy only
// upserts the agent and POSTs /v1/agents/{name}/deploy, so there is no spend.
//
// Stack down + E2E_ALLOW_SKIP unset -> fail; E2E_ALLOW_SKIP=1 -> skip.
package deploy_e2e

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dshakes/pal/e2e/internal/e2ekit"
)

const agentName = "e2e-deploy-w2d"

func TestDeployEndToEnd(t *testing.T) {
	base := e2ekit.DefaultBase()
	c := &http.Client{Timeout: 10 * time.Second}

	resp, err := c.Get(base + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		msg := "PAL stack not reachable at " + base
		if e2ekit.EnvOr("E2E_ALLOW_SKIP", "") == "1" {
			t.Skip(msg)
		}
		t.Fatalf("%s — set E2E_ALLOW_SKIP=1 to skip instead of failing", msg)
	}
	resp.Body.Close()

	creds, _ := json.Marshal(map[string]string{"email": e2ekit.DefaultEmail(), "password": e2ekit.DefaultPassword()})
	lr, err := c.Post(base+"/auth/login", "application/json", bytes.NewReader(creds))
	if err != nil {
		t.Fatal(err)
	}
	var login struct{ Token string }
	_ = json.NewDecoder(lr.Body).Decode(&login)
	lr.Body.Close()
	if lr.StatusCode != 200 || login.Token == "" {
		t.Fatalf("login failed: HTTP %d", lr.StatusCode)
	}

	api := func(method, path string) (int, map[string]any) {
		req, _ := http.NewRequest(method, base+path, nil)
		req.Header.Set("Authorization", "Bearer "+login.Token)
		r, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		return r.StatusCode, m
	}
	t.Cleanup(func() { api("DELETE", "/v1/agents/"+agentName) })
	api("DELETE", "/v1/agents/"+agentName)

	bin := filepath.Join(t.TempDir(), "pal")
	build := exec.Command("go", "build", "-o", bin, "./cmd/pal")
	build.Dir = "../../packages/cli"
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build cli: %v\n%s", err, out)
	}

	work := t.TempDir()
	manifest := "name: " + agentName + "\ndescription: deploy e2e\nmodel: auto\nsystem_prompt: v1\n"
	deploy := func(args ...string) (string, int) {
		if err := os.WriteFile(filepath.Join(work, "agent.yaml"), []byte(manifest), 0o600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bin, append([]string{"--api-url", base, "--api-key", login.Token, "deploy"}, args...)...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "HOME="+work)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		code := 0
		if err := cmd.Run(); err != nil {
			ee, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatal(err)
			}
			code = ee.ExitCode()
		}
		t.Logf("deploy %v -> exit %d stderr=%s", args, code, strings.TrimSpace(stderr.String()))
		return stdout.String(), code
	}

	// First deploy creates, second updates; both return a live deployment.
	for i, want := range []string{"created", "updated"} {
		if i == 1 {
			manifest = strings.Replace(manifest, "v1", "v2", 1)
		}
		out, code := deploy("--json")
		if code != 0 {
			t.Fatalf("deploy #%d exit %d", i+1, code)
		}
		var got map[string]any
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("deploy #%d stdout not JSON: %q", i+1, out)
		}
		if got["status"] != "live" || got["agent"] != want || got["id"] == "" || got["agentName"] != agentName {
			t.Fatalf("deploy #%d unexpected result: %v", i+1, got)
		}
	}

	st, ag := api("GET", "/v1/agents/"+agentName)
	if st != 200 {
		t.Fatalf("GET agent: HTTP %d", st)
	}
	t.Logf("agent after deploy: %v", ag)
	st, dep := api("GET", "/v1/agents/"+agentName+"/deploy")
	if st != 200 || dep["status"] != "live" {
		t.Fatalf("GET deploy: HTTP %d %v", st, dep)
	}

	// Bad credentials map to the auth exit code (3).
	cmd := exec.Command(bin, "--api-url", base, "--api-key", "bogus", "deploy")
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "HOME="+work)
	err = cmd.Run()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 3 {
		t.Fatalf("bad token: want exit 3, got %v", err)
	}
}
