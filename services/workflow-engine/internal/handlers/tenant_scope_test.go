package handlers

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestRPCsDoNotDiscardCallerTenant guards a bug class with a distinctive smell.
//
// QueryRun extracted the caller's tenant and threw it away — `_, err :=
// middleware.MustTenantID(ctx)` — then looked a run up by id alone. So it
// authenticated that the caller had *a* tenant and never checked the run was
// theirs: any caller could query any run in any tenant. Its sibling RPCs
// (Cancel/Signal/Resume) all verify ownership; this one silently did not.
//
// Discarding the tenant into `_` is the tell, and it is cheap to catch.
func TestRPCsDoNotDiscardCallerTenant(t *testing.T) {
	src, err := os.ReadFile("workflow.go")
	if err != nil {
		t.Fatalf("read workflow.go: %v", err)
	}
	discard := regexp.MustCompile(`_,\s*err\s*:=\s*middleware\.MustTenantID\(`)

	var bad []string
	for i, line := range strings.Split(string(src), "\n") {
		if discard.MatchString(line) {
			bad = append(bad, "workflow.go:"+itoa(i+1)+"  "+strings.TrimSpace(line))
		}
	}
	if len(bad) > 0 {
		t.Errorf("caller tenant extracted then discarded:\n  %s\n\n"+
			"Authenticating that a tenant exists is not authorizing access to the "+
			"resource. Keep the tenant and verify ownership (see "+
			"Engine.VerifyRunOwnership).", strings.Join(bad, "\n  "))
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
