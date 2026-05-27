// Package scoring implements the placement score function used by the
// RuntimeScheduler to pick which node should host a candidate VM.
//
// The score is a weighted sum of five normalized [0..1] sub-scores. A
// higher score means a better placement. Weights are configurable via
// env so cluster operators can tune for "pack tighter" vs. "spread
// wider" vs. "save money".
//
// The scoring is intentionally pure: no I/O, no clock, no globals. The
// caller passes a snapshot of relevant cluster state and gets back a
// number. This keeps the unit tests cheap and reproducible.
package scoring

import (
	"strings"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
)

// Weights controls the relative importance of each sub-score. The defaults
// favour warm-pool hits (cold-boot cost dominates p99 latency) and region
// affinity (data gravity), and lightly penalize fair-share violations and
// unhealthy nodes.
type Weights struct {
	WarmPool  float64
	Region    float64
	FairShare float64
	Cost      float64
	Health    float64
}

// DefaultWeights returns the production defaults.
func DefaultWeights() Weights {
	return Weights{
		WarmPool:  0.40,
		Region:    0.25,
		FairShare: 0.15,
		Cost:      0.10,
		Health:    0.10,
	}
}

// NodeSnapshot is the subset of cluster state needed to score a single
// node against a candidate workload. Populated by the caller from
// cluster.State; the scoring package never reaches into mutable state.
type NodeSnapshot struct {
	Name             string
	Region           string
	AvailabilityZone string
	Continent        string

	// Warm-pool inventory keyed by "<image>@<class>@<size>" composite plus
	// "<image>" alone for image-only fallback. Values are slot counts.
	WarmPoolExact     map[string]int32
	WarmPoolImageOnly map[string]int32

	// Pricing class — used by the cost score.
	IsSpot bool
	IsARM  bool

	// Health signals collected from manager heartbeats over a recent
	// window (e.g. last 10 minutes).
	RecentOOMCount     int
	RecentKernelEvents int

	// True if the node is in `draining` state and should never be picked.
	Draining bool

	// Free capacity. Used elsewhere (filter) but also exposed here so the
	// scorer can be one place to plug capacity-aware ranking later.
	FreeVcpuMillis  int64
	FreeMemoryBytes int64
}

// WorkloadSnapshot is the subset of the AgentSpec + tenant fair-share
// state needed for scoring. The scheduler builds this once per request.
type WorkloadSnapshot struct {
	ImageDigest        string
	Class              lanternv1.IsolationClass
	SizeKey            string // canonical "vcpu/memory" key, e.g. "500m/512Mi"
	DataRegion         string // region where the agent's data lives
	DataContinent      string
	TenantID           string
	TenantLiveVMs      int  // current count of running VMs for this tenant
	TenantSoftCap      int  // tenant's soft concurrency cap
	ArchitectureLocked bool // if true, the workload needs x86 specifically
}

// ScoreNode produces the weighted placement score for (node, workload).
// Returns 0 for any draining node — callers should pre-filter, but we
// belt-and-braces it.
func ScoreNode(node NodeSnapshot, wl WorkloadSnapshot, w Weights) float64 {
	if node.Draining {
		return 0
	}

	warm := warmPoolMatchScore(node, wl)
	region := regionMatchScore(node, wl)
	fair := fairShareScore(wl)
	cost := costScore(node, wl)
	health := healthScore(node)

	return w.WarmPool*warm +
		w.Region*region +
		w.FairShare*fair +
		w.Cost*cost +
		w.Health*health
}

// warmPoolMatchScore: 1.0 if the node has a slot keyed by exact
// (image, class, size); 0.3 if it has image-only; 0 otherwise.
func warmPoolMatchScore(node NodeSnapshot, wl WorkloadSnapshot) float64 {
	if wl.ImageDigest == "" {
		return 0
	}
	exactKey := warmPoolExactKey(wl.ImageDigest, wl.Class, wl.SizeKey)
	if node.WarmPoolExact[exactKey] > 0 {
		return 1.0
	}
	if node.WarmPoolImageOnly[wl.ImageDigest] > 0 {
		return 0.3
	}
	return 0
}

// regionMatchScore: 1.0 same-region as the data, 0.5 same-continent,
// 0 cross-continent. If the workload didn't declare a data region, we
// return a neutral 0.5 so the term doesn't dominate.
func regionMatchScore(node NodeSnapshot, wl WorkloadSnapshot) float64 {
	if wl.DataRegion == "" {
		return 0.5
	}
	if node.Region != "" && node.Region == wl.DataRegion {
		return 1.0
	}
	if node.Continent != "" && wl.DataContinent != "" && node.Continent == wl.DataContinent {
		return 0.5
	}
	return 0
}

// fairShareScore penalizes tenants who are over their soft cap. The
// returned score decays linearly from 1.0 (at-or-under cap) to 0.0
// (at 2x cap or more).
func fairShareScore(wl WorkloadSnapshot) float64 {
	if wl.TenantSoftCap <= 0 {
		return 1.0
	}
	if wl.TenantLiveVMs <= wl.TenantSoftCap {
		return 1.0
	}
	overage := float64(wl.TenantLiveVMs - wl.TenantSoftCap)
	cap := float64(wl.TenantSoftCap)
	ratio := overage / cap
	if ratio >= 1.0 {
		return 0
	}
	return 1.0 - ratio
}

// costScore rewards cheaper instance shapes. Spot beats on-demand; ARM
// beats x86 when the workload isn't pinned to an architecture.
func costScore(node NodeSnapshot, wl WorkloadSnapshot) float64 {
	score := 0.5
	if node.IsSpot {
		score += 0.3
	}
	if node.IsARM && !wl.ArchitectureLocked {
		score += 0.2
	}
	if score > 1.0 {
		score = 1.0
	}
	return score
}

// healthScore penalizes nodes with recent OOMs or kernel events. The
// curve is hard-floored at 0 once a node hits 5+ OOMs or 10+ kernel
// events, on the theory that we'd rather wait than place on a
// flapping host.
func healthScore(node NodeSnapshot) float64 {
	score := 1.0
	score -= float64(node.RecentOOMCount) * 0.2
	score -= float64(node.RecentKernelEvents) * 0.1
	if score < 0 {
		return 0
	}
	return score
}

// warmPoolExactKey builds the composite key used in NodeSnapshot.WarmPoolExact.
// Keep this stable — runtime-manager produces the same key when it
// reports its inventory.
func warmPoolExactKey(image string, class lanternv1.IsolationClass, size string) string {
	var sb strings.Builder
	sb.WriteString(image)
	sb.WriteByte('@')
	sb.WriteString(class.String())
	sb.WriteByte('@')
	sb.WriteString(size)
	return sb.String()
}

// WarmPoolExactKey is the public alias used by callers building snapshots.
func WarmPoolExactKey(image string, class lanternv1.IsolationClass, size string) string {
	return warmPoolExactKey(image, class, size)
}
