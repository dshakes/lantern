package engine

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestRLSCatalog_NoUnscopedTenantQueries is a permanent gate.
//
// The engine writes run state for every tenant on the platform and, until this
// was fixed, set `app.tenant_id` NOWHERE — so under LANTERN_RLS_ENFORCE=1 its
// queries were outside the policies the rest of the platform depends on
// (invariant #7). Worse than a leak: an unset GUC matches NOTHING, so
// enforcement would have made the engine silently stop working — updates
// affecting zero rows, reads returning nothing.
//
// A one-time cutover does not stay done. This test fails when a new query
// reaches the runs or agents tables on a raw pool without either going through
// db.WithTenant / beginTenantTx or carrying an explicit `rls-exempt:` marker
// saying why it cannot be scoped. Adding an exemption is fine — writing down
// the reason is the point.
//
// Mirrors the control-plane's TestRLSEnforcement_AllTenantTables in intent: the
// catalog is the thing that keeps a security property from rotting.
func TestRLSCatalog_NoUnscopedTenantQueries(t *testing.T) {
	// Raw pool query calls: e.pool.Query(, se.pool.Exec(, s.pool.QueryRow(, ...
	// Begin is included deliberately: a raw pool.Begin followed by
	// tx.Exec("UPDATE runs ...") is unscoped just the same, and it is the shape
	// the code had BEFORE this cutover — i.e. the most likely way to regress.
	// Catching only Query/QueryRow/Exec would leave the gate open on its own
	// primary failure mode.
	rawPoolCall := regexp.MustCompile(`\.pool\.(Query|QueryRow|Exec|Begin)\(`)
	// Tables under RLS that carry a tenant_id. journal_events and run_locks are
	// in the platform's documented exempt set — no tenant_id to police.
	tenantTables := regexp.MustCompile(`(?i)\b(FROM|INTO|UPDATE|JOIN)\s+(runs|agents|agent_versions)\b`)

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}

	var violations []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		lines := strings.Split(string(src), "\n")

		for i, line := range lines {
			if !rawPoolCall.MatchString(line) {
				continue
			}
			// The SQL usually follows the call on the next few lines.
			end := min(i+14, len(lines))
			stmt := strings.Join(lines[i:end], "\n")
			if !tenantTables.MatchString(stmt) {
				continue // run_locks / journal_events / non-tenant tables
			}
			// An `rls-exempt:` marker in the preceding lines or in the
			// statement itself documents a deliberate cross-tenant query.
			start := max(0, i-8)
			context := strings.Join(lines[start:end], "\n")
			if strings.Contains(context, "rls-exempt") {
				continue
			}
			violations = append(violations,
				f+":"+itoa(i+1)+"  "+strings.TrimSpace(line))
		}
	}

	if len(violations) > 0 {
		t.Errorf("raw pool queries touch tenant-scoped tables without db.WithTenant/beginTenantTx "+
			"and without an `rls-exempt:` reason:\n  %s\n\n"+
			"Scope it (db.WithTenant / beginTenantTx), or add an `rls-exempt:` comment saying why it "+
			"cannot be. Under LANTERN_RLS_ENFORCE=1 an unscoped query matches no rows at all.",
			strings.Join(violations, "\n  "))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
