import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function DemoPage() {
  return (
    <>
      <h1>Demo mode</h1>
      <p>
        <code>lantern demo</code> starts the whole stack in kiosk mode: every visitor
        gets a private workspace with sample agents, a guided tour, and no sign-up.
        The workspace is deleted after 30 minutes. It needs Docker and nothing else:
        no LLM key.
      </p>

      <Concept>
        A demo that needs your API key is not a demo you can leave on a booth. Kiosk
        mode answers from <strong>recorded replays</strong> served by a local fixture
        server, labels every answer &quot;replay&quot;, and gives each visitor a
        throwaway tenant that the database itself isolates from every other visitor.
      </Concept>

      <h2 id="try-it">Try it</h2>
      <pre><code>{`lantern demo            # builds, starts, opens http://localhost:3001/kiosk
lantern demo --down     # stop and delete all demo data
make demo               # same stack without the CLI`}</code></pre>
      <p>
        Press <strong>Start demo</strong>. The tour has five steps over real pages:
        the inbox, running an agent (watch the step waterfall), a budget that returns
        HTTP 402, a signed-receipt check at <code>/proof</code>, and the sandbox view.
        After 120 seconds without input, or when the 30-minute timer ends, the session
        is closed and the workspace deleted.
      </p>

      <h2 id="isolation">How visitors are isolated</h2>
      <ul>
        <li>
          <code>POST /v1/kiosk/session</code> creates a fresh <code>kiosk-&lt;rand&gt;</code>{" "}
          tenant and returns a short-lived JWT with role <code>kiosk</code>. Row-level
          security is enforced, so visitor B reading visitor A&apos;s run or agent gets{" "}
          <code>404</code>.
        </li>
        <li>
          The token cannot write settings, connectors or budgets, mint API keys, or delete
          the tenant (<code>LANTERN_AUTHZ_ENFORCE=1</code> is part of the overlay).
        </li>
        <li>
          A sweep deletes expired tenants through the same erasure code path as{" "}
          <code>DELETE /v1/tenants/&#123;id&#125;</code>, across every table that has a{" "}
          <code>tenant_id</code> column.
        </li>
        <li>
          No provider key exists in a kiosk tenant. The server refuses to start in kiosk
          mode if a provider key is set without a fixture base URL.
        </li>
      </ul>

      <h2 id="reference">Reference</h2>
      <table>
        <thead>
          <tr><th>Variable</th><th>Default</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_KIOSK</code></td><td>off</td><td><code>1</code> enables the endpoint, sweep and guards. Otherwise <code>/v1/kiosk/session</code> is 404.</td></tr>
          <tr><td><code>LANTERN_KIOSK_ALLOW_PROD</code></td><td>off</td><td>Required to run kiosk in prod/production/staging. Use only on a dedicated demo host.</td></tr>
          <tr><td><code>LANTERN_KIOSK_TTL_MIN</code></td><td>30</td><td>Session lifetime in minutes.</td></tr>
          <tr><td><code>LANTERN_KIOSK_SWEEP_SEC</code></td><td>60</td><td>How often expired sessions are purged.</td></tr>
          <tr><td><code>LANTERN_KIOSK_MAX_SESSIONS</code></td><td>20</td><td>Live-session cap; over it returns 503.</td></tr>
          <tr><td><code>LANTERN_KIOSK_IP_PER_HOUR</code></td><td>3</td><td>Sessions per client address per hour; over it returns 429.</td></tr>
          <tr><td><code>KIOSK_JWT_SECRET</code></td><td>local default</td><td>Compose overlay only. Set a strong value for any host others can reach.</td></tr>
        </tbody>
      </table>
      <p>
        Kiosk mode also requires <code>LANTERN_RLS_ENFORCE=1</code>,{" "}
        <code>LANTERN_AUTHZ_ENFORCE=1</code> and an explicit <code>JWT_SECRET</code>; the
        compose overlay <code>infra/docker/docker-compose.kiosk.yml</code> sets all of them
        and points <code>LANTERN_LLM_BASEURL_OPENAI</code>/<code>_ANTHROPIC</code> at the
        replay server.
      </p>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>Answers are recorded, not live. A live-model kiosk needs a separate, capped platform key and is not built.</li>
        <li>The per-address limit is in-memory and per process; behind a proxy all visitors share one address.</li>
        <li>The sandbox step shows the view only; the overlay does not start the microVM runtime.</li>
      </ul>
      <p>
        See also <Link href="/accounts">Accounts &amp; sign-up</Link> and{" "}
        <Link href="/security">Security</Link>.
      </p>
    </>
  );
}
