import Link from "next/link";

export default function ExamplesPage() {
  return (
    <>
      <h1>Examples</h1>
      <p>
        Runnable, end-to-end agents. Each lives under <code>examples/</code> in the repo with a README and an
        end-to-end test that runs it against recorded GitHub, Sentry, PagerDuty, Google Calendar and Slack servers, a fixture model, and (for chat) the real surface-gateway
        (<code>make test-e2e-examples</code>), so you can try it with no SaaS account and no model key.
      </p>

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
        <code>setup.py</code> deploys over REST because it also uploads the documents and mints the widget key;{" "}
        <code>lantern deploy</code> from the example directory deploys the agent on its own.
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

      <h2 id="daily-digest">Daily digest to Slack</h2>
      <p>
        <strong>What:</strong> every weekday at 09:00 New York time the agent lists open GitHub PRs, has a model write a
        short digest, and posts it to Slack. <strong>Why:</strong> the smallest unattended agent: a{" "}
        <Link href="/scheduling">schedule</Link> with a timezone, a three-node workflow, and a hard budget cap. Path:{" "}
        <code>examples/daily-digest/</code>.
      </p>
      <pre><code>{`cd examples/daily-digest
lantern deploy                      # agent + system prompt + workflow from agent.yaml
# install the slack and github connectors, edit owner/repo/channel in schedule.json, then:
curl -X POST $API/v1/schedules -H "Authorization: Bearer $TOKEN" -d @schedule.json   # nextFireAt = next weekday 09:00 NY`}</code></pre>
      <p>
        <code>lantern deploy</code> covers the agent; the schedule has no deploy field, so it is created over REST.
        Run it now with <code>POST /v1/runs</code>. The scheduler polls every 60 s.
      </p>

      <h2 id="telegram-assistant">Telegram assistant</h2>
      <p>
        <strong>What:</strong> message a Telegram bot (or WhatsApp Cloud number) and a workflow reads your Google
        Calendar and answers in the same chat. <strong>Uses:</strong> the surface-gateway,{" "}
        <a href="/surfaces#telegram">Telegram</a> secret-token and WhatsApp <code>X-Hub-Signature-256</code> checks, the
        calendar <code>list_events</code> action. Path: <code>examples/telegram-assistant/</code>.
      </p>
      <pre><code>{`cd examples/telegram-assistant
lantern deploy
curl -X POST $API/v1/runs -H "Authorization: Bearer $TOKEN" -d '{"agentName":"telegram-assistant","input":{"text":"hi"}}'   # priming run
# run the gateway (see the README), then setWebhook with secret_token, and message the bot`}</code></pre>
      <p>
        The priming run is needed because the gateway starts runs over gRPC, which refuses an agent that has never had
        a REST run (no promoted version). Replies are plain text, once, within 3 minutes.
      </p>

      <h2 id="voice-receptionist">Voice receptionist</h2>
      <p>
        <strong>What:</strong> a Twilio number answers inbound calls under a hard spend cap: forged webhooks get 403, an
        over-budget call is declined with <code>&lt;Reject/&gt;</code> before it connects, and the status callback
        reconciles the $0.05 reservation to the real per-started-minute cost. Path:{" "}
        <code>examples/voice-receptionist/</code>; details in <a href="/surfaces#twilio">Voice</a>.
      </p>
      <pre><code>{`cd examples/voice-receptionist
lantern deploy
curl -X PUT  $API/v1/agents/voice-receptionist/budget -d '{"maxCostUsdPerDay":2,"hardFail":true}'
curl -X POST $API/v1/voice/numbers -d @number.json    # your SID, auth token, number`}</code></pre>
      <p>
        Budgets and voice numbers are not part of the deploy manifest, so those stay REST. The inbound reply is a fixed
        greeting; the realtime conversation needs the LiveKit media worker.
      </p>

      <h2 id="eval-gated-deploy">Eval-gated deploy</h2>
      <p>
        <strong>What:</strong> a CI pipeline that cannot ship a worse agent. It runs an eval suite against the
        candidate, records it with <code>POST /v1/eval-runs</code>, and a <code>422</code> (regressed vs. the pinned
        baseline) stops the job before <code>lantern deploy --json</code>. A passing change is deployed, a receipt is
        issued with <code>POST /v1/runs/{"{id}"}/receipt</code>, and verified at{" "}
        <code>POST /v1/runs/receipts/verify</code>. Path: <code>examples/eval-gated-deploy/</code> (scripts plus a
        sample GitHub Actions workflow). See <Link href="/evaluations#eval-runs">Recording a run + CI gate</Link>.
      </p>
      <pre><code>{`cd examples/eval-gated-deploy
EVAL_PIN=1 scripts/eval.sh .                    # baseline: 3/3 cases, pinned for branch main
scripts/eval.sh candidates/regressed; echo $?   # 1: HTTP 422, nothing deploys
scripts/eval.sh candidates/improved && scripts/release.sh candidates/improved`}</code></pre>
      <p>
        The server stores the per-case results you post and compares the mean score; the script scores each case
        (<code>assert.contains</code>) from the run output.
      </p>

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
