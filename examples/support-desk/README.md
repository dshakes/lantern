# Support desk

A webchat agent that answers from your documents (and shows which ones), and
hands the conversation to a human when it cannot answer, with a Slack ping.

| File | What |
| --- | --- |
| `agent.yaml` | The agent manifest (labels `handoff=human`, `handoff_slack_channel`). |
| `spec.json` | The same agent as the REST body `setup.py` posts. |
| `knowledge.json`, `docs/` | Three sample help-center documents with fixed ids. |
| `rules.json` | Scripted replies for the fixture LLM (CI / no provider key). |
| `demo.html` | A page with the widget pasted in. |

`setup.py` deploys over REST (agent, knowledge docs and widget key in one go); `lantern deploy` from this directory deploys the agent itself.

## Try it

```bash
make dev-infra && make run-api               # terminal 1 (needs an OpenAI key for embeddings, see below)
python3 examples/support-desk/setup.py       # creates the agent, uploads the 3 docs
```

1. In the dashboard, Settings, API keys, create a key with scope `runs:execute`.
2. Put it in `demo.html` (`data-api-key`), serve the dashboard (`make dashboard-dev`) so `/widget.js` exists, and open the page.
3. Ask **How do I reset my password?** You get a short answer with
   `Sources: Resetting your password` under it.
4. Ask **I want a refund.** The widget shows "Connecting you to a human teammate"
   and the agent stops replying. If the Slack connector is installed (Dashboard,
   Integrations) a message lands in `#support-handoffs`.
5. Answer as the operator (needs a key or login with the `write` scope):

   ```bash
   curl -X POST $API/v1/sessions/$SESSION_ID/operator-messages \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"content":"Hi, I have started your refund."}'
   ```

   It appears in the widget. `POST .../resolve` hands the chat back to the bot;
   `GET /v1/sessions?status=handoff` lists chats waiting for a person.

Embeddings use the tenant's OpenAI key. Without one the documents are still
searched, by Postgres full-text instead of vectors.

## Test it

```bash
# fixture tier: no provider key, deterministic replies
go run ./services/control-plane/cmd/llm-replay -addr 127.0.0.1:9192 -rules examples/support-desk/rules.json &
LANTERN_LLM_BASEURL_OPENAI=http://127.0.0.1:9192 LANTERN_LLM_BASEURL_ANTHROPIC=http://127.0.0.1:9192 \
  OPENAI_API_KEY=fixture LANTERN_CONNECTOR_BASEURL_SLACK=http://127.0.0.1:9193 make run-api &
cd e2e/examples && LANTERN_E2E_API_URL=http://localhost:8080 LANTERN_E2E_SLACK_FIXTURE_ADDR=127.0.0.1:9193 \
  LANTERN_E2E_FIXTURE_LLM=1 go test -tags e2e -count=1 -v ./...
```

Against a real LLM, drop the fixture variables; the test then asserts the
`sources` of the answer rather than the reply text.

## Security notes

A handoff agent has exactly one tool (`handoff_to_human`) and no connectors.
The widget key is visible in the page: give it only `runs:execute`. Operator
endpoints need `write`, which that key does not have. Note that
`GET /v1/sessions` is not yet per-visitor, so do not hand a widget key to
untrusted pages for tenants that hold other customers' sessions.
