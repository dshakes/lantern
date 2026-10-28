import Link from "next/link";
import { BrandGrid } from "../_components/Brands";
import { Concept } from "../_components/Concept";

export default function ConnectorsPage() {
  return (
    <>
      <h1>Connectors</h1>
      <p>
        A connector gives an agent hands: search a Gmail inbox, open a GitHub
        issue, post to Slack. Lantern ships 18, each with a fixed set of
        actions. Connect once; credentials are stored per tenant.
      </p>

      <Concept>
        Without connectors an agent can only think and answer. Connect a
        service once (usually an OAuth &quot;Allow&quot; screen) and the agent
        can call its actions. Per-tool limits can be stored on a{" "}
        <Link href="/budgets">budget</Link> and are enforced on workflow tool and connector nodes only.
      </Concept>

      <BrandGrid items={[
        { name: "Gmail", sub: "list · search · send", href: "#email-calendar" },
        { name: "Google Calendar", sub: "list · create events", href: "#email-calendar" },
        { name: "Slack", sub: "post · reply in thread · channels", href: "#communication" },
        { name: "GitHub", sub: "repos · PRs · issues", href: "#dev-tools" },
        { name: "Notion", sub: "search · databases", href: "#docs-storage" },
        { name: "Stripe", sub: "charges · customers", href: "#commerce" },
        { name: "HubSpot", sub: "contacts · deals", href: "#crm-sales" },
        { name: "Jira", sub: "list · create issues", href: "#dev-tools" },
      ]} />

      <h2 id="available">Available connectors (18)</h2>

      <h3 id="communication">Communication</h3>
      <ul>
        <li>
          <strong>Slack</strong> (<code>slack</code>) -- list channels and
          users, post messages, reply in threads; OAuth or bot token
        </li>
        <li>
          <strong>Discord</strong> (<code>discord</code>) -- list guilds, send
          messages; bot token or OAuth
        </li>
        <li>
          <strong>Telegram</strong> (<code>telegram</code>) -- send messages,
          fetch updates; bot token
        </li>
        <li>
          <strong>Twilio</strong> (<code>twilio</code>) -- send SMS, list
          messages, place calls, add conference participants; Account SID + Auth
          Token + phone number (or Messaging Service SID)
        </li>
      </ul>

      <h3 id="email-calendar">Email &amp; Calendar</h3>
      <ul>
        <li>
          <strong>Gmail</strong> (<code>gmail</code>) -- list, search and send
          mail; Google OAuth or email + app password
        </li>
        <li>
          <strong>Google Calendar</strong> (<code>google-calendar</code>) --
          list and create events; Google OAuth
        </li>
      </ul>

      <h3 id="docs-storage">Docs &amp; Storage</h3>
      <ul>
        <li>
          <strong>Google Drive</strong> (<code>google-drive</code>) -- list
          files; Google OAuth
        </li>
        <li>
          <strong>Google Sheets</strong> (<code>google-sheets</code>) -- get a
          spreadsheet, get cell values; Google OAuth
        </li>
        <li>
          <strong>Notion</strong> (<code>notion</code>) -- search, list
          databases; OAuth or integration token
        </li>
      </ul>

      <h3 id="dev-tools">Dev Tools</h3>
      <ul>
        <li>
          <strong>GitHub</strong> (<code>github</code>) -- list repos, list and
          get PRs, list and get issues, create issues, comment on PRs; OAuth or
          personal access token
        </li>
        <li>
          <strong>Linear</strong> (<code>linear</code>) -- list and create
          issues; API key or OAuth
        </li>
        <li>
          <strong>Jira</strong> (<code>jira</code>) -- list and create issues;
          email + API token + domain, or OAuth
        </li>
        <li>
          <strong>Sentry</strong> (<code>sentry</code>) -- list and get
          issues; auth token
        </li>
        <li>
          <strong>PagerDuty</strong> (<code>pagerduty</code>) -- list and get
          incidents, create and update incidents; REST API key. No dashboard
          card yet; install over the API (see{" "}
          <a href="#new-actions">Newer actions</a>)
        </li>
        <li>
          <strong>Vercel</strong> (<code>vercel</code>) -- list projects and
          deployments; access token
        </li>
      </ul>

      <h3 id="crm-sales">CRM &amp; Sales</h3>
      <ul>
        <li>
          <strong>HubSpot</strong> (<code>hubspot</code>) -- list contacts and
          deals; API key or OAuth
        </li>
        <li>
          <strong>Salesforce</strong> (<code>salesforce</code>) -- run SOQL
          queries; access token + instance URL (OAuth supported)
        </li>
      </ul>

      <h3 id="commerce">Commerce</h3>
      <ul>
        <li>
          <strong>Stripe</strong> (<code>stripe</code>) -- list charges and
          customers; secret key or OAuth
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Web search</strong> is a built-in agent tool, not a connector:
        nothing to install. Sessions enable it with the <code>webSearch</code>{" "}
        flag.
      </div>

      <div className="callout callout-info">
        <strong>Adding a connector</strong> is a code change today: a new case
        in <code>connector_executor.go</code> in the control plane. There is
        no plug-in interface yet.
      </div>

      <h2 id="new-actions">Newer actions</h2>
      <p>
        Four actions and one connector (PagerDuty, four actions) were added after the original set.
        All run through{" "}
        <code>POST /v1/connectors/&#123;id&#125;/execute?action=&lt;action&gt;</code>{" "}
        with a JSON body of params (the connector must be installed and
        connected first). A successful call returns{" "}
        <code>{"{"}&quot;connector&quot;, &quot;action&quot;, &quot;data&quot;{"}"}</code>;
        a failed vendor call returns 502 with{" "}
        <code>{"{"}&quot;error&quot;, &quot;connector&quot;, &quot;action&quot;{"}"}</code>;
        an uninstalled connector returns 404.
      </p>
      <table>
        <thead>
          <tr>
            <th>Connector / action</th>
            <th>Params (<strong>required</strong> in bold)</th>
            <th>Credential (config field)</th>
            <th>Class</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>slack</code> / <code>reply_thread</code></td>
            <td><strong><code>channel</code></strong>, <strong><code>text</code></strong>, <strong><code>thread_ts</code></strong></td>
            <td>OAuth, or <code>botToken</code></td>
            <td>write</td>
          </tr>
          <tr>
            <td><code>github</code> / <code>comment_pr</code></td>
            <td><strong><code>owner</code></strong>, <strong><code>repo</code></strong>, <strong><code>number</code></strong>, <strong><code>body</code></strong></td>
            <td>OAuth, or <code>personalAccessToken</code></td>
            <td>write</td>
          </tr>
          <tr>
            <td><code>sentry</code> / <code>get_issue</code></td>
            <td><strong><code>organization</code></strong>, <strong><code>issue_id</code></strong></td>
            <td><code>authToken</code></td>
            <td>read-only</td>
          </tr>
          <tr>
            <td><code>google-calendar</code> / <code>create_event</code></td>
            <td><strong><code>summary</code></strong>, <strong><code>start</code></strong>, <strong><code>end</code></strong> (RFC3339); optional <code>calendarId</code> (default <code>primary</code>), <code>timeZone</code>, <code>description</code>, <code>location</code>, <code>attendees</code> (array of emails)</td>
            <td>Google OAuth</td>
            <td>write</td>
          </tr>
          <tr>
            <td><code>pagerduty</code> / <code>list_incidents</code></td>
            <td>optional <code>status</code> (<code>triggered</code>, <code>acknowledged</code>, <code>resolved</code>), <code>limit</code> (default 25)</td>
            <td><code>apiKey</code> (REST API key)</td>
            <td>read-only</td>
          </tr>
          <tr>
            <td><code>pagerduty</code> / <code>get_incident</code></td>
            <td><strong><code>incident_id</code></strong></td>
            <td><code>apiKey</code></td>
            <td>read-only</td>
          </tr>
          <tr>
            <td><code>pagerduty</code> / <code>create_incident</code></td>
            <td><strong><code>title</code></strong>, <strong><code>service_id</code></strong>, <strong><code>from</code></strong> (acting user&apos;s email); optional <code>details</code></td>
            <td><code>apiKey</code></td>
            <td>write</td>
          </tr>
          <tr>
            <td><code>pagerduty</code> / <code>update_incident</code></td>
            <td><strong><code>incident_id</code></strong>, <strong><code>from</code></strong>, <strong><code>status</code></strong> (<code>acknowledged</code> or <code>resolved</code>)</td>
            <td><code>apiKey</code></td>
            <td>write</td>
          </tr>
          <tr>
            <td><code>pagerduty</code> / <code>add_note</code></td>
            <td><strong><code>incident_id</code></strong>, <strong><code>content</code></strong>, <strong><code>from</code></strong></td>
            <td><code>apiKey</code></td>
            <td>write</td>
          </tr>
        </tbody>
      </table>
      <p>
        Slack <code>post_message</code> also accepts an optional{" "}
        <code>thread_ts</code>; <code>reply_thread</code> is the same call with{" "}
        <code>thread_ts</code> required. &quot;Read-only&quot; is the
        allowlist in <code>connector_safety.go</code>; anything not on it,
        including every action on an unknown connector, is treated as
        side-effecting.
      </p>
      <p>
        PagerDuty has no dashboard card yet. Install it over the API, then
        call it. Agents get <code>list_incidents</code> and{" "}
        <code>get_incident</code> as tools;{" "}
        <code>create_incident</code>, <code>update_incident</code> and{" "}
        <code>add_note</code> are REST-only (and usable from workflow connector nodes).
      </p>
      <pre>
        <code>{`# install PagerDuty (config.apiKey = a REST API key)
curl -X POST http://localhost:8080/v1/connectors/install \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectorId": "pagerduty", "displayName": "PagerDuty", "config": {"apiKey": "..."}}'

# read an incident
curl -X POST "http://localhost:8080/v1/connectors/pagerduty/execute?action=get_incident" \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"incident_id": "PABC123"}'

# acknowledge it (write; "from" is required by PagerDuty)
curl -X POST "http://localhost:8080/v1/connectors/pagerduty/execute?action=update_incident" \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"incident_id": "PABC123", "from": "oncall@example.com", "status": "acknowledged"}'

# reply in a Slack thread
curl -X POST "http://localhost:8080/v1/connectors/slack/execute?action=reply_thread" \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C0123", "thread_ts": "1700000000.000100", "text": "On it."}'`}</code>
      </pre>

      <h2 id="recorded-test-mode">Recorded test mode</h2>
      <p>
        Run connector actions without a real SaaS account by pointing a vendor
        at a local fixture server. This is dev and test only.
      </p>
      <p>
        <strong>1. Start the fixture server</strong> from{" "}
        <code>services/control-plane</code>. It listens on loopback and serves
        recorded responses for Slack, GitHub, Sentry, PagerDuty and Google
        Calendar:
      </p>
      <pre>
        <code>{`go run ./cmd/connector-replay            # 127.0.0.1:9191
go run ./cmd/connector-replay -addr 127.0.0.1:9292`}</code>
      </pre>
      <p>
        <strong>2. Point the control plane at it</strong> before starting it
        (<code>LANTERN_ENV</code> must not be prod, production or staging):
      </p>
      <pre>
        <code>{`export LANTERN_CONNECTOR_BASEURL_SLACK=http://127.0.0.1:9191
export LANTERN_CONNECTOR_BASEURL_GITHUB=http://127.0.0.1:9191
export LANTERN_CONNECTOR_BASEURL_SENTRY=http://127.0.0.1:9191
export LANTERN_CONNECTOR_BASEURL_GOOGLE=http://127.0.0.1:9191
export LANTERN_CONNECTOR_BASEURL_PAGERDUTY=http://127.0.0.1:9191
make run-api`}</code>
      </pre>
      <p>
        <strong>3. Check it worked</strong>: install a connector with any
        non-empty token, execute an action, then read what the server saw:
      </p>
      <pre>
        <code>{`curl -s http://127.0.0.1:9191/__requests`}</code>
      </pre>
      <p>
        Each recorded call has <code>method</code>, <code>path</code>,{" "}
        <code>query</code>, <code>header</code>, <code>body</code>,{" "}
        <code>hasAuth</code>, <code>matched</code> and <code>status</code>.
        The <code>Authorization</code> header is never stored, only whether it
        was set.
      </p>

      <h3 id="baseurl-vars">Override variables</h3>
      <table>
        <thead>
          <tr><th>Variable</th><th>Vendor host replaced</th><th>Connectors affected</th></tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_SLACK</code></td><td><code>slack.com</code></td><td>Slack</td></tr>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_GITHUB</code></td><td><code>api.github.com</code></td><td>GitHub</td></tr>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_SENTRY</code></td><td><code>sentry.io</code></td><td>Sentry</td></tr>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_GOOGLE</code></td><td><code>www.googleapis.com</code></td><td>Google Calendar, Google Drive</td></tr>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_PAGERDUTY</code></td><td><code>api.pagerduty.com</code></td><td>PagerDuty</td></tr>
        </tbody>
      </table>
      <p>
        The value must be an absolute <code>http</code> or <code>https</code>{" "}
        URL with a host. Only scheme and host are replaced; the vendor path is
        kept, so the fixture server serves real paths such as{" "}
        <code>/api/chat.postMessage</code>. An unmatched request gets 404{" "}
        <code>{"{"}&quot;error&quot;: &quot;no recorded fixture for METHOD PATH&quot;{"}"}</code>.
      </p>
      <p>
        Fixtures are exact method + path matches in{" "}
        <code>internal/connectorreplay/fixtures.json</code> (embedded in the
        binary): Slack <code>conversations.list</code> and{" "}
        <code>chat.postMessage</code>; GitHub <code>acme/api</code> pulls list,
        PR 42, and a comment on 42; Sentry org <code>acme</code> issues list
        and issue <code>1001</code>; PagerDuty incidents list, get{" "}
        <code>PABC123</code>, create, update; Google Calendar{" "}
        <code>primary</code> events list and insert. Use those owner, repo,
        org and ids in your test params.
      </p>

      <h3 id="prod-guard">Refused in production</h3>
      <p>
        A bearer token must never be sent to an arbitrary host, so overrides
        are blocked twice:
      </p>
      <ul>
        <li>
          <strong>Startup:</strong> with <code>LANTERN_ENV</code> set to{" "}
          <code>prod</code>, <code>production</code> or <code>staging</code>,
          the control plane exits if any override variable is set:{" "}
          <code>LANTERN_CONNECTOR_BASEURL_X set in production — connector base-URL overrides are test-only and would redirect tenant credentials to another host; unset them</code>{" "}
          (names of every variable set are listed). In any environment a
          malformed value is also fatal:{" "}
          <code>LANTERN_CONNECTOR_BASEURL_X is malformed: must be an absolute http(s) URL, got &quot;...&quot;</code>.
        </li>
        <li>
          <strong>Request time:</strong> the outbound transport ignores
          overrides whenever the environment is prod, even if one slipped in.
        </li>
      </ul>

      <h2 id="slack">Setting up a connector</h2>

      <h3>OAuth-based connectors</h3>
      <p>
        Gmail, Google Calendar, Drive, Sheets, Slack, GitHub and Notion
        support OAuth. The flow:
      </p>
      <ol>
        <li>
          Open <strong>Integrations</strong> (<code>/connectors</code>) in the dashboard
        </li>
        <li>Click the connector you want to enable</li>
        <li>
          Click <strong>Connect</strong> -- you will be redirected to the
          service&apos;s OAuth consent screen
        </li>
        <li>Authorize access and you will be redirected back to Lantern</li>
        <li>
          The connector is now available and can be attached to any agent
        </li>
      </ol>


      <div className="callout callout-tip">
        <strong>Tip:</strong> Revoke access any time by uninstalling the
        connector (<code>DELETE /v1/connectors/&#123;id&#125;</code>).
      </div>

      <h3>API key-based connectors</h3>
      <p>
        Linear, Sentry, Vercel, Stripe, Twilio, Telegram and others take a key
        or token instead of OAuth. For these:
      </p>
      <ol>
        <li>
          Open <strong>Integrations</strong>
        </li>
        <li>Click the connector and select <strong>Manual credentials</strong></li>
        <li>Enter your API key or credentials</li>
        <li>
          Click <strong>Save</strong> -- credentials are encrypted at rest
          (AES-256-GCM) when <code>LANTERN_CREDENTIAL_KEY</code> is set;
          without it they are stored as plaintext, so set it outside dev
        </li>
      </ol>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Credentials never appear in logs, traces or
        run state. Connector actions run in the control plane, which resolves
        the credential at call time.
      </div>

      <h2 id="per-agent">Per-agent connector assignment</h2>
      <p>
        Connect an account once, then choose which agents may use it:
      </p>
      <ul>
        <li>
          You connect your Gmail account once in Settings
        </li>
        <li>
          For each agent, you choose which connectors it can access
        </li>
        <li>
          An agent can only use connectors explicitly assigned to it
        </li>
      </ul>
      <p>To assign connectors to an agent:</p>
      <ol>
        <li>
          Open the agent&apos;s detail page in the dashboard
        </li>
        <li>
          Go to the <strong>Configuration</strong> tab
        </li>
        <li>
          In the <strong>Connectors</strong> section, toggle the connectors
          this agent should have access to
        </li>
        <li>
          Click <strong>Save</strong>
        </li>
      </ol>

      <h2>How agents use connectors</h2>
      <p>
        Assigned connectors reach the LLM as tools; it decides when to call
        them. You can also call an action directly over REST:
      </p>
      <pre>
        <code>{`curl -X POST "http://localhost:8080/v1/connectors/gmail/execute?action=search" \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "from:boss@company.com subject:urgent"}'`}</code>
      </pre>
      <p>
        Lantern classifies list, get, search and query actions as read-only;
        everything else (send, post, create) counts as side-effecting. In
        the workflow engine, <Link href="/human-in-the-loop">confidence
        gating</Link> (off by default) can route side-effecting steps to a
        human first.
      </p>

      <h2>Connector permissions</h2>
      <p>
        OAuth scopes come from <code>oauth_providers.go</code>:
      </p>
      <ul>
        <li>
          <strong>Gmail</strong> -- <code>gmail.modify</code>: read, send, label.
          No permanent delete.
        </li>
        <li>
          <strong>GitHub</strong> -- <code>repo</code>, <code>read:user</code>
        </li>
        <li>
          <strong>Slack</strong> -- <code>channels:read</code>,{" "}
          <code>chat:write</code>, <code>users:read</code>
        </li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> If a connector is missing or uninstalled, the
        action returns a missing-credentials error naming the connector.
      </div>
    </>
  );
}
