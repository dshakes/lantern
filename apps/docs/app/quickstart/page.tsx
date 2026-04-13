export default function QuickStartPage() {
  return (
    <>
      <h1>Quick Start</h1>
      <p>
        Get a full Lantern development environment running locally in under 5
        minutes. By the end of this guide you will have the API server, dashboard,
        and infrastructure running and will have created your first agent.
      </p>

      <h2>Prerequisites</h2>
      <p>Make sure you have these installed:</p>
      <ul>
        <li>
          <strong>Docker Desktop</strong> (v4.x+) -- required for Postgres, Redis,
          and MinIO
        </li>
        <li>
          <strong>Node.js</strong> (v20+) -- for the dashboard and SDK
        </li>
        <li>
          <strong>Go</strong> (v1.22+) -- for the control plane API
        </li>
        <li>
          <strong>Git</strong> -- to clone the repository
        </li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> On macOS, you can install all prerequisites with{" "}
        <code>brew install docker node go git</code>.
      </div>

      <h2>Step 1: Clone the repository</h2>
      <pre>
        <code>{`git clone https://github.com/dshakes/lantern.git
cd lantern`}</code>
      </pre>

      <h2>Step 2: Start infrastructure</h2>
      <p>
        This starts Postgres, Redis, and MinIO in Docker containers. These services
        are the backbone of the control plane.
      </p>
      <pre>
        <code>{`make dev-infra`}</code>
      </pre>
      <p>
        Wait until you see all three containers reporting healthy. This usually
        takes 10-15 seconds.
      </p>

      <div className="callout callout-info">
        <strong>Note:</strong> The infrastructure runs on the following default ports:
        Postgres on 5432, Redis on 6379, and MinIO on 9000 (console on 9001).
      </div>

      <h2>Step 3: Start the API server</h2>
      <p>
        The control plane API is a Go service that handles agent management,
        scheduling, and workflow orchestration.
      </p>
      <pre>
        <code>{`make run-api`}</code>
      </pre>
      <p>
        The API starts on <code>http://localhost:8080</code>. You should see log
        output confirming the server is ready.
      </p>

      <h2>Step 4: Start the dashboard</h2>
      <p>
        In a new terminal window, start the Next.js dashboard:
      </p>
      <pre>
        <code>{`make dashboard-dev`}</code>
      </pre>
      <p>
        The dashboard is available at <code>http://localhost:3001</code>.
      </p>

      <h2>Step 5: Sign up</h2>
      <p>
        Open <code>http://localhost:3001</code> in your browser. Click{" "}
        <strong>Sign up</strong> and create an account using your email address.
        In local dev mode, email verification is skipped automatically.
      </p>
      <p>[Screenshot: Sign-up page with email and password fields]</p>

      <h2>Step 6: Create your first agent</h2>
      <p>
        From the dashboard, click <strong>New Agent</strong> and choose the{" "}
        <strong>AI-assisted</strong> creation method. Describe what you want
        your agent to do in plain English:
      </p>
      <pre>
        <code>{`Research a given topic by searching the web, reading the top
results, and writing a comprehensive summary with citations.`}</code>
      </pre>
      <p>
        Lantern will generate the agent configuration, system prompt, and
        connected tools for you. Review the configuration, then click{" "}
        <strong>Create</strong>.
      </p>
      <p>[Screenshot: Agent creation wizard with AI-assisted mode]</p>

      <h2>Step 7: Run your agent</h2>
      <p>
        From the agent detail page, open the <strong>Playground</strong> tab.
        Enter a topic and click <strong>Run</strong>. You will see the agent
        execute in real time with streaming output for each step.
      </p>
      <pre>
        <code>{`# Or run from the CLI:
lantern run research-agent --input '{"topic": "quantum computing"}'`}</code>
      </pre>
      <p>[Screenshot: Agent playground with streaming output]</p>

      <div className="callout callout-tip">
        <strong>Tip:</strong> You can also seed sample data with{" "}
        <code>make seed</code> to explore pre-built agents and runs.
      </div>

      <h2>Next steps</h2>
      <ul>
        <li>
          <a href="/agents">Agents</a> -- learn how to create and configure agents
          in depth
        </li>
        <li>
          <a href="/connectors">Connectors</a> -- connect Gmail, Slack, GitHub, and
          more
        </li>
        <li>
          <a href="/surfaces">Surfaces</a> -- set up WhatsApp, Discord, or web chat
        </li>
        <li>
          <a href="/models">Models</a> -- configure LLM providers and API keys
        </li>
      </ul>
    </>
  );
}
