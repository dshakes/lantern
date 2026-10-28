import { Concept } from "../_components/Concept";

export default function ExamplesPage() {
  return (
    <>
      <h1>Examples</h1>
      <p>
        Runnable, end-to-end examples under <code>examples/</code> in the repo. Each has a README with try-it steps
        and an e2e test that proves it works.
      </p>

      <Concept>
        An example is a whole working setup, not a snippet: the agent definition, the data it needs, and a test that
        fails if the example stops working.
      </Concept>

      <h2 id="support-desk">Support desk</h2>
      <p>
        A webchat agent that answers from your docs (with the source shown), and hands the conversation to a human
        when it cannot answer, pinging Slack. Path: <code>examples/support-desk/</code>. See{" "}
        <a href="/knowledge">Knowledge base &amp; human handoff</a> for the APIs.
      </p>
      <pre><code>{`make dev-infra && make run-api          # terminal 1
python3 examples/support-desk/setup.py   # creates the agent, uploads the docs
# create an API key with scope runs:execute, then open examples/support-desk/demo.html`}</code></pre>
      <p>
        Try it: ask <em>How do I reset my password?</em> (a cited answer), then <em>I want a refund</em> (the widget
        shows &quot;Connecting you to a human&quot;). An operator replies with{" "}
        <code>POST /v1/sessions/{"{id}"}/operator-messages</code> and the reply appears in the widget.
      </p>
      <p>
        Note: <code>lantern deploy</code> is still a simulated spike, so the example deploys over REST with{" "}
        <code>setup.py</code>.
      </p>
    </>
  );
}
