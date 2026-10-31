# Dashboard e2e (Playwright)

Headless Chromium against a private, throwaway stack. Run from `apps/web`:

```bash
npm ci
npx playwright install chromium     # CI: add --with-deps
npm run test:e2e
```

Prereqs: Go, `psql`, and a reachable Postgres + Redis (`make dev-infra` provides both).

## What `global-setup.ts` boots

| Piece | Where |
| --- | --- |
| Postgres DB `pal_e2e_<pid>` | created via `E2E_PG_ADMIN_URL` (default `pal:pal@localhost:5432/postgres`), dropped at the end |
| Redis | db index `E2E_REDIS_DB` (default 13), flushed before and after so `/auth/*` rate limits (10 sign-ups/IP/hour) never leak between runs |
| llm-replay | `:9412`, rules in `fixtures/llm-rules.json` |
| control-plane | HTTP `:8411`, gRPC `:50411`, metrics `:9411`; `PAL_CORS_ORIGINS` = the dashboard origin (without it every API call fails CORS); `PAL_MAILER=log`; `PAL_LLM_BASEURL_*` -> llm-replay |
| dashboard (`next dev`) | `:3411` with `NEXT_PUBLIC_API_URL` / `PAL_API_URL` -> the control-plane |

Ports: `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_GRPC_PORT`, `E2E_METRICS_PORT`, `E2E_LLM_PORT`. Never use :8080/:3001 or the shared `pal` DB.
Logs, binaries and artifacts go to `$E2E_RUN_DIR` (default `$TMPDIR/pal-e2e-run`) -- deliberately outside `apps/web`, because `next dev` watches the project and a growing log there causes endless rebuilds.
`global-setup.ts` warms each route once; cold `next dev` compiles take tens of seconds.

Iterating: boot the stack once yourself and run with `E2E_REUSE_STACK=1 npx playwright test <file>` to skip setup/teardown.

## Specs (`specs/`)

- `auth.spec.ts` sign-up lands logged in (dev mode is auto-verified; the verification gate is prod-only); forgot -> reset via the mailer log -> sign in, reset link is single-use
- `onboarding.spec.ts` template gallery -> review step; free-text goal -> key test -> design -> create -> first run succeeded with fixture output
- `settings-danger.spec.ts` delete workspace (typed phrase), then the account is gone
- `theme.spec.ts` login renders in light and dark; toggle persists

Helpers: `support/mail.ts` (`mailLink` reads the control-plane log), `support/users.ts` (`signUp`), `support/env.ts`.

## Kiosk specs

Put them in `kiosk/*.spec.ts` (picked up by the same config). Extra control-plane env goes in `extraEnv` at the top of `global-setup.ts`; extra fixture LLM rules in `fixtures/llm-rules.json` (first matching substring wins, so use unique markers).

## Known app quirks the suite works around

- After sign-up the app lands on `/agents`, not `/onboarding` (the `isAuthenticated` redirect races the explicit `router.replace("/onboarding")`); specs navigate to `/onboarding` themselves.
- Free-text onboarding needs a model key *before* the design step; the spec adds a dummy OpenAI key, which the control-plane tests against llm-replay.
