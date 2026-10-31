# ADR 0051 — Onboarding as a conversation with an onboarding agent

- Status: Accepted
- Date: 2026-10-30
- Builds on: ADR 0048 (agentic first-run for pal) and the Runtime agentic onboarding (`/onboarding`, `pal onboard`)

## Context

Both first-run flows were step wizards with LLM assists: the Runtime builder flow
(goal → spec → provider → create → run → sandbox) and pal's (consent → channels →
voice → trust → profile → Brief). The LLM explained and drafted; the user drove a
fixed sequence of cards. The ask is a true multi-turn conversation: the user says
what they want in their own words, and an onboarding agent asks follow-ups, picks
the next step, explains failures and fixes, and calls real tools — for both
products, on the dashboard and in the CLI.

The risk is obvious: an LLM that drives setup can skip a gate, claim a success
that never happened, record consent on the owner's behalf, or put a provider key
into a transcript. The wizards' state machines already encode the gates; the
question is how to hand control to a model without handing it those.

## Decision

One server endpoint, `POST /v1/onboarding/agent/turn` (`GET` / `DELETE
/v1/onboarding/agent?product=`), runs a bounded tool-use loop for either product
(`internal/handlers/onboarding_agent.go`). The LLM chooses and narrates; the
existing deterministic machinery remains the guard rail.

1. **Model path.** Each step of the loop is one `CompleteInternalWithUsage` call
   (capability `auto`, provider chain / model-router seam — never a vendor model,
   invariant #6). The model returns one JSON object `{say, tool}`; at most 4 model
   calls per turn. Using plain completions (not provider-native tool calling) keeps
   the call on the model-router offload path and makes the loop testable with a
   stub model.
2. **Tools are gated per turn from read-back facts** (`allowedOnboardingTools`, a
   pure function). The model sees only CALLABLE tools plus the reason each other
   tool is gated; a call to anything else is refused, recorded in the transcript
   and fed back so the model narrates the refusal. Side-effecting tools
   (`create_agent`, `start_run`, `skip_voice`, `finish_profile`) need a user
   message in that turn, and every server tool runs at most once per turn (a retry
   costs money and needs the user's say-so).
3. **Every server tool is a real endpoint.** Server tools are in-process requests
   into the real REST mux (`SetDispatcher(httpMux)`) carrying the caller's own
   credentials, so each target applies its own auth, scopes and validation.
   Progress is written only through `PUT /v1/onboarding` and `PUT
   /v1/pal/onboarding`, whose validation (`palCanEnter`, typed specs) still
   applies. "ok" means a 2xx plus, where one exists, a read-back (the created agent
   is read back; a run is polled to a terminal status through `GET /v1/runs/{id}`).
4. **Facts are read back every turn, never taken from the model or the client.**
   A client tool's report is narration in the transcript; the next turn's facts
   come from the server documents. The one exception is the live channel check,
   which only the owner's Mac can make — the same trust model as ADR 0048 — and
   it expires after 15 minutes.
5. **Client tools.** Some steps can only run on the client: the secure key form,
   the owner's consent (a click / an explicit `y`), live bridge checks, WhatsApp
   pairing, voice sampling, and confirmations of proposed trust settings and
   profile items. The agent emits these as `actions`; the client runs them against
   the same endpoints the wizards use and reports `results` on the next turn. The
   agent cannot record consent: there is no server tool for it.
6. **Secrets.** A provider key pasted into the chat is saved and tested through the
   real settings endpoints and replaced with a placeholder before the message is
   stored or shown to the model. Every persisted or model-bound string passes
   `redactSecrets` (provider keys, AWS/GitHub/Slack/Google keys, JWTs, bearer
   tokens). Invariant #10.
7. **Persistence and resume.** The transcript lives in
   `tenants.settings->'onboardingChat'->'<product>'` as a whitelisted typed struct
   (capped at 80 messages), next to the existing `onboarding` / `palOnboarding`
   documents, which remain the source of truth for progress. A pending client
   action is persisted and re-offered on reload; a `resume` turn asks the model to
   recap, and a recap replaces the previous one rather than stacking.
8. **Degradation.** No provider key (or a key that just failed its test): the turn
   is scripted — there is no model to ask — and offers the key form with the
   provider's real error. Model failure: `mode: "fallback"`; the dashboard and CLI
   switch to the existing wizard, labelled, with the same saved progress.

Clients: the dashboard pages are chat-first (`app/onboarding/agent-chat.tsx`,
`agent-actions.tsx`, pure logic in `agent-chat-logic.ts`) with the progress rail
as a side panel computed from facts; the wizards moved to `wizard.tsx` and are
reachable via **Step by step** / `?mode=steps`. `pal onboard` and `pal setup`
converse by default on a TTY (`onboard_agent.go`); `--steps`, `--yes`, any
unattended flag, or a non-TTY keeps today's behavior, so `--yes` still never
grants consent.

## Consequences

- Both products share one conversation engine; adding a step means adding a
  tool spec, its gate, and (for client tools) a card and a CLI executor.
- The wizards stay as the fallback and for features the conversation does not
  cover yet (starter gallery, spec editing, the optional sandbox run).
- The model can still say something unhelpful; it cannot make something happen
  that a gate forbids or report a result the tools did not return. The final
  narration falls back to deterministic text built from tool results when the
  model misbehaves repeatedly.
- One more LLM call per user turn (up to 4). Spend is the tenant's own key, as with
  the existing assists.
- The channel check remains a client claim (as in ADR 0048); the server cannot see
  the bridges.
