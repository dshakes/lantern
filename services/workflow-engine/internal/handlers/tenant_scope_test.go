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

// TestStreamingRPCsVerifyBeforeSubscribing closes the class, not the instance.
//
// ExecuteRun and ResumeRun both subscribed to a run's event stream BEFORE any
// ownership check. A cross-tenant caller was therefore attached to another
// tenant's stream for the whole window until the engine rejected it, and events
// published in that window were delivered.
//
// ExecuteRun was reported; ResumeRun was found only by sweeping afterwards.
// That is the third time in this change that fixing the reported instance left
// an identical sibling in place, so the rule is asserted here instead: in an
// RPC that subscribes to a run's stream, the ownership check must come first.
func TestStreamingRPCsVerifyBeforeSubscribing(t *testing.T) {
	src, err := os.ReadFile("workflow.go")
	if err != nil {
		t.Fatalf("read workflow.go: %v", err)
	}
	lines := strings.Split(string(src), "\n")

	fnStart := regexp.MustCompile(`^func \(s \*WorkflowService\) ([A-Za-z]+)\(`)
	var current string
	var start int
	var bad []string

	flush := func(body []string, name string, off int) {
		if name == "" {
			return
		}
		subIdx, verIdx := -1, -1
		for i, l := range body {
			if subIdx < 0 && strings.Contains(l, "Streamer().Subscribe(") {
				subIdx = i
			}
			if verIdx < 0 && strings.Contains(l, "VerifyRunOwnership(") {
				verIdx = i
			}
		}
		if subIdx >= 0 && (verIdx < 0 || verIdx > subIdx) {
			bad = append(bad, name+" (workflow.go:"+itoa(off+subIdx+1)+") subscribes before verifying ownership")
		}
	}

	for i, l := range lines {
		if m := fnStart.FindStringSubmatch(l); m != nil {
			flush(lines[start:i], current, start)
			current, start = m[1], i
		}
	}
	flush(lines[start:], current, start)

	if len(bad) > 0 {
		t.Errorf("streaming RPCs attach to a run's event stream before checking it belongs "+
			"to the caller:\n  %s\n\nVerify ownership first — events published between "+
			"subscribe and rejection are delivered to the wrong tenant.",
			strings.Join(bad, "\n  "))
	}
}
