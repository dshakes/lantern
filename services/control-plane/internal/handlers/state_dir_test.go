package handlers

import (
	"os"
	"path/filepath"
	"testing"
)

// palStateDir must resolve exactly like bridge-core palStateDir():
// PAL_STATE_DIR → PAL_STATE_DIR → ~/.pal if it exists → ~/.pal,
// re-evaluated on every call.
func TestPalStateDir_ResolutionOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PAL_STATE_DIR", "")
	t.Setenv("PAL_STATE_DIR", "")
	got := func() string {
		t.Helper()
		d, err := palStateDir()
		if err != nil {
			t.Fatal(err)
		}
		return d
	}

	if d := got(); d != filepath.Join(home, ".pal") {
		t.Fatalf("default: %q", d)
	}
	if err := os.Mkdir(filepath.Join(home, ".pal"), 0o700); err != nil {
		t.Fatal(err)
	}
	if d := got(); d != filepath.Join(home, ".pal") {
		t.Fatalf("~/.pal exists (read per call): %q", d)
	}
	t.Setenv("PAL_STATE_DIR", "/legacy")
	if d := got(); d != "/legacy" {
		t.Fatalf("PAL_STATE_DIR: %q", d)
	}
	t.Setenv("PAL_STATE_DIR", "/pal")
	if d := got(); d != "/pal" {
		t.Fatalf("PAL_STATE_DIR wins: %q", d)
	}
}

// The signals JSONL lands in the resolved state dir.
func TestSignalsFilePath_UsesStateDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PAL_STATE_DIR", dir)
	d, p, err := signalsFilePath()
	if err != nil || d != dir || p != filepath.Join(dir, "device-signals.jsonl") {
		t.Fatalf("got %q %q %v", d, p, err)
	}
}
