package engine

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNoTenantScopeFromLookedUpState guards a whole bug class, not one bug.
//
// `e.runs[runID]` returns a NIL *RunState when the run is not active in memory.
// Functions that do that lookup and then scope a transaction with
// `state.TenantID` dereference nil on exactly the path where the run is
// inactive — which is the normal path for signalling or cancelling a queued or
// paused run. It panics the engine service, not just the request.
//
// This shipped twice in one change: the tenant-scoping cutover swapped
// `pool.Begin` for `beginTenantTx(ctx, state.TenantID)` mechanically, and the
// compiler was happy because `state` IS in scope — it is simply nil at runtime.
// A reviewer caught one instance; the second was found only by going looking.
// The lesson is the reason this test exists: "the compiler checked it" does not
// cover nil.
//
// The rule: in a function that looks up state from the active-runs map, scope
// transactions with the caller's tenant (already verified against the database)
// rather than the possibly-nil state.
func TestNoTenantScopeFromLookedUpState(t *testing.T) {
	lookupPattern := regexp.MustCompile(`:=\s*e\.runs\[`)
	scopeFromState := regexp.MustCompile(`beginTenantTx\(ctx,\s*state\.TenantID\)`)
	funcStart := regexp.MustCompile(`^func\s`)

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

		// Walk function by function.
		start := -1
		for i, line := range lines {
			if funcStart.MatchString(line) {
				if start >= 0 {
					checkFunc(f, lines[start:i], start, lookupPattern, scopeFromState, &violations)
				}
				start = i
			}
		}
		if start >= 0 {
			checkFunc(f, lines[start:], start, lookupPattern, scopeFromState, &violations)
		}
	}

	if len(violations) > 0 {
		t.Errorf("tenant scope taken from a possibly-nil state (looked up via e.runs[...]):\n  %s\n\n"+
			"e.runs[id] yields nil for an inactive run, so state.TenantID panics the service on "+
			"that path. Scope with the caller's tenant instead — it is verified against the "+
			"database and is never nil.",
			strings.Join(violations, "\n  "))
	}
}

func checkFunc(file string, body []string, offset int, lookup, scope *regexp.Regexp, out *[]string) {
	joined := strings.Join(body, "\n")
	if !lookup.MatchString(joined) {
		return
	}
	for i, line := range body {
		if scope.MatchString(line) {
			*out = append(*out, file+":"+itoa(offset+i+1)+"  "+strings.TrimSpace(line))
		}
	}
}
