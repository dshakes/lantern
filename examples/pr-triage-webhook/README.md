# pr-triage-webhook

A GitHub `pull_request` webhook starts a run that reads the PR, has a model triage it in one line, comments the verdict on the PR, and posts the PR to Slack with the verdict threaded under it.

```
GitHub ──signed POST──▶ /v1/hooks/{id} ──▶ run: get_pr → ai-step → comment_pr → Slack post → Slack thread reply
```

Files: `agent.yaml` (manifest), `workflow.json` (the graph), `trigger.json` (provider + input mapping), `fixtures/` (signed-payload body, fixture LLM rules), `send-fixture.sh`.

## Try it against fixtures (no accounts, no model key)

```bash
make test-e2e-examples        # runs this example's test on a throwaway stack
```

To poke at it by hand, run `connector-replay` and `llm-replay` (`services/control-plane/cmd/`), start the API with `LANTERN_CONNECTOR_BASEURL_{GITHUB,SLACK}` and `LANTERN_LLM_BASEURL_OPENAI` pointing at them plus a dummy `OPENAI_API_KEY`, then follow the steps below. `GET <connector-replay>/__requests` shows the GitHub comment and Slack messages the run sent.

## Try it for real

```bash
API=http://localhost:8080; TOKEN=...   # JWT or API key
# 1. connectors (GitHub PAT with repo scope, Slack bot token with chat:write)
curl -X POST $API/v1/connectors/install -H "Authorization: Bearer $TOKEN" \
  -d '{"connectorId":"github","displayName":"GitHub","config":{"personalAccessToken":"ghp_..."}}'
curl -X POST $API/v1/connectors/install -H "Authorization: Bearer $TOKEN" \
  -d '{"connectorId":"slack","displayName":"Slack","config":{"botToken":"xoxb-..."}}'
# 2. agent + workflow
curl -X POST $API/v1/agents -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"pr-triage-webhook","description":"PR triage","systemPrompt":"Workflow agent: see workflow.json"}'
curl -X PUT $API/v1/agents/pr-triage-webhook/workflow -H "Authorization: Bearer $TOKEN" -d @workflow.json
# 3. trigger (edit slackChannel in trigger.json to your channel id first) - the secret is shown once
curl -X POST $API/v1/agents/pr-triage-webhook/triggers -H "Authorization: Bearer $TOKEN" -d @trigger.json
```

Then in the GitHub repo: Settings, Webhooks, Add webhook. Payload URL `$API/v1/hooks/<trigger-id>`, content type `application/json`, secret = the trigger secret, event "Pull requests". Open a PR and watch the run waterfall; the comment and Slack thread appear.

Or replay the fixture: `./send-fixture.sh $API/v1/hooks/<trigger-id> <secret>`. Sending the same delivery id again returns `200 {"duplicate":true}` and starts no run.

## Notes

- The prompt asks for one plain line because the reply is templated into connector parameters.
- Comments use the PR conversation (`comment_pr`), not inline diff comments.
- `agent.yaml` is the deploy manifest; the workflow and trigger are applied with the API calls above until `pal deploy` applies them.
