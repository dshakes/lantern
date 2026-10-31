package cli

import (
	"errors"
	"fmt"
	"os"
)

// Main runs the CLI and returns the process exit code.
func Main(version, commit, date string) int {
	root := NewRootCommand(version, commit, date)
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
