package main

import (
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
		os.Exit(1)
	}
}
