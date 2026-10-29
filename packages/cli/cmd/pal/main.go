package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/dshakes/lantern/packages/cli/internal/cli"
	"github.com/dshakes/lantern/packages/palenv"
)

// Build-time variables set via ldflags.
var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	palenv.Bridge()
	root := cli.NewRootCommand(version, commit, date)
	if err := root.Execute(); err != nil {
		// The root command sets SilenceErrors so cobra doesn't print;
		// that makes it our job to surface the error instead of exiting mute.
		fmt.Fprintln(os.Stderr, "Error:", err)
		var ee *cli.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.Code)
		}
		os.Exit(1)
	}
}
