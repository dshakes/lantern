import Link from "next/link";
import { BrandGrid } from "../_components/Brands";
import { Concept } from "../_components/Concept";

export default function ConnectorsPage() {
  return (
    <>
      <h1>Connectors</h1>
      <p>
        Connectors are integrations with external services that your agents can
        use as tools. When an agent has a connector attached, it can read from
        and write to that service -- searching emails, creating GitHub issues,
        posting Slack messages, and more.
      </p>

      <Concept>
        A connector is how you give an agent hands. On its own, an agent can
        only think and answer; connect Gmail and it can search your inbox,
        connect Slack and it can post to a channel, connect Stripe and it can
        look up a payment. You sign in to each service once (usually a normal
        OAuth &quot;Allow&quot; screen), and every agent you authorize can then
        use it — with per-tool rate limits from{" "}
        <Link href="/budgets">Budgets</Link> keeping usage in check.
      </Concept>

      <BrandGrid items={[
        { name: "Gmail", sub: "read · search · send", href: "#email-calendar" },
        { name: "Google Calendar", sub: "events · availability", href: "#email-calendar" },
        { name: "Slack", sub: "post · read channels", href: "#communication" },
        { name: "GitHub", sub: "issues · PRs · repos", href: "#dev-tools" },
        { name: "Notion", sub: "pages · databases", href: "#docs-storage" },
        { name: "Stripe", sub: "payments · billing", href: "#commerce" },
        { name: "HubSpot", sub: "CRM · contacts · deals", href: "#crm-sales" },
        { name: "Jira", sub: "issues · agile", href: "#dev-tools" },
      ]} />

      <h2 id="available">Available connectors (17)</h2>

      <h3 id="communication">Communication</h3>
      <ul>
        <li>
          <strong>Slack</strong> (<code>slack</code>) -- read channels, post
          messages, manage threads; OAuth or bot token
        </li>
        <li>
          <strong>Discord</strong> (<code>discord</code>) -- bot integration for
          servers and DMs
        </li>
        <li>
          <strong>Telegram</strong> (<code>telegram</code>) -- bot messaging with
          inline buttons and media
        </li>
        <li>
          <strong>Twilio</strong> (<code>twilio</code>) -- SMS, voice calls, and
          WhatsApp messaging; Account SID + Auth Token + phone number
        </li>
      </ul>

      <h3 id="email-calendar">Email &amp; Calendar</h3>
      <ul>
        <li>
          <strong>Gmail</strong> (<code>gmail</code>) -- read, search, draft, and
          send emails; Google OAuth or app password
        </li>
        <li>
          <strong>Google Calendar</strong> (<code>google-calendar</code>) -- read
          and create events, check availability
        </li>
      </ul>

      <h3 id="docs-storage">Docs &amp; Storage</h3>
      <ul>
        <li>
          <strong>Google Drive</strong> (<code>google-drive</code>) -- access
          files and manage permissions
        </li>
        <li>
          <strong>Google Sheets</strong> (<code>google-sheets</code>) -- read and
          write spreadsheet data
        </li>
        <li>
          <strong>Notion</strong> (<code>notion</code>) -- access databases and
          workspace content; integration token
        </li>
      </ul>

      <h3 id="dev-tools">Dev Tools</h3>
      <ul>
        <li>
          <strong>GitHub</strong> (<code>github</code>) -- repositories, issues,
          pull requests; OAuth or personal access token
        </li>
        <li>
          <strong>Linear</strong> (<code>linear</code>) -- issue tracking and
          project management; API key
        </li>
        <li>
          <strong>Jira</strong> (<code>jira</code>) -- issue tracking and agile
          management; email + API token + domain
        </li>
        <li>
          <strong>Sentry</strong> (<code>sentry</code>) -- error tracking and
          performance monitoring; auth token
        </li>
        <li>
          <strong>Vercel</strong> (<code>vercel</code>) -- deployment management
          and project config; access token
        </li>
      </ul>

      <h3 id="crm-sales">CRM &amp; Sales</h3>
      <ul>
        <li>
          <strong>HubSpot</strong> (<code>hubspot</code>) -- CRM contacts, deals,
          and marketing; API key
        </li>
        <li>
          <strong>Salesforce</strong> (<code>salesforce</code>) -- CRM platform
          with full API access; username + password + security token
        </li>
      </ul>

      <h3 id="commerce">Commerce</h3>
      <ul>
        <li>
          <strong>Stripe</strong> (<code>stripe</code>) -- payments, subscriptions,
          and billing; secret key
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Web search and web scrape</strong> are built-in agent tools, not
        connectors -- no installation required. They are always available and
        enabled per-session via the <code>webSearch</code> session flag.
      </div>

      <div className="callout callout-info">
        <strong>Note:</strong> Custom connectors can be added by implementing
        the connector interface. See the SDK reference for details.
      </div>

      <h2 id="slack">Setting up a connector</h2>

      <h3>OAuth-based connectors</h3>
      <p>
        Most connectors (Gmail, Google Calendar, Slack, GitHub, Notion) use
        OAuth for authentication. The setup flow is:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Connectors</strong> in the dashboard
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
        <strong>Tip:</strong> You can connect multiple accounts for the same
        service. For example, connect both your personal and work Gmail
        accounts, then assign different accounts to different agents.
      </div>

      <h3>API key-based connectors</h3>
      <p>
        Some connectors (Web Search, custom APIs) use API keys instead of OAuth.
        For these:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Connectors</strong>
        </li>
        <li>Click the connector and select <strong>Manual credentials</strong></li>
        <li>Enter your API key or credentials</li>
        <li>
          Click <strong>Save</strong> -- credentials are encrypted at rest using
          your tenant&apos;s encryption key
        </li>
      </ol>

      <div className="callout callout-warning">
        <strong>Warning:</strong> API keys are stored encrypted and never
        appear in logs, traces, or run state. They are resolved at execution
        time inside the microVM.
      </div>

      <h2 id="per-agent">Per-agent connector assignment</h2>
      <p>
        Connectors are enabled at the account level but assigned per agent. This
        means:
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
        When an agent runs, its assigned connectors are injected as tools that
        the LLM can call. For example, an agent with the Gmail connector can:
      </p>
      <pre>
        <code>{`// The agent's LLM can call these tools automatically:
ctx.tools.gmail.search({ query: "from:boss@company.com subject:urgent" })
ctx.tools.gmail.draft({ to: "team@company.com", subject: "Summary", body: "..." })
ctx.tools.github.createIssue({ repo: "org/repo", title: "Bug: ...", body: "..." })`}</code>
      </pre>
      <p>
        The LLM decides when to use each tool based on the agent&apos;s system
        prompt and the user&apos;s input. You do not need to write code to
        invoke connectors -- just assign them and the LLM handles the rest.
      </p>

      <h2>Connector permissions</h2>
      <p>
        Each connector requests the minimum set of permissions (OAuth scopes)
        needed for its functionality. You can review the exact permissions on
        the connector&apos;s detail page in Settings.
      </p>
      <ul>
        <li>
          <strong>Gmail</strong> -- read and send email (not delete)
        </li>
        <li>
          <strong>GitHub</strong> -- read repos, issues, PRs; create issues and
          comments
        </li>
        <li>
          <strong>Slack</strong> -- read channels, post messages, manage threads
        </li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> You can disconnect a connector at any time from
        Settings. Agents that depend on it will fail gracefully and report the
        missing connector in their run output.
      </div>
    </>
  );
}
