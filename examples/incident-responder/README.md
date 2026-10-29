# incident-responder

A Sentry alert (or PagerDuty incident) starts a run that looks up the Sentry issue and the PagerDuty incident, has a model summarize them and suggest a runbook step, posts that to Slack, then **parks at an approval node**. A human approves (the run posts a note on the PagerDuty incident) or denies (the step fails and nothing is posted).

```
Sentry/PagerDuty ─signed POST─▶ /v1/hooks/{id} ─▶ get_issue → get_incident → ai-step → Slack → [approval] → add_note
```

Files: `agent.yaml`, `workflow.json`, `trigger-sentry.json`, `trigger-pagerduty.json`, `fixtures/` (signed payload bodies, fixture LLM rules), `send-fixture.sh`.

## Try it against fixtures

```bash
make test-e2e-examples        # covers approve, deny, replay, bad signature
```

(Manual setup is the same as in `../pr-triage-webhook/README.md`, with `PAL_CONNECTOR_BASEURL_{SENTRY,PAGERDUTY,SLACK}`.)

## Try it for real

1. Install the `sentry` (`authToken`), `pagerduty` (`apiKey`) and `slack` (`botToken`) connectors (`POST /v1/connectors/install`).
2. Create the agent, `PUT /v1/agents/incident-responder/workflow` with `workflow.json`.
3. Edit the templates, then create the triggers: `organization` (your Sentry org slug), `incidentId` (Sentry trigger: the PagerDuty incident to annotate; PagerDuty trigger takes it from the event), `issueId` (PagerDuty trigger: the Sentry issue to summarize), `from` (a PagerDuty user email), `slackChannel`.
   ```bash
   curl -X POST $API/v1/agents/incident-responder/triggers -H "Authorization: Bearer $TOKEN" -d @trigger-sentry.json
   curl -X POST $API/v1/agents/incident-responder/triggers -H "Authorization: Bearer $TOKEN" -d @trigger-pagerduty.json
   ```
4. Sentry: Settings, Developer Settings, Internal Integration, webhook URL `$API/v1/hooks/<sentry-trigger-id>`, subscribe to alerts; use its client secret as the trigger secret (`PATCH /v1/triggers/{id}` with `{"secret":"..."}`). PagerDuty: Integrations, Generic Webhooks (v3), URL `$API/v1/hooks/<pagerduty-trigger-id>`, same secret handling.
5. Fire an alert, or `./send-fixture.sh sentry $API/v1/hooks/<id> <secret>`. Slack shows the summary; the run waits.
6. Approve or deny in the dashboard (Runs, the run, Approve), or:
   ```bash
   curl $API/v1/runs/<run-id>/takeover -H "Authorization: Bearer $TOKEN"            # find the pending id
   curl -X POST $API/v1/runs/<run-id>/takeover/<id>/grant -H "Authorization: Bearer $TOKEN" -d '{"notes":"go"}'
   curl -X POST $API/v1/runs/<run-id>/takeover/<id>/deny  -H "Authorization: Bearer $TOKEN" -d '{"notes":"not now"}'
   ```

## Notes

- The approval is a request for a human decision, not a rollback: this example does not roll anything back. Add a connector or tool node after the approval for the real action.
- Pending approvals expire after 30 minutes by row, but nothing re-drives an expired one yet; deny or grant explicitly.
- Run status for a parked run is not a stable string in the run API; use `GET /v1/runs/{id}/takeover`.
