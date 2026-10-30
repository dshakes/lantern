package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/dshakes/lantern/packages/palenv"
)

// legacyBinaryName is the pre-rename name of this binary (ADR 0032). Installs
// symlink it to `pal`; invoked under it, the CLI works unchanged.
const legacyBinaryName = "lantern"

// Main runs the CLI and returns the process exit code. cmd/pal and the legacy
// cmd/lantern both call it, so the two binaries cannot drift.
func Main(version, commit, date string) int {
	palenv.Bridge()
	root := NewRootCommand(version, commit, date)
	if invokedAs(os.Args[0]) == legacyBinaryName {
		root.Use = legacyBinaryName // usage lines echo the name that was typed
		if isTerminal(os.Stderr) {
			fmt.Fprintln(os.Stderr, "note: `lantern` is now `pal`; this alias keeps working.")
		}
	}
	if err := root.Execute(); err != nil {
		// The root command sets SilenceErrors so cobra doesn't print;
		// that makes it our job to surface the error instead of exiting mute.
		fmt.Fprintln(os.Stderr, "Error:", err)
		var ee *ExitError
		if errors.As(err, &ee) {
			return ee.Code
		}
		return 1
	}
	return 0
}

// invokedAs is the binary name from argv[0], without directory or .exe.
func invokedAs(argv0 string) string {
	return strings.TrimSuffix(filepath.Base(argv0), ".exe")
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}
