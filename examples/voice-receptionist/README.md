# voice-receptionist

**What.** A phone number that answers inbound Twilio calls under a hard spend cap: a call over budget is declined
before it connects, and the cost of every call is reconciled to its real duration when it ends.

**Why.** Voice is the one channel where spend is billed by the minute by a third party. This example shows the
guardrails: signed webhooks only, a connect-time reservation, `<Reject>` over budget, and refund/true-up on the
status callback.

| File | Role |
| --- | --- |
| `agent.yaml` | The manifest `lantern deploy` reads: description and the receptionist `system_prompt` (greet, take name + call-back number, offer a booking) |
| `number.json` | Body for `POST /v1/voice/numbers`: links `+15125550100` to the agent with your Twilio credentials |

## Try it with fixtures (no Twilio account)

```bash
make dev-infra
make test-e2e-examples        # runs TestVoice_* among the others
```

The suite signs Twilio webhooks itself (HMAC-SHA1 over URL + sorted params with the number's auth token) and asserts:
unsigned/forged -> 403; signed inbound -> TwiML and a $0.05 reservation in `agent_usage_daily`; the status callback for
a 61 s call -> $0.06; a replayed callback changes nothing; a never-connected call refunds to zero; over a hard-fail
budget -> `<Reject/>` with no call row and no spend.

## Try it with a real number

1. `lantern deploy` from this directory, then set a hard-fail budget (not a manifest field, so REST):
   `PUT /v1/agents/voice-receptionist/budget` with `{"maxCostUsdPerDay": 2, "hardFail": true}`.
2. Put your SID, auth token and number in `number.json`, then `POST /v1/voice/numbers` (numbers are not deployable either).
3. In Twilio, set the number's **Voice webhook** to `https://<public-host>/v1/voice/webhook/twilio` and its
   **Call status changes** callback to `https://<public-host>/v1/voice/calls/status/twilio`. Behind a proxy set
   `LANTERN_PUBLIC_BASE_URL` to that origin, because the signature covers the exact public URL.
4. Call the number. `GET /v1/voice/calls` shows duration and cost; `GET /v1/agents/voice-receptionist/budget` shows the day's spend.

## Reference and limits

- Billing: per started minute at $0.03 (Twilio), $0.04 (LiveKit); reservation $0.05 on connect, reconciled on the callback.
- The inbound reply is a fixed greeting TwiML; the realtime conversation (STT -> agent -> TTS) needs the LiveKit Agents
  media worker, which is a separate deployment. This example proves routing, gating and cost, not the conversation.
- Twilio webhooks fail closed (403) unless the signature verifies; `LANTERN_TWILIO_WEBHOOK_AUTH=off` is dev-only and the
  control-plane refuses to start with it in prod.
- The after-hours SMS follow-up from the plan is not included.
