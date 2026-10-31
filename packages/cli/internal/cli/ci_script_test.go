package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// runCIScript executes the generated .pal/ci.sh with a shimmed curl (serves files from
// rel) and an optional fake cosign, so the install/verify paths run for real offline.
func runCIScript(t *testing.T, env []string, rel map[string]string, cosignOK *bool) (string, error) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	relDir := filepath.Join(dir, "rel")
	for _, d := range []string{bin, relDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for n, c := range rel {
		if err := os.WriteFile(filepath.Join(relDir, n), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	curl := "#!/bin/sh\nout=\nurl=\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=$2; shift ;; http*) url=$1 ;; esac; shift; done\n" +
		"cp \"" + relDir + "/$(basename \"$url\")\" \"$out\"\n"
	if err := os.WriteFile(filepath.Join(bin, "curl"), []byte(curl), 0o755); err != nil {
		t.Fatal(err)
	}
	if cosignOK != nil {
		rc := "1"
		if *cosignOK {
			rc = "0"
		}
		if err := os.WriteFile(filepath.Join(bin, "cosign"), []byte("#!/bin/sh\nexit "+rc+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script := filepath.Join(dir, "ci.sh")
	content := renderCIFiles(ciInitParams{Agent: "a", Suite: "ci", Manifest: "agent.yaml", Branch: "main"})[1].Content
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sh", script)
	cmd.Env = append([]string{"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "TMPDIR=" + dir, "PAL_API_URL=x", "PAL_API_KEY=x"}, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestCIScriptInstall(t *testing.T) {
	arch := "amd64"
	if runtime.GOARCH == "arm64" {
		arch = "arm64"
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("script supports linux and darwin only")
	}
	asset := "pal_" + runtime.GOOS + "_" + arch
	binary := "#!/bin/sh\necho RAN \"$@\"\n" // stand-in for the pal binary
	h := sha256.Sum256([]byte(binary))
	sums := hex.EncodeToString(h[:]) + "  " + asset + "\n"
	good := map[string]string{asset: binary, "SHA256SUMS": sums, "SHA256SUMS.sigstore.json": "{}"}
	yes, no := true, false
	ver := []string{"PAL_CLI_VERSION=v0.21.0"}

	if out, err := runCIScript(t, ver, good, &yes); err != nil || !strings.Contains(out, "RAN ci check --agent a") {
		t.Fatalf("verified install should run the binary: %v %s", err, out)
	}
	if out, err := runCIScript(t, ver, good, nil); err != nil || !strings.Contains(out, "checksum only") {
		t.Fatalf("no cosign: checksum-only with a warning: %v %s", err, out)
	}
	tampered := map[string]string{asset: binary + "# tampered\n", "SHA256SUMS": sums, "SHA256SUMS.sigstore.json": "{}"}
	if out, err := runCIScript(t, ver, tampered, &yes); err == nil || strings.Contains(out, "RAN") {
		t.Fatalf("checksum mismatch must abort: %v %s", err, out)
	}
	if out, err := runCIScript(t, ver, good, &no); err == nil || strings.Contains(out, "RAN") {
		t.Fatalf("cosign failure must abort: %v %s", err, out)
	}
	for _, v := range [][]string{nil, {"PAL_CLI_VERSION=latest"}, {"PAL_CLI_VERSION=v1"}} {
		if out, err := runCIScript(t, v, good, &yes); err == nil || strings.Contains(out, "RAN") {
			t.Fatalf("unpinned version %v must be refused: %v %s", v, err, out)
		}
	}
	// documented escape hatch: a prebuilt binary, no download
	stub := filepath.Join(t.TempDir(), "pal")
	if err := os.WriteFile(stub, []byte(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := runCIScript(t, []string{"PAL_CLI_PATH=" + stub}, nil, nil); err != nil || !strings.Contains(out, "RAN ci check") {
		t.Fatalf("PAL_CLI_PATH: %v %s", err, out)
	}
}
