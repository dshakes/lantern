// Command sweep deletes all e2e-* agents from the dev tenant.
// Used by `make e2e-clean` for manual recovery after an interrupted test run.
//
// Usage:
//
//	go run ./e2e/internal/e2ekit/cmd/sweep
//
// Env vars: LANTERN_E2E_API_URL, LANTERN_E2E_EMAIL, LANTERN_E2E_PASSWORD
package main

import (
	"fmt"
	"os"

	"github.com/dshakes/lantern/e2e/internal/e2ekit"
)

func main() {
	base := e2ekit.DefaultBase()
	email := e2ekit.DefaultEmail()
	password := e2ekit.DefaultPassword()

	fmt.Fprintf(os.Stderr, "e2e-clean: sweeping e2e-* agents from %s\n", base)
	e2ekit.Sweep(base, email, password)
	fmt.Fprintln(os.Stderr, "e2e-clean: done")
}
