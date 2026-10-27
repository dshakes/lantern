import Link from "next/link";
import { Concept } from "../../_components/Concept";
import { Diagram } from "../../_components/Diagram";
import { Recording } from "../../_components/Recording";
import { LifecycleMachine } from "../../_components/interactive/LifecycleMachine";
import { Sequence } from "../../_components/interactive/Sequence";

export default function RuntimeSandboxLifecyclePage() {
  return (
    <>
      <h1>Sandbox lifecycle</h1>
      <p>
        MicroVM sandboxes are stateful. A running VM suspends itself when idle and wakes on the next request; you can
        also <strong>pause</strong> it (snapshot, quota slot freed), <strong>resume</strong> it under the same{" "}
        <code>vm_id</code>, or <strong>fork</strong> it into independent copies. Command output streams over SSE as it
        is produced.
      </p>

      <Concept>
        Pause is &quot;save game&quot;: the VM&apos;s memory and disk are snapshotted and the machine stops holding a
        concurrency slot. Resume loads the save into the same VM id. Fork loads the same save into several new VMs at
        once, for trying N approaches from one warmed-up state.
      </Concept>

      <h2 id="states">States</h2>
      <Diagram
        name="sandbox-lifecycle"
        caption="scheduled → running ⇄ suspended (idle) · running ⇄ paused · running → forks · terminated"
      />
      <LifecycleMachine />
      <Sequence name="lifecycle" />

      <h2 id="idle">Idle suspend</h2>
      <p>
        Set <code>idleTimeoutSecs</code> on the schedule request (<code>--idle-timeout N</code> on the CLI; 0 or unset
        = never). When a sandbox sees no exec, tool call or file request for that long, it is snapshotted and its
        compute and quota slot released; the scheduler sweeps every 10 s on activity reported with the 30 s node heartbeat, so suspension can trail the timeout by up to ~40 s. The next exec or file request (REST, CLI
        or SDK) resumes it transparently: the caller sees a slower first response (~4 s for the in-guest exec channel
        to re-establish), not an error. A VM paused by an operator (<code>POST /pause</code>) is never auto-resumed.
        The snapshot stays in storage while suspended. Lifecycle latency numbers (Lima nested-virt, Apple M4 Max,
        aarch64 — indicative, not bare metal):{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/benchmarks/runtime-latency.md">
          docs/benchmarks/runtime-latency.md
        </a>
        .
      </p>

      <Concept>
        Forks share the parent snapshot&apos;s memory copy-on-write, so N forks cost one snapshot&apos;s memory plus
        whatever each child writes; each fork gets its own private copy of the captured disk. The per-call cap defaults
        to 100 and is set with <code>LANTERN_MAX_FORK_COUNT</code> (ceiling 1000).
      </Concept>

      <h2 id="snapshots">Snapshots</h2>
      <p>
        A snapshot captures the VM&apos;s guest memory, its vmstate <em>and its writable disk</em>. The disk is copied
        while the VM is paused for the memory snapshot, so memory and disk describe the same instant (a restored guest&apos;s
        page cache matches the disk underneath it). Every snapshot is stored as three artifacts:
      </p>
      <ul>
        <li><code>snapshot</code> — Firecracker vmstate</li>
        <li><code>mem</code> — guest memory (as large as the VM&apos;s RAM)</li>
        <li><code>rootfs</code> — the captured disk</li>
      </ul>
      <p>
        <strong>Restore and fork stage from the captured disk.</strong> Resume, idle wake and each fork copy the
        snapshot&apos;s <code>rootfs</code> to a per-VM writable path (or into the jail), so files written before the
        snapshot are still there and writes after it stay private to that VM. A legacy snapshot taken before disks were
        captured has no <code>rootfs</code>; it restores onto the base image, which does not match its memory, so
        re-snapshot long-lived VMs.
      </p>

      <h3 id="snapshot-storage">Where snapshots are stored</h3>
      <p>
        The runtime-manager&apos;s snapshot store keeps the canonical copy on local disk and optionally mirrors it to
        S3/MinIO. All reads go through the local tier and fall back to S3 when the local copy is gone.
      </p>
      <table>
        <thead>
          <tr><th>Env var (runtime-manager)</th><th>Default</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr><td><code>SNAPSHOT_DIR</code></td><td><code>/var/lib/lantern/snapshots</code></td><td>Local tier root, laid out <code>&lt;agent_version_id&gt;/&lt;vm_id&gt;/&lt;snapshot_id&gt;/</code></td></tr>
          <tr><td><code>S3_ENDPOINT</code> + <code>S3_BUCKET</code></td><td>unset (S3 tier off)</td><td>Enable the S3/MinIO mirror under <code>snapshots/&lt;agent_version_id&gt;/&lt;vm_id&gt;/&lt;snapshot_id&gt;/</code></td></tr>
          <tr><td><code>AWS_ACCESS_KEY_ID</code> / <code>AWS_SECRET_ACCESS_KEY</code></td><td>unset</td><td>S3 credentials (same variables the control-plane uses)</td></tr>
        </tbody>
      </table>
      <p>
        An S3 upload failure is logged and does not fail the snapshot; the local copy is already safe. Retention is
        applied after every write: the newest 3 snapshots per VM are kept and anything older than 7 days is deleted.
      </p>

      <h3 id="snapshot-cost">Cost</h3>
      <p>
        Each snapshot stores <code>mem</code> (up to the VM&apos;s RAM) plus a full copy of the disk, and every
        restore or fork copies the disk again. Disk capture happens while the VM is paused, so it adds to pause time
        (the copy reflinks on XFS/btrfs and byte-copies elsewhere). On the jailed path forks share the memory file via
        a hard link, so only the disk is copied per fork. Indicative numbers from{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/benchmarks/runtime-latency.md">
          docs/benchmarks/runtime-latency.md
        </a>
        , measured in a Lima nested-virt guest on an Apple M4 Max (aarch64, 1 vCPU, 128 MiB VM, jailed). They are not
        bare-metal numbers:
      </p>
      <table>
        <thead>
          <tr><th>Step</th><th>Indicative</th></tr>
        </thead>
        <tbody>
          <tr><td>Snapshot (128 MiB memory, 134 MB written)</td><td>634 ms</td></tr>
          <tr><td>Restore (Spawn RPC)</td><td>138 ms</td></tr>
          <tr><td>Fork spawn (hard-linked memory + per-VM rootfs copy)</td><td>131–160 ms</td></tr>
        </tbody>
      </table>
      <p>
        The benchmark does not break out disk-capture time, so expect snapshot time to grow with rootfs size. The doc estimates the per-VM rootfs copy at ~5–50 ms for a 20–100 MiB image. The
        in-guest exec channel then needs ~2–5 s to re-establish after a restore.
      </p>

      <Recording
        name="lifecycle-kvm"
        alt="Terminal recording, recorded on Lima nested KVM: the real-Firecracker lifecycle e2e test passes — boot, ExecTool, snapshot, stop, restore with state intact, fork ×3, copy-on-write isolation, shared snapshot-memory inode, clean teardown, then the per-step timing table."
        caption="infra/firecracker/integration-test.sh on real Firecracker 1.15.1 + jailer, recorded on Lima nested KVM (aarch64). Unedited output, filtered to PASS lines and the timing table."
      />

      <h2 id="rest">REST</h2>
      <pre><code>{`# Pause: snapshot + stop. Frees the quota slot.
POST /v1/runtime/vms/{id}/pause
→ { "vmId": "...", "snapshotId": "...", "state": "paused" }

# Resume: same vm id. 402 if quota is exhausted, 409 if the VM is not paused.
POST /v1/runtime/vms/{id}/resume
→ { "vmId": "...", "snapshotId": "...", "state": "running" }

# Fork: count 1..100 by default (LANTERN_MAX_FORK_COUNT, ceiling 1000); forks share the snapshot memory copy-on-write. Each fork gets its own vm_id, cert and agent identity.
POST /v1/runtime/vms/{id}/fork
{ "count": 3 }
→ { "sourceVmId": "...", "snapshotId": "...",
    "forks": [ { "vmId": "...", "state": "running" },
               { "vmId": "...", "state": "failed", "error": "..." } ] }`}</code></pre>
      <p>
        <code>GET /v1/runtime/vms/&#123;id&#125;</code> additionally returns{" "}
        <code>snapshotId</code> and <code>parentVmId</code> (set on forks), and{" "}
        <code>state</code> may be <code>paused</code>. Restoring a snapshot onto a fresh TAP (resume, idle
        wake, fork; not broker mode) uses snapshot-load <code>network_overrides</code>, which needs
        Firecracker ≥ 1.12 with the jailer (tested on 1.15).
        Snapshots are owned by the tenant that created them; restoring another
        tenant&apos;s snapshot returns <code>NOT_FOUND</code> (
        <a href="https://github.com/dshakes/lantern/blob/master/docs/adr/0025-sandbox-spawn-contract-and-manager-authz.md">ADR 0025</a>
        ). A restored VM re-identifies with a fresh identity rather than
        reusing the source VM&apos;s.
      </p>

      <h2 id="streaming-exec">Streaming exec</h2>
      <p>
        <code>POST /v1/runtime/vms/&#123;id&#125;/exec</code> buffers output by
        default. Send <code>Accept: text/event-stream</code> to receive{" "}
        <code>stdout</code>, <code>stderr</code>, then <code>exit</code>{" "}
        events (or <code>error</code>) as they happen. Exec is execve-style:{" "}
        <code>command</code> is the executable, <code>argv</code> its
        arguments — pass <code>/bin/sh</code> with <code>[&quot;-c&quot;, …]</code>{" "}
        for a shell line.
      </p>

      <h2 id="files">Files</h2>
      <p>
        Read and write files under the VM&apos;s <code>/workspace</code>. These
        run through the in-guest harness tool runner, so paths are confined to{" "}
        <code>/workspace</code> (escapes return 400) and files are accessed as
        the workload user. Content is UTF-8 text, at most 1 MiB (writes above
        return 413; larger reads are cut and flagged with{" "}
        <code>X-Lantern-Truncated: true</code>). Firecracker VMs only; other
        backends return 503.
      </p>
      <pre><code>{`GET /v1/runtime/vms/{id}/files?path=src          # → { path, entries: [{name, type, size}], truncated }
GET /v1/runtime/vms/{id}/files/content?path=a.txt  # → raw text
PUT /v1/runtime/vms/{id}/files/content?path=a.txt  # body = file bytes → { path, bytesWritten }`}</code></pre>

      <h2 id="sdk">SDKs</h2>
      <h3>TypeScript</h3>
      <pre><code>{`const { snapshotId } = await client.runtime.pause(vmId);
await client.runtime.resume(vmId);                       // same vm id

const { forks } = await client.runtime.fork(vmId, { count: 3 });
for (const f of forks) if (f.error) console.warn(f.vmId, f.error);

await client.runtime.writeFile(vmId, "job.py", "print('hi')");
const { content } = await client.runtime.readFile(vmId, "job.py");
const { entries } = await client.runtime.listFiles(vmId);

for await (const ev of client.runtime.execStream(vmId, {
  command: "/bin/sh",
  argv: ["-c", "pip install -q requests && python job.py"],
})) {
  if (ev.type === "exit") console.log("exit", ev.exitCode);
  else process.stdout.write(ev.data);                    // stdout | stderr
}`}</code></pre>

      <h3>Python</h3>
      <pre><code>{`await client.runtime.pause(vm_id)
await client.runtime.resume(vm_id)

result = await client.runtime.fork(vm_id, count=3)
for f in result.forks:
    if f.error:
        print(f.vm_id, f.error)

await client.runtime.write_file(vm_id, "job.py", "print('hi')")
text = (await client.runtime.read_file(vm_id, "job.py"))["content"]
listing = await client.runtime.list_files(vm_id)

async for ev in client.runtime.exec_stream(vm_id, "/bin/sh", ["-c", "python job.py"]):
    if ev.type == "exit":
        print("exit", ev.exit_code)
    else:
        print(ev.data, end="")`}</code></pre>

      <h3>CLI and Go</h3>
      <p>
        The Go SDK exposes <code>PauseVM</code>, <code>ResumeVM</code>,{" "}
        <code>ForkVM</code>, <code>ListFiles</code>, <code>ReadFile</code> and{" "}
        <code>WriteFile</code>.
      </p>
      <pre><code>{`lantern vm pause <id>
lantern vm resume <id>
lantern vm fork <id> --count 3
lantern vm ls <id> [path]
lantern vm cat <id> <path>
lantern vm put <id> <local-file|-> <path>`}</code></pre>
      <p>
        The dashboard VM detail page (<code>/runtime/&#123;vm&#125;</code>) has
        Pause, Resume and Fork actions.
      </p>

      <p>
        Related: <Link href="/runtime/isolation">Isolation tiers</Link>,{" "}
        <Link href="/runtime/durable-execution">Durable execution</Link>,{" "}
        <Link href="/cli">CLI reference</Link>.
      </p>
    </>
  );
}
