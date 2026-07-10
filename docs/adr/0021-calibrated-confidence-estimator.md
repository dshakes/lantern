# ADR 0021 — Self-consistency confidence estimator for gated execution

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Shekhar Mudarapu, control-plane, agent-runtime
- **Relates to:** Confidence-gated execution (`LANTERN_CONFIDENCE_GATE`), `docs/architecture/18-agent-runtime-nextgen.md`, invariant #10 (secrets), the Phase-1 outcome-feedback loop

## Context

Before a side-effecting workflow node (`tool`, `connector`, or an `ai-step`
flagged `requiresConfidence`) auto-executes, the interpreter can score a
confidence in `[0,1]` and divert steps below `LANTERN_CONFIDENCE_GATE_THRESHOLD`
(default `0.75`) to human approval (`internal/workflow/confidence.go`).

The only estimator was `VerbalizationHeuristic`: it scrapes the model's own
self-reported number from prior step text ("Confidence: 85%") and, when none is
present, returns `DefaultConfidence = 0.9`. Two problems make this the wrong
thing to gate real side-effects (emails, money, sending documents) on:

1. **It is trivially gamed.** A model that hallucinates an action will also
   cheerfully write "Confidence: 95%" about it. Self-reported confidence is
   famously uncalibrated; scraping it measures the model's willingness to assert,
   not the soundness of the action.
2. **Its default is "auto-execute."** `0.9 > 0.75`, so any step where the model
   volunteers no confidence signal clears the gate. Silence — the common case —
   means auto-fire. For a system that now sends passports and touches money, the
   safe default should be caution, not confidence.

The interface comment already named the intended successor ("self-consistency
sampling, logit-based scoring"), and the interpreter already exposes a
tenant-scoped LLM caller (`Deps.CallLLM`) at the gate call site.

## Decision

Add a second estimator, `SelfConsistencyEstimator`, selectable via
`LANTERN_CONFIDENCE_ESTIMATOR=self-consistency`. It scores confidence from the
model's **independent agreement** that an action is correct, not from a number
the model volunteers about itself:

- Re-pose the pending action to the model `N` times
  (`LANTERN_CONFIDENCE_SAMPLES`, default 5, clamped `[1,9]`) as a fresh,
  deliberately skeptical **YES/NO** judgment ("is this safe and correct to
  execute RIGHT NOW, no further confirmation?").
- Confidence = fraction voting "execute". Consensus → high; a split vote → low →
  divert. An unsound action tends to draw a split vote across independent samples,
  which is harder to game than a single self-report.
- If a prior verbalized self-doubt signal is **lower** than the consensus, the
  lower value wins (`min`): the model's own caution can only lower confidence,
  never raise it.

To make this a change the interface can express, `ConfidenceEstimator` gains a
nil-safe `sample Sampler` parameter (the gate passes `Deps.CallLLM`, which may be
nil) and a `Name()` method (so `confidence_evaluated` tags which signal gated the
step). `VerbalizationHeuristic` ignores the sampler and remains the default.

```
                 side-effecting node (tool / connector / ai-step*)
                                    │
                     ┌──────────────┴───────────────┐
   LANTERN_CONFIDENCE_ESTIMATOR                       │  Deps.CallLLM (nil-safe)
                     │                                │
        ┌────────────┴─────────────┐                  │
        ▼                          ▼                  │
 verbalization_heuristic     self_consistency ────────┘
 (scrape "conf: 85%",        poll model N× ── YES/NO ── vote
  silence → 0.9)             consensus = execVotes / usable
        │                    min(consensus, verbalized-doubt)
        │                          │   fallback ↓ (nil sampler /
        └───────────┬──────────────┘   no describable action / all fail)
                    ▼
         score  <  threshold ?  ──yes──►  divert to human approval
                    │
                    no
                    ▼
                 execute
```

**Fail-safe by construction.** The self-consistency estimator falls back to the
verbalization heuristic whenever `sample` is nil (no LLM wired), the action can't
be described, or every sample call fails — so enabling it never hard-fails a run
and preserves exact prior behavior in degraded conditions. Prompts carry only the
action description + prior step context; no secret material (invariant #10).

## Consequences

- **Positive.** Gating no longer rests on a self-reported number; silence is
  actively probed instead of defaulting to auto-execute; the estimator is
  opt-in and always-safe to enable.
- **Cost.** Each gated step now makes up to `N` extra LLM judgment calls when
  self-consistency is on. `N` is clamped `[1,9]`; use a small capability and tune
  per traffic. The verbalization default is unchanged (zero extra calls).
- **Scope / what this is NOT.** This is *grounded* self-consistency, not yet
  *statistical calibration* against realized false-execution rates. True
  calibration — scoring the estimator against this tenant's auto-executed →
  thumbs-down history per action type — requires reading outcome data back, which
  is the Phase-1 "close the write-only feedback loop" work (`feedback.go`,
  `rehearse.go`, forecast records are all write-only today). The `Sampler`/`Name`
  seam and the `confidence_evaluated` telemetry are the substrate that phase
  builds on.

## Alternatives considered

- **Flip the heuristic default below threshold.** Making "no signal" divert would
  break every existing unattended flow (which is why `0.9` was chosen). Adding a
  real signal is better than inverting a bad default.
- **Logit/entropy-based confidence.** Stronger in principle but needs token
  logprobs the model-router path doesn't surface uniformly across providers.
  Deferred; the interface accommodates it later.

## Update — Phase 1 (outcome calibration) implemented

The "close the write-only feedback loop" work named above is now shipped:
`CalibratedEstimator` (`internal/workflow/confidence.go`) wraps any base
estimator and lowers its score by the realized **regret rate** for this
`(agent, node_type)` — the fraction of auto-executed steps later thumbs-downed
(`run_feedback.score <= 2`) or ended in a `failed` run — via
`adjusted = base × (1 − regret)`, clamped `[0,1]`, never raising. The regret
lookup (`internal/handlers/confidence_calibration.go`) is tenant-scoped
(`db.WithTenantConn`, RLS-safe), 5-min cached, min-3-sample guarded, and
fail-safe (no data / any error → regret 0 → base unchanged). Opt-in via
`LANTERN_CONFIDENCE_CALIBRATE`; default OFF. This makes the self-consistency
signal *outcome-calibrated* rather than merely grounded.
