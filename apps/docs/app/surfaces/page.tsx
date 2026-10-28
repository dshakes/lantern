import Link from "next/link";
import { BrandGrid } from "../_components/Brands";
import { Concept } from "../_components/Concept";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/surfaces");

export default function SurfacesPage() {
  return (
    <>
      <h1>Surfaces</h1>
      <p>
        A surface is a channel where people talk to an agent. Seven are wired:
        WhatsApp, iMessage, Slack, Discord, Telegram, voice and web chat.
        Replies go back on the channel the message came from.
      </p>

      <Concept>
        Put the agent where the conversation already happens instead of asking
        people to open a dashboard. Same agent and guardrails on every channel;
        only the doorway changes.
      </Concept>

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
        Two paths:
      </p>
      <ul>
        <li>
          <strong>Personal (bridge)</strong> -- a Baileys-based bridge pairs
          with your own WhatsApp account by QR code. No Business account
          needed. Self-hosted only.
        </li>
        <li>
          <strong>Business Cloud API</strong> -- the surface gateway has a
          WhatsApp Cloud API adapter for a dedicated business number.
        </li>
      </ul>
      <p>
        To set up personal WhatsApp:
      </p>
      <ol>
        <li>
          Open <strong>Channels</strong> (<code>/surfaces</code>) and choose WhatsApp
        </li>
        <li>
          Select <strong>Personal (bridge)</strong>
        </li>
        <li>Scan the QR code with your WhatsApp app</li>
        <li>The bridge connects and your agent is now reachable via WhatsApp</li>
      </ol>

      <div className="callout callout-info">
        <strong>Note:</strong> The bridge is a separate long-running process
        (port 3100). Start it with <code>make run-whatsapp-bridge</code>, or{" "}
        <code>lantern dev</code>, which starts it by default.
      </div>

      <h4>Bridge tenant env var</h4>
      <p>
        Set <code>LANTERN_TENANT_ID</code> to the tenant UUID the bridge runs
        under. <code>LANTERN_DEFAULT_TENANT_ID</code> is still read as a
        fallback. The iMessage bridge and <code>bridge-core</code> resolve it
        in that order. The macOS iMessage bridge is covered in{" "}
        <Link href="/personal">Personal assistant</Link>.
      </p>

      <h3 id="slack">Slack</h3>
      <p>
        The surface gateway (<code>services/surface-gateway</code>) has a Slack
        adapter for events and bot messages, and the control plane serves a
        slash-command endpoint at <code>POST /v1/surfaces/slack/command</code>.
        In production, unsigned slash commands are refused unless{" "}
        <code>SLACK_SIGNING_SECRET</code> is set. Configure the surface under{" "}
        <strong>Channels</strong> (<code>POST /v1/surfaces</code> with a{" "}
        <code>surfaceId</code> and <code>displayName</code>).
      </p>

      <h3 id="discord">Discord</h3>
      <p>
        A Discord adapter ships in the surface gateway. Configure it under{" "}
        <strong>Channels</strong> with your bot credentials.
      </p>

      <h3 id="telegram">Telegram</h3>
      <p>
        Connect a Telegram bot to an agent:
      </p>
      <ol>
        <li>
          Create a bot via <code>@BotFather</code> on Telegram
        </li>
        <li>
          Add the bot token under <strong>Channels</strong>
        </li>
        <li>Assign the surface to an agent</li>
      </ol>
      <p>
        <strong>How a message becomes a reply.</strong> Telegram POSTs the update to the surface-gateway at{" "}
        <code>/webhooks/telegram</code>. The gateway checks the{" "}
        <code>X-Telegram-Bot-Api-Secret-Token</code> header against <code>TELEGRAM_SECRET_TOKEN</code> (a missing or
        wrong token is a 401 and nothing runs), creates a run for <code>LANTERN_AGENT_NAME</code> in{" "}
        <code>LANTERN_TENANT_ID</code>, waits for it to finish, and sends the run&apos;s output to the same chat with{" "}
        <code>sendMessage</code>. The same loop serves WhatsApp Cloud, whose POSTs are verified with{" "}
        <code>X-Hub-Signature-256</code> (<code>WHATSAPP_APP_SECRET</code>). Try it end to end with{" "}
        <code>examples/telegram-assistant</code> (calendar-aware assistant) and see{" "}
        <Link href="/testing#examples">the fixture suite</Link>.
      </p>
      <p>Limits:</p>
      <ul>
        <li>The agent needs a promoted version before the gateway can run it: run it once from the dashboard or <code>POST /v1/runs</code> first, otherwise the gateway logs <code>agent has no promoted version</code>.</li>
        <li>Replies are plain text, sent once when the run ends (no token streaming to the chat). Replies are wired for Telegram and WhatsApp only; a Slack or Discord run completes but is not posted back.</li>
        <li>A run that does not finish within 3 minutes gets no reply.</li>
        <li><code>TELEGRAM_API_BASE_URL</code> re-points Bot API calls at a fixture server for tests; the gateway refuses to start with it when <code>LANTERN_ENV</code> is prod, production or staging.</li>
      </ul>

      <h3 id="twilio">Voice (Twilio + LiveKit)</h3>
      <p>
        Phone numbers route inbound calls to a Lantern agent. Two providers are
        supported:
      </p>
      <ul>
        <li>
          <strong>Twilio</strong> -- TwiML webhooks for inbound PSTN calls. The
          control-plane verifies Twilio&apos;s webhook signature and replies with
          TwiML. SMS is also available on the same Twilio connector.
        </li>
        <li>
          <strong>LiveKit</strong> -- realtime audio; the control-plane mints a
          short-lived join token and the audio loop runs in a separately-deployed
          LiveKit Agents worker (media last-mile).
        </li>
      </ul>

      <h4>Budget gating</h4>
      <p>
        Voice spend counts against the same <code>agent_budgets</code> as runs.
        A Twilio inbound call over a hard-fail budget is declined with{" "}
        <code>&lt;Reject&gt;</code> (no carrier cost). A LiveKit join token is
        refused with HTTP 402 (no token means no media). A flat cost estimate
        is recorded on connect; the provider&apos;s status callback at{" "}
        <code>POST /v1/voice/calls/status/&#123;provider&#125;</code> reconciles
        to actual duration cost when the call ends.
      </p>

      <p>
        Both Twilio endpoints verify <code>X-Twilio-Signature</code> (HMAC-SHA1 over the public URL plus the sorted form
        fields, keyed with the number&apos;s auth token) and answer a bad or missing one with 403 before touching any
        state, so a forged status callback cannot move a budget. Billing is by started minute: a 61-second call is two
        minutes at $0.03, so the $0.05 connect-time reservation reconciles to $0.06; a call that never connects refunds
        it to zero. Try it with <code>examples/voice-receptionist</code>; the signed-webhook flow is asserted in{" "}
        <Link href="/testing#examples">the fixture suite</Link>. The inbound reply is a fixed greeting today; the
        realtime conversation needs the LiveKit worker (media last mile).
      </p>

      <h4>Voice API</h4>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>POST</code></td>
            <td><code>/v1/voice/numbers</code></td>
            <td>Link a phone number to an agent (provider + config)</td>
          </tr>
          <tr>
            <td><code>GET</code></td>
            <td><code>/v1/voice/numbers</code></td>
            <td>List linked numbers</td>
          </tr>
          <tr>
            <td><code>DELETE</code></td>
            <td><code>/v1/voice/numbers/&#123;id&#125;</code></td>
            <td>Unlink a number</td>
          </tr>
          <tr>
            <td><code>GET</code></td>
            <td><code>/v1/voice/calls</code></td>
            <td>Recent calls with duration and cost</td>
          </tr>
          <tr>
            <td><code>POST</code></td>
            <td><code>/v1/voice/token</code></td>
            <td>Mint a short-lived LiveKit join token</td>
          </tr>
          <tr>
            <td><code>POST</code></td>
            <td><code>/v1/voice/webhook/&#123;provider&#125;</code></td>
            <td>Inbound call webhook (Twilio TwiML or LiveKit JWT)</td>
          </tr>
          <tr>
            <td><code>POST</code></td>
            <td><code>/v1/voice/calls/status/&#123;provider&#125;</code></td>
            <td>Call-end status callback — reconciles actual cost into budget rollup. Point Twilio&apos;s &ldquo;call status changes&rdquo; webhook here.</td>
          </tr>
        </tbody>
      </table>

      <h4>Env vars</h4>
      <table>
        <thead>
          <tr><th>Variable</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>LANTERN_VOICE_CALLER_ID</code></td>
            <td>E.164 caller-ID shown on outbound calls. Must be a Twilio verified number.</td>
          </tr>
          <tr>
            <td><code>LANTERN_VOICE_SMS_HEADSUP</code></td>
            <td><code>on</code> (default) — sends an SMS heads-up before the call so recipients recognize the number.</td>
          </tr>
          <tr>
            <td><code>LANTERN_VOICE_CLONE</code></td>
            <td>Optional — <code>1</code> speaks outbound calls in the owner&apos;s cloned voice via ElevenLabs. Requires <code>LANTERN_ELEVENLABS_API_KEY</code> and <code>LANTERN_ELEVENLABS_VOICE_ID</code>.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="webchat">Web Chat</h3>
      <p>
        Embed a chat widget on any website:
      </p>
      <pre>
        <code>{`<!-- widget.js is served by the dashboard app; copy the exact snippet from /embed -->
<script src="http://localhost:3001/widget.js"
  data-api-key="YOUR_SCOPED_API_KEY"
  data-agent="your-agent-name"
  data-api-base="http://localhost:8080"
  data-theme="dark"
  data-position="bottom-right"
  async defer></script>`}</code>
      </pre>
      <p>
        The widget uses the same <code>/v1/sessions</code> endpoints as the
        dashboard and streams replies over SSE. The API key is visible in the
        browser, so scope it to sessions and messages. The dashboard&apos;s{" "}
        <code>/embed</code> page generates the snippet.
      </p>

      <h3>REST API</h3>
      <p>
        Every agent is accessible via the REST API. See the{" "}
        <Link href="/api">API Reference</Link> for full details.
      </p>
      <pre>
        <code>{`curl -X POST http://localhost:8080/v1/runs \\
  -H "Authorization: Bearer $LANTERN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"agentName": "my-agent", "input": {"topic": "quantum computing"}}'`}</code>
      </pre>

      <h2>Assigning surfaces to agents</h2>
      <p>
        Configure a surface once for the tenant, then point it at an agent:
      </p>
      <ol>
        <li>Set up the surface under <strong>Channels</strong></li>
        <li>
          On the agent&apos;s page, open its <strong>Channels</strong> tab and
          enable the surfaces it should answer on
        </li>
      </ol>

      <div className="callout callout-warning">
        <strong>Warning:</strong> An agent answers only on surfaces assigned to
        it. A message on a channel the agent is not enabled for gets no
        reply.
      </div>

      <h2>Two-way communication</h2>
      <p>
        When a user sends a message:
      </p>
      <ol>
        <li>The surface gateway (or a bridge) receives the message</li>
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
        <strong>Tip:</strong> Pair a <Link href="/scheduling">schedule</Link>{" "}
        with the Slack connector to post a daily summary.
      </div>
    </>
  );
}
