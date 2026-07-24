import Link from "next/link";
import { Diagram } from "../../_components/Diagram";

export default function RuntimeDurableExecutionPage() {
  return (
    <>
      <h1>Durable Execution</h1>
      <p>
        A crash mid-run does not lose work, re-spend tokens, or fire a side
        effect twice. Both the shared tier (inline executor) and the microVM
        tier guarantee exactly-once completion through the same mechanism: an
        event-sourced <code>journal_events</code> table and a{" "}
        <code>CompletedStep</code> replay gate.
      </p>

      <Diagram
        name="durable-execution"
        caption="Crash-resume: the recovery sweep wins a run_locks UPSERT, re-drives the run, and the CompletedStep hook skips nodes that already have a step_completed row."
      />

      <h2 id="journal">Event-sourced journal</h2>
      <p>
        Every step transition is appended to <code>journal_events</code> before
        the next step begins. The journal — not in-memory state — is
        authoritative. On the shared tier the inline executor writes these
        events directly; on the microVM tier the harness streams them to the
        manager via the <code>RuntimeHarness.Report</code> RPC, which writes to
        the same table.
      </p>
      <pre><code>{`run        step           journal events
────────────────────────────────────────────────
run_1      step_a         step_started → step_completed
run_1      step_b         step_started → step_completed
run_1      step_c         step_started   ◀── crash here
                          (no step_completed written)`}</code></pre>
      <p>
        Other event kinds you will see in the waterfall:{" "}
        <code>step_retrying</code> (between retry attempts),{" "}
        <code>step_waiting</code> (run parked at an approval node),{" "}
        <code>anomaly_detected</code> (token budget breach),{" "}
        <code>confidence_evaluated</code> (confidence gate decision, when
        enabled), and <code>confidence_gate_bypassed</code> (gating is on but
        no handler is wired — step auto-approves).
      </p>

      <h2 id="completedstep">CompletedStep replay</h2>
      <p>
        The workflow interpreter receives a <code>CompletedStep</code> hook
        wired to <code>journalCompletedStep</code>. Before invoking any
        side-effecting node (<code>ai-step</code>, <code>tool</code>,{" "}
        <code>connector</code>, <code>subagent</code>, <code>approval</code>)
        the interpreter queries <code>journal_events</code> for an existing{" "}
        <code>step_completed</code> row. If one is found, the cached output is
        returned and the underlying side-effect is never re-invoked.
      </p>
      <p>
        The plain-LLM path has the equivalent <code>checkCachedLLMStep</code>{" "}
        cache: before calling the model router, the executor checks the journal
        for a previous successful LLM step for this run. If found, it replays
        the cached response — the provider is never contacted again.
      </p>
      <div className="callout callout-tip">
        <strong>No re-spent tokens on crash-replay.</strong> Completed LLM
        steps are read back from the journal. The provider sees only the
        original call, not a retry.
      </div>

      <h2 id="resume">Resume from the last completed step</h2>
      <p>
        On re-drive, the interpreter walks the graph from the trigger node
        again. Nodes that already have a <code>step_completed</code> row are
        skipped via the <code>CompletedStep</code> hook. Execution continues
        from the first incomplete node. This is idempotent: a re-drive that
        re-walks an already-finished graph is a no-op.
      </p>

      <h2 id="idempotency">Side-effect dedup via idempotency keys</h2>
      <p>
        Every external side effect carries a key derived from a one-way hash of
        the three identifiers, pipe-delimited:
      </p>
      <pre><code>{`idempotency_key = sha256("runID|stepID|attempt")`}</code></pre>
      <p>
        <strong>LLM provider calls</strong> receive an{" "}
        <code>Idempotency-Key</code> HTTP header on every request to OpenAI and
        Anthropic (derived in <code>internal/handlers/llm_idempotency.go</code>
        via a one-way hash — the key never carries secret material). A crash
        then replay to the same provider dedups at the provider instead of
        double-billing.
      </p>
      <p>
        <strong>Connector and tool calls</strong> claim a{" "}
        <code>side_effect_receipts</code> row before dispatching. A re-drive
        that reaches the same step finds the receipt and short-circuits without
        re-invoking the connector.
      </p>
      <div className="callout callout-info">
        <strong>Steps must be idempotent by authorship.</strong> The
        idempotency key protects the <em>delivery</em>; writing the step to
        tolerate re-invocation is the other half of the contract.
      </div>

      <h2 id="recovery">Shared-tier recovery sweep</h2>
      <p>
        The shared tier uses <code>run_locks</code> to detect orphaned runs.
        Each in-flight run holds a lock row{" "}
        <code>(run_id, worker_id, expires_at)</code>. A background loop —{" "}
        <code>RunRecoveryLoop</code> — runs every 30 s (override:{" "}
        <code>LANTERN_RECOVERY_INTERVAL</code>; set <code>"0"</code> or{" "}
        <code>"off"</code> to disable). Each pass:
      </p>
      <div className="flow">
        <div className="flow-step">
          <div className="flow-dot">1</div>
          <div className="flow-body">
            <div className="flow-name">Find orphans</div>
            <div className="flow-sub">SELECT runs WHERE status IN ('running','queued') AND (no lock row OR lock expired). Capped at 20 runs per pass.</div>
          </div>
        </div>
        <div className="flow-step">
          <div className="flow-dot">2</div>
          <div className="flow-body">
            <div className="flow-name">Lease steal (distributed guard)</div>
            <div className="flow-sub">UPSERT run_locks with a fresh 10-minute TTL. Only the replica that wins the UPSERT proceeds; others skip silently — no thundering-herd double-execution.</div>
          </div>
        </div>
        <div className="flow-step">
          <div className="flow-dot">3</div>
          <div className="flow-body">
            <div className="flow-name">Re-drive</div>
            <div className="flow-sub">Winner calls redriveRun → runWorkflowIfPresent (graph) or executeRunInlineSync (plain LLM). The CompletedStep hook skips already-finished nodes.</div>
          </div>
        </div>
        <div className="flow-step">
          <div className="flow-dot">4</div>
          <div className="flow-body">
            <div className="flow-name">Resume</div>
            <div className="flow-sub">Interpreter continues at the first node without a step_completed row. No node that already completed is ever re-invoked.</div>
          </div>
        </div>
      </div>
      <div className="callout callout-info">
        <strong>MicroVM runs are handled separately by the recovery sweep.</strong>{" "}
        When the sweep finds an orphaned microVM run it calls{" "}
        <code>resumeMicroVMRun</code> — see{" "}
        <a href="#microvm-resume">MicroVM-tier crash-resume</a> below — rather
        than re-driving it via the shared-tier inline executor. The two paths are
        distinct to avoid racing with the scheduler&apos;s own state machine.
      </div>

      <h2 id="ha">Scheduler HA (microVM tier)</h2>
      <p>
        On the microVM tier, the scheduler itself is not a single point of
        failure. Placement state is durable, and a replacement scheduler picks
        up pending and in-flight work. For VMs with{" "}
        <code>idempotent: true</code> and a recent snapshot, the scheduler
        issues a fresh <code>Spawn</code> on another node. Non-idempotent VMs
        are marked failed and the caller is notified via the event stream.
      </p>

      <h2 id="retry">Per-step retry policy</h2>
      <p>
        Workflow nodes can declare a retry policy in{" "}
        <code>node.Data["retry"]</code>:
      </p>
      <pre><code>{`{
  "retry": {
    "maxAttempts": 3,
    "backoffMs": 500,
    "retryableClasses": ["llm", "connector"]
  }
}`}</code></pre>
      <p>
        <code>maxAttempts</code> is the total number of attempts including the
        first (default <code>1</code> = no retry). Between attempts the
        interpreter journals a <code>step_retrying</code> event with{" "}
        <code>{"{attempt, of, error}"}</code> — visible in the run waterfall.
        Retryable classes: <code>any</code>, <code>timeout</code>,{" "}
        <code>llm</code>, <code>connector</code>, <code>tool</code>.
      </p>
      <p>
        Retry wraps <code>executeNode</code> <em>outside</em> the{" "}
        <code>CompletedStep</code> check. A crash-replay skips a node only when
        it has a <code>step_completed</code> row — it does not re-retry a node
        that was mid-retry when the crash happened.
      </p>

      <h2 id="microvm-resume">MicroVM-tier crash-resume</h2>
      <p>
        The recovery sweep handles microVM runs separately from shared-tier
        runs. When the sweep finds an orphaned <code>microvm</code> run (no live
        VM, lock expired), it calls <code>resumeMicroVMRun</code>:
      </p>
      <ol>
        <li>
          If a live (non-terminal) VM exists for this run — skip. The VM is
          self-managing.
        </li>
        <li>
          Count all <code>runtime_vms</code> rows for this run (total VMs ever
          spawned = resume attempts).
        </li>
        <li>
          If <code>attempts &ge; 3</code> — mark the run{" "}
          <code>failed</code> with code{" "}
          <code>microvm_resume_exhausted</code>. No further retries.
        </li>
        <li>
          Otherwise — re-schedule a new VM via the dispatcher, injecting{" "}
          <code>LANTERN_RESUME=1</code> in the environment.
        </li>
      </ol>
      <pre><code>{`# environment injected into the re-scheduled VM
LANTERN_RESUME=1`}</code></pre>
      <p>
        The in-VM agent reads <code>LANTERN_RESUME</code> and consults the
        journal <code>CompletedStep</code> cache to skip already-completed
        nodes, then continues from the first incomplete node. The 3-attempt cap
        is a hard constant (<code>maxMicroVMResumeAttempts = 3</code>) — on
        exhaustion the run is permanently failed and the dashboard shows a{" "}
        <code>step_failed</code> event with{" "}
        <code>code: microvm_resume_exhausted</code>.
      </p>

      <h2 id="takeaway">Why it matters</h2>
      <ul>
        <li><strong>No double-spend.</strong> LLM steps are replayed from the journal, never re-billed at the provider.</li>
        <li><strong>No double-send.</strong> Idempotency keys and <code>side_effect_receipts</code> de-dup external side effects across retries.</li>
        <li><strong>No babysitting.</strong> The 30s recovery sweep and the microVM scheduler HA recover crashed runs without intervention.</li>
        <li><strong>Retry visibility.</strong> <code>step_retrying</code> events appear in the waterfall so you see exactly how many attempts a step took.</li>
      </ul>
      <p>
        Each resume is still one trace per span — see{" "}
        <Link href="/runtime/observability">Observability</Link> — and the
        completed run&apos;s journal is what the{" "}
        <Link href="/runtime/receipts">verifiable receipt</Link> is signed over.
      </p>
    </>
  );
}
