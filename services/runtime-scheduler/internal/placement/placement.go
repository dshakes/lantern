// Package placement turns "I have a workload and a cluster" into "this
// is the node we picked". It composes the cluster state with the
// scoring package and is the only place that filters by capacity.
package placement

import (
	"fmt"
	"sort"

	lanternv1 "github.com/dshakes/lantern/gen/go/lantern/v1"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/cluster"
	"github.com/dshakes/lantern/services/runtime-scheduler/internal/scoring"
)

// Decision is the placement result returned to the caller.
type Decision struct {
	NodeName string
	NodeAddr string
	Score    float64
	// All candidates with their scores, useful for /v1/cluster debugging.
	Scores map[string]float64
}

// Engine picks a node for a candidate AgentSpec.
type Engine struct {
	Store   cluster.ClusterStore
	Weights scoring.Weights
}

// Pick runs the placement algorithm and returns the winning node, or an
// error if no node is suitable. Filters are applied before scoring:
//   - draining nodes are excluded
//   - nodes without enough free vCPU / memory are excluded
//   - if a PlacementHint pins a node, that's used (still validated)
func (e *Engine) Pick(spec *lanternv1.AgentSpec, hint *lanternv1.PlacementHint, tenantSoftCap int) (*Decision, error) {
	nodes := e.Store.ListNodes()
	if len(nodes) == 0 {
		return nil, fmt.Errorf("no nodes registered in cluster")
	}

	wl := buildWorkload(spec, tenantSoftCap, e.Store.TenantLiveVMs(spec.TenantId))

	// Hard pin via hint.
	if hint != nil && hint.Node != "" {
		n, ok := e.Store.GetNode(hint.Node)
		if !ok {
			return nil, fmt.Errorf("hinted node %q not found", hint.Node)
		}
		if n.Draining {
			return nil, fmt.Errorf("hinted node %q is draining", hint.Node)
		}
		snap := cluster.BuildNodeSnapshot(n)
		score := scoring.ScoreNode(snap, wl, e.Weights)
		return &Decision{
			NodeName: n.Name,
			NodeAddr: n.Address,
			Score:    score,
			Scores:   map[string]float64{n.Name: score},
		}, nil
	}

	requiredVcpu, requiredMem := requiredCapacity(spec)

	type candidate struct {
		node  cluster.Node
		score float64
	}
	candidates := make([]candidate, 0, len(nodes))
	allScores := make(map[string]float64, len(nodes))

	for _, n := range nodes {
		if n.Draining {
			continue
		}
		if requiredVcpu > 0 && n.FreeVcpuMillis < requiredVcpu {
			continue
		}
		if requiredMem > 0 && n.FreeMemoryBytes < requiredMem {
			continue
		}
		if hint != nil {
			if hint.Region != "" && n.Region != "" && n.Region != hint.Region {
				continue
			}
			if hint.AvailabilityZone != "" && n.AvailabilityZone != "" && n.AvailabilityZone != hint.AvailabilityZone {
				continue
			}
		}
		snap := cluster.BuildNodeSnapshot(n)
		s := scoring.ScoreNode(snap, wl, e.Weights)
		allScores[n.Name] = s
		candidates = append(candidates, candidate{node: n, score: s})
	}

	if len(candidates) == 0 {
		return nil, fmt.Errorf("no suitable node found (capacity / region / draining filters excluded all %d nodes)", len(nodes))
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].node.Name < candidates[j].node.Name
	})

	winner := candidates[0]
	return &Decision{
		NodeName: winner.node.Name,
		NodeAddr: winner.node.Address,
		Score:    winner.score,
		Scores:   allScores,
	}, nil
}

// buildWorkload converts the AgentSpec into the slim WorkloadSnapshot
// that the scorer needs.
func buildWorkload(spec *lanternv1.AgentSpec, softCap, live int) scoring.WorkloadSnapshot {
	var region, continent string
	if len(spec.PreferredRegions) > 0 {
		region = spec.PreferredRegions[0]
		continent = continentFor(region)
	}
	arch := spec.Labels["architecture"]
	return scoring.WorkloadSnapshot{
		ImageDigest:        spec.ImageDigest,
		Class:              spec.Isolation,
		SizeKey:            cluster.SizeKey(spec.Limits),
		DataRegion:         region,
		DataContinent:      continent,
		TenantID:           spec.TenantId,
		TenantLiveVMs:      live,
		TenantSoftCap:      softCap,
		ArchitectureLocked: arch == "x86_64" || arch == "amd64",
	}
}

// continentFor is a tiny lookup table for the common cloud regions. It
// intentionally falls back to "" rather than guessing — the scorer
// treats unknown continent as neutral.
func continentFor(region string) string {
	switch {
	case len(region) >= 3 && region[:3] == "us-":
		return "na"
	case len(region) >= 3 && region[:3] == "ca-":
		return "na"
	case len(region) >= 3 && region[:3] == "eu-":
		return "eu"
	case len(region) >= 3 && region[:3] == "ap-":
		return "asia"
	case len(region) >= 3 && region[:3] == "sa-":
		return "sa"
	case len(region) >= 3 && region[:3] == "af-":
		return "af"
	case len(region) >= 3 && region[:3] == "me-":
		return "me"
	default:
		return ""
	}
}

// requiredCapacity converts the AgentSpec resource limits into raw
// vcpu_millis / memory_bytes integers. Unparseable values yield 0 so
// we don't accidentally block placement on malformed input.
func requiredCapacity(spec *lanternv1.AgentSpec) (int64, int64) {
	if spec == nil || spec.Limits == nil {
		return 0, 0
	}
	return parseVcpuMillis(spec.Limits.Vcpu), parseMemoryBytes(spec.Limits.Memory)
}
