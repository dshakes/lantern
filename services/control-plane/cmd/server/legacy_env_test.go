package main

import (
	"testing"
	"time"

	"github.com/dshakes/lantern/packages/palenv"
	"github.com/dshakes/lantern/services/control-plane/internal/handlers"
)

// An existing deployment sets only LANTERN_*. Reads now use PAL_* (ADR 0032),
// so palenv.Bridge() — the first statement of main() — must serve them.
func TestLegacyEnvOnly_BridgeServesPALReads(t *testing.T) {
	t.Setenv("LANTERN_ENV", "production")
	t.Setenv("LANTERN_PG_MAX_CONN_LIFETIME", "7m")
	// Registered empty so t.Cleanup unsets the mirrors Bridge writes; an
	// empty PAL_X never overrides a non-empty LANTERN_X.
	t.Setenv("PAL_ENV", "")
	t.Setenv("PAL_PG_MAX_CONN_LIFETIME", "")

	palenv.Bridge()

	if !handlers.IsProd() {
		t.Error("PAL_ENV=production alone: IsProd() = false, want true")
	}
	if got := envDurationMain("PAL_PG_MAX_CONN_LIFETIME", time.Hour); got != 7*time.Minute {
		t.Errorf("PAL_PG_MAX_CONN_LIFETIME=7m alone: got %v, want 7m", got)
	}
}
