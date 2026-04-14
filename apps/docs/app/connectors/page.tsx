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

      <h2 id="gmail">Available connectors</h2>
      <p>Lantern ships with built-in connectors for:</p>
      <ul>
        <li>
          <strong>Gmail</strong> -- read, search, draft, and send emails
        </li>
        <li>
          <strong>Google Calendar</strong> -- read and create events, check
          availability
        </li>
        <li>
          <strong>Slack</strong> -- read channels, post messages, manage threads
        </li>
        <li>
          <strong>GitHub</strong> -- read repos, create issues, manage PRs,
          search code
        </li>
        <li>
          <strong>Linear</strong> -- read and create issues, manage projects
        </li>
        <li>
          <strong>Notion</strong> -- read and update pages, search databases
        </li>
        <li>
          <strong>Google Drive</strong> -- read and search documents
        </li>
        <li>
          <strong>Web Search</strong> -- search the web via configurable
          providers
        </li>
        <li>
          <strong>Web Scrape</strong> -- read and extract content from URLs
        </li>
      </ul>

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
      <p>[Screenshot: Connectors settings page with OAuth flow]</p>

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
      <p>[Screenshot: Agent configuration with connector toggles]</p>

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
