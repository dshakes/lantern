import Link from "next/link";

export default function ExamplesPage() {
  return (
    <>
      <h1>Examples</h1>
      <p>
        Runnable agents that start from someone else&apos;s event. Each lives under <code>examples/</code> in the repo, ships a
        signed fixture payload, and has an end-to-end test that runs it against recorded GitHub, Sentry, PagerDuty and
        Slack servers (<code>make test-e2e-examples</code>), so you can try it with no SaaS account and no model key.
      </p>

      <h2 id="pr-triage-webhook">PR triage to a Slack thread</h2>
      <p>
        <strong>What:</strong> every opened GitHub pull request is read, triaged by a model in one line, commented on the PR,
        and announced in Slack with the verdict in the thread. <strong>Why:</strong> a reviewer sees risk before opening
        the diff. <strong>Uses:</strong> a <Link href="/triggers">webhook trigger</Link>, the GitHub{" "}
        <code>get_pr</code> and <code>comment_pr</code> actions, Slack <code>post_message</code> and{" "}
        <code>reply_thread</code>, in a <code>workflow.json</code> graph.
      </p>
      <pre>
        <code>{`cd examples/pr-triage-webhook
curl -X POST $API/v1/agents -H "Authorization: Bearer $TOKEN" -d '{"name":"pr-triage-webhook","description":"PR triage","systemPrompt":"Workflow agent: see workflow.json"}'
curl -X PUT $API/v1/agents/pr-triage-webhook/workflow -H "Authorization: Bearer $TOKEN" -d @workflow.json
curl -X POST $API/v1/agents/pr-triage-webhook/triggers -H "Authorization: Bearer $TOKEN" -d @trigger.json
# -> {"id": "<trigger-id>", "secret": "<shown once>"}
./send-fixture.sh $API/v1/hooks/<trigger-id> <secret>   # signed pull_request.opened`}</code>
      </pre>
      <p>
        For real GitHub, install the <code>github</code> and <code>slack</code> connectors, then add a repository webhook with
        payload URL <code>$API/v1/hooks/&lt;trigger-id&gt;</code>, content type JSON, the trigger secret, and the Pull requests
        event. Re-sending the same delivery returns <code>200 duplicate</code> and starts no second run; a bad signature is{" "}
        <code>401</code>; an agent over its budget gets <code>402</code>.
      </p>

      <h2 id="incident-responder">Incident responder with an approval</h2>
      <p>
        <strong>What:</strong> a Sentry alert (or PagerDuty incident) is summarized with the Sentry issue and the
        PagerDuty incident in hand, a runbook step is posted to Slack, and the run parks at an approval node. Approving
        posts a note on the PagerDuty incident; denying fails the step and posts nothing.{" "}
        <strong>Uses:</strong> two triggers (<code>sentry</code>, <code>pagerduty</code>), Sentry <code>get_issue</code>,
        PagerDuty <code>get_incident</code> and <code>add_note</code>, and the{" "}
        <Link href="/human-in-the-loop">approval node</Link>.
      </p>
      <pre>
        <code>{`cd examples/incident-responder
# create the agent and PUT workflow.json as above, then create both triggers
curl -X POST $API/v1/agents/incident-responder/triggers -d @trigger-sentry.json    # and trigger-pagerduty.json
./send-fixture.sh sentry $API/v1/hooks/<sentry-trigger-id> <secret>
# the run parks; approve or deny it:
curl -X POST $API/v1/runs/<run-id>/takeover/<takeover-id>/grant -d '{"notes":"go"}'
curl -X POST $API/v1/runs/<run-id>/takeover/<takeover-id>/deny  -d '{"notes":"not now"}'`}</code>
      </pre>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          A model reply is dropped into JSON-free connector parameters, so the prompts ask for one plain line. Keep that
          if you edit them.
        </li>
        <li>
          The incident trigger templates pin the Sentry organization and the PagerDuty incident or issue id to the
          fixture values; edit <code>trigger-*.json</code> for your account.
        </li>
        <li>
          PR comments use the PR conversation (<code>comment_pr</code>); inline review comments on a diff line are not
          wired.
        </li>
      </ul>
    </>
  );
}
