package workflow

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ConfidenceEstimator evaluates how confident the system is that a
// side-effecting workflow step should auto-execute. The interface is the
// clean seam for a future calibrated estimator (self-consistency sampling,
// logit-based scoring per arXiv 2602.05073 / 2601.15778) to replace the
// current heuristic implementation without changing the interpreter.
type ConfidenceEstimator interface {
	// Estimate returns a confidence score in [0, 1]. 1.0 = fully confident,
	// 0.0 = no confidence. Must not block longer than the step timeout.
	Estimate(ctx context.Context, node Node, vars map[string]any) float64
}

// ConfidenceGate holds the feature configuration for confidence-gated
// execution. When nil in Deps, the feature is completely bypassed — no
// existing workflow behaviour changes. Wired at the call site when
// LANTERN_CONFIDENCE_GATE is set (see rest.go buildConfidenceGate).
type ConfidenceGate struct {
	// Estimator produces a confidence score in [0, 1] for a step.
	Estimator ConfidenceEstimator
	// Threshold is the minimum score for auto-execution.
	// score >= Threshold → execute normally.
	// score <  Threshold → divert to human approval.
	Threshold float64
}

// VerbalizationHeuristic is the ONLY ConfidenceEstimator shipping in this
// increment. It is a HEURISTIC — NOT statistically calibrated. It scans
// prior step text outputs for LLM self-reported confidence signals, then
// falls back to DefaultConfidence.
//
// Known ceiling: map iteration over vars["steps"] is non-deterministic;
// when multiple prior steps express confidence, which signal is used depends
// on map iteration order. A calibrated estimator (self-consistency sampling,
// logit probes) can replace this via the ConfidenceEstimator interface
// without any interpreter changes.
//
// ponytail: one impl now; one seam for later.
type VerbalizationHeuristic struct {
	// DefaultConfidence is returned when no verbalized signal is found in
	// prior step outputs. Defaults to 0.9 so existing flows clear the
	// default 0.75 threshold without requiring any LLM prompt changes.
	DefaultConfidence float64
}

// Estimate scans all prior step text outputs for verbalized confidence
// patterns. Returns DefaultConfidence (effective default: 0.9) when none
// are found.
func (v VerbalizationHeuristic) Estimate(_ context.Context, _ Node, vars map[string]any) float64 {
	steps, ok := vars["steps"].(map[string]any)
	if !ok {
		return v.defaultConf()
	}
	for _, out := range steps {
		s, ok := out.(string)
		if !ok || s == "" {
			continue
		}
		if score, found := parseVerbalized(s); found {
			return score
		}
	}
	return v.defaultConf()
}

func (v VerbalizationHeuristic) defaultConf() float64 {
	if v.DefaultConfidence > 0 {
		return v.DefaultConfidence
	}
	return 0.9
}

// parseVerbalized extracts a [0, 1] confidence score from LLM self-reported
// text. Returns (score, true) on a match, (0, false) otherwise.
//
// Supported patterns (case-insensitive):
//
//	"Confidence: 85%"           → 0.85
//	"I am 70% confident"        → 0.70
//	"confidence score: 0.8"     → 0.80
//	"confidence: 0.85"          → 0.85
//	"Confidence: High"          → 0.90
//	"Confidence: Medium"        → 0.60
//	"Confidence: Low"           → 0.30
func parseVerbalized(text string) (float64, bool) {
	lower := strings.ToLower(text)

	// Numeric percentage: "confidence: 85%" or "70% confident"
	for _, re := range confidencePercentREs {
		if m := re.FindStringSubmatch(lower); m != nil {
			f, err := strconv.ParseFloat(m[1], 64)
			if err == nil && f >= 0 && f <= 100 {
				return f / 100.0, true
			}
		}
	}

	// Decimal in [0, 1]: "confidence: 0.85" or "confidence score: 0.8"
	// Checked after percentage so "85%" doesn't accidentally match "0.85".
	for _, re := range confidenceDecimalREs {
		if m := re.FindStringSubmatch(lower); m != nil {
			f, err := strconv.ParseFloat(m[1], 64)
			if err == nil && f >= 0 && f <= 1 {
				return f, true
			}
		}
	}

	// Verbalized level labels (broadest match, checked last)
	if strings.Contains(lower, "confidence: high") || strings.Contains(lower, "high confidence") {
		return 0.90, true
	}
	if strings.Contains(lower, "confidence: medium") || strings.Contains(lower, "medium confidence") {
		return 0.60, true
	}
	if strings.Contains(lower, "confidence: low") || strings.Contains(lower, "low confidence") {
		return 0.30, true
	}

	return 0, false
}

// confidencePercentREs matches percent-form confidence signals.
// Compiled once at package init; safe for concurrent use.
var confidencePercentREs = []*regexp.Regexp{
	regexp.MustCompile(`confidence[^:]*:\s*(\d+(?:\.\d+)?)\s*%`),
	regexp.MustCompile(`(\d+(?:\.\d+)?)\s*%\s+confident`),
}

// confidenceDecimalREs matches decimal [0, 1] confidence signals.
var confidenceDecimalREs = []*regexp.Regexp{
	regexp.MustCompile(`confidence\s+score[^:]*:\s*(0\.\d+)`),
	regexp.MustCompile(`confidence[^:]*:\s*(0\.\d+)`),
}

// isConfidenceGated reports whether a node participates in the confidence
// gate when deps.ConfidenceGate is non-nil.
//
//   - tool and connector: always gated (always side-effecting).
//   - ai-step: opt-in via node.Data["requiresConfidence"] = true, for
//     action-driving steps whose LLM output is itself an instruction to act.
//   - all other types: never gated (trigger, condition, end, loop, approval,
//     subagent all have their own execution semantics).
func isConfidenceGated(node Node) bool {
	switch node.Type {
	case "tool", "connector":
		return true
	case "ai-step":
		v, _ := node.Data["requiresConfidence"].(bool)
		return v
	default:
		return false
	}
}

// runConfidenceGate evaluates confidence for node and blocks on human
// approval when below threshold. Returns nil to proceed with execution,
// or an error when approval is denied or the wait fails.
//
// Precondition: deps.ConfidenceGate != nil && isConfidenceGated(node).
// Callers (executeNode) must check both conditions before calling.
func runConfidenceGate(ctx context.Context, runID string, deps Deps, emit emitFn, node Node, vars map[string]any) error {
	gate := deps.ConfidenceGate
	score := gate.Estimator.Estimate(ctx, node, vars)
	threshold := gate.Threshold

	decision := "execute"
	if score < threshold {
		decision = "divert"
	}

	// Always emit the evaluation result so the run waterfall can display it.
	emit("confidence_evaluated", node.ID, map[string]any{
		"score":     score,
		"threshold": threshold,
		"decision":  decision,
		"node_type": node.Type,
		// ponytail: remove estimator tag once a calibrated estimator ships
		"estimator": "verbalization_heuristic",
	})

	if decision != "divert" {
		return nil
	}

	reason := fmt.Sprintf(
		"confidence %.2f below threshold %.2f for %s node %q — human review required",
		score, threshold, node.Type, node.ID,
	)

	if deps.WaitForApproval == nil {
		// Same auto-approve contract as the approval node when no handler is wired:
		// record the bypass and proceed so unattended workflows still complete.
		emit("confidence_gate_bypassed", node.ID, map[string]any{
			"reason": "no WaitForApproval handler wired; auto-approving",
			"score":  score,
		})
		return nil
	}

	disposition, err := deps.WaitForApproval(ctx, runID, node.ID, reason)
	if err != nil {
		return fmt.Errorf("confidence gate: approval wait failed: %w", err)
	}
	if !disposition.Granted {
		return fmt.Errorf("confidence gate: not approved: %s", disposition.Reason)
	}
	return nil // granted — caller proceeds to execute the node
}
