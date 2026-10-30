//go:build e2e

package examples_e2e

// examples/eval-gated-deploy (plan §3 X8): the sample CI job's two scripts run for
// real against the fixture stack (scripts/e2e-examples.sh).
//
//	regressing candidate -> eval.sh exits 1 on HTTP 422, release.sh refuses, and the
//	                        agent is never created/deployed
//	passing candidate    -> eval.sh clean, `pal deploy --json` records a deployment,
//	                        the receipt for the gating run verifies
//	tampered receipt     -> POST /v1/runs/receipts/verify says valid:false
//
// Cases are scored by eval.sh (the server stores what is POSTed); the model is the
// fixture LLM, driven by examples/eval-gated-deploy/fixtures/llm-rules.json.

import (
	"cmp"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const (
	egdStaging = "e2e-analyst"    // eval runs here (created through e2ekit: budget + cheap model)
	egdProd    = "e2e-quickstart" // `pal deploy` creates this one; eval.sh never runs it
)

// egdScript runs one of the example's scripts and returns its exit code and output.
func egdScript(t *testing.T, env []string, script string, args ...string) (int, string) {
	t.Helper()
	cmd := exec.Command(filepath.Join("..", "..", "examples", "eval-gated-deploy", "scripts", script), args...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return 0, string(out)
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode(), string(out)
	}
	t.Fatalf("run %s: %v", script, err)
	return -1, ""
}

// egdCandidate writes <tmp>/<name>/agent.yaml: the example's manifest with the
// agent renamed to the reserved e2e name.
func egdCandidate(t *testing.T, tmp, name, rel string) string {
	t.Helper()
	dir := filepath.Join(tmp, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	y := regexp.MustCompile(`(?m)^name:.*$`).ReplaceAll(readFile(t, "eval-gated-deploy/"+rel), []byte("name: "+egdProd))
	if err := os.WriteFile(filepath.Join(dir, "agent.yaml"), y, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func egdReadJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("parse %s: %v: %s", path, err, b)
	}
	return m
}

func TestEvalGatedDeploy(t *testing.T) {
	s := connect(t)
	tmp := t.TempDir()

	// The real CLI: `pal deploy` is what the sample workflow calls.
	cli := filepath.Join(tmp, "pal")
	build := exec.Command("go", "build", "-o", cli, "./cmd/pal")
	build.Dir = filepath.Join("..", "..", "packages", "cli")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build pal CLI: %v\n%s", err, out)
	}

	s.kit.CreateAgent(t, egdStaging, map[string]any{"description": "e2e eval staging", "systemPrompt": "placeholder"})
	t.Cleanup(func() { s.kit.DoAuth(t, http.MethodDelete, "/v1/agents/"+egdProd, nil, nil) })

	branch := uniq("e2e-main") // baselines are per (agent, branch): never touch another run's
	env := []string{
		"PAL_API_URL=" + strings.TrimRight(cmp.Or(os.Getenv("PAL_E2E_API_URL"), os.Getenv("PAL_E2E_API_URL")), "/"),
		"PAL_API_KEY=" + s.token(t),
		"PAL_CLI=" + cli,
		"STAGING_AGENT=" + egdStaging,
		"EVAL_BRANCH=" + branch,
		"EVAL_RESULT=" + filepath.Join(tmp, "eval-result.json"),
		"DEPLOY_JSON=" + filepath.Join(tmp, "deploy.json"),
		"RECEIPT_JSON=" + filepath.Join(tmp, "receipt.json"),
	}
	if cmp.Or(os.Getenv("PAL_E2E_API_URL"), os.Getenv("PAL_E2E_API_URL")) == "" {
		t.Fatal("PAL_E2E_API_URL must be set (scripts/e2e-examples.sh sets it)")
	}
	deployments := func() int {
		var list []struct {
			AgentName string `json:"agentName"`
		}
		if st, raw := s.kit.DoAuth(t, http.MethodGet, "/v1/deployments", nil, &list); st != http.StatusOK {
			t.Fatalf("list deployments: HTTP %d: %s", st, raw)
		}
		n := 0
		for _, d := range list {
			if d.AgentName == egdProd {
				n++
			}
		}
		return n
	}
	agentStatus := func() int {
		st, _ := s.kit.DoAuth(t, http.MethodGet, "/v1/agents/"+egdProd, nil, nil)
		return st
	}

	base := egdCandidate(t, tmp, "main", "agent.yaml")
	regressed := egdCandidate(t, tmp, "regressed", "candidates/regressed/agent.yaml")
	improved := egdCandidate(t, tmp, "improved", "candidates/improved/agent.yaml")

	// 1. main's version sets the baseline (all three cases pass: score 1.0).
	if code, out := egdScript(t, append(env, "EVAL_PIN=1"), "eval.sh", base); code != 0 {
		t.Fatalf("baseline eval exited %d:\n%s", code, out)
	}
	if r := egdReadJSON(t, filepath.Join(tmp, "eval-result.json")); r["score"] != 1.0 || r["http"] != 200.0 {
		t.Fatalf("baseline result = %v, want score 1 over HTTP 200", r)
	}
	if st := agentStatus(); st != http.StatusNotFound {
		t.Fatalf("%s exists before any deploy (HTTP %d); run against a clean stack", egdProd, st)
	}
	before := deployments()

	// 2. regressing candidate: 422, job stops, nothing deploys.
	code, out := egdScript(t, env, "eval.sh", regressed)
	if code != 1 {
		t.Fatalf("regressed eval exited %d, want 1 (gate):\n%s", code, out)
	}
	r := egdReadJSON(t, filepath.Join(tmp, "eval-result.json"))
	if r["http"] != 422.0 || r["regressed"] != true || r["baselineScore"] != 1.0 {
		t.Fatalf("regressed result = %v, want HTTP 422, regressed, baselineScore 1", r)
	}
	if got := r["score"].(float64); got < 0.66 || got > 0.67 {
		t.Fatalf("regressed score = %v, want 2 of 3 cases (0.667): only the pinned case may regress", got)
	}
	if code, out := egdScript(t, env, "release.sh", regressed); code == 0 || !strings.Contains(out, "refusing to deploy") {
		t.Fatalf("release.sh after a failed gate exited %d, want a refusal:\n%s", code, out)
	}
	if st := agentStatus(); st != http.StatusNotFound {
		t.Fatalf("regressed candidate created/deployed %s (HTTP %d)", egdProd, st)
	}
	if got := deployments(); got != before {
		t.Fatalf("deployments after regressed candidate = %d, want %d (no deploy row)", got, before)
	}

	// 3. passing candidate: gate clean, deploy recorded, receipt verifies.
	if code, out := egdScript(t, env, "eval.sh", improved); code != 0 {
		t.Fatalf("improved eval exited %d:\n%s", code, out)
	}
	if code, out := egdScript(t, env, "release.sh", improved); code != 0 {
		t.Fatalf("release exited %d:\n%s", code, out)
	}
	if got := deployments(); got != before+1 {
		t.Fatalf("deployments after passing candidate = %d, want %d", got, before+1)
	}
	dep := egdReadJSON(t, filepath.Join(tmp, "deploy.json"))
	if dep["status"] != "live" || dep["agentName"] != egdProd || dep["id"] == "" {
		t.Fatalf("deploy --json = %v, want a live deployment of %s", dep, egdProd)
	}
	receipt := egdReadJSON(t, filepath.Join(tmp, "receipt.json"))
	result := egdReadJSON(t, filepath.Join(tmp, "eval-result.json"))
	payload, _ := receipt["payload"].(map[string]any)
	if payload["runId"] != result["runId"] || receipt["signature"] == "" {
		t.Fatalf("receipt %v is not for the gating run %v", receipt, result["runId"])
	}

	verify := func(rc map[string]any) map[string]any {
		var v map[string]any
		if st, raw := s.kit.Do(t, http.MethodPost, "/v1/runs/receipts/verify", rc, &v); st != http.StatusOK {
			t.Fatalf("verify: HTTP %d: %s", st, raw)
		}
		return v
	}
	if v := verify(receipt); v["valid"] != true {
		t.Fatalf("untouched receipt did not verify: %v", v)
	}

	// 4. tampering: a corrupted signature, and a receipt re-pointed at another run.
	sig := receipt["signature"].(string)
	flip := "A"
	if strings.HasPrefix(sig, "A") {
		flip = "B"
	}
	badSig := map[string]any{"payload": payload, "algorithm": receipt["algorithm"], "signature": flip + sig[1:]}
	if v := verify(badSig); v["valid"] != false {
		t.Fatalf("receipt with a corrupted signature verified: %v", v)
	}
	otherRun := map[string]any{}
	for k, v := range payload {
		otherRun[k] = v
	}
	otherRun["runId"] = "00000000-0000-4000-8000-0000000000e8"
	repointed := map[string]any{"payload": otherRun, "algorithm": receipt["algorithm"], "signature": sig}
	if v := verify(repointed); v["valid"] != false {
		t.Fatalf("receipt re-pointed at another run verified: %v", v)
	}

	// An edited payload carrying the original signature must fail (#349).
	edited := map[string]any{}
	for k, v := range payload {
		edited[k] = v
	}
	edited["costUsd"] = 99.0
	if v := verify(map[string]any{"payload": edited, "algorithm": receipt["algorithm"], "signature": sig}); v["valid"] != false {
		t.Fatalf("receipt with an edited costUsd and the original signature verified: %v", v)
	}
}
