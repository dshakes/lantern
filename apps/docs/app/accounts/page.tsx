import Link from "next/link";
import { Concept } from "../_components/Concept";
import { Flow } from "../_components/Flow";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/accounts");

export default function AccountsPage() {
  return (
    <>
      <h1>Accounts &amp; sign-up</h1>
      <p>
        How people get into a Lantern deployment and how they leave: gated
        sign-up, email verification, password reset, data export and workspace
        deletion. Every control here is on the control plane (
        <code>:8080</code>); the dashboard pages are thin clients over the
        endpoints below.
      </p>

      <Concept>
        Public sign-up on a self-hosted deployment means anyone can create
        tenants, each with its own budget and microVM quota. Production
        therefore starts <strong>closed</strong>: you open it on purpose, behind
        a captcha, rate limits and a verified email.
      </Concept>

      <h2 id="modes">Sign-up modes</h2>
      <p>
        <code>LANTERN_SIGNUP_MODE</code> controls <code>POST /auth/signup</code>.
        Unset, it is <code>closed</code> when <code>LANTERN_ENV</code> is{" "}
        <code>prod</code>, <code>production</code> or <code>staging</code>, and{" "}
        <code>open</code> otherwise. Any other value stops the server at startup.
      </p>
      <table>
        <thead>
          <tr>
            <th>Mode</th>
            <th>Behaviour</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>closed</code></td>
            <td>Every sign-up gets <code>403 {"{"}"error":"sign-up is closed"{"}"}</code>. Default in prod.</td>
          </tr>
          <tr>
            <td><code>invite</code></td>
            <td>
              Needs an <code>inviteCode</code> bound to the email, else{" "}
              <code>403</code>. Requires <code>LANTERN_SIGNUP_INVITE_SECRET</code>.
            </td>
          </tr>
          <tr>
            <td><code>open</code></td>
            <td>Anyone, subject to the rate limit and captcha. Default in dev.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="flow">Sign-up, verify, login</h2>
      <Flow
        steps={[
          {
            name: "POST /auth/signup",
            sub: "Rate limit, then mode, then captcha. Creates a tenant and an owner user with email_verified_at = NULL, and mails a verification link.",
          },
          {
            name: "Prod: 202 verificationRequired",
            sub: "No JWT is issued. Dev: 201 with a JWT straight away (verification is not enforced), and the mail goes to the server log.",
          },
          {
            name: "Open the emailed link",
            sub: "The dashboard page /auth/verify?token=... posts the token to POST /auth/verify. Single use, 24 hours.",
          },
          {
            name: "POST /auth/login",
            sub: "Returns the JWT. In prod, an unverified user gets 403 with code email_unverified, after the password has matched.",
          },
        ]}
      />

      <h2 id="try-it">Try it</h2>
      <p>
        Against a dev stack (<code>make run-api</code>), sign-up is open and
        returns a token immediately. The verification mail is printed to the
        control-plane log by the log mailer.
      </p>
      <pre>
        <code>{`curl -s -X POST http://localhost:8080/auth/signup \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"new.user@example.com","password":"correct-horse-battery","name":"New User"}'
# 201 {"token":"...","user":{"id":"...","tenantId":"...","email":"new.user@example.com","name":"New User","role":"owner"}}

# grab the link from the log, then redeem the token from its ?token= value
curl -s -X POST http://localhost:8080/auth/verify \\
  -H 'Content-Type: application/json' -d '{"token":"<token from the link>"}'
# 200 {"verified":true}`}</code>
      </pre>

      <h2 id="email-verification">Email verification</h2>
      <ul>
        <li>
          <strong>Enforced in prod only.</strong> Dev keeps one-step sign-up so{" "}
          <code>make dev</code> works unchanged, but still sends the mail so the
          flow is testable.
        </li>
        <li>
          Token: 32 random bytes, emailed as a link, valid{" "}
          <strong>24 hours</strong>, usable once. Only its SHA-256 is stored.
        </li>
        <li>
          Blocked until verified (prod): sign-up returns no JWT, and{" "}
          <code>POST /auth/login</code> returns{" "}
          <code>403 {"{"}"error":"email not verified","code":"email_unverified"{"}"}</code>.
        </li>
        <li>
          Existing users and OAuth sign-ins are treated as verified (migration{" "}
          <code>0023_account_lifecycle</code> defaults{" "}
          <code>users.email_verified_at</code> to <code>now()</code>; only the
          password sign-up path writes <code>NULL</code>).
        </li>
        <li>
          Lost the link? <code>POST /auth/verify/resend</code> mails a fresh
          one to an unverified password user.
        </li>
        <li>
          A completed password reset also verifies the email.
        </li>
      </ul>

      <h2 id="password-reset">Password reset</h2>
      <p>
        <code>POST /auth/forgot</code> mails a link to{" "}
        <code>/auth/reset?token=...</code> on the dashboard. The token is valid{" "}
        <strong>1 hour</strong> and works once. A successful reset sets the new
        password, verifies the email, and burns every other outstanding reset
        link for that user. Passwords must be at least 12 characters. Reset
        applies to password (<code>local</code>) accounts only.
      </p>
      <p>
        <strong>No account-existence leak.</strong> <code>/auth/forgot</code> and{" "}
        <code>/auth/verify/resend</code> return the same{" "}
        <code>202</code> body whether or not the address has an account, and the
        mail itself is sent in the background, so relay latency does not show in
        response time (an existing account still costs one extra database write
        before the reply). In prod,
        signing up with an already-registered email returns the same{" "}
        <code>202 verificationRequired</code> as a new one. (In dev it returns{" "}
        <code>409 email already registered</code>.)
      </p>
      <p>
        Links point at <code>OAUTH_DASHBOARD_URL</code> (default{" "}
        <code>http://localhost:3001</code>), so set it in any deployed
        environment or emailed links will point at localhost.
      </p>

      <h2 id="invite-codes">Invite codes</h2>
      <p>
        Stateless and email-bound: <code>&lt;expiryUnix&gt;.&lt;hex HMAC-SHA256(secret, lower(email) + &quot;|&quot; + expiryUnix)&gt;</code>.
        There is no table and no admin API. A code works only for the email it
        was minted for and only until its expiry; it is effectively single-use
        because emails are unique. Mint one on any machine that has the secret:
      </p>
      <pre>
        <code>{`EXP=$(( $(date +%s) + 7*86400 )); EMAIL=new.user@example.com
echo "$EXP.$(printf '%s|%s' "$EMAIL" "$EXP" | openssl dgst -sha256 -hmac "$LANTERN_SIGNUP_INVITE_SECRET" -r | cut -d' ' -f1)"`}</code>
      </pre>
      <p>
        The invitee sends it as <code>inviteCode</code> in the sign-up body. A
        missing, expired, malformed or wrong-email code gets{" "}
        <code>403 a valid invite code is required to sign up</code>.
      </p>

      <h2 id="captcha">Captcha</h2>
      <p>
        Cloudflare Turnstile, verified server-side against{" "}
        <code>siteverify</code> with the caller IP. Required when{" "}
        <code>LANTERN_TURNSTILE_SECRET</code> is set, and always required for{" "}
        <code>open</code> sign-up in prod. Closed deployments never call
        Turnstile (the mode check runs first). The client sends the widget
        token as <code>captchaToken</code>.
      </p>
      <ul>
        <li>No token: <code>400 captcha is required</code>.</li>
        <li>Token rejected: <code>403 captcha verification failed</code>.</li>
        <li>
          Turnstile unreachable: <code>503 captcha verification unavailable</code>{" "}
          (sign-up fails closed).
        </li>
        <li>
          Required but no secret configured: <code>503 sign-up is not available</code>.
          Startup refuses this combination in prod, so you should not see it.
        </li>
      </ul>
      <p>
        The dashboard renders the widget on the sign-up form when{" "}
        <code>NEXT_PUBLIC_TURNSTILE_SITE_KEY</code> is set at build time.
      </p>

      <h2 id="rate-limits">Rate limits</h2>
      <p>
        Fixed-window counters in Redis, keyed by client IP (and email where
        noted). The IP is the TCP peer;{" "}
        <code>X-Forwarded-For</code> is honored only when the peer is inside{" "}
        <code>LANTERN_TRUSTED_PROXIES</code>. If Redis is absent or errors, the
        limiter fails open so an outage cannot lock owners out. Exceeding a
        limit returns <code>429</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Limit</th>
            <th>Key</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>POST /auth/signup</code></td>
            <td>10 / hour</td>
            <td>IP</td>
          </tr>
          <tr>
            <td><code>POST /auth/login</code></td>
            <td>10 / minute</td>
            <td>IP, and separately email</td>
          </tr>
          <tr>
            <td><code>POST /auth/forgot</code>, <code>POST /auth/verify/resend</code></td>
            <td>20 / hour, and 5 / hour</td>
            <td>IP, and email (each endpoint has its own counters)</td>
          </tr>
          <tr>
            <td><code>POST /auth/verify</code>, <code>POST /auth/reset</code></td>
            <td>20 / hour</td>
            <td>IP (per endpoint)</td>
          </tr>
        </tbody>
      </table>
      <p>
        Body: <code>{"{"}"error":"too many requests; please try again later"{"}"}</code>{" "}
        (login says <code>too many login attempts; please try again later</code>).
      </p>

      <h2 id="export">Data export</h2>
      <p>
        <code>GET /v1/tenants/{"{"}id{"}"}/export</code> returns everything the
        workspace owns as one JSON document, sent with{" "}
        <code>Content-Disposition: attachment; filename=&quot;lantern-export-&lt;tenantId&gt;.json&quot;</code>.
        Owner JWT only; the id must be your own tenant. Another tenant&apos;s id
        is <code>404</code> (existence is not leaked), a non-owner is{" "}
        <code>403 owner role required</code>, no token is <code>401</code>.
      </p>
      <pre>
        <code>{`{
  "tenantId": "…",
  "exportedAt": "2026-10-27T12:00:00Z",
  "tables": {
    "agents": [ … ],
    "runs": [ … ],
    "tenants": [ { … } ]
  }
}`}</code>
      </pre>
      <p>
        <code>tables</code> has one array per table that has a{" "}
        <code>tenant_id</code> column (discovered from the database catalog, so
        new tables are included automatically), plus the tenant row. Credential
        columns are left out by name: any column with a <code>secret</code>,{" "}
        <code>token</code>, <code>key</code>, <code>password</code>,{" "}
        <code>hash</code>, <code>enc</code>/<code>encrypted</code>,{" "}
        <code>ciphertext</code> or <code>credential(s)</code> segment (for
        example <code>password_hash</code>,{" "}
        <code>agent_triggers.secret_enc</code>,{" "}
        <code>data_planes.reg_token_hash</code>), plus{" "}
        <code>provider_config</code> and <code>connector_installs.config</code>.
        Dedup keys (<code>idempotency_key</code>, <code>idem_key</code>,{" "}
        <code>replay_key</code>) and <code>key_prefix</code> are exported. The
        rule is structural, so a new credential column is excluded by
        default. The
        document is built in memory, so very large workspaces produce a large
        response.
      </p>

      <h2 id="delete">Workspace deletion</h2>
      <p>
        <code>DELETE /v1/tenants/{"{"}id{"}"}</code> permanently erases the
        workspace (GDPR right to erasure). In one transaction it deletes every
        tenant-scoped row (runs and their journal events first, then agents,
        every other tenant table, users) and finally the tenant itself. It
        cannot be undone.
      </p>
      <ul>
        <li>Owner JWT required; <code>403 owner role required</code> otherwise.</li>
        <li><code>403 may only purge your own tenant</code> if the id is not yours.</li>
        <li>
          Any failure rolls the whole transaction back and returns{" "}
          <code>500 internal error</code>; nothing is removed.
        </li>
        <li>
          Success: <code>200 {"{"}"tenant_id":"…","deleted":{"{"}"runs":12,"agents":3,…{"}"}{"}"}</code>, a
          per-table row count.
        </li>
      </ul>
      <p>
        The API has no confirmation parameter; the safeguard is in the
        dashboard. <strong>Settings &gt; Your data</strong> (owners only) offers
        Export and Delete, and Delete requires typing{" "}
        <code>delete my workspace</code> before the button enables.
      </p>

      <h2 id="mailer">Mailer</h2>
      <p>
        Verification and reset mail go through one of three drivers, chosen by{" "}
        <code>LANTERN_MAILER</code> (default <code>log</code>). Mail is
        plain text and sent in the background with a 30 second limit; a failed
        send is logged, not returned to the caller.
      </p>
      <table>
        <thead>
          <tr>
            <th>Driver</th>
            <th>Behaviour</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>log</code></td>
            <td>
              Delivers nothing. Dev logs recipient, subject <em>and body</em>{" "}
              (the link). Prod logs recipient and subject only, so tokens never
              reach prod logs.
            </td>
          </tr>
          <tr>
            <td><code>smtp</code></td>
            <td>
              Standard-library SMTP to <code>LANTERN_SMTP_ADDR</code>, upgraded
              with STARTTLS when offered. Credentials are refused over an
              unencrypted connection to a non-localhost server.
            </td>
          </tr>
          <tr>
            <td><code>http</code></td>
            <td>
              POSTs JSON <code>{"{"}from,to,subject,text{"}"}</code> to{" "}
              <code>LANTERN_MAIL_HTTP_URL</code> with{" "}
              <code>Authorization: Bearer LANTERN_MAIL_HTTP_TOKEN</code> (the
              shape of Resend&apos;s <code>/emails</code> API). 15 second
              timeout; a non-2xx response is an error.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="startup-checks">Startup checks</h2>
      <p>The control plane refuses to start when:</p>
      <ul>
        <li><code>LANTERN_SIGNUP_MODE</code> is not <code>open</code>, <code>invite</code> or <code>closed</code>.</li>
        <li><code>invite</code> mode is set without <code>LANTERN_SIGNUP_INVITE_SECRET</code>.</li>
        <li><code>LANTERN_MAILER</code> is unknown, or <code>smtp</code>/<code>http</code> lacks its address/URL.</li>
        <li>In prod, <code>open</code> mode has no <code>LANTERN_TURNSTILE_SECRET</code>.</li>
        <li>
          In prod, mode is <code>open</code> or <code>invite</code> with{" "}
          <code>LANTERN_MAILER=log</code>: new users could never receive their
          verification link.
        </li>
      </ul>

      <h2 id="endpoints">Endpoint reference</h2>
      <p>
        All are JSON. The <code>/auth/*</code> routes need no Bearer token.
      </p>

      <h3>POST /auth/signup</h3>
      <pre>
        <code>{`{ "email": "…", "password": "…(12+ chars)", "name": "…", "inviteCode": "…", "captchaToken": "…" }`}</code>
      </pre>
      <table>
        <thead>
          <tr><th>Status</th><th>Body</th></tr>
        </thead>
        <tbody>
          <tr><td>201</td><td>Dev only. <code>{"{"}token, user:{"{"}id, tenantId, email, name, role{"}"}{"}"}</code>. <code>name</code> defaults to the part of the email before <code>@</code>.</td></tr>
          <tr><td>202</td><td>Prod. <code>{"{"}"verificationRequired":true,"message":"Check your email for a link to verify your account."{"}"}</code>. No JWT.</td></tr>
          <tr><td>400</td><td><code>invalid request body</code>; <code>email and password are required</code>; <code>a valid email is required</code>; <code>password must be at least 12 characters</code>; <code>captcha is required</code></td></tr>
          <tr><td>403</td><td><code>sign-up is closed</code>; <code>a valid invite code is required to sign up</code>; <code>captcha verification failed</code></td></tr>
          <tr><td>409</td><td>Dev only. <code>email already registered</code></td></tr>
          <tr><td>429</td><td>Rate limited.</td></tr>
          <tr><td>503</td><td><code>captcha verification unavailable</code>; <code>sign-up is not available</code></td></tr>
        </tbody>
      </table>

      <h3>POST /auth/login</h3>
      <p>
        <code>{"{"}"email","password"{"}"}</code> returns the JWT and user as
        above. <code>401 invalid credentials</code>, <code>429</code>, and in
        prod <code>403 {"{"}"error":"email not verified","code":"email_unverified"{"}"}</code>.
      </p>

      <h3>POST /auth/verify</h3>
      <p>
        <code>{"{"}"token":"…"{"}"}</code> returns <code>200 {"{"}"verified":true{"}"}</code>.{" "}
        <code>400 invalid or expired token</code> for an unknown, reused,
        expired or wrong-purpose token. <code>429</code> past 20 per hour per IP.
      </p>

      <h3>POST /auth/verify/resend</h3>
      <p>
        <code>{"{"}"email":"…"{"}"}</code> returns{" "}
        <code>202 {"{"}"status":"ok","message":"If that address has an account, we&apos;ve sent it a link."{"}"}</code>{" "}
        for any well-formed email. <code>400 a valid email is required</code>,{" "}
        <code>429</code>.
      </p>

      <h3>POST /auth/forgot</h3>
      <p>Same request, responses and limits as resend; sends a reset link instead.</p>

      <h3>POST /auth/reset</h3>
      <p>
        <code>{"{"}"token":"…","password":"…"{"}"}</code> returns{" "}
        <code>200 {"{"}"reset":true{"}"}</code>. <code>400</code>:{" "}
        <code>password must be at least 12 characters</code> or{" "}
        <code>invalid or expired token</code>. <code>429</code>. The token is
        checked after the password length, so a short password does not burn it.
      </p>

      <h3>GET /v1/tenants/{"{"}id{"}"}/export and DELETE /v1/tenants/{"{"}id{"}"}</h3>
      <p>
        Bearer owner JWT. See <a href="#export">Data export</a> and{" "}
        <a href="#delete">Workspace deletion</a>. Both routes also pass the{" "}
        <code>admin</code> scope annotation, which blocks when{" "}
        <code>LANTERN_AUTHZ_ENFORCE=1</code> (on in production: a key without the
        scope gets <code>403</code>); either way API keys are not
        owners, so they get <code>403</code>.
      </p>

      <h2 id="free-tier">Free-tier caps</h2>
      <p>
        Every new workspace, whether created by password sign-up or the first Google login, starts with a
        hard-fail daily spend cap and a sandbox quota so a new account cannot run up cost. The cap is the
        tenant-wide budget (the same row <code>PUT /v1/budgets/tenant</code> edits) and the quota is the same
        one <code>PUT /v1/runtime/quota</code> edits, so an owner can raise or remove either. Existing
        workspaces and the seeded dev workspace are never touched. Set a variable to <code>off</code> to
        skip that cap.
      </p>
      <table>
        <thead>
          <tr><th>Variable</th><th>Default</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_FREE_TIER_COST_USD_PER_DAY</code></td><td><code>2.00</code></td><td>Tenant-wide LLM spend per day (hard fail, HTTP 402).</td></tr>
          <tr><td><code>LANTERN_FREE_TIER_MAX_VMS</code></td><td><code>2</code></td><td>Concurrent sandbox VMs. Compute hours (4/day) and egress (1 GB/day) are fixed.</td></tr>
          <tr><td><code>LANTERN_FREE_TIER_RUNTIME_COST_USD_PER_DAY</code></td><td><code>1.00</code></td><td>Sandbox spend per day.</td></tr>
        </tbody>
      </table>

      <h2 id="run-gate">Running agents before you verify</h2>
      <p>
        Where verification is required (production), <code>POST /v1/runs</code> from an unverified user returns{" "}
        <code>403 {"{"}&quot;code&quot;:&quot;email_unverified&quot;{"}"}</code>. Login and sign-up already withhold
        tokens from unverified users, so this is a second check. Google sign-in counts as verified, and API keys
        are not affected. In dev the gate is off.
      </p>

      <h2 id="env-vars">Environment variables</h2>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Default</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_ENV</code></td><td>unset (dev)</td><td><code>prod</code>/<code>production</code>/<code>staging</code> turns on closed-by-default sign-up, email verification and the startup checks.</td></tr>
          <tr><td><code>LANTERN_SIGNUP_MODE</code></td><td><code>closed</code> in prod, <code>open</code> in dev</td><td><code>open</code>, <code>invite</code> or <code>closed</code>.</td></tr>
          <tr><td><code>LANTERN_SIGNUP_INVITE_SECRET</code></td><td>none</td><td>HMAC key for invite codes. Required for <code>invite</code> mode.</td></tr>
          <tr><td><code>LANTERN_TURNSTILE_SECRET</code></td><td>none</td><td>Turnstile secret. Setting it requires a captcha on every sign-up; required for <code>open</code> in prod.</td></tr>
          <tr><td><code>NEXT_PUBLIC_TURNSTILE_SITE_KEY</code></td><td>none</td><td>Dashboard build-time site key; renders the widget.</td></tr>
          <tr><td><code>LANTERN_MAILER</code></td><td><code>log</code></td><td><code>log</code>, <code>smtp</code> or <code>http</code>.</td></tr>
          <tr><td><code>LANTERN_MAIL_FROM</code></td><td><code>Lantern &lt;no-reply@localhost&gt;</code></td><td>From address for <code>smtp</code> and <code>http</code>.</td></tr>
          <tr><td><code>LANTERN_SMTP_ADDR</code></td><td>none</td><td><code>host:port</code>. Required for <code>smtp</code>.</td></tr>
          <tr><td><code>LANTERN_SMTP_USER</code>, <code>LANTERN_SMTP_PASSWORD</code></td><td>none</td><td>SMTP credentials (PLAIN auth).</td></tr>
          <tr><td><code>LANTERN_MAIL_HTTP_URL</code></td><td>none</td><td>Endpoint for the <code>http</code> driver. Required for it.</td></tr>
          <tr><td><code>LANTERN_MAIL_HTTP_TOKEN</code></td><td>none</td><td>Bearer token for the <code>http</code> driver.</td></tr>
          <tr><td><code>OAUTH_DASHBOARD_URL</code></td><td><code>http://localhost:3001</code></td><td>Base URL used in emailed verify/reset links.</td></tr>
          <tr><td><code>LANTERN_TRUSTED_PROXIES</code></td><td>empty</td><td>CIDRs whose <code>X-Forwarded-For</code> is trusted for rate-limit keys.</td></tr>
        </tbody>
      </table>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          Invite codes cannot be listed or revoked; to cancel one, rotate{" "}
          <code>LANTERN_SIGNUP_INVITE_SECRET</code> (which invalidates all of them).
        </li>
        <li>
          Rate limiting needs Redis; without it only the captcha and sign-up
          mode protect <code>/auth/*</code>.
        </li>
      </ul>
      <p>
        See also <Link href="/security">Security</Link> and the{" "}
        <Link href="/api">API reference</Link>.
      </p>
    </>
  );
}
