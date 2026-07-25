package scoring

import (
	"testing"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// The warm-pool term carries the highest placement weight (0.40), and it only
// fires when the key the RUNTIME-MANAGER publishes in its heartbeat is
// byte-identical to the key built here. Nothing in the type system spans that
// Go/Rust boundary, so both sides pin the same literals. If either format
// changes, one of the two tests fails instead of the term silently evaluating
// to zero for every placement.
//
// Rust counterpart: pool::key_parity_tests::exact_key_matches_scheduler_format
// in services/runtime-manager/src/pool.rs.
func TestWarmPoolExactKey_ManagerParity(t *testing.T) {
	cases := []struct {
		image string
		class lanternv1.IsolationClass
		size  string
		want  string
	}{
		{"demo:latest", lanternv1.IsolationClass_ISOLATION_TRUSTED, "500m/512Mi",
			"demo:latest@ISOLATION_TRUSTED@500m/512Mi"},
		{"img@sha256:ab", lanternv1.IsolationClass_ISOLATION_UNTRUSTED, "1/1Gi",
			"img@sha256:ab@ISOLATION_UNTRUSTED@1/1Gi"},
	}
	for _, c := range cases {
		if got := WarmPoolExactKey(c.image, c.class, c.size); got != c.want {
			t.Errorf("WarmPoolExactKey(%q,%v,%q)\n got: %s\nwant: %s\n"+
				"If this format changed on purpose, update exact_key() in "+
				"services/runtime-manager/src/pool.rs in the same commit.",
				c.image, c.class, c.size, got, c.want)
		}
	}
}

// A node advertising a matching warm slot must actually win the warm term —
// this is the end the manager's inventory feeds.
func TestWarmPoolMatch_UsesPublishedInventory(t *testing.T) {
	wl := WorkloadSnapshot{
		ImageDigest: "demo:latest",
		Class:       lanternv1.IsolationClass_ISOLATION_TRUSTED,
		SizeKey:     "500m/512Mi",
	}
	exact := NodeSnapshot{
		WarmPoolExact: map[string]int32{"demo:latest@ISOLATION_TRUSTED@500m/512Mi": 1},
	}
	if got := warmPoolMatchScore(exact, wl); got != 1.0 {
		t.Fatalf("exact warm match should score 1.0, got %v", got)
	}

	imageOnly := NodeSnapshot{WarmPoolImageOnly: map[string]int32{"demo:latest": 1}}
	if got := warmPoolMatchScore(imageOnly, wl); got != 0.3 {
		t.Fatalf("image-only warm match should score 0.3, got %v", got)
	}

	// The pre-fix behavior: empty maps meant this term was always zero.
	if got := warmPoolMatchScore(NodeSnapshot{}, wl); got != 0 {
		t.Fatalf("no warm slot should score 0, got %v", got)
	}
}
