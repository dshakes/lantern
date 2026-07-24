package main

import (
	"fmt"
	"os"

	"github.com/dshakes/lantern/packages/cli/internal/cli"
)

// Build-time variables set via ldflags.
var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	root := cli.NewRootCommand(version, commit, date)
	if err := root.Execute(); err != nil {
		// The root command sets SilenceErrors so cobra doesn't print;
		// that makes it our job to surface the error instead of exiting mute.
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
