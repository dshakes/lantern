package engine

import (
	"os"
	"strings"
	"testing"
)

// TestAppPoolIsWiredInMain guards against the setter going dead.
//
// SetAppPool shipped in the previous commit with NOTHING calling it. The engine
// therefore ran every query on the privileged DATABASE_URL pool — and
// PostgreSQL superusers BYPASS row-level security, so app.tenant_id was being
// set on connections the policies never applied to. The API existed, the tests
// passed, and RLS was completely bypassed at runtime.
//
// A unit test cannot catch that: the wiring lives in cmd/server. So assert it
// directly. If the call disappears, the engine silently stops enforcing RLS
// again, and nothing else in this package would notice.
func TestAppPoolIsWiredInMain(t *testing.T) {
	src, err := os.ReadFile("../../cmd/server/main.go")
	if err != nil {
		t.Fatalf("read cmd/server/main.go: %v", err)
	}
	main := string(src)

	if !strings.Contains(main, "SetAppPool(") {
		t.Fatal("cmd/server/main.go never calls SetAppPool — the engine will run tenant " +
			"queries on the privileged pool, which BYPASSES RLS entirely")
	}
	if !strings.Contains(main, "LANTERN_APP_DB_PASSWORD") {
		t.Error("main.go does not read LANTERN_APP_DB_PASSWORD, so the lantern_app pool " +
			"can never be built")
	}
	if !strings.Contains(main, "lantern_app") {
		t.Error("main.go does not connect the app pool as the lantern_app role; a pool on " +
			"the privileged role is subject to no policies")
	}
}
