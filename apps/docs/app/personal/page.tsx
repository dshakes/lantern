import Link from "next/link";
import { PersonalHarnessDiagram } from "../_components/PersonalHarnessDiagram";

export default function PersonalHarnessPage() {
  return (
    <>
      <h1>Personal harness — your phone, your bot</h1>
      <p>
        The iMessage + WhatsApp bridges run on your own Mac and answer as{" "}
        <em>you</em>. The personal harness gives them real-world context from
        your iPhone — where you are, whether you&apos;re driving, what Focus
        you&apos;re in — so the bot grounds its replies to you in what&apos;s
        actually happening, and can tell people pinging you whether you&apos;re
        reachable. It&apos;s entirely <strong>owner-only and local</strong>:
        signals live on your Mac, and nothing about your whereabouts is ever
        revealed to a contact.
      </p>

      <h2 id="model">The model in one picture</h2>
      <p>
        An iPhone automation fires a Lantern Shortcut, which POSTs one tiny
        signal to your control plane over a private Tailscale network. The
        bridge reads those signals on-demand and folds them into context.
      </p>
      <PersonalHarnessDiagram />

      <h2 id="triggers">1 · iPhone triggers</h2>
      <p>
        Each trigger is a one-line iOS <strong>Personal Automation</strong>{" "}
        wired to a signed Shortcut. Generate the whole set with one command:
      </p>
      <pre><code>scripts/iphone/app-context/generate-signals.sh</code></pre>
      <p>
        That writes 13 ready-to-import shortcuts to your Desktop (the signal
        token is baked in, so they&apos;re never committed). AirDrop them to the
        phone and attach each to its trigger. A few examples:
      </p>
      <ul>
        <li><strong>Drive</strong> — point <em>two</em> automations at the same{" "}
          <code>Lantern-Driving</code> shortcut: <strong>CarPlay Connects</strong>{" "}
          (a car with CarPlay, e.g. an Odyssey) and{" "}
          <strong>Bluetooth → your Tesla Connects</strong> (no CarPlay needed).</li>
        <li><strong>Place</strong> — <strong>Arrive</strong>/<strong>Leave</strong>{" "}
          geofences for Home, Office, Gym, Airport.</li>
        <li><strong>Status</strong> — the iPhone <strong>Action Button</strong>,
          an <strong>NFC tag</strong> on your desk, or a <strong>Focus</strong>{" "}
          turning on.</li>
        <li><strong>Rhythm</strong> — <strong>Sleep</strong> Focus, <strong>Low
          Power Mode</strong>, now-playing, and Health automations.</li>
      </ul>
      <p>
        Full recipe + trigger table:{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/scripts/iphone/app-context/RICH-SIGNALS.md" target="_blank" rel="noopener noreferrer">RICH-SIGNALS.md</a>.
      </p>

      <h2 id="pipeline">2 · The signal pipeline</h2>
      <p>
        Every shortcut POSTs the same shape to{" "}
        <code>/v1/signals</code> with an <code>x-lantern-signal-token</code>{" "}
        header:
      </p>
      <pre><code>{`{ "kind": "location", "detail": "Office" }     // where you are
{ "kind": "device",   "detail": "driving" }    // CarPlay / Tesla BT
{ "kind": "focus",    "detail": "Busy" }        // status / Focus mode`}</code></pre>
      <p>
        The endpoint is <strong>token-gated and fails closed</strong> — a
        missing or wrong token is rejected, and the token is never logged. It
        appends one line to <code>~/.lantern/device-signals.jsonl</code>{" "}
        (mode <code>0600</code>, your user only), auto-trimmed to the most
        recent entries. The phone reaches it over a{" "}
        <strong>private Tailscale Serve</strong> host — nothing is exposed to the
        public internet. See{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/personal/REMOTE-ACCESS.md" target="_blank" rel="noopener noreferrer">REMOTE-ACCESS.md</a>.
      </p>

      <h2 id="bridge">3 · The bridge reads on-demand</h2>
      <p>
        On <em>every</em> owner self-chat turn the bridge reads the signals file
        fresh (<code>freshIphoneSignalsLine()</code>) right before the model
        call — a sub-millisecond local read in front of a multi-second LLM call,
        so a signal that just landed is <strong>already in context</strong>{" "}
        (zero polling lag). It keeps the <strong>latest of each category</strong>{" "}
        from the last ~2 hours and composes one line:
      </p>
      <blockquote>
        On iPhone (last 2h): YouTube, LinkedIn — at Office, Work focus, driving,
        6.2k steps, playing Hardcore History.
      </blockquote>
      <p>
        That line is injected <strong>only</strong> into your own self-chat
        assistant context — never a contact reply. Ask the bot &ldquo;where am
        I&rdquo;, &ldquo;what have I been doing&rdquo;, or &ldquo;am I free at
        3&rdquo; and it answers from real context.
      </p>

      <h2 id="concierge">4 · The availability concierge</h2>
      <p>
        When a <em>contact</em> DMs you, the bridge uses the same presence
        signals — plus your calendar — to be genuinely helpful while staying
        discreet:
      </p>
      <ul>
        <li>&ldquo;Is he around?&rdquo; → a truthful status from your Focus +
          calendar, with an offer to take a message or have you call back.</li>
        <li>&ldquo;When&apos;s he free?&rdquo; → real open slots from your
          calendar.</li>
        <li>Anything urgent or from a VIP → escalated straight to you instead of
          auto-handled.</li>
      </ul>
      <p>
        A hard guard ensures the concierge shares <strong>availability only —
        never your location</strong>: a contact asking &ldquo;where are
        you?&rdquo; gets &ldquo;he&apos;s away from his phone right now&rdquo;,
        not a city or place. See{" "}
        <Link href="/security">Security</Link> for the full privacy model.
      </p>

      <h2 id="privacy">Privacy recap</h2>
      <ul>
        <li>Signals are stored <strong>only</strong> on your Mac, mode{" "}
          <code>0600</code>. They never leave your machine.</li>
        <li>The composite summary grounds <strong>your own</strong> self-chat —
          the bot never volunteers it and never reveals it to a contact.</li>
        <li>The token gates the endpoint; keep it server-side only.</li>
        <li>Turn it off any time: <code>LANTERN_IPHONE_SIGNALS=off</code> on the
          bridge, or unset <code>LANTERN_SIGNAL_TOKEN</code> on the receiver.</li>
      </ul>
    </>
  );
}
