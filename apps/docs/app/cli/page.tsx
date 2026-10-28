import Link from "next/link";
import { Concept } from "../_components/Concept";

export default function CliPage() {
  return (
    <>
      <h1>CLI Reference</h1>
      <p>
        One static Go binary. It boots the local stack, scaffolds and runs
        agents, gates CI on evals, drives sandbox VMs, and installs the data
        plane in your cloud.
      </p>

      <Concept>
        Starting out? Two commands cover it: <code>lantern dev</code> boots
        the stack and <code>lantern onboard</code> walks you through your first
        agent.
      </Concept>

      <h3>Install</h3>
      <pre>
        <code>{`# Build from the repo
cd packages/cli && go install ./cmd/lantern

lantern --version`}</code>
      </pre>

      <h2 id="onboard">onboard</h2>
      <p>
        First-run wizard: health check, sign-in, provider key (with a real test
        call), then the agentic part. It asks what you want the agent to do, the
        control plane designs it, you confirm, and the first run streams live. With{" "}
        <code>--yes</code> or a non-terminal stdin it never prompts (CI). Flags:{" "}
        <code>--provider</code> (openai|anthropic), <code>--api-key</code>,{" "}
        <code>--description</code>. See{" "}
        <Link href="/quickstart#cli">Get started</Link>.
      </p>
      <pre>
        <code>{`lantern onboard                     # interactive
lantern onboard --yes --provider anthropic --api-key "$KEY" \\
  --description "Triage support tickets"   # CI`}</code>
      </pre>

      <h2 id="doctor">doctor</h2>
      <p>
        Runs readiness checks against the local stack, one pass/fail line each.
        Exits non-zero if any hard check fails. Run it before you report a
        bug. The <em>Sandbox runtime</em>{" "}
        section, which never fails the run, reports whether the API uses a real
        scheduler or the stub, whether the scheduler and runtime manager are
        reachable, and whether KVM and Firecracker are present. Each failing
        check prints its fix.
      </p>
      <pre>
        <code>{`lantern doctor`}</code>
      </pre>

      <h2 id="dev">dev</h2>
      <p>
        Boots the local stack: Postgres, Redis and MinIO (Docker), the
        control-plane API (host Go process), the Next.js dashboard, and the
        WhatsApp and iMessage bridges (iMessage is skipped off macOS). Logs
        interleave in one terminal. Flags: <code>--infra-only</code>,{" "}
        <code>--with-whatsapp=false</code>, <code>--with-imessage=false</code>,{" "}
        <code>--no-open</code>, <code>--dashboard-port</code> (3001),{" "}
        <code>--api-port</code> (8080).
      </p>
      <pre>
        <code>{`lantern dev       # start everything
lantern dev down  # stop infra containers (--volumes also deletes data)
lantern dev logs  # tail all infra logs
lantern dev logs postgres  # tail one service`}</code>
      </pre>

      <h2 id="init">init</h2>
      <p>
        Scaffold a new agent directory with <code>agent.yaml</code> and starter
        code. Templates: <code>basic</code> (default), <code>research</code>,{" "}
        <code>tool-use</code>, <code>connector</code>, <code>personal</code>,{" "}
        <code>scheduled</code>, <code>approval</code>.
      </p>
      <pre>
        <code>{`lantern init my-agent
lantern init my-agent --template research`}</code>
      </pre>

      <h2 id="agents">agents</h2>
      <p>Manage agents. Aliased as <code>agent</code>.</p>
      <pre>
        <code>{`lantern agents create --name my-agent --description "Triage tickets" [--label team=support]
lantern agents list
lantern agents get my-agent
lantern agents delete my-agent [--force]

# Development inner loop — watches the agent dir and re-publishes on change
lantern agents dev my-agent [--dir ./my-agent] [--input '{"prompt":"hi"}'] [--eval] [--yes]`}</code>
      </pre>

      <p>
        <code>agents dev</code> is the agent development inner loop: it watches
        the local directory for changes to <code>agent.yaml</code> or code
        files, re-publishes the agent version on each change, runs a smoke input
        (<code>--input</code>), and streams the run events. <code>--eval</code>{" "}
        also runs the agent&apos;s eval suite after each publish.
      </p>

      <h2 id="runs">runs</h2>
      <p>
        Manage runs: create, list, inspect, cancel.
      </p>
      <pre>
        <code>{`lantern runs create --agent my-agent --input '{"topic":"AI"}' [--stream]
lantern runs list [--agent my-agent] [--status succeeded]
lantern runs get <run-id>
lantern runs cancel <run-id> [--reason "..."]`}</code>
      </pre>

      <h2 id="logs">logs</h2>
      <p>Stream a run&apos;s journal events. For dev-stack containers use <code>lantern dev logs</code>.</p>
      <pre>
        <code>{`lantern logs <run-id> [-f]   # journal events; -f keeps the stream open`}</code>
      </pre>

      <h2 id="test">test</h2>
      <p>
        Run an agent&apos;s eval suite and compare against the branch baseline.
        Exits non-zero with a regression summary when the score drops below
        the baseline. Wire it into CI to gate merges. <code>--set-baseline</code>{" "}
        pins the run as the branch baseline. <code>--rehearse</code> replays
        past failed or low-score production runs instead of a suite
        (<code>--window</code>, default 7d).
      </p>
      <pre>
        <code>{`lantern test --agent my-agent --suite factual-accuracy
lantern test --agent my-agent --suite factual-accuracy --against last-green
lantern test --agent my-agent --rehearse --window 24h`}</code>
      </pre>

      <h2 id="vm">vm</h2>
      <p>
        Schedule and manage headless sandbox VMs. <code>lantern run</code> takes a
        spec file; <code>vm</code> (aliases <code>vms</code>,{" "}
        <code>runtime</code>) manages what it started.
      </p>
      <pre>
        <code>{`# Schedule a headless agent from a spec file
lantern run agent.yaml [--input '{...}'] [--follow] [--idle-timeout 600]

# VM subcommands
lantern vm list [--state running] [--limit 50]
lantern vm get <vm-id>
lantern vm logs <vm-id>          # SSE log stream from the harness
lantern vm stop <vm-id> [--grace 30]
lantern vm pause <vm-id>            # snapshot + stop, frees the quota slot
lantern vm resume <vm-id>           # restore under the same vm id
lantern vm fork <vm-id> --count 3   # N copies; the server caps N (100 by default, LANTERN_MAX_FORK_COUNT, ceiling 1000)
lantern vm exec <vm-id> -- ls /tmp   # exec into a running VM (-t/-i for a PTY)
lantern vm ls <vm-id> [path]        # list /workspace
lantern vm cat <vm-id> <path>       # print a file (1 MiB cap)
lantern vm put <vm-id> ./f.txt /workspace/f.txt   # write a file (1 MiB cap)
lantern vm quota get             # current quota + today's usage
lantern vm quota set --max-concurrent 10 --max-cost 50   # owner only
lantern vm cluster               # node load + warm-pool capacity (owner only)`}</code>
      </pre>

      <h2 id="deploy">deploy</h2>
      <p>
        Reads <code>agent.yaml</code> from the current directory, creates the
        agent on the control plane (or updates its system prompt and model if
        it already exists), saves the optional <code>workflow</code> graph, then
        calls <code>POST /v1/agents/{"{name}"}/deploy</code>. Manifest keys used:{" "}
        <code>name</code> (required), <code>description</code>,{" "}
        <code>model</code>, <code>system_prompt</code>, <code>labels</code>{" "}
        (set on create only; the update endpoint cannot change description or
        labels) and <code>workflow</code>. Other keys are ignored. Uses REST, so
        pass the HTTP address or let it derive one from the gRPC address.
      </p>
      <p>
        Flags: <code>--json</code> (print the API response; same as{" "}
        <code>-o json</code>), <code>--dry-run</code> (one read-only lookup,
        reports <code>create</code> or <code>update</code>, changes nothing).
        Exit codes: <code>0</code> ok, <code>3</code> unauthorized (401/403),{" "}
        <code>4</code> quota or budget (402), <code>5</code> not found (404),{" "}
        <code>6</code> server error (5xx), <code>1</code> anything else.
      </p>
      <pre>
        <code>{`$ cat agent.yaml
name: demo-bot
description: demo
model: auto
system_prompt: You are terse.

$ lantern --api-url http://localhost:8080 deploy --json
{
  "agent": "created",
  "agentName": "demo-bot",
  "deployedAt": "...",
  "environment": "cloud",
  "id": "<deployment-id>",
  "status": "live",
  "tenantId": "<tenant-id>",
  "url": "http://localhost:8080/v1/agents/demo-bot/a2a/invoke"
}`}</code>
      </pre>

      <h2 id="infra">infra</h2>
      <p>
        Generate and manage the data plane for AWS, GCP or Azure (EKS, GKE,
        AKS) via Terraform.
      </p>
      <pre>
        <code>{`lantern infra install --cloud aws [--region us-east-1] [--node-count 3] [--firecracker]
lantern infra status    # show connection status
lantern infra upgrade [--version latest]
lantern infra uninstall [--force]   # tear down the data plane`}</code>
      </pre>

      <h2 id="auth">login / whoami / logout</h2>
      <pre>
        <code>{`lantern login [--email --password]   # authenticate to the control plane
lantern whoami          # show current authenticated user
lantern logout          # clear stored credentials`}</code>
      </pre>

      <h2 id="global">Global flags</h2>
      <pre>
        <code>{`--api-url string    Control plane address (default: $LANTERN_API_URL or localhost:50051, gRPC)
--api-key string    API key (default: $LANTERN_API_KEY)
--tenant-id string  Tenant ID (default: $LANTERN_TENANT_ID)
-o, --output string Output format: text or json (default text)
--rest              Use REST instead of gRPC (or set LANTERN_USE_REST)`}</code>
      </pre>
    </>
  );
}
