export default function CliPage() {
  return (
    <>
      <h1>CLI Reference</h1>
      <p>
        The <code>lantern</code> CLI is a single static binary (Go + Cobra) that
        covers the entire development lifecycle: local dev, agent iteration,
        run inspection, headless VM management, and data-plane infra.
      </p>

      <h3>Install</h3>
      <pre>
        <code>{`# Build from the repo
cd packages/cli && go install ./cmd/lantern

lantern --version`}</code>
      </pre>

      <h2 id="onboard">onboard</h2>
      <p>
        First-run wizard: health check → auth → provider key → create agent →
        run. Gets you from a running stack to a working agent in under a minute.
      </p>
      <pre>
        <code>{`lantern onboard`}</code>
      </pre>

      <h2 id="doctor">doctor</h2>
      <p>
        Runs a sequence of readiness checks against the local stack and prints
        a pass/fail line for each one. Exits non-zero if any hard check fails.
        Always run this before reporting a bug.
      </p>
      <pre>
        <code>{`lantern doctor`}</code>
      </pre>

      <h2 id="dev">dev</h2>
      <p>
        Boots the full Lantern stack locally with hot reload: Postgres, Redis,
        MinIO (via Docker), the control-plane API (host Go process), the
        Next.js dashboard, and the WhatsApp bridge. All logs interleave into
        one terminal.
      </p>
      <pre>
        <code>{`lantern dev       # start everything
lantern down      # stop infra containers
lantern logs      # tail all infra logs
lantern logs api  # tail a specific service`}</code>
      </pre>

      <h2 id="init">init</h2>
      <p>
        Scaffold a new agent directory with <code>agent.yaml</code> and starter
        code.
      </p>
      <pre>
        <code>{`lantern init my-agent
lantern init my-agent --template research`}</code>
      </pre>

      <h2 id="agents">agents</h2>
      <p>Manage agents. Aliased as <code>agent</code>.</p>
      <pre>
        <code>{`lantern agents create --name my-agent --system-prompt "You are..."
lantern agents list
lantern agents get my-agent
lantern agents delete my-agent

# Development inner loop — watches the agent dir and re-publishes on change
lantern agents dev my-agent [--dir ./my-agent] [--run '{"key":"val"}']`}</code>
      </pre>

      <p>
        <code>agents dev</code> is the agent development inner loop: it watches
        the local directory for changes to <code>agent.yaml</code> or code
        files, re-publishes the agent version on each change, and streams run
        events in the terminal.
      </p>

      <h2 id="runs">runs</h2>
      <p>
        Manage runs (invoke, inspect, cancel). Aliased as <code>run</code>.
      </p>
      <pre>
        <code>{`lantern runs create --agent my-agent --input '{"topic":"AI"}' [--stream]
lantern runs list [--agent my-agent] [--status succeeded]
lantern runs get <run-id>
lantern runs cancel <run-id>`}</code>
      </pre>

      <h2 id="logs">logs</h2>
      <p>Tail logs for a run or a dev-stack service.</p>
      <pre>
        <code>{`lantern logs <run-id>      # stream journal events for a run
lantern logs api           # dev-stack: tail the API service
lantern logs               # dev-stack: all services`}</code>
      </pre>

      <h2 id="test">test</h2>
      <p>
        Run an agent&apos;s eval suite and compare against the branch baseline.
        Returns non-zero (and prints a regression summary) when the score drops
        below the baseline — wire this into CI to gate merges.
      </p>
      <pre>
        <code>{`lantern test --agent my-agent --suite factual-accuracy
lantern test --agent my-agent --suite factual-accuracy --against last-green`}</code>
      </pre>

      <h2 id="vm">vm</h2>
      <p>
        Inspect and manage headless microVM agent runs. Aliased as{" "}
        <code>vms</code> and <code>runtime</code>.
      </p>
      <pre>
        <code>{`# Schedule a headless agent from a spec file
lantern run agent.yaml [--follow]

# VM subcommands
lantern vm list [--state running]
lantern vm get <vm-id>
lantern vm logs <vm-id>          # SSE log stream from the harness
lantern vm stop <vm-id> [--grace 30]
lantern vm exec <vm-id> -- ls /tmp   # exec into a running VM (debug)
lantern vm quota                 # current quota + today's usage
lantern vm cluster               # node load + warm-pool capacity (owner only)`}</code>
      </pre>

      <h2 id="deploy">deploy</h2>
      <p>
        Reads <code>agent.yaml</code> from the current directory, builds the
        agent bundle, uploads it, and deploys it to Lantern.
      </p>
      <pre>
        <code>{`lantern deploy [--env staging]`}</code>
      </pre>

      <h2 id="infra">infra</h2>
      <p>
        Manage the data plane in your cloud infrastructure (EKS, GKE, AKS).
      </p>
      <pre>
        <code>{`lantern infra install   # generate Terraform config for the data plane
lantern infra status    # show connection status
lantern infra upgrade   # upgrade data plane components`}</code>
      </pre>

      <h2 id="auth">login / whoami / logout</h2>
      <pre>
        <code>{`lantern login           # authenticate to the control plane
lantern whoami          # show current authenticated user
lantern logout          # clear stored credentials`}</code>
      </pre>

      <h2 id="global">Global flags</h2>
      <pre>
        <code>{`--api-url string    Control plane base URL (default: $LANTERN_API_URL or http://localhost:8080)
--api-key string    API key (default: $LANTERN_API_KEY)
--json              Output JSON instead of human-readable text
--no-color          Disable ANSI colour output
-v, --verbose       Verbose logging`}</code>
      </pre>
    </>
  );
}
