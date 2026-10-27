# ADR 0027 — Public sign-up, email verification, and sign-up abuse controls

- **Status:** Accepted
- **Date:** 2026-10-27
- **Deciders:** Lantern control-plane, security
- **Tags:** auth, trust-boundary, multi-tenant, abuse, gdpr

## Context

`POST /auth/signup` is the one route that creates a **tenant** without any
prior credential. Before this ADR it validated an email and a 12-character
password, inserted a tenant and an owner user, and returned an owner JWT
immediately. It had no rate limit, no captcha, no proof that the caller owns
the email, and no way to turn it off. That is a new trust boundary
(unauthenticated tenant creation, invariant #7) with nothing guarding it: one
script can mint unlimited tenants, each with its own budget, runtime quota and
LLM-proxy surface. There was also no forgot-password path, so a locked-out
owner could only be fixed by hand in the database, and no self-serve data
export for GDPR Art. 20.

## Decision

### 1. One switch for who may sign up — `LANTERN_SIGNUP_MODE`

| Mode     | Behaviour |
| -------- | --------- |
| `closed` | `POST /auth/signup` returns 403. **Default in prod** (`LANTERN_ENV=prod/production/staging`). |
| `invite` | Sign-up needs an `inviteCode` bound to the email (below). |
| `open`   | Anyone may sign up, subject to captcha + rate limits. **Default in dev.** |

Any other value fails startup. Closed-by-default in prod means a deploy that
forgets the flag is safe; opening sign-up is a deliberate act.

**Invite codes are stateless and email-bound:**
`<expiryUnix>.<hex HMAC-SHA256(LANTERN_SIGNUP_INVITE_SECRET, lower(email) + "|" + expiryUnix)>`.
A code only works for the email it was minted for and only until its expiry.
It is effectively single-use because emails are unique — once that address
has an account the code has nothing left to create. No table, no admin API.
Mint one with:

```bash
EXP=$(( $(date +%s) + 7*86400 )); EMAIL=new.user@example.com
echo "$EXP.$(printf '%s|%s' "$EMAIL" "$EXP" | openssl dgst -sha256 -hmac "$LANTERN_SIGNUP_INVITE_SECRET" -r | cut -d' ' -f1)"
```

`invite` mode without `LANTERN_SIGNUP_INVITE_SECRET` fails startup.

### 2. Captcha — Cloudflare Turnstile, verified server-side

`LANTERN_TURNSTILE_SECRET` set → every sign-up must carry a `captchaToken`,
checked against Turnstile's `siteverify` with the caller IP. **Open sign-up in
prod without the secret fails startup**, and the handler refuses the request
too (defence in depth if the guard is bypassed). In dev, unset means off.
The dashboard renders the widget when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set.

### 3. Email verification and password reset — single-use, hashed, expiring tokens

- `users.email_verified_at` (new). Migration `0024` adds it with
  `DEFAULT now()` so **existing users and every non-password path (OAuth,
  dev seed) are verified** — the provider already proved the address. Only the
  password sign-up path inserts `NULL`.
- `auth_tokens(token_hash PK, tenant_id, user_id, purpose, expires_at,
  used_at)`. The raw token is 32 random bytes (base64url) and exists only in
  the emailed link; the DB stores its SHA-256. Purposes: `verify_email` (24h)
  and `reset_password` (1h).
- Consuming a token is one `UPDATE … WHERE token_hash=$1 AND purpose=$2 AND
  used_at IS NULL AND expires_at > now() RETURNING …`. Reuse, expiry, wrong
  purpose and unknown tokens all get the same `400 invalid or expired token`.
- A successful reset also marks the email verified (the caller proved inbox
  ownership) and burns every other outstanding reset token for that user.
- `auth_tokens` is tenant-scoped and under RLS like every tenant table. Its
  reads/writes run on the privileged pool with `rls-exempt:` reasons, because
  they happen **before** there is a tenant context — the same pattern as
  login.

**Verification is enforced in prod only.** In prod, sign-up returns
`202 {verificationRequired:true}` with **no JWT**, and login for an unverified
password user returns `403 {code:"email_unverified"}`. In dev, sign-up returns
the JWT as before (so `make dev` and the dashboard keep their one-step flow) and
still sends the verification mail through the log mailer, so the flow is
testable locally.

### 4. Enumeration-safe responses

`/auth/forgot` and `/auth/verify/resend` return the same `202` body whether
or not the email exists. In prod, sign-up with an already-registered email
returns the same `202` as a fresh sign-up (dev keeps `409` for ergonomics).
Mail is sent from a detached goroutine with a 30s timeout so SMTP latency
cannot reveal whether an account exists.

### 5. Mailer — one interface, three drivers (`internal/mailer`)

`LANTERN_MAILER` = `log` (default) | `smtp` | `http`.

- `log` prints the message to the server log. In dev it prints the body (the
  link). In prod it prints recipient + subject only — **never the token**.
- `smtp` uses stdlib `net/smtp` (`LANTERN_SMTP_ADDR`, `LANTERN_SMTP_USER`,
  `LANTERN_SMTP_PASSWORD`); STARTTLS when the server offers it.
- `http` POSTs `{from,to,subject,text}` with a bearer token to
  `LANTERN_MAIL_HTTP_URL` (Resend's `/emails` API shape; `LANTERN_MAIL_HTTP_TOKEN`).

All drivers send from `LANTERN_MAIL_FROM`. A driver missing its settings
fails startup, and so does prod with sign-up `open`/`invite` on the `log`
driver: users could never receive their link. Links point at
`OAUTH_DASHBOARD_URL` (the existing dashboard base URL) under `/auth/verify`
and `/auth/reset`, which the dashboard middleware already treats as public.

### 6. Rate limits on `/auth/*`

Redis fixed-window counters (same mechanism as the existing login limiter),
keyed by `remoteIP(r)` — which honours `X-Forwarded-For` only from
`LANTERN_TRUSTED_PROXIES` — and by account where there is one. Login previously
trusted the leftmost `X-Forwarded-For` unconditionally, so any client could
rotate its "IP"; it now uses `remoteIP` too. Limits: login 10/min per IP and
per email (unchanged); sign-up 10/hour per IP; forgot + resend 5/hour per email
and 20/hour per IP; verify + reset 20/hour per IP. Exceeding returns 429. A
Redis outage fails open, as the login limiter always has: an outage must not
lock owners out, and captcha + verification still stand.

### 7. Data export and erasure

- `GET /v1/tenants/{id}/export` (owner JWT, `admin` scope) returns every row
  of every table with a `tenant_id` column, discovered from the catalog so new
  tables are included automatically, read through `WithTenant`. Credential
  columns (`password_hash`, `key_hash`, `*_encrypted`, `provider_config`,
  `connector_installs.config`) are removed. Another tenant's id returns 404.
- `DELETE /v1/tenants/{id}` (existing GDPR purge) is now behind
  `WithScope(admin)` and is reachable from the dashboard danger zone.
- **S3:** the control plane writes no tenant-keyed objects. The only objects
  it stores are `dl/<id>` secure-download files, which are not tenant-keyed and
  expire in about an hour; agent bundles are referenced by URI, not uploaded
  here. There is nothing in object storage for the erasure to purge. If a
  tenant-keyed prefix is ever added, the purge must delete it.

### 8. Every mutating route carries a scope annotation

`cmd/server/routes_scope_test.go` parses the route table and fails if any
`POST/PUT/PATCH/DELETE` route lacks `WithScope`, unless it is on an explicit
exemption list with its reason: pre-auth `/auth/*`, provider-signed webhooks
(Twilio, Slack, voice), shared-token service endpoints (`/internal/*`,
heartbeat, signals, runtime report/secret relay, receipt verify), and the
runtime routes, which check `runtime:*` scopes inside the handler. Mutators
that already authenticated with a JWT/API key but had no annotation are now
wrapped. With `LANTERN_AUTHZ_ENFORCE` off (the default) this changes nothing at
runtime; it is what makes flipping the flag on safe.

## Consequences

- Prod sign-up is off until an operator picks `open` (with Turnstile and a
  real mailer) or `invite`. That is the intended posture.
- Existing JWTs are not revoked by a password reset — there is no revocation
  list. Tokens expire on their normal TTL. Follow-up if needed: a per-user
  `password_changed_at` checked in `validateRequest`.
- Unverified prod accounts cannot log in at all; there is no reduced-quota
  "sandbox tier". If unverified trial use is wanted later, gate on
  `email_verified_at` in the quota path instead of at login.
- `domain_records` exports its stored ciphertext, not plaintext.
- No disposable-domain blocklist: it is a maintenance treadmill, and captcha +
  verification + per-IP limits cover the same abuse.

## Env summary

| Var | Default | Purpose |
| --- | --- | --- |
| `LANTERN_SIGNUP_MODE` | `closed` prod / `open` dev | `open` \| `invite` \| `closed` |
| `LANTERN_SIGNUP_INVITE_SECRET` | — | HMAC key for invite codes (required for `invite`) |
| `LANTERN_TURNSTILE_SECRET` | — | Turnstile server secret; required for prod `open` |
| `LANTERN_MAILER` | `log` | `log` \| `smtp` \| `http` |
| `LANTERN_MAIL_FROM` | `Lantern <no-reply@localhost>` | Sender address |
| `LANTERN_SMTP_ADDR` / `_USER` / `_PASSWORD` | — | SMTP driver |
| `LANTERN_MAIL_HTTP_URL` / `LANTERN_MAIL_HTTP_TOKEN` | — | HTTP (Resend-shaped) driver |
