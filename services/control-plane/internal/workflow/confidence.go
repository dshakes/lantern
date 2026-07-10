package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Sampler runs one independent LLM turn for the self-consistency estimator.
// It is the interpreter's tenant-scoped Deps.CallLLM (same signature), passed
// through at the gate call site. Nil when no LLM is wired — estimators MUST
// tolerate a nil sampler and degrade gracefully rather than panic.
type Sampler func(ctx context.Context, prompt string, capability string) (string, error)

// ConfidenceEstimator evaluates how confident the system is that a
// side-effecting workflow step should auto-execute. The interface is the
// clean seam for a calibrated estimator (self-consistency sampling,
// logit-based scoring per arXiv 2602.05073 / 2601.15778) to replace the
// verbalization heuristic without changing the interpreter.
type ConfidenceEstimator interface {
	// Estimate returns a confidence score in [0, 1]. 1.0 = fully confident,
	// 0.0 = no confidence. Must not block longer than the step timeout and
	// must tolerate a nil sample (no LLM available) without panicking.
	Estimate(ctx context.Context, node Node, vars map[string]any, sample Sampler) float64
	// Name identifies the estimator in the confidence_evaluated journal event
	// so a run's waterfall shows which signal gated the step.
	Name() string
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

// Name identifies this estimator in the confidence_evaluated event.
func (v VerbalizationHeuristic) Name() string { return "verbalization_heuristic" }

// Estimate scans all prior step text outputs for verbalized confidence
// patterns. Returns DefaultConfidence (effective default: 0.9) when none
// are found. The sampler is unused — this estimator never calls the model.
func (v VerbalizationHeuristic) Estimate(_ context.Context, _ Node, vars map[string]any, _ Sampler) float64 {
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

// SelfConsistencyEstimator scores confidence from the model's INDEPENDENT
// agreement that an action is correct — not from a number the model volunteers
// about itself. It re-poses the pending action to the model N times as a fresh
// yes/no judgment and returns the fraction that vote "execute". Consensus →
// high confidence; a split vote → low → the step diverts to human approval.
//
// Why this over the verbalization heuristic: a model that hallucinates an
// action will also happily write "Confidence: 95%" about it, so scraping the
// self-report gates real side-effects on a number the model invents. Polling
// for agreement is harder to game — an unsound action tends to draw a split
// vote across independent samples. Critically, it fixes the heuristic's
// dangerous default: silence (no verbalized signal) no longer means 0.9
// auto-execute; here silence is actively probed.
//
// This is grounded self-consistency, NOT yet statistical calibration against
// realized false-execution rates — that requires the outcome feedback loop
// (see docs/adr/0021 + docs/architecture/18-agent-runtime-nextgen.md, Phase 1).
// The Fallback preserves exact prior behavior whenever no LLM is wired.
type SelfConsistencyEstimator struct {
	// Samples is the number of independent judgments. Clamped to [1, 9];
	// defaults to 5. Each is one LLM call, so N trades cost/latency for signal.
	Samples int
	// Capability is the model capability used for the judgment calls. A small,
	// fast reasoning model is appropriate; defaults to "reasoning-small".
	Capability string
	// Fallback estimates confidence when no sampler is wired, the action can't
	// be described, or every sample call fails — so degradation is graceful and
	// never a hard failure of the run. Defaults to VerbalizationHeuristic{}.
	Fallback ConfidenceEstimator
}

// Name identifies this estimator in the confidence_evaluated event.
func (s SelfConsistencyEstimator) Name() string { return "self_consistency" }

// Estimate polls the model for independent agreement that the node's action is
// correct to execute now, returning the fraction voting "execute". Falls back
// to s.fallback() when the action can't be described or no sampler is wired.
// If a verbalized self-doubt signal is present in prior steps and is LOWER than
// the consensus, the lower value wins (the model's own caution is honored).
func (s SelfConsistencyEstimator) Estimate(ctx context.Context, node Node, vars map[string]any, sample Sampler) float64 {
	action := describeAction(node)
	if sample == nil || action == "" {
		return s.fallback().Estimate(ctx, node, vars, sample)
	}

	n := s.Samples
	if n < 1 {
		n = 5
	}
	if n > 9 {
		n = 9
	}
	capability := s.Capability
	if capability == "" {
		capability = "reasoning-small"
	}
	prompt := buildSelfConsistencyPrompt(action, recentContext(vars))

	var execVotes, usable int
	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			break // step timeout / cancellation — score what we have
		}
		out, err := sample(ctx, prompt, capability)
		if err != nil {
			continue
		}
		if vote, ok := parseYesNo(out); ok {
			usable++
			if vote {
				execVotes++
			}
		}
	}
	if usable == 0 {
		// Every sample failed or was unparseable — don't fabricate a score.
		return s.fallback().Estimate(ctx, node, vars, sample)
	}

	consensus := float64(execVotes) / float64(usable)
	// Honor the model's OWN expressed doubt when it is more cautious than the
	// consensus: a low verbalized signal can only lower confidence, never raise
	// it (never let self-report override a skeptical independent vote).
	if steps, ok := vars["steps"].(map[string]any); ok {
		for _, out := range steps {
			if str, ok := out.(string); ok && str != "" {
				if v, found := parseVerbalized(str); found && v < consensus {
					consensus = v
				}
			}
		}
	}
	return consensus
}

func (s SelfConsistencyEstimator) fallback() ConfidenceEstimator {
	if s.Fallback != nil {
		return s.Fallback
	}
	return VerbalizationHeuristic{}
}

// describeAction renders a concise, human-readable description of the
// side-effecting action a node is about to perform, for the self-consistency
// judgment. Returns "" when the node carries no describable action (the
// estimator then falls back rather than judge an empty action).
func describeAction(node Node) string {
	get := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := node.Data[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	argsJSON := func() string {
		if a, ok := node.Data["args"]; ok {
			if b, err := json.Marshal(a); err == nil && len(b) > 2 && len(b) < 1200 {
				return " with args " + string(b)
			}
		}
		return ""
	}

	switch node.Type {
	case "tool":
		if name := get("tool", "name"); name != "" {
			return "run the tool \"" + name + "\"" + argsJSON()
		}
	case "connector":
		conn := get("connector", "connectorId", "name")
		act := get("action")
		if conn != "" || act != "" {
			return "call connector \"" + conn + "\" action \"" + act + "\"" + argsJSON()
		}
	case "ai-step":
		// The "action" is the step's own instruction/output that will drive a
		// downstream effect (only reached when requiresConfidence is set).
		if p := get("prompt", "instruction", "output"); p != "" {
			return "act on this step: " + truncate(p, 800)
		}
		if label := get("label"); label != "" {
			return "act on step \"" + label + "\""
		}
	}
	return ""
}

// recentContext returns a short slice of prior step output to ground the
// judgment — the reasoning that led to this action. Best-effort and bounded;
// map iteration order is non-deterministic but this is context, not the
// decision, so ordering is immaterial.
func recentContext(vars map[string]any) string {
	steps, ok := vars["steps"].(map[string]any)
	if !ok {
		return ""
	}
	for _, out := range steps {
		if s, ok := out.(string); ok && strings.TrimSpace(s) != "" {
			return truncate(strings.TrimSpace(s), 600)
		}
	}
	return ""
}

// buildSelfConsistencyPrompt asks for a single, decisive YES/NO judgment. The
// framing is deliberately skeptical ("safe and correct to execute RIGHT NOW")
// so an unsound action draws NO votes across the independent samples.
func buildSelfConsistencyPrompt(action, context string) string {
	var b strings.Builder
	b.WriteString("You are an independent safety reviewer for an AI agent about to take a real, side-effecting action.\n\n")
	b.WriteString("Action the agent is about to take:\n")
	b.WriteString(action)
	b.WriteString("\n")
	if context != "" {
		b.WriteString("\nContext that led here:\n")
		b.WriteString(context)
		b.WriteString("\n")
	}
	b.WriteString("\nIs this action safe and correct to execute RIGHT NOW, with no further human confirmation? Consider whether it is well-specified, targets the right recipient/resource, and is not premature, ambiguous, or irreversible-when-uncertain.\n")
	b.WriteString("Answer with exactly one word on the first line: YES or NO. Then one short sentence of reasoning.")
	return b.String()
}

// parseYesNo extracts a boolean execute-vote from a judgment reply. Returns
// (vote, true) when the reply clearly starts with yes/no; (false, false) when
// it can't be read (that sample is discarded, not counted as a NO).
func parseYesNo(s string) (bool, bool) {
	t := strings.TrimSpace(strings.ToLower(s))
	t = strings.TrimLeft(t, "*_->#`\"' \t\n")
	switch {
	case strings.HasPrefix(t, "yes"):
		return true, true
	case strings.HasPrefix(t, "no"):
		return false, true
	}
	return false, false
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
	// Pass the tenant-scoped LLM caller so a sampling estimator can poll for
	// independent agreement. deps.CallLLM may be nil (no LLM wired) — estimators
	// tolerate that and degrade to their non-sampling fallback.
	score := gate.Estimator.Estimate(ctx, node, vars, deps.CallLLM)
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
		"estimator": gate.Estimator.Name(),
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
