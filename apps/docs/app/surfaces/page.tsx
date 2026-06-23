import Link from "next/link";
import { BrandGrid } from "../_components/Brands";

export default function SurfacesPage() {
  return (
    <>
      <h1>Surfaces</h1>
      <p>
        Surfaces are the communication channels through which users interact
        with agents. Lantern supports 11 built-in surfaces, all two-way --
        agents reply in the same channel you messaged from.
      </p>

      <BrandGrid items={[
        { name: "WhatsApp", sub: "Baileys · self-host", href: "#whatsapp" },
        { name: "iMessage", sub: "macOS bridge", href: "#whatsapp" },
        { name: "Slack", sub: "events + bot", href: "#slack" },
        { name: "Discord", sub: "bot", href: "#discord" },
        { name: "Telegram", sub: "bot", href: "#telegram" },
        { name: "Voice", sub: "Twilio · LiveKit", href: "#twilio" },
        { name: "Web Chat", sub: "embeddable widget", href: "#webchat" },
      ]} />

      <h2 id="available">Available surfaces</h2>

      <h3 id="whatsapp">WhatsApp</h3>
      <p>
        Lantern supports two modes for WhatsApp:
      </p>
      <ul>
        <li>
          <strong>Personal (via bridge)</strong> -- connects to your personal
          WhatsApp account using the multi-device bridge. Messages to your
          agent appear as regular WhatsApp conversations. No WhatsApp Business
          account required.
        </li>
        <li>
          <strong>Business API</strong> -- for teams and companies that need
          a dedicated phone number and the official WhatsApp Business Cloud
          API. Supports templates, rich messages, and higher throughput.
        </li>
      </ul>
      <p>
        To set up personal WhatsApp:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Surfaces &gt; WhatsApp</strong>
        </li>
        <li>
          Select <strong>Personal (bridge)</strong>
        </li>
        <li>Scan the QR code with your WhatsApp app</li>
        <li>The bridge connects and your agent is now reachable via WhatsApp</li>
      </ol>
      <p>[Screenshot: WhatsApp QR code pairing screen]</p>

      <div className="callout callout-info">
        <strong>Note:</strong> The WhatsApp bridge service runs as a sidecar
        and maintains a persistent connection. Start it locally with{" "}
        <code>make run-whatsapp-bridge</code>.
      </div>

      <h4>Bridge tenant env var</h4>
      <p>
        Set <code>LANTERN_TENANT_ID</code> to the tenant UUID the bridge should
        operate under. The fallback <code>LANTERN_DEFAULT_TENANT_ID</code> is
        still accepted for backwards compatibility, but{" "}
        <code>LANTERN_TENANT_ID</code> is the canonical name going forward. Both
        the iMessage bridge and the <code>bridge-core</code> shared library
        read the same variable in this order.
      </p>

      <h3 id="slack">Slack</h3>
      <p>
        Create a Slack app and connect it to Lantern:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Surfaces &gt; Slack</strong>
        </li>
        <li>
          Click <strong>Connect to Slack</strong> and authorize the Lantern bot
          in your workspace
        </li>
        <li>
          Choose which channels the agent should listen to, or enable DM mode
        </li>
      </ol>
      <p>
        Agents respond in threads by default. Mention <code>@lantern</code> in
        a channel or send a direct message to trigger a run.
      </p>

      <h3 id="discord">Discord</h3>
      <p>
        Similar to Slack, add the Lantern bot to your Discord server:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Surfaces &gt; Discord</strong>
        </li>
        <li>Click the invite link to add the bot to your server</li>
        <li>Configure which channels the agent monitors</li>
      </ol>

      <h3 id="telegram">Telegram</h3>
      <p>
        Connect a Telegram bot to an agent:
      </p>
      <ol>
        <li>
          Create a bot via <code>@BotFather</code> on Telegram
        </li>
        <li>
          Copy the bot token to{" "}
          <strong>Settings &gt; Surfaces &gt; Telegram</strong>
        </li>
        <li>
          Assign the surface to an agent
        </li>
      </ol>

      <h3 id="twilio">Twilio (SMS and Voice)</h3>
      <p>
        Connect your Twilio account for SMS and voice call surfaces:
      </p>
      <ol>
        <li>
          Navigate to <strong>Settings &gt; Surfaces &gt; Twilio</strong>
        </li>
        <li>Enter your Twilio Account SID, Auth Token, and phone number</li>
        <li>
          Choose <strong>SMS</strong>, <strong>Voice</strong>, or both
        </li>
      </ol>
      <p>
        For voice calls, agents use text-to-speech for responses and
        speech-to-text for input. The conversation flows naturally as a phone
        call.
      </p>

      <h3>Email</h3>
      <p>
        Agents can receive and send emails. Configure an email surface with:
      </p>
      <ol>
        <li>A dedicated email address (e.g., agent@yourdomain.com)</li>
        <li>IMAP/SMTP credentials or a connected Gmail connector</li>
      </ol>
      <p>
        Incoming emails trigger the agent; the response is sent as a reply to
        the same thread.
      </p>

      <h3 id="webchat">Web Chat</h3>
      <p>
        Embed a chat widget on any website:
      </p>
      <pre>
        <code>{`<script src="https://cdn.lantern.run/chat.js"
  data-agent="your-agent-name"
  data-tenant="your-tenant-id">
</script>`}</code>
      </pre>
      <p>
        The widget renders a chat interface that streams agent responses in
        real time.
      </p>

      <h3>CLI</h3>
      <p>
        Interact with agents directly from your terminal:
      </p>
      <pre>
        <code>{`lantern chat my-agent`}</code>
      </pre>
      <p>
        This opens an interactive session with streaming output.
      </p>

      <h3>REST API</h3>
      <p>
        Every agent is accessible via the REST API. See the{" "}
        <Link href="/api">API Reference</Link> for full details.
      </p>
      <pre>
        <code>{`curl -X POST https://api.lantern.run/v1/agents/my-agent/runs \\
  -H "Authorization: Bearer $LANTERN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"topic": "quantum computing"}}'`}</code>
      </pre>

      <h2>Assigning surfaces to agents</h2>
      <p>
        Surfaces are configured at the account level and then assigned per
        agent, similar to connectors:
      </p>
      <ol>
        <li>Set up the surface in <strong>Settings &gt; Surfaces</strong></li>
        <li>
          On the agent&apos;s <strong>Configuration</strong> tab, enable the
          surfaces this agent should be reachable on
        </li>
      </ol>

      <div className="callout callout-warning">
        <strong>Warning:</strong> An agent can only respond on surfaces that
        are explicitly assigned to it. If a user messages via WhatsApp but the
        agent does not have WhatsApp enabled, the message will be silently
        dropped.
      </div>

      <h2>Two-way communication</h2>
      <p>
        All surfaces are two-way. When a user sends a message:
      </p>
      <ol>
        <li>The surface gateway receives the message</li>
        <li>
          It routes to the correct agent based on the surface configuration
        </li>
        <li>The agent runs with the message as input</li>
        <li>
          The response streams back through the same surface, in the same
          conversation or thread
        </li>
      </ol>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Agents can also proactively send messages on
        surfaces -- for example, posting a daily summary to a Slack channel on
        a schedule.
      </div>
    </>
  );
}
