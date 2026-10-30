package handlers

import (
	"os"
	"path/filepath"
)

// palStateDir is the owner's local state directory, resolved exactly like
// bridge-core palStateDir() so the control plane and the bridges always agree
// on where device signals and the brief-channel override live:
//
//  1. PAL_STATE_DIR
//  2. ~/.pal
//
// Evaluated per call, never cached.
func palStateDir() (string, error) {
	if v := os.Getenv("PAL_STATE_DIR"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pal"), nil
}
