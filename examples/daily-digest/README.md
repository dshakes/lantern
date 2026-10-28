# daily-digest

**What.** A weekday-morning digest: on a cron schedule the agent reads open PRs from GitHub, has an LLM write a
short summary, and posts it to a Slack channel.

**Why.** It is the smallest useful scheduled agent: it shows a schedule with a timezone, a three-node workflow
(connector -> AI step -> connector), and spend that stays under a hard cap while nobody is watching.

| File | Role |
| --- | --- |
| `agent.yaml` | Agent manifest for `lantern deploy` (note: `lantern deploy` is **simulated** today, so use the REST steps below) |
| `spec.json` | Body for `POST /v1/agents` |
| `workflow.json` | `trigger -> github.list_prs -> ai-step -> slack.post_message -> end` (`PUT /v1/agents/{name}/workflow`) |
| `schedule.json` | Body for `POST /v1/schedules`: `0 9 * * 1-5`, `America/New_York`, and the `owner`/`repo`/`channel` the workflow reads as `{{input.*}}` |

## Try it with fixtures (no accounts, no keys)

```bash
make dev-infra
make test-e2e-examples        # runs TestDigest_* among the others, ~70 s
```

The suite installs Slack and GitHub against `connector-replay`, makes the schedule due, waits for the scheduler,
and asserts exactly one `chat.postMessage` carrying the (multi-line, quoted) digest. See `/testing#examples`.

## Try it with your accounts

```bash
TOKEN=...   # POST /auth/login
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
curl -s "${H[@]}" localhost:8080/v1/connectors/install -d '{"connectorId":"slack","displayName":"Slack","config":{"botToken":"xoxb-..."}}'
curl -s "${H[@]}" localhost:8080/v1/connectors/install -d '{"connectorId":"github","displayName":"GitHub","config":{"personalAccessToken":"ghp_..."}}'
curl -s "${H[@]}" localhost:8080/v1/agents -d @spec.json
curl -s -X PUT "${H[@]}" localhost:8080/v1/agents/daily-digest/workflow -d @workflow.json
# edit owner / repo / channel (a channel ID like C0123..., invite the bot to it) in schedule.json first
curl -s "${H[@]}" localhost:8080/v1/schedules -d @schedule.json   # -> nextFireAt = next weekday 09:00 New York
```

To see it now instead of tomorrow: `POST /v1/runs` with `{"agentName":"daily-digest","input":{"owner":"...","repo":"...","channel":"C..."}}`.
Add `"deliveryEmail": "you@example.com"` to `schedule.json` to also mail the output (not covered by the fixture suite).

## Reference and limits

- The scheduler polls every 60 s; a due schedule fires within a minute. An agent over its hard-fail budget does not fire.
- The workflow's `end` node sets `outputExpression` on purpose: without it the run output is an arbitrary step's output.
- `inputMapping` is a JSON string with `{{steps.<id>}}` / `{{input.<key>}}` placeholders; free text (the digest) is JSON-escaped for you.
- One schedule per agent (`POST /v1/schedules` upserts on tenant + agent).
- Reads open PRs only, with the connector's default page size; it does not read Gmail or Linear.
