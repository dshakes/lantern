// Command lantern is the legacy name of the pal CLI (ADR 0032): the same
// binary, kept so `go install ./cmd/lantern` and scripts calling `lantern`
// keep working. It behaves exactly like `pal`.
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

func main() { os.Exit(cli.Main(version, commit, date)) }
