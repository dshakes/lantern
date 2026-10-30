package handlers

import (
	"os"
	"path/filepath"
)

// palStateDir is the owner's local state directory, resolved exactly like
// bridge-core palStateDir() so the control plane and the bridges always agree
// on where device signals and the brief-channel override live (ADR 0032):
//
//  1. PAL_STATE_DIR, else PAL_STATE_DIR
//  2. ~/.pal, only once it exists
//  3. ~/.pal (legacy; every existing install lives here)
//
// Evaluated per call, never cached: the owner migrates by moving ~/.pal to
// ~/.pal, and every store must switch at that moment.
func palStateDir() (string, error) {
	if v := os.Getenv("PAL_STATE_DIR"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(filepath.Join(home, ".pal")); err == nil && fi.IsDir() {
		return filepath.Join(home, ".pal"), nil
	}
	return filepath.Join(home, ".pal"), nil
}
