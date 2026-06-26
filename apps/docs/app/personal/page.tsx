import Link from "next/link";
import { PersonalHarnessArchitecture } from "../_components/PersonalHarnessArchitecture";
import { PersonalHarnessDiagram } from "../_components/PersonalHarnessDiagram";

export default function PersonalHarnessPage() {
  return (
    <>
      <h1>Personal harness — your phone, your bot</h1>
      <p>
        The iMessage + WhatsApp bridges run on your own Mac and answer as{" "}
        <em>you</em>. The personal harness is the whole stack behind that: it{" "}
        <strong>senses</strong> what&apos;s happening, <strong>remembers</strong>{" "}
        you and the people you talk to across every channel,{" "}
        <strong>reasons</strong> about what to do, makes the reply{" "}
        <strong>sound like you</strong>, and then <strong>acts</strong> — all{" "}
        owner-only and local, with nothing about your whereabouts ever revealed
        to a contact.
      </p>

      <h2 id="harness">The harness, end to end</h2>
      <p>
        Five layers, top to bottom, fed by your surfaces and grounded by the
        control plane. Every cell links to the section that explains it. The{" "}
        <strong>memory layer</strong> (amber) is the cross-app store — one
        canonical identity and one timeline that every other layer reads from
        and writes to.
      </p>
      <PersonalHarnessArchitecture />

      <h2 id="signals">L1 · Sense — signals &amp; ingestion</h2>
      <p>
        The harness starts from real-world context. iPhone automations
        (geofences, Focus, the Action Button, NFC, and{" "}
        <strong>CarPlay / Bluetooth → driving</strong>) fire signed Shortcuts
        that POST one tiny signal — location, focus, device, health, media — to
        the control plane over a private Tailscale network. On-device screen and
        app-usage stays owner-only and never leaves the Mac; inbound email is
        ingested and classified into life-events; and every inbound message on
        every channel is a signal too. The bridge reads the signals file fresh
        on every owner turn, in front of the LLM, so a signal that just landed is
        already in context with zero polling lag.
      </p>
      <p>
        The phone-trigger flow in detail — triggers, the token-gated{" "}
        <code>/v1/signals</code> hop over Tailscale, and the on-demand read:
      </p>
      <PersonalHarnessDiagram />
      <p>
        Each trigger is a one-line iOS <strong>Personal Automation</strong> wired
        to a signed Shortcut. Generate the whole set with one command —{" "}
        <code>scripts/iphone/app-context/generate-signals.sh</code> writes 13
        ready-to-import shortcuts to your Desktop (the signal token is baked in,
        so they&apos;re never committed). Full recipe + trigger table:{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/scripts/iphone/app-context/RICH-SIGNALS.md" target="_blank" rel="noopener noreferrer">RICH-SIGNALS.md</a>;
        remote-access setup in{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/personal/REMOTE-ACCESS.md" target="_blank" rel="noopener noreferrer">REMOTE-ACCESS.md</a>.
      </p>

      <h2 id="memory">L2 · Remember — cross-app memory &amp; identity</h2>
      <p>
        This is how the harness stores cross-app stuff. The{" "}
        <strong>person graph</strong> resolves any{" "}
        <code>(channel, handle)</code> — an iMessage address, a WhatsApp JID, an
        email, a phone number for voice — to a single canonical person, so what
        you learned about someone on WhatsApp is there when they email or call.
        On top of that identity sit two recall indices:{" "}
        <strong>episodic memory</strong> (a rolling 14-day log of{" "}
        <code>date · topic · outcome</code> per contact) and a 7-day{" "}
        <strong>topic index</strong> that surfaces what <em>other</em> threads
        said about the same topic, so cross-thread context is available without
        ever volunteering it.
      </p>
      <p>
        The <strong>owner profile</strong> — your facts, per-contact
        relationship rules, and the style lessons the 👎 flywheel mines — is
        injected as ground truth into every reply. <strong>Presence</strong> is a
        live cross-bridge view of whether you&apos;re reachable, and the{" "}
        <strong>life-events ledger</strong> records classified bills, deliveries,
        travel, and fraud alerts so the dashboard can show a feed and per-category
        trust toggles. The substrate is deliberately split:{" "}
        <strong>local 0600 JSONL on the Mac</strong> for the most personal
        signals (episodes, topics, dislikes) and{" "}
        <strong>control-plane Postgres with row-level security, encrypted at
        rest</strong> for the tenant-scoped person graph, memory events, and
        life-events. Because both channels write the <em>same</em> person and the
        same timeline, a fact learned on one channel is recalled on the other for
        the same canonical person.
      </p>

      <h2 id="reason">L3 · Reason — decisioning &amp; orchestration</h2>
      <p>
        With context and memory in hand, the harness decides what to do. The{" "}
        <strong>life-event engine</strong> classifies inbound into typed events
        and extracts their fields; the <strong>auto-act ladder</strong> routes
        each one by your per-category trust setting —{" "}
        <code>safe-auto</code> (just do it), <code>ask</code> (one-tap confirm),
        or <code>never</code>. The <strong>availability concierge</strong> turns
        live presence plus your calendar into truthful replies for contacts who
        ask if you&apos;re around, while <strong>anticipation</strong> fires
        proactive nudges to your self-chat for pre-meetings, anniversaries,
        overdue replies, and open commitments. When a meeting is in play,{" "}
        <strong>scheduling</strong> can propose, hold, and confirm a concrete
        time and book it.
      </p>

      <h2 id="persona">L4 · Sound like you — persona &amp; authenticity</h2>
      <p>
        A correct reply still has to sound like you. <strong>Owner-voice</strong>{" "}
        is mined from your real sent messages, and a{" "}
        <strong>language &amp; dialect</strong> modality keeps the bot in your
        attested forms — never invented word-forms. The last pass before every
        send is the <strong>bot-tell guards</strong>: they suppress drafts that
        use customer-service stock phrases, leak reasoning, or deny your
        biographical facts, and trigger a regeneration instead of staying silent.{" "}
        <strong>Pacing</strong> replays your real per-contact reply latency with
        typing indicators, and <strong>draft-and-confirm</strong> plus the{" "}
        <strong>claim verifier</strong> hold low-confidence replies for your
        approval and rewrite any &ldquo;I did X&rdquo; the bridge can&apos;t
        actually back up into honest intent form.
      </p>

      <h2 id="actions">L5 · Act — actions &amp; delivery</h2>
      <p>
        Finally the harness follows through. <strong>Reply send</strong> delivers
        the paced message on the right channel (with an SMS/RCS fallback when an
        iMessage send fails). <strong>Mac actions</strong> create Calendar events,
        Notes, and Mail via locale-safe AppleScript — only after you confirm.{" "}
        <strong>Connectors</strong> (Gmail, Calendar, and the rest of the 17)
        reach your other systems through the control plane, and{" "}
        <strong>voice calls</strong> place real outbound calls over Twilio or
        LiveKit when a task needs a phone, not a text.
      </p>

      <h2 id="safety">Safety &amp; privacy — the rail beside every layer</h2>
      <p>
        Privacy isn&apos;t a layer; it runs alongside all of them.{" "}
        <strong>Owner-only enforcement</strong> means the doc, action, and command
        pipelines fire only for the owner — DMs from non-owner contacts never
        reach them. A hard <strong>location-leak guard</strong> ensures the
        concierge shares <strong>availability only — never your location</strong>:
        a contact asking &ldquo;where are you?&rdquo; gets &ldquo;he&apos;s away
        from his phone right now&rdquo;, not a place. A master{" "}
        <strong>kill switch</strong> lets you silence all inbound from self-chat.
        The most personal stores are <strong>local 0600 and path-restricted</strong>,
        and <strong>secrets never appear in logs, traces, or run state</strong>.
        See <Link href="/security">Security</Link> for the full model.
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
