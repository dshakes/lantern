import Link from "next/link";
import { Concept } from "../_components/Concept";
import { Flow } from "../_components/Flow";
import { CodeTabs } from "../_components/CodeTabs";

export default function TriggersPage() {
  return (
    <>
      <h1>Webhook triggers</h1>
      <p>
        A trigger binds a public URL, <code>POST /v1/hooks/{"{id}"}</code>, to one agent. GitHub, Sentry, PagerDuty or any
        service that can sign a request with HMAC-SHA256 posts events there, and every verified delivery starts a run.
        The signature is the only credential: the sender never holds a Lantern token.
      </p>

      <Concept>
        The trigger URL is a mail slot with a wax seal. Anyone can drop a letter in, but the clerk only opens letters
        stamped with the seal that matches your secret. A letter delivered twice is opened once.
      </Concept>

      <h2 id="how-it-works">How it works</h2>
      <Flow
        steps={[
          { name: "Look up the trigger", sub: "By id. Unknown, disabled, or its agent is gone: 404. Nothing else runs yet." },
          { name: "Verify the signature", sub: "HMAC-SHA256 over the raw body in the provider's format, constant-time. Bad or missing: 401." },
          { name: "Rate limit", sub: "Per trigger, spent only by senders that passed the signature check. Over: 429." },
          { name: "Deduplicate", sub: "On the provider delivery id and a hash of the signed bytes. Seen before: 200 duplicate, no run." },
          { name: "Create the run", sub: "Same code path as POST /v1/runs: spawn limit, budget check, routing. Success: 202." },
        ]}
      />

      <h2 id="create">Create a trigger</h2>
      <p>
        <code>POST /v1/agents/{"{name}"}/triggers</code> with <code>provider</code> (<code>generic</code>,{" "}
        <code>github</code>, <code>sentry</code> or <code>pagerduty</code>), and optionally <code>secret</code> and{" "}
        <code>inputTemplate</code>. The agent must already exist. Requires the <code>agents:write</code> scope when scope
        enforcement is on.
      </p>
      <CodeTabs
        tabs={[
          {
            label: "curl",
            lang: "bash",
            code: `curl -X POST http://localhost:8080/v1/agents/my-agent/triggers \\
  -H "Authorization: Bearer $LANTERN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"provider":"github"}'

# 201 Created
# {
#   "id": "6f0c1c6e-...",
#   "agentName": "my-agent",
#   "provider": "github",
#   "enabled": true,
#   "hookPath": "/v1/hooks/6f0c1c6e-...",
#   "createdAt": "2026-10-27T12:00:00Z",
#   "secret": "whsec_..."
# }

# list, get, disable, delete
curl http://localhost:8080/v1/agents/my-agent/triggers -H "Authorization: Bearer $LANTERN_API_KEY"
curl http://localhost:8080/v1/triggers/$ID -H "Authorization: Bearer $LANTERN_API_KEY"
curl -X PATCH http://localhost:8080/v1/triggers/$ID -H "Authorization: Bearer $LANTERN_API_KEY" -d '{"enabled":false}'
curl -X DELETE http://localhost:8080/v1/triggers/$ID -H "Authorization: Bearer $LANTERN_API_KEY"   # 204`,
          },
          {
            label: "TypeScript",
            lang: "ts",
            code: `import { LanternClient } from "@lantern/sdk";
const client = new LanternClient({ apiKey: process.env.LANTERN_API_KEY, baseUrl: "http://localhost:8080" });

const t = await client.triggers.create("my-agent", { provider: "github" });
console.log(t.hookPath, t.secret); // secret is present only here

await client.triggers.list("my-agent");
await client.triggers.update(t.id, { enabled: false }); // also: secret, inputTemplate (null clears)
await client.triggers.delete(t.id);`,
          },
          {
            label: "Python",
            lang: "python",
            code: `from lantern import LanternClient

async with LanternClient(api_key="hlx_live_...", base_url="http://localhost:8080") as client:
    t = await client.triggers.create("my-agent", provider="github")
    print(t["hookPath"], t.get("secret"))  # secret is present only here

    await client.triggers.list("my-agent")
    await client.triggers.update(t["id"], enabled=False)  # also: secret, input_template, clear_input_template
    await client.triggers.delete(t["id"])`,
          },
          {
            label: "Go",
            lang: "go",
            code: `import lantern "github.com/dshakes/lantern/packages/sdk-go"

c := lantern.New(lantern.WithAPIKey(key), lantern.WithBaseURL("http://localhost:8080"))

t, err := c.CreateTrigger(ctx, "my-agent", lantern.TriggerCreate{Provider: "github"})
// t.Secret is set only here
list, _ := c.ListTriggers(ctx, "my-agent")
off := false
_, _ = c.UpdateTrigger(ctx, t.ID, lantern.TriggerUpdate{Enabled: &off})
_ = c.DeleteTrigger(ctx, t.ID)`,
          },
          {
            label: "CLI",
            lang: "bash",
            code: `lantern hooks create my-agent --provider github   # prints the URL path and the secret once
lantern hooks list my-agent
lantern hooks get <trigger-id>
lantern hooks update <trigger-id> --disable        # --enable, --template '<json>', --clear-template, --secret-stdin
lantern hooks delete <trigger-id>

# supply your own secret without it landing in shell history
printf '%s' "$SECRET" | lantern hooks create my-agent --provider generic --secret-stdin`,
          },
        ]}
      />
      <p>
        <code>lantern hooks</code> is also reachable as <code>lantern hook</code> and <code>lantern triggers</code>. In the
        dashboard, open an agent and use <strong>Manage</strong> on its webhook triggers card (
        <code>/agents/{"{name}"}/triggers</code>): <strong>New trigger</strong> picks a provider, takes an optional secret
        and input template, then shows the payload URL and secret in a copy dialog. Each row has Enable/Disable,{" "}
        <strong>Replace secret</strong> and Delete.
      </p>

      <h2 id="url-and-secret">The URL and the secret</h2>
      <p>
        The public URL is the API base URL plus the trigger&apos;s <code>hookPath</code>, e.g.{" "}
        <code>http://localhost:8080/v1/hooks/6f0c1c6e-...</code>. The sender must be able to reach it, so a local
        control plane needs a tunnel.
      </p>
      <ul>
        <li>
          If you omit <code>secret</code>, Lantern generates one (<code>whsec_</code> plus 64 hex characters) and returns
          it in the create response only. List and get never return it, and there is no way to read it back.
        </li>
        <li>
          If you supply one, it must be at least 16 characters and is not echoed back.
        </li>
        <li>
          To change it, <code>PATCH /v1/triggers/{"{id}"}</code> with a new <code>secret</code> (same 16-character minimum).
          The old secret stops working immediately; there is no overlap window.
        </li>
      </ul>

      <h2 id="providers">Provider setup</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Header</th>
            <th>Signed bytes</th>
            <th>Delivery id (dedup key)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>github</code></td>
            <td><code>X-Hub-Signature-256: sha256=&lt;hex&gt;</code></td>
            <td>raw body</td>
            <td><code>X-GitHub-Delivery</code></td>
          </tr>
          <tr>
            <td><code>sentry</code></td>
            <td><code>Sentry-Hook-Signature: &lt;hex&gt;</code></td>
            <td>raw body</td>
            <td><code>Request-ID</code></td>
          </tr>
          <tr>
            <td><code>pagerduty</code></td>
            <td><code>X-PagerDuty-Signature: v1=&lt;hex&gt;[,v1=&lt;hex&gt;]</code></td>
            <td>raw body</td>
            <td><code>event.id</code> in the JSON body</td>
          </tr>
          <tr>
            <td><code>generic</code></td>
            <td><code>X-Lantern-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;[,v1=&lt;hex&gt;]</code></td>
            <td><code>&lt;t&gt;.&lt;raw body&gt;</code></td>
            <td><code>X-Lantern-Delivery</code> (optional)</td>
          </tr>
        </tbody>
      </table>
      <p>All four are HMAC-SHA256 with the trigger secret, hex encoded.</p>

      <h3 id="github">GitHub</h3>
      <p>
        Create a <code>github</code> trigger and let Lantern generate the secret. In the repository (or organization),{" "}
        <strong>Settings → Webhooks → Add webhook</strong>: paste the URL as the payload URL, set content type to{" "}
        <code>application/json</code>, paste the secret into <strong>Secret</strong>, and choose the events to send.
        GitHub sends a <code>ping</code> when you save; it is a signed delivery like any other and starts a run. The
        event name is available to templates as <code>event</code> (from <code>X-GitHub-Event</code>).
      </p>

      <h3 id="sentry">Sentry</h3>
      <p>
        Sentry generates its own client secret, so you cannot choose it. Create a <code>sentry</code> trigger first (you
        need its URL for the Sentry integration), then paste Sentry&apos;s client secret into Lantern:
      </p>
      <pre>
        <code>{`printf '%s' "<sentry client secret>" | lantern hooks update <trigger-id> --secret-stdin`}</code>
      </pre>
      <p>
        Or use <strong>Replace secret</strong> in the dashboard, or <code>PATCH</code> with <code>secret</code>. Lantern
        reads the event from <code>Sentry-Hook-Resource</code>.
      </p>

      <h3 id="pagerduty">PagerDuty</h3>
      <p>
        PagerDuty shows its signing secret after you create the webhook subscription, so the order is the same: create the{" "}
        <code>pagerduty</code> trigger, use its URL as the subscription&apos;s delivery URL, then replace the trigger&apos;s
        secret with the one PagerDuty displays. During a PagerDuty secret rotation it sends several{" "}
        <code>v1=</code> signatures in one header; any match passes. The delivery id and event come from{" "}
        <code>event.id</code> and <code>event.event_type</code> in the body.
      </p>

      <h3 id="generic">Generic HMAC</h3>
      <p>
        For anything else, sign <code>{"<unix-timestamp>.<body>"}</code> with HMAC-SHA256 and send{" "}
        <code>X-Lantern-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>. The timestamp must be within five minutes of
        server time, in either direction. Send <code>X-Lantern-Delivery</code> as a stable id per event and optionally{" "}
        <code>X-Lantern-Event</code>.
      </p>
      <pre>
        <code>{`SECRET=whsec_...   # from the create response
HOOK=http://localhost:8080/v1/hooks/<trigger-id>
BODY='{"service":"checkout","status":"down"}'
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

curl -i -X POST "$HOOK" \\
  -H "X-Lantern-Signature: t=$T,v1=$SIG" \\
  -H "X-Lantern-Delivery: incident-42" \\
  -d "$BODY"
# HTTP/1.1 202 Accepted
# {"runId":"...","deliveryId":"incident-42"}`}</code>
      </pre>
      <p>
        Run it a second time within five minutes with the same <code>X-Lantern-Delivery</code> and you get the duplicate
        response below.
      </p>

      <h2 id="responses">Responses</h2>
      <p>
        Every error body is <code>{`{"error": "..."}`}</code>. The signature checks never say which part failed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Body</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>202</code></td>
            <td><code>{`{"runId":"...","deliveryId":"..."}`}</code></td>
            <td>Signature verified, run created.</td>
          </tr>
          <tr>
            <td><code>200</code></td>
            <td><code>{`{"duplicate":true,"deliveryId":"...","runId":"..."}`}</code></td>
            <td>Delivery already seen. No second run. <code>runId</code> is omitted if the first delivery has no run recorded yet.</td>
          </tr>
          <tr>
            <td><code>401</code></td>
            <td><code>{`{"error":"invalid signature"}`}</code></td>
            <td>Missing or wrong signature, malformed header, or a generic timestamp outside the five-minute window.</td>
          </tr>
          <tr>
            <td><code>404</code></td>
            <td><code>{`{"error":"hook not found"}`}</code></td>
            <td>Id is not a UUID, no such trigger, trigger disabled, or its agent no longer exists. Identical for all four.</td>
          </tr>
          <tr>
            <td><code>413</code></td>
            <td><code>{`{"error":"payload too large"}`}</code></td>
            <td>Body over 1 MiB (1,048,576 bytes). Checked before the trigger lookup.</td>
          </tr>
          <tr>
            <td><code>429</code></td>
            <td><code>{`{"error":"rate limited"}`}</code></td>
            <td>This trigger&apos;s delivery rate was exceeded (after the signature passed).</td>
          </tr>
          <tr>
            <td><code>429</code></td>
            <td><code>{`{"error":"rate limited: too many runs, slow down"}`}</code></td>
            <td>The tenant&apos;s run-spawn limit (shared with <code>POST /v1/runs</code>) was hit.</td>
          </tr>
          <tr>
            <td><code>402</code></td>
            <td><code>{`{"error":"agent budget limit reached: <reason>","reason":"<reason>"}`}</code></td>
            <td>The agent has a hard-fail <Link href="/budgets">budget</Link> that is already reached.</td>
          </tr>
          <tr>
            <td><code>400</code></td>
            <td><code>{`{"error":"could not read body"}`}</code></td>
            <td>The request body could not be read.</td>
          </tr>
          <tr>
            <td><code>500</code></td>
            <td><code>{`{"error":"run creation failed"}`}</code> or <code>{`{"error":"internal error"}`}</code></td>
            <td>
              Run creation failed for any reason other than 402/429 (including a budget check that was unavailable), or a
              server error such as an unreadable stored secret. Detail is logged, not returned.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        When run creation fails (402, 429, 500), the delivery id is released, so the provider&apos;s own retry can
        succeed once the budget resets or the limit clears.
      </p>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>
          <strong>Body size:</strong> 1 MiB. Larger gets 413.
        </li>
        <li>
          <strong>Rate:</strong> per trigger, 60 deliveries per minute with a burst of 10 by default. Set{" "}
          <code>LANTERN_HOOK_RATE_PER_MIN</code> and <code>LANTERN_HOOK_BURST</code> on the control plane to change them.
          Buckets are in memory per replica, so with several replicas the effective limit is higher.
        </li>
        <li>
          <strong>Delivery id:</strong> longer than 200 characters is replaced by its SHA-256 for storage.
        </li>
      </ul>

      <h2 id="idempotency">Duplicate deliveries</h2>
      <p>
        Every delivery is checked against two keys, each unique per trigger: the provider&apos;s delivery id (table above;
        for <code>generic</code> without <code>X-Lantern-Delivery</code>, and for any provider that sends no id, a hash of
        the signed bytes) and a SHA-256 of the signed bytes. A match on either returns{" "}
        <code>200 {`{"duplicate":true}`}</code> and starts no run.
      </p>
      <p>
        The second key exists because GitHub, Sentry and PagerDuty sign only the body, not their delivery id headers, so
        someone holding a captured request could replay it with a fresh id. The consequence: a sender that posts the
        byte-identical body twice gets one run. The real providers put a unique id or timestamp in their payloads; for
        hand-rolled senders use <code>generic</code>, whose signed bytes include the timestamp. Delivery rows are not
        pruned yet.
      </p>

      <h2 id="run-input">What the run receives</h2>
      <p>
        With no template, the run input is:
      </p>
      <pre>
        <code>{`{
  "provider": "github",
  "event": "pull_request",
  "deliveryId": "b1c2...",
  "payload": { ...the parsed JSON body... }
}`}</code>
      </pre>
      <p>
        If the body is not valid JSON, <code>payload</code> is the raw body as a string. <code>event</code> is the
        provider&apos;s event name, or an empty string where the format has none. The run is recorded with trigger kind{" "}
        <code>webhook</code>.
      </p>
      <p>
        An <code>inputTemplate</code> (a JSON object, set on create or update; <code>null</code> clears it) replaces that
        shape. Inside it, a string that is exactly <code>{"{{path}}"}</code> becomes the typed value at that dotted path in{" "}
        <code>{"{payload, event, provider, deliveryId, triggerId}"}</code> (or <code>null</code> if absent). A{" "}
        <code>{"{{path}}"}</code> inside a longer string is interpolated as text (empty if absent; non-strings are
        JSON-encoded). Nothing else is evaluated.
      </p>
      <pre>
        <code>{`lantern hooks create my-agent --provider github \\
  --template '{"pr":"{{payload.number}}","title":"{{payload.pull_request.title}}","note":"PR {{payload.number}} opened"}'`}</code>
      </pre>

      <h2 id="budgets">Budgets and spend</h2>
      <p>
        A delivery creates a run through the same handler as <code>POST /v1/runs</code>, so the agent&apos;s{" "}
        <Link href="/budgets">budget</Link> and the tenant spawn limit apply unchanged. With <code>hardFail</code> on and a
        cap reached, the delivery gets 402 and no run starts. A signed sender can therefore spend only the budget of the
        one agent its trigger is bound to. Set a budget on any agent you expose this way.
      </p>

      <h2 id="security">Security notes</h2>
      <ul>
        <li>
          <strong>Signature only.</strong> The route takes no token. The one query before verification is the trigger
          lookup by id; the trigger&apos;s tenant is taken from that row, never from the request.
        </li>
        <li>
          <strong>Constant-time compare</strong> of the MAC (<code>hmac.Equal</code>); every candidate signature is
          checked with no early exit.
        </li>
        <li>
          <strong>404 vs 401.</strong> Unknown, disabled, bad-UUID and orphaned-agent triggers all return the same 404 body,
          so an outsider cannot tell which ids exist. 401 appears only for an existing, enabled trigger. The rate limit is
          spent only after the signature passes, so an unsigned flood cannot use up a real sender&apos;s allowance.
        </li>
        <li>
          <strong>Secret storage.</strong> Stored encrypted with AES-256-GCM when <code>LANTERN_CREDENTIAL_KEY</code> is
          set (plaintext pass-through when unset, as for other credentials). Never returned after create, never logged.
        </li>
        <li>
          <strong>Tenant scoping.</strong> Trigger CRUD runs under row-level security by tenant; get, update and delete of
          another tenant&apos;s trigger return 404. The run is created in the trigger&apos;s tenant.
        </li>
        <li>
          <strong>Replay.</strong> Only <code>generic</code> signs a timestamp (five-minute window). The others rely on the
          duplicate check above.
        </li>
      </ul>

      <h2 id="not-yet">Not yet</h2>
      <ul>
        <li>No overlap window when rotating a secret.</li>
        <li>No retention sweep for delivery records.</li>
        <li>Per-replica rate limit; no per-IP limit at this layer.</li>
        <li>No event filter: every verified delivery, including a GitHub <code>ping</code>, starts a run.</li>
      </ul>
      <p>
        Related: <Link href="/api#triggers">API reference</Link>, <Link href="/budgets">Budgets</Link>,{" "}
        <Link href="/cli">CLI</Link>, <Link href="/sdk">SDKs</Link>.
      </p>
    </>
  );
}
