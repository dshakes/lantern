import { Concept } from "../_components/Concept";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/human-in-the-loop");

export default function HumanInTheLoopPage() {
  return (
    <>
      <h1>Human-in-the-loop</h1>
      <p>
        Two ways to put a person in a workflow:{" "}
        <strong>approval nodes</strong> you place yourself, and the{" "}
        <strong>confidence gate</strong> (off by default), which diverts
        low-confidence steps to a person. Both record the decision through the
        takeover API.
      </p>

      <Concept>
        Some actions should not run unattended: mailing 500 customers, issuing
        a refund, deleting records. The run stops there and asks a person.
        Place the checkpoint yourself, or let the confidence gate add one when
        the agent seems unsure. While it waits, the run is parked and holds no
        worker.
      </Concept>

      <h2 id="approval">Approval workflow nodes</h2>
      <p>
        In the visual workflow editor, an <code>approval</code> node pauses
        execution until a human acts. The run moves to{" "}
        <code>status: &apos;waiting&apos;</code>, the executing goroutine exits,
        and a <code>takeover_requests</code> row is created. The request
        expires after <strong>30 minutes</strong> by default (pass{" "}
        <code>timeoutMinutes</code>, max 1440).
      </p>

      <h3>Takeover API</h3>
      <pre>
        <code>{`# Create a pending takeover row (done by the workflow node automatically,
# or manually by an operator)
POST /v1/runs/{id}/takeover/request
{ "reason": "About to send email to 500 users", "stepId": "send", "timeoutMinutes": 60 }
→ { "id": "tk-uuid", "status": "pending", "expiresAt": "..." }

# List takeover requests for a run
GET /v1/runs/{id}/takeover
→ [{ "id": "tk-uuid", "status": "pending", "reason": "...", "expiresAt": "..." }]

# Operator approves (optional notes; optional SDP offer for WebRTC takeover)
POST /v1/runs/{id}/takeover/{tkId}/grant
{ "notes": "ok to send", "sdpOffer": "v=0\r\n..." }

# Operator denies: the approval node fails (step_failed) and so does the run
POST /v1/runs/{id}/takeover/{tkId}/deny
{ "notes": "not now" }

# Browser-side SDP answer (for live WebRTC session)
POST /v1/runs/{id}/takeover/{tkId}/answer
{ "sdpAnswer": "v=0\r\n..." }

# Release — the run is re-queued and resumes from the approval node
POST /v1/runs/{id}/takeover/{tkId}/release`}</code>
      </pre>

      <div className="callout callout-info">
        <strong>Parked, not spinning.</strong> A run in <code>waiting</code>{" "}
        status holds no goroutine, so a long wait costs no compute. On release
        the interpreter replays the graph and skips every step already
        completed in the journal, resuming at the approval node. The SDP
        fields exist for live WebRTC takeover, but the microVM video stream
        is not wired yet; the grant, release and resume path is. A paused
        child run fails its parent step; nested approvals do not work yet.
      </div>

      <h2 id="confidence-gate">Confidence gate</h2>
      <p>
        Off by default. Set <code>LANTERN_CONFIDENCE_GATE=1</code> to turn it
        on. Before a side-effecting node runs, the interpreter scores it. Below
        the threshold (<code>LANTERN_CONFIDENCE_GATE_THRESHOLD</code>, default
        0.75) the step goes to human approval instead of executing. If no
        approval handler is wired, the step auto-approves so unattended
        workflows still finish.
      </p>

      <h3>Gated node types</h3>
      <ul>
        <li>
          <strong><code>tool</code></strong> and{" "}
          <strong><code>connector</code></strong> — always gated when the
          feature is on
        </li>
        <li>
          <strong><code>ai-step</code></strong> — only gated when{" "}
          <code>node.Data["requiresConfidence"] = true</code>
        </li>
      </ul>

      <h3>Estimators</h3>
      <p>
        Select the estimator with{" "}
        <code>LANTERN_CONFIDENCE_ESTIMATOR</code>:
      </p>
      <table>
        <thead>
          <tr>
            <th>Estimator</th>
            <th>How it scores</th>
            <th>Failure mode</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>verbalization</code> (default)</td>
            <td>
              Scans prior step text for self-reported confidence ("Confidence:
              85%"). Falls back to 0.9 when none found.
            </td>
            <td>
              Silence → 0.9 → auto-execute. A model that hallucinates an action
              also writes "confidence: 95%".
            </td>
          </tr>
          <tr>
            <td><code>self-consistency</code></td>
            <td>
              Re-poses the pending action to the model{" "}
              <code>LANTERN_CONFIDENCE_SAMPLES</code> times (default 5) as a
              fresh YES/NO judgment. Returns the fraction voting "execute".
              Consensus → high; split vote → low → divert.
            </td>
            <td>
              Safer: silence is actively probed. Falls back to verbalization
              heuristic when no LLM sampler is wired.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Outcome calibration</h3>
      <p>
        Off by default; <code>LANTERN_CONFIDENCE_CALIBRATE=1</code> enables it. Wraps the
        base estimator and lowers its score by the realized{" "}
        <strong>regret rate</strong> — the fraction of auto-executed steps of
        that type later thumbs-downed (feedback score ≤ 2) or ending in a
        failed run:{" "}
        <code>adjusted = base × (1 − regret)</code>. Action types that have
        gone wrong get gated harder over time. Fail-safe: any error or
        fewer than 3 samples → regret 0 → base unchanged.
      </p>

      <h3>Journal events</h3>
      <p>
        Every gated step emits a <code>confidence_evaluated</code> journal event
        with <code>{"{ score, threshold, decision (\"execute\" | \"divert\"), node_type, estimator }"}</code>.
        A diverted step emits <code>step_completed</code> once approved, or{" "}
        <code>step_failed</code> if denied.
      </p>

      <h3>Env vars</h3>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Default</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>LANTERN_CONFIDENCE_GATE</code></td>
            <td>off</td>
            <td><code>1</code>/<code>true</code>/<code>on</code> enables gating</td>
          </tr>
          <tr>
            <td><code>LANTERN_CONFIDENCE_GATE_THRESHOLD</code></td>
            <td><code>0.75</code></td>
            <td>Minimum score [0,1] for auto-execution</td>
          </tr>
          <tr>
            <td><code>LANTERN_CONFIDENCE_ESTIMATOR</code></td>
            <td><code>verbalization</code></td>
            <td><code>self-consistency</code> to poll for independent agreement</td>
          </tr>
          <tr>
            <td><code>LANTERN_CONFIDENCE_SAMPLES</code></td>
            <td><code>5</code></td>
            <td>Independent judgments for self-consistency (clamped [1,9])</td>
          </tr>
          <tr>
            <td><code>LANTERN_CONFIDENCE_CALIBRATE</code></td>
            <td>off</td>
            <td><code>1</code> wraps the estimator in outcome-regret calibration</td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info">
        <strong>Rollout order.</strong> Enable the gate on non-production
        agents first. Inspect <code>confidence_evaluated</code> events in the
        run waterfall. Switch to <code>self-consistency</code> and tune
        threshold / samples. Then production.
      </div>
    </>
  );
}
