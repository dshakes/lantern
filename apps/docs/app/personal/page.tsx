import Link from "next/link";
import { Concept } from "../_components/Concept";
import { PersonalHarnessArchitecture } from "../_components/PersonalHarnessArchitecture";
import { PersonalHarnessDiagram } from "../_components/PersonalHarnessDiagram";
import { AgentLoop } from "../_components/AgentLoop";

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
        <strong>sound like you</strong>, and then <strong>acts</strong>. The
        pipelines are owner-only, and your location is shared with a contact
        only under per-contact rules you set.
      </p>

      <Concept>
        A personal assistant that lives in your own messaging apps. It reads
        incoming texts on your Mac, drafts replies in your voice, tracks who
        people are and what you last discussed, and handles routine
        follow-ups. You stay in control: money and promise replies are held
        for you, a thumbs-down teaches it, and a kill switch stops all
        inbound. The bridges and their state run on your Mac. Message text
        still goes to the LLM provider you configure to draft replies.
      </Concept>

      <h2 id="harness">The harness, end to end</h2>
      <p>
        Five layers, top to bottom, fed by your surfaces and grounded by the
        control plane. Every cell links to the section that explains it. The{" "}
        <strong>memory layer</strong> (amber) is the cross-app store — one
        canonical identity and one timeline that every other layer reads from
        and writes to.
      </p>
      <PersonalHarnessArchitecture />

      <div className="callout callout-info">
        <strong>What is off by default.</strong> Draft-and-confirm
        (<code>LANTERN_DRAFT_CONFIRM</code> on iMessage,{" "}
        <code>LANTERN_DRAFT_HIGH_STAKES</code> on WhatsApp), concierge nudges
        (<code>LANTERN_CONCIERGE</code>), the four bridge loops, the
        immigration sentinel, the Mac app-usage signal
        (<code>LANTERN_MAC_USAGE</code>), voice cloning
        (<code>LANTERN_VOICE_CLONE</code>), the model-router cutover and RLS
        enforcement. Each is labeled where it appears below.
      </div>

      <h2 id="agents">Your agents</h2>
      <p>
        Sixteen agents make up the personal suite across three execution models.
        The scheduled ones are seeded for the dev tenant when the control plane
        starts with dev seeding on; elsewhere you create them with{" "}
        <code>POST /v1/agents/loop</code>.
        Ten are <strong>owner-facing</strong> — they nudge or brief you in your
        self-chat and never touch your contacts. Only the two{" "}
        <strong>assistant</strong> agents reply to contacts as you. Four{" "}
        <strong>bridge-signal</strong> agents react to device signals on your Mac.
        This distinction matters for trust: owner-facing agents can be aggressive
        and proactive; assistant agents carry the weight of impersonation.
      </p>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>What it does</th>
            <th>Runs</th>
            <th>You see it</th>
            <th>Touches contacts?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>concierge</strong></td>
            <td>Captures tasks, researches how, nudges with 1-click actions — reply / snooze / done.</td>
            <td>45m cron</td>
            <td>self-chat (nudges need <code>LANTERN_CONCIERGE=on</code>)</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>care-coordinator</strong></td>
            <td>Health email → meds/doctors/appts records + refill/appt reminders + coaching.</td>
            <td>every 6h</td>
            <td>/personal Health</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>garage</strong></td>
            <td>Vehicle service/insurance/DMV email → records + renewal reminders.</td>
            <td>every 6h</td>
            <td>/personal Vehicle</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>upskill</strong></td>
            <td>Job/learning email → skill records + career coaching nudges.</td>
            <td>every 6h</td>
            <td>/personal Career</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>travel-concierge</strong></td>
            <td>Flights/hotels → itinerary records + check-in reminders.</td>
            <td>every 6h</td>
            <td>/personal Travel</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>household</strong></td>
            <td>Utilities/warranties/services → records + renewal reminders.</td>
            <td>every 6h</td>
            <td>/personal Home</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>financial-sentinel</strong></td>
            <td>Watches bills for price hikes → review reminders. Never moves money.</td>
            <td>daily 8am</td>
            <td>/personal Finance</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>relationship-keeper</strong></td>
            <td>Finds people gone quiet (21d+) → reach-out reminders + draft in your voice.</td>
            <td>weekly (Mon 9am)</td>
            <td>self-chat</td>
            <td><strong>No</strong> — you do the outreach</td>
          </tr>
          <tr>
            <td><strong>inbox-triage</strong></td>
            <td>Every 45 min reads Gmail, classifies each message action/FYI/noise, and queues a one-tap draft for anything needing a reply.</td>
            <td>45m</td>
            <td>self-chat · needs Gmail</td>
            <td><strong>No</strong> — you confirm every send</td>
          </tr>
          <tr>
            <td><strong>ai-radar</strong></td>
            <td>Every 5 min polls AI lab, people, coding-tool and aggregator feeds, dedupes by URL, and has the LLM rank the new items. Pull anytime with &quot;news&quot;.</td>
            <td>5m</td>
            <td>self-chat (&quot;news&quot;)</td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>commute-copilot</strong></td>
            <td>Driving signal → hands-free task surface + parked recap.</td>
            <td>bridge interval</td>
            <td>self-chat · <code>LANTERN_COMMUTE=on</code></td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>energy-guardian</strong></td>
            <td>Short sleep → offer to lighten the day&apos;s load.</td>
            <td>bridge interval</td>
            <td>self-chat · <code>LANTERN_ENERGY=on</code></td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>health-coach</strong></td>
            <td>Steps/sleep/workout nudges toward a daily goal.</td>
            <td>bridge interval</td>
            <td>self-chat · <code>LANTERN_HEALTH=on</code></td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>focus-guardian</strong></td>
            <td>Holds non-urgent nudges during Focus mode, recaps after.</td>
            <td>bridge interval</td>
            <td>self-chat · <code>LANTERN_FOCUS=on</code></td>
            <td><strong>No</strong></td>
          </tr>
          <tr>
            <td><strong>whatsapp-assistant</strong></td>
            <td>Auto-replies to your WhatsApp contacts in your voice.</td>
            <td>reactive</td>
            <td>replies to contacts</td>
            <td><strong>Yes</strong> — talks to contacts as you</td>
          </tr>
          <tr>
            <td><strong>imessage-assistant</strong></td>
            <td>Auto-replies to your iMessage contacts in your voice.</td>
            <td>reactive</td>
            <td>replies to contacts</td>
            <td><strong>Yes</strong> — talks to contacts as you</td>
          </tr>
        </tbody>
      </table>

      <h3>How each agent loops</h3>
      <p>
        Each diagram shows the stages of one agent&apos;s cycle — solid arrows
        are the forward flow; the dashed arc loops from the last stage back to
        the first. Agents are grouped by how they execute. The two contact-facing
        agents are <strong>rose-highlighted</strong> because they reply as you to
        real people — they carry the full weight of impersonation.
      </p>

      <h4 id="scheduled-agents">Scheduled — runs as a Lantern agent on a cron timer</h4>
      <p>
        These agents are created via <code>POST /v1/agents</code> and run on the
        Lantern platform on a cron schedule, with runs, cost and history in the dashboard like any
        other agent. Gmail-reading agents need the Gmail connector installed.
        Concierge nudges to your self-chat stay off until{" "}
        <code>LANTERN_CONCIERGE=on</code>.
      </p>

      <AgentLoop
        title="concierge"
        cadence="45m cron"
        execModel="scheduled"
        stages={["Capture task", "Research how", "Nudge you", "You act"]}
        tone="sky"
        ownerFacing
        interface="runs: every 45m · you see it: self-chat (reply / snooze / done)"
      />
      <AgentLoop
        title="care-coordinator"
        cadence="every 6h"
        execModel="scheduled"
        stages={["Morning scan", "Health records", "Refill/appt alert", "You act"]}
        tone="emerald"
        ownerFacing
        interface="runs: every 6h · you see it: /personal Health · needs Gmail"
      />
      <AgentLoop
        title="garage"
        cadence="every 6h"
        execModel="scheduled"
        stages={["Gmail scan", "Vehicle records", "Renewal alert", "You act"]}
        tone="amber"
        ownerFacing
        interface="runs: every 6h · you see it: /personal Vehicle · needs Gmail"
      />
      <AgentLoop
        title="upskill"
        cadence="every 6h"
        execModel="scheduled"
        stages={["Gmail scan", "Skill records", "Career nudge", "You act"]}
        tone="violet"
        ownerFacing
        interface="runs: every 6h · you see it: /personal Career · needs Gmail"
      />
      <AgentLoop
        title="travel-concierge"
        cadence="every 6h"
        execModel="scheduled"
        stages={["Gmail scan", "Trip records", "Check-in alert", "You act"]}
        tone="sky"
        ownerFacing
        interface="runs: every 6h · you see it: /personal Travel · needs Gmail"
      />
      <AgentLoop
        title="household"
        cadence="every 6h"
        execModel="scheduled"
        stages={["Gmail scan", "Home records", "Renewal alert", "You act"]}
        tone="amber"
        ownerFacing
        interface="runs: every 6h · you see it: /personal Home · needs Gmail"
      />
      <AgentLoop
        title="financial-sentinel"
        cadence="daily 8am"
        execModel="scheduled"
        stages={["Scan bills", "Detect price hike", "Flag for review", "You review"]}
        tone="amber"
        ownerFacing
        interface="runs: daily 8am · you see it: /personal Finance · needs Gmail"
      />
      <AgentLoop
        title="relationship-keeper"
        cadence="weekly"
        execModel="scheduled"
        stages={["Scan people", "Gone quiet?", "Draft in your voice", "Nudge you", "You reach out"]}
        tone="violet"
        ownerFacing
        interface="runs: weekly (Mon 9am) · you see it: self-chat"
      />
      <AgentLoop
        title="inbox-triage"
        cadence="45m cron"
        execModel="scheduled"
        stages={["Read Gmail", "Classify msg", "Queue draft", "You confirm"]}
        tone="sky"
        ownerFacing
        interface="runs: every 45m · you see it: self-chat · needs Gmail"
      />
      <AgentLoop
        title="ai-radar"
        cadence="5m cron"
        execModel="scheduled"
        stages={["Scan AI feeds", "Dedupe", "Rank new", "Surface to you"]}
        tone="violet"
        ownerFacing
        interface={'runs: every 5m · you see it: "news" in self-chat'}
      />

      <h4 id="bridge-agents">Bridge loops — runs on your Mac, driven by device signals</h4>
      <p>
        These agents run inside the bridge process at a short interval and react
        to iPhone signals (driving state, sleep data, step count, Focus mode).
        All four are <strong>off by default</strong>. Set the env var and the
        loop activates on the next bridge restart. If the signal threshold
        isn&apos;t met, they send nothing.
      </p>

      <AgentLoop
        title="commute-copilot"
        cadence="bridge interval"
        execModel="bridge"
        stages={["Drive signal", "Task surface", "Parked recap", "You act"]}
        tone="amber"
        ownerFacing
        interface="runs: bridge interval · you see it: self-chat · LANTERN_COMMUTE=on"
      />
      <AgentLoop
        title="energy-guardian"
        cadence="bridge interval"
        execModel="bridge"
        stages={["Sleep signal", "Assess energy", "Lighten day", "You act"]}
        tone="rose"
        ownerFacing
        interface="runs: bridge interval · you see it: self-chat · LANTERN_ENERGY=on"
      />
      <AgentLoop
        title="health-coach"
        cadence="bridge interval"
        execModel="bridge"
        stages={["Step/sleep data", "Track goal", "Nudge you", "You act"]}
        tone="emerald"
        ownerFacing
        interface="runs: bridge interval · you see it: self-chat · LANTERN_HEALTH=on"
      />
      <AgentLoop
        title="focus-guardian"
        cadence="bridge interval"
        execModel="bridge"
        stages={["Focus signal", "Hold nudges", "Focus ends", "Recap to you"]}
        tone="violet"
        ownerFacing
        interface="runs: bridge interval · you see it: self-chat · LANTERN_FOCUS=on"
      />

      <h4 id="reactive-agents">Reactive — fires on every inbound message</h4>
      <p>
        The two assistant agents sit in the bridge&apos;s message handler and
        fire on every inbound message from a contact. They carry the full weight
        of impersonation — everything in the harness (owner voice, bot-tell
        guards, pacing, draft-and-confirm, claim verifier) exists to keep them
        indistinguishable from you.
      </p>

      <AgentLoop
        title="whatsapp-assistant"
        cadence="reactive"
        execModel="reactive"
        stages={["Contact messages", "Understand", "Draft in your voice", "Send to contact"]}
        tone="rose"
        ownerFacing={false}
        interface="fires: per inbound · you see it: replies to contacts"
      />
      <AgentLoop
        title="imessage-assistant"
        cadence="reactive"
        execModel="reactive"
        stages={["Contact messages", "Understand", "Draft in your voice", "Send to contact"]}
        tone="rose"
        ownerFacing={false}
        interface="fires: per inbound · you see it: replies to contacts"
      />

      <h2 id="signals">L1 · Sense — signals &amp; ingestion</h2>
      <p>
        The harness starts from real-world context. iPhone automations
        (geofences, Focus, the Action Button, NFC, and{" "}
        <strong>CarPlay / Bluetooth → driving</strong>) fire Shortcuts
        that POST one small signal (location, focus, device, health, media) to
        the control plane through a private tunnel; the recipe uses Tailscale
        Serve. Mac app usage is a separate signal, off unless{" "}
        <code>LANTERN_MAC_USAGE=on</code>, and it is distilled to one summary
        line for your self-chat only. Inbound email is classified into
        life-events, and every inbound message on every channel is a signal
        too. The bridge reads the signals file fresh
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
        trust toggles. Storage is split:{" "}
        <strong>local 0600 JSONL on the Mac</strong> for the most personal
        signals (the episode, topic and dislike stores are also AES-256-GCM
        encrypted) and <strong>control-plane Postgres</strong> for the
        tenant-scoped person graph, memory events and life-events. Row-level
        security policies cover those tables; they are enforced once{" "}
        <code>LANTERN_RLS_ENFORCE=1</code>, which is off by default. Because both channels write the <em>same</em> person and the
        same timeline, a fact learned on one channel is recalled on the other for
        the same canonical person.
      </p>

      <h3 id="life-events">Life-event engine</h3>
      <p>
        Inbound email and messages are classified into typed life-events:{" "}
        <code>bill</code>, <code>delivery</code>, <code>appointment</code>,{" "}
        <code>fraud_alert</code>, <code>otp</code>, <code>travel</code>,{" "}
        <code>receipt</code>, <code>promo</code>. Each event lands in the{" "}
        <code>life_events</code> table and is routed by your per-category trust
        toggle: <code>auto</code>, <code>ask</code> (default) or{" "}
        <code>off</code>.
        Endpoints: <code>POST /v1/life-events</code>,{" "}
        <code>GET /v1/life-events</code> (feed, newest-first),{" "}
        <code>GET /v1/life-events/prefs</code>,{" "}
        <code>PUT /v1/life-events/prefs</code>. Deduped on{" "}
        <code>(tenant, idempotencyKey)</code>.
      </p>

      <h3 id="immigration-sentinel">Immigration sentinel</h3>
      <p>
        Off by default; <code>LANTERN_IMMIGRATION_SENTINEL=1</code> turns it on.
        The sentinel reasons over the family&apos;s immigration PDFs and arriving USCIS /
        attorney email to surface <em>derived</em> deadlines that nobody typed
        in — EAD/AP expiry, I-485 windows, biometrics / RFE clocks. The LLM is
        capability-addressed (never a hardcoded vendor), doc and mail PII are
        never logged, and a deadline is dropped unless the LLM grounds it in a
        non-blank <code>source_ref</code> with <code>confidence ≥ 0.6</code>.
        Endpoints: <code>POST /v1/immigration/scan</code>,{" "}
        <code>GET /v1/immigration/deadlines</code>. Unset means the scan is inert and endpoints return{" "}
        <code>{`{"enabled":false}`}</code>.
      </p>

      <h2 id="reason">L3 · Reason — decisioning &amp; orchestration</h2>
      <p>
        With context and memory in hand, the harness decides what to do. The{" "}
        <strong>life-event engine</strong> classifies inbound into typed events
        and extracts their fields; the <strong>auto-act ladder</strong> routes
        each one by your per-category trust setting —{" "}
        <code>auto</code> (just do it), <code>ask</code> (one-tap confirm),
        or <code>off</code>. The <strong>availability concierge</strong> turns
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
        typing indicators. The <strong>claim verifier</strong> rewrites any
        &ldquo;I did X&rdquo; the bridge can&apos;t back up into intent form.
        <strong> Draft-and-confirm</strong>, which holds low-confidence
        replies for your approval, is <strong>off by default</strong>.
      </p>
      <p>
        Two gates hold a reply for you and never send it: the{" "}
        <strong>commitment gate</strong> (replies that promise money or an
        action, or answer a request for money, in any language) and the{" "}
        <strong>grounding gate</strong> (a specific date for your own plans, a
        contradiction of the contact about your plans, an outcome only you
        could confirm, or a celebratory reply to bad news). Each runs an LLM
        judge plus a deterministic backstop, so an LLM outage cannot let one
        through.
      </p>

      <h2 id="actions">L5 · Act — actions &amp; delivery</h2>
      <p>
        Finally the harness follows through. <strong>Reply send</strong> delivers
        the paced message on the right channel (with an SMS/RCS fallback when an
        iMessage send fails). <strong>Mac actions</strong> create Calendar events,
        Notes, and Mail via locale-safe AppleScript — only after you confirm.{" "}
        <strong>Connectors</strong> (Gmail, Calendar, and the rest of the 17)
        reach your other systems through the control plane, and{" "}
        <strong>voice calls</strong> place outbound calls through the Twilio
        connector when a task needs a phone, not a text.
      </p>

      <h2 id="safety">Safety &amp; privacy — the rail beside every layer</h2>
      <p>
        Privacy isn&apos;t a layer; it runs alongside all of them.{" "}
        <strong>Owner-only enforcement</strong> means the doc, action, and command
        pipelines fire only for the owner — DMs from non-owner contacts never
        reach them. The availability concierge answers
        &ldquo;are you around?&rdquo; from presence and calendar and does not
        volunteer a place; per-contact disclosure rules decide what a contact
        may learn. The <strong>kill switch</strong> makes the bridge ignore all
        inbound until you release it; <strong>mute</strong> only stops sends
        (replies are drafted to you instead).
        The most personal stores are <strong>local 0600 and path-restricted</strong>,
        and <strong>secrets never appear in logs, traces, or run state</strong>.
        See <Link href="/security">Security</Link> for the full model.
      </p>

      <h2 id="privacy">Privacy recap</h2>
      <ul>
        <li>Device signals are appended to a mode <code>0600</code> JSONL file
          on the host running the control plane (your Mac in the default
          setup).</li>
        <li>The composite summary grounds <strong>your own</strong> self-chat —
          the bot never volunteers it and never reveals it to a contact.</li>
        <li>The token gates the endpoint; keep it server-side only.</li>
        <li>Turn it off any time: <code>LANTERN_IPHONE_SIGNALS=off</code> on the
          bridge, or unset <code>LANTERN_SIGNAL_TOKEN</code> on the receiver.</li>
      </ul>
    </>
  );
}
