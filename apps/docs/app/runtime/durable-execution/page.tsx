export default function RuntimeDurableExecutionPage() {
  return (
    <>
      <h1>Durable Execution</h1>
      <p>
        A headless agent can run for minutes and call an LLM dozens of times.
        Nodes get preempted, pods get evicted, processes crash. Durable
        execution is the guarantee that a crash mid-run does not lose work,
        re-spend tokens, or fire a side effect twice — the run is{" "}
        <strong>exactly-once</strong>, not at-least-once.
      </p>

      <h2 id="journal">Event-sourced journal</h2>
      <p>
        Work is decomposed into <strong>steps</strong>, and every step
        transition is appended to an event-sourced journal before the next step
        begins. The journal — not in-memory state — is authoritative. Anything
        that can take longer than ~100ms or calls an LLM is a step, and each
        step is idempotent and replayable.
      </p>
      <pre><code>{`run        step           journal events
────────────────────────────────────────────────
run_1      step_a         step_started → step_completed
run_1      step_b         step_started → step_completed
run_1      step_c         step_started   ◀── crash here
                          (no step_completed written)`}</code></pre>

      <h2 id="resume">Resume from the last completed step</h2>
      <p>
        On recovery the engine replays the journal and resumes from the last{" "}
        <code>step_completed</code>. In the trace above, <code>step_a</code> and{" "}
        <code>step_b</code> are <strong>not re-executed</strong> — their results
        are read back from the journal — and execution restarts at{" "}
        <code>step_c</code>. Completed LLM calls are not re-issued, so{" "}
        <strong>their tokens are not re-spent</strong>.
      </p>

      <h2 id="idempotency">Side-effect dedup via idempotency keys</h2>
      <p>
        Replaying a step that performs an external side effect — a model API
        call, a webhook delivery, a Kubernetes create — must not duplicate it.
        Every external side effect carries an idempotency key derived from the
        tuple:
      </p>
      <pre><code>{`idempotency_key = (run_id, step_id, attempt)`}</code></pre>
      <p>
        Because the key is stable across replays of the same step, a retried
        delivery is recognized and de-duplicated downstream rather than sent
        twice. This is what makes "resume from last step" safe even when a step
        had already reached out to the outside world before crashing.
      </p>

      <div className="callout callout-info">
        <strong>Note:</strong> Steps must be written to be idempotent — same
        inputs, same effect. The idempotency key protects the{" "}
        <em>delivery</em>; authoring the step to tolerate replay is the other
        half of the contract.
      </div>

      <h2 id="recovery">Recovery watchdog</h2>
      <p>
        A run is leased to a worker. If that worker dies without releasing the
        lease, a <strong>recovery watchdog</strong> detects the expired lease
        and re-schedules the run onto a healthy node, where it replays the
        journal and continues. No human intervention, no lost run.
      </p>

      <h2 id="ha">Scheduler HA</h2>
      <p>
        The scheduler itself is not a single point of failure. Placement state
        is durable, and a replacement scheduler instance picks up pending and
        in-flight work without re-placing what is already running. Combined with
        the watchdog, a node loss degrades to a brief resume rather than a
        failed run.
      </p>

      <h2 id="takeaway">Why it matters</h2>
      <ul>
        <li><strong>No double-spend.</strong> Completed LLM steps are replayed from the journal, never re-billed.</li>
        <li><strong>No double-send.</strong> Idempotency keys de-dup external side effects across retries.</li>
        <li><strong>No babysitting.</strong> The watchdog + HA scheduler recover crashed runs automatically.</li>
      </ul>
      <p>
        Each resume is still one trace per spawn — see{" "}
        <a href="/runtime/observability">Observability</a> — and a completed
        run&apos;s journal is what the <a href="/runtime/receipts">verifiable
        receipt</a> is signed over.
      </p>
    </>
  );
}
