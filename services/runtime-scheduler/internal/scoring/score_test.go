package scoring

import (
	"math"
	"testing"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

const epsilon = 1e-9

func approxEqual(a, b float64) bool {
	return math.Abs(a-b) < epsilon
}

func TestWarmPoolMatchScore_ExactHit(t *testing.T) {
	wl := WorkloadSnapshot{
		ImageDigest: "sha256:abc",
		Class:       lanternv1.IsolationClass_ISOLATION_STANDARD,
		SizeKey:     "500m/512Mi",
	}
	key := WarmPoolExactKey(wl.ImageDigest, wl.Class, wl.SizeKey)
	node := NodeSnapshot{
		WarmPoolExact:     map[string]int32{key: 2},
		WarmPoolImageOnly: map[string]int32{},
	}
	if got := warmPoolMatchScore(node, wl); !approxEqual(got, 1.0) {
		t.Fatalf("exact warm-pool match: want 1.0, got %v", got)
	}
}

func TestWarmPoolMatchScore_ImageOnly(t *testing.T) {
	wl := WorkloadSnapshot{
		ImageDigest: "sha256:abc",
		Class:       lanternv1.IsolationClass_ISOLATION_STANDARD,
		SizeKey:     "500m/512Mi",
	}
	node := NodeSnapshot{
		WarmPoolExact:     map[string]int32{},
		WarmPoolImageOnly: map[string]int32{"sha256:abc": 1},
	}
	if got := warmPoolMatchScore(node, wl); !approxEqual(got, 0.3) {
		t.Fatalf("image-only warm-pool match: want 0.3, got %v", got)
	}
}

func TestWarmPoolMatchScore_Miss(t *testing.T) {
	wl := WorkloadSnapshot{ImageDigest: "sha256:abc"}
	node := NodeSnapshot{
		WarmPoolExact:     map[string]int32{},
		WarmPoolImageOnly: map[string]int32{},
	}
	if got := warmPoolMatchScore(node, wl); got != 0 {
		t.Fatalf("warm-pool miss: want 0, got %v", got)
	}
}

func TestRegionMatchScore(t *testing.T) {
	cases := []struct {
		name     string
		nodeReg  string
		nodeCont string
		wlReg    string
		wlCont   string
		want     float64
	}{
		{"same region", "us-east-1", "na", "us-east-1", "na", 1.0},
		{"same continent", "us-east-1", "na", "us-west-2", "na", 0.5},
		{"cross continent", "us-east-1", "na", "eu-west-1", "eu", 0},
		{"no data region", "us-east-1", "na", "", "", 0.5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := regionMatchScore(
				NodeSnapshot{Region: tc.nodeReg, Continent: tc.nodeCont},
				WorkloadSnapshot{DataRegion: tc.wlReg, DataContinent: tc.wlCont},
			)
			if !approxEqual(got, tc.want) {
				t.Fatalf("%s: want %v, got %v", tc.name, tc.want, got)
			}
		})
	}
}

func TestFairShareScore(t *testing.T) {
	cases := []struct {
		name string
		live int
		soft int
		want float64
	}{
		{"under cap", 5, 10, 1.0},
		{"at cap", 10, 10, 1.0},
		{"10% over", 11, 10, 0.9},
		{"100% over", 20, 10, 0},
		{"way over", 50, 10, 0},
		{"no cap configured", 100, 0, 1.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := fairShareScore(WorkloadSnapshot{TenantLiveVMs: tc.live, TenantSoftCap: tc.soft})
			if !approxEqual(got, tc.want) {
				t.Fatalf("%s: want %v, got %v", tc.name, tc.want, got)
			}
		})
	}
}

func TestCostScore(t *testing.T) {
	cases := []struct {
		name       string
		isSpot     bool
		isARM      bool
		archLocked bool
		want       float64
	}{
		{"on-demand x86", false, false, false, 0.5},
		{"spot x86", true, false, false, 0.8},
		{"on-demand arm", false, true, false, 0.7},
		{"spot arm", true, true, false, 1.0},
		{"spot arm but arch-locked", true, true, true, 0.8},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := costScore(
				NodeSnapshot{IsSpot: tc.isSpot, IsARM: tc.isARM},
				WorkloadSnapshot{ArchitectureLocked: tc.archLocked},
			)
			if !approxEqual(got, tc.want) {
				t.Fatalf("%s: want %v, got %v", tc.name, tc.want, got)
			}
		})
	}
}

func TestHealthScore(t *testing.T) {
	cases := []struct {
		name  string
		ooms  int
		kevts int
		want  float64
	}{
		{"clean", 0, 0, 1.0},
		{"one OOM", 1, 0, 0.8},
		{"one OOM + 2 kevts", 1, 2, 0.6},
		{"five OOMs", 5, 0, 0},
		{"way unhealthy", 10, 10, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := healthScore(NodeSnapshot{RecentOOMCount: tc.ooms, RecentKernelEvents: tc.kevts})
			if !approxEqual(got, tc.want) {
				t.Fatalf("%s: want %v, got %v", tc.name, tc.want, got)
			}
		})
	}
}

func TestScoreNode_DrainingIsZero(t *testing.T) {
	got := ScoreNode(NodeSnapshot{Draining: true}, WorkloadSnapshot{}, DefaultWeights())
	if got != 0 {
		t.Fatalf("draining node must score 0, got %v", got)
	}
}

func TestScoreNode_WeightedSum(t *testing.T) {
	wl := WorkloadSnapshot{
		ImageDigest:   "sha256:abc",
		Class:         lanternv1.IsolationClass_ISOLATION_STANDARD,
		SizeKey:       "500m/512Mi",
		DataRegion:    "us-east-1",
		DataContinent: "na",
		TenantLiveVMs: 0,
		TenantSoftCap: 20,
	}
	exactKey := WarmPoolExactKey(wl.ImageDigest, wl.Class, wl.SizeKey)
	node := NodeSnapshot{
		Region:            "us-east-1",
		Continent:         "na",
		WarmPoolExact:     map[string]int32{exactKey: 1},
		WarmPoolImageOnly: map[string]int32{wl.ImageDigest: 1},
		IsSpot:            true,
		IsARM:             true,
	}
	// All sub-scores are 1.0 (warm exact, same region, under cap, spot+arm
	// cost capped at 1.0, no health hits). Total must equal the weight sum.
	w := DefaultWeights()
	total := w.WarmPool + w.Region + w.FairShare + w.Cost + w.Health
	got := ScoreNode(node, wl, w)
	if !approxEqual(got, total) {
		t.Fatalf("weighted sum: want %v, got %v", total, got)
	}
}
