import Link from "next/link";
import { BrandGrid } from "../_components/Brands";
import { Concept } from "../_components/Concept";

export default function ConnectorsPage() {
  return (
    <>
      <h1>Connectors</h1>
      <p>
        A connector gives an agent hands: search a Gmail inbox, open a GitHub
        issue, post to Slack. Lantern ships 17, each with a fixed set of
        actions. Connect once; credentials are stored per tenant.
      </p>

      <Concept>
        Without connectors an agent can only think and answer. Connect a
        service once (usually an OAuth &quot;Allow&quot; screen) and the agent
        can call its actions. Per-tool limits can be stored on a{" "}
        <Link href="/budgets">budget</Link> but are not enforced yet.
      </Concept>

      <BrandGrid items={[
        { name: "Gmail", sub: "list · search · send", href: "#email-calendar" },
        { name: "Google Calendar", sub: "list events", href: "#email-calendar" },
        { name: "Slack", sub: "post · list channels", href: "#communication" },
        { name: "GitHub", sub: "repos · PRs · issues", href: "#dev-tools" },
        { name: "Notion", sub: "search · databases", href: "#docs-storage" },
        { name: "Stripe", sub: "charges · customers", href: "#commerce" },
        { name: "HubSpot", sub: "contacts · deals", href: "#crm-sales" },
        { name: "Jira", sub: "list · create issues", href: "#dev-tools" },
      ]} />

      <h2 id="available">Available connectors (17)</h2>

      <h3 id="communication">Communication</h3>
      <ul>
        <li>
          <strong>Slack</strong> (<code>slack</code>) -- list channels and
          users, post messages; OAuth or bot token
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
          list events; Google OAuth
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
          get PRs, list and get issues, create issues; OAuth or personal access
          token
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
          <strong>Sentry</strong> (<code>sentry</code>) -- list issues; auth
          token
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
