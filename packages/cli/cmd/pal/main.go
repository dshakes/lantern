// Command pal is the PAL Runtime CLI.
package main

import (
	"os"

	"github.com/dshakes/pal/packages/cli/internal/cli"
)

// Build-time variables set via ldflags.
var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() { os.Exit(cli.Main(version, commit, date)) }
