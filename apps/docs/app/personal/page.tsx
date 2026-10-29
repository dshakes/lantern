import Link from "next/link";
import { Concept } from "../_components/Concept";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/personal");

export default function PersonalPage() {
  return (
    <>
      <h1>Built on Lantern: a personal assistant in production</h1>
      <p>
        The founder of Lantern runs a personal assistant on iMessage and
        WhatsApp, built on the platform these docs describe. It handles
        multilingual threads, tracks commitments across both channels, and
        takes actions on the owner&apos;s Mac. This page covers how it is
        built, which platform features it uses, the safety model around it,
        and the feedback loop that improves it. Claims are checked against the
        source; paths are listed at the end.
      </p>

      <Concept>
        Two small programs (the channel bridges) run on the owner&apos;s Mac
        and talk to a Lantern control plane. Every reply a contact would
        receive passes through a series of checks first. Most replies pass and
        are sent after a short, human-paced delay. A reply that commits the
        owner to money or an action, or asserts something the assistant cannot
        verify, is held and shown to the owner instead.
      </Concept>

      <h2 id="architecture">Architecture</h2>
      <pre>
        <code>{`iMessage (chat.db)        WhatsApp
        |                    |
        +---------+----------+
                  | inbound message
                  v
   channel bridge (Node.js, on the Mac)
     owner-only checks, check stack, pacing
                  | POST /v1/sessions/{id}/messages
                  v
   control plane (Lantern)
     sessions, web_search tool, memory API
                  | model: "auto"
                  v
   model router -> concrete model

On the Mac:       encrypted sent log, dislike log, episode and topic stores
In the platform:  person graph, memory events (Postgres, RLS)`}</code>
      </pre>
      <p>
        Each contact gets a Lantern session through the same{" "}
        <code>/v1/sessions</code> API the dashboard and SDKs use; there is no
        separate bridge protocol. Auxiliary LLM calls (gate judges, voice
        refinement, ranking) use a <strong>purpose-keyed session</strong>{" "}
        (<code>&lt;contact&gt;::&lt;purpose&gt;</code>) so they cannot leak
        into the contact&apos;s live thread.
      </p>

      <h2 id="pipeline">The reply pipeline</h2>
      <p>
        Every contact reply goes through these stages in order. The first
        three are soft: a failure triggers regeneration. The next two are
        hard: they hold the reply for the owner. The prompt rules are advice;
        these stages are code.
      </p>
      <pre>
        <code>{`1. draft            purpose-keyed session, web_search on, read-only tools
2. bot-tell guard   stock phrases, leaked reasoning, denials of the
                    owner's own facts            (soft: regenerate)
3. voice floor      stylometric distance from the owner's own sent
                    messages                     (soft: regenerate)
4. critique-refine  MEDIUM/LOW drafts only; accepted only if closer to
                    the owner's voice and bot-tell clean
5. commitment gate  LLM judge + deterministic multilingual backstop
                    holds replies that commit money or an action
                                                 (HOLD for the owner)
6. grounding gate   LLM judge + deterministic backstop; holds replies
                    that state unverifiable facts about the owner's
                    plans or answer bad news in the wrong register
                                                 (HOLD for the owner)
7. claim rewrite    "I sent it" becomes "I'll send it" unless the action
                    was recorded for that contact in the last 10 minutes
8. paced send       hold time from the owner's real reply latency,
                    jittered, clamped to 600 ms - 25 s`}</code>
      </pre>
      <p>
        The last two checks that can hold a message (stages 5 and 6) hold any
        reply that commits money or asserts what it cannot verify. They are
        not a blanket hold: most replies pass. Each runs a deterministic
        backstop alongside the LLM judge, so an LLM outage cannot make them
        fail open. A hold forces the draft path even when draft-and-confirm is
        off, and the owner gets a notification with the held draft.
      </p>
      <p>
        <strong>Why two hard gates.</strong> They exist because of two
        failure modes seen in production. In the first, the assistant made
        repeated money promises in a non-English language that no English-only
        guard recognized; replaying that conversation through the
        deterministic backstop alone held most of those replies. In the
        second, it asserted a stale profile fact as current and answered a
        solemn message in the wrong register.
      </p>

      <h2 id="features">Platform features used</h2>
      <table>
        <thead>
          <tr>
            <th>Feature</th>
            <th>How the assistant uses it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Sessions</strong> (<code>/v1/sessions</code>)</td>
            <td>One session per contact; purpose-keyed sessions for side calls</td>
          </tr>
          <tr>
            <td><strong>Model router</strong></td>
            <td>The bridge requests <code>model: &quot;auto&quot;</code> by default; the router picks the concrete model</td>
          </tr>
          <tr>
            <td><strong>Web search</strong> tool</td>
            <td>On for every contact reply, for live facts the model should check before answering</td>
          </tr>
          <tr>
            <td><strong>Memory API</strong> (<code>/v1/memory</code>, <code>/v1/people</code>)</td>
            <td>One person graph and timeline shared by both channels</td>
          </tr>
        </tbody>
      </table>
      <p>
        Actions on the Mac (Calendar, Notes, Mail) run through AppleScript in
        the bridge, not through the connector layer.
      </p>

      <h2 id="safety">Safety model</h2>
      <ul>
        <li>
          <strong>Owner-only.</strong> Document search, Mac actions and
          commands run only for the owner&apos;s chat. A message from anyone
          else never reaches them.
        </li>
        <li>
          <strong>Path-restricted documents.</strong> Reads stay inside{" "}
          <code>LANTERN_PERSONAL_DOCS_ROOTS</code> and go through{" "}
          <code>isAllowedPath</code>; the OCR cache is mode 0600.
        </li>
        <li>
          <strong>Mute is not the kill switch.</strong> Mute still runs the
          pipeline but hands every contact reply to the owner as a draft; the
          block is enforced at the send boundary, so groups and fallbacks are
          covered too. The kill switch ignores all inbound and does nothing.
        </li>
        <li>
          <strong>No silent drops.</strong> Every suppression logs which
          check fired and why.
        </li>
        <li>
          <strong>Draft-and-confirm is opt-in.</strong> When off, a
          LOW-confidence reply is held briefly, then sent with a heads-up to
          the owner. Enable with <code>LANTERN_DRAFT_CONFIRM=on</code>{" "}
          (iMessage) or <code>LANTERN_DRAFT_HIGH_STAKES=on</code> (WhatsApp).
        </li>
        <li>
          <strong>Data stays on the Mac</strong>, except the message text sent
          to the LLM provider you configure. The highest-sensitivity stores
          are AES-256-GCM encrypted at rest.
        </li>
      </ul>

      <h2 id="quality">The quality loop</h2>
      <ul>
        <li>
          <strong>Sent log.</strong> Every sent contact reply is stored
          encrypted (AES-256-GCM) with its tier and voice score, so quality is
          measurable. Nothing on the reply path reads it back.
        </li>
        <li>
          <strong>Voice score.</strong> A deterministic stylometric distance
          from the owner&apos;s own messages. The floor is the 95th percentile
          of the owner&apos;s own samples. It checks surface features, not
          meaning.
        </li>
        <li>
          <strong>Thumbs-down flywheel.</strong> A thumbs-down logs the pair.
          Patterns recurring across three or more rejections graduate into
          style lessons that are injected into every future prompt. An LLM
          clustering pass is on by default and fail-safe (
          <code>LANTERN_DISLIKE_LLM_CLUSTER=0</code> disables it).
        </li>
        <li>
          <strong>Audits.</strong> A script (
          <code>scripts/introspect/run.sh</code>) audits recent live replies
          four times a day and alarms if no run has succeeded in 36 hours.
        </li>
        <li>
          <strong>Parity test.</strong> CI fails if a shared pipeline module
          is wired into one bridge but not the other.
        </li>
      </ul>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>The bridge runs on one Mac. If it is off, nothing is processed.</li>
        <li>
          The grounding gate holds claims it cannot verify; it does not
          verify them. A separate scheduled refresh updates the owner&apos;s
          profile from mail and calendar, so there is a lag.
        </li>
        <li>Voice scoring is a signal, not a judgment of tone or meaning.</li>
        <li>
          Voice cloning (<code>LANTERN_VOICE_CLONE</code>) is off by default
          and treated as deepfake-class.
        </li>
      </ul>

      <h2 id="run-your-own">Run your own</h2>
      <p>
        Setup is in{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/personal/BOT-SETUP.md">
          <code>docs/personal/BOT-SETUP.md</code>
        </a>
        . Key variables:
      </p>
      <table>
        <thead>
          <tr>
            <th>Var</th>
            <th>Default</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_OWNER_NAME</code></td><td>required</td><td>First name, used for document ranking</td></tr>
          <tr><td><code>LANTERN_OWNER_TIMEZONE</code></td><td>process timezone</td><td>Quiet hours, digests, calendar lookups</td></tr>
          <tr><td><code>LANTERN_DRAFT_CONFIRM</code> / <code>LANTERN_DRAFT_HIGH_STAKES</code></td><td>off</td><td>Hold LOW-confidence replies for approval</td></tr>
          <tr><td><code>LANTERN_VOICE_REFINE</code></td><td>on</td><td>Critique-refine for MEDIUM/LOW drafts</td></tr>
          <tr><td><code>LANTERN_VOICE_FLOOR</code></td><td>on</td><td>Stylometric floor; <code>0</code> disables</td></tr>
          <tr><td><code>LANTERN_QUIET_START</code> / <code>LANTERN_QUIET_END</code></td><td>1 / 6</td><td>Quiet-hours window (24h integers); messages queue</td></tr>
        </tbody>
      </table>
      <p>
        See also <Link href="/surfaces/">Channels</Link> and{" "}
        <Link href="/security/">Security</Link>.
      </p>

      <h2 id="sources">Source paths</h2>
      <p>
        <code>packages/bridge-core/src/</code>: <code>natural.ts</code>,{" "}
        <code>voice-score.ts</code>, <code>voice-refine.ts</code>,{" "}
        <code>commitment-gate.ts</code>, <code>grounding-gate.ts</code>,{" "}
        <code>verifiable-claims.ts</code>, <code>sent-log.ts</code>,{" "}
        <code>secure-store.ts</code>, <code>dislike-consolidator.ts</code>,{" "}
        <code>agent.ts</code>, <code>bridge-parity.test.ts</code>.
        Wiring: <code>services/imessage-bridge/src/session.ts</code>.
      </p>
    </>
  );
}
