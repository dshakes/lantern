# daily-digest

**What.** A weekday-morning digest: on a cron schedule the agent reads open PRs from GitHub, has an LLM write a
short summary, and posts it to a Slack channel.

**Why.** It is the smallest useful scheduled agent: it shows a schedule with a timezone, a three-node workflow
(connector -> AI step -> connector), and spend that stays under a hard cap while nobody is watching.

| File | Role |
| --- | --- |
| `agent.yaml` | The manifest `lantern deploy` reads: description, `system_prompt` and the whole `workflow` (`trigger -> github.list_prs -> ai-step -> slack.post_message -> end`) |
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
cd examples/daily-digest
lantern deploy                       # creates the agent with its prompt and workflow
TOKEN=...   # POST /auth/login
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
curl -s "${H[@]}" localhost:8080/v1/connectors/install -d '{"connectorId":"slack","displayName":"Slack","config":{"botToken":"xoxb-..."}}'
curl -s "${H[@]}" localhost:8080/v1/connectors/install -d '{"connectorId":"github","displayName":"GitHub","config":{"personalAccessToken":"ghp_..."}}'
# edit owner / repo / channel (a channel ID like C0123..., invite the bot to it) in schedule.json first
curl -s "${H[@]}" localhost:8080/v1/schedules -d @schedule.json   # -> nextFireAt = next weekday 09:00 New York
```

`lantern deploy` covers the agent only; its manifest has no schedule or connector fields, so those two steps stay REST.

To see it now instead of tomorrow: `POST /v1/runs` with `{"agentName":"daily-digest","input":{"owner":"...","repo":"...","channel":"C..."}}`.
Add `"deliveryEmail": "you@example.com"` to `schedule.json` to also mail the output (not covered by the fixture suite).

## Reference and limits

- The scheduler polls every 60 s; a due schedule fires within a minute. An agent over its hard-fail budget does not fire.
- The workflow's `end` node sets `outputExpression` on purpose: without it the run output is an arbitrary step's output.
- `inputMapping` is a JSON string with `{{steps.<id>}}` / `{{input.<key>}}` placeholders; free text (the digest) is JSON-escaped for you.
- One schedule per agent (`POST /v1/schedules` upserts on tenant + agent).
- Reads open PRs only, with the connector's default page size; it does not read Gmail or Linear.
