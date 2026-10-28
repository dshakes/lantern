import Link from "next/link";
import { Concept } from "../../_components/Concept";
import { pageMeta } from "../../_meta";

export const metadata = pageMeta("/runtime/local-microvms");

export default function RuntimeLocalMicrovmsPage() {
  return (
    <>
      <h1>Run real microVMs on your Mac</h1>
      <p>
        On an Apple Silicon Mac you can run real Firecracker microVMs locally: a Lima Linux guest with nested
        virtualization provides <code>/dev/kvm</code>, and the runtime-manager runs inside it with{" "}
        <code>RUNTIME_BACKEND=firecracker</code>.
      </p>

      <Concept>
        macOS has no KVM, so Firecracker cannot run on it directly. Lima starts a small Linux machine that is allowed
        to host virtual machines of its own: a VM inside a VM. Firecracker runs in the inner layer exactly as it would
        on a Linux server.
      </Concept>

      <h2 id="requirements">Requirements</h2>
      <ul>
        <li>Apple Silicon <strong>M3 or newer</strong> and <strong>macOS 15 or newer</strong>. Nested virtualization in Virtualization.framework needs both.</li>
        <li><a href="https://lima-vm.io">Lima</a> (<code>brew install lima</code>).</li>
      </ul>
      <p>
        The Lima template (<code>infra/lima/firecracker-dev.yaml</code>) uses <code>vmType: vz</code> with{" "}
        <code>nestedVirtualization: true</code>, 4 CPUs, 8 GiB RAM and a 30 GiB disk, and installs the pinned
        Firecracker v1.15.1 release plus the jailer. Provisioning fails with a <code>/dev/kvm missing</code> error on
        an M1/M2 or a pre-macOS-15 host. There, use the KVM CI workflow
        (<code>.github/workflows/microvm-integration.yml</code>), a remote Linux host, or the Docker backend
        (<code>RUNTIME_BACKEND=docker</code>), which stays the zero-setup macOS path.
      </p>

      <h2 id="what-you-get">What you get</h2>
      <table>
        <thead>
          <tr><th></th><th>Real Firecracker (this page)</th><th>Stub scheduler (default)</th></tr>
        </thead>
        <tbody>
          <tr><td>Isolation</td><td>Firecracker microVM on KVM</td><td>none: nothing is spawned</td></tr>
          <tr><td>Placement</td><td>real VMs you can exec into, pause, resume and fork</td><td>faked: a generated vm id placed on node <code>node-stub</code> / zone <code>az-stub</code></td></tr>
          <tr><td>Setup</td><td>Lima guest, runtime-manager built inside it</td><td>none</td></tr>
        </tbody>
      </table>
      <p>
        Without <code>LANTERN_SCHEDULER_GRPC_ADDR</code> the control-plane uses a stub scheduler client, and without{" "}
        <code>LANTERN_DEFAULT_MANAGER_ADDR</code> the scheduler keeps a log-only dialer. Both are fine for dashboard
        work and are rejected in production.
      </p>

      <h2 id="setup">Setup</h2>
      <p>
        From the repo on the Mac (it must live under your home directory, which the VM mounts read-only at the same
        path):
      </p>
      <pre><code>{`brew install lima
make lima-up           # create/start "firecracker-dev"; verify /dev/kvm, firecracker, jailer; install guest build deps
make lima-e2e          # build harness + manager + image in the VM, run the jailed lifecycle e2e, print the timing table
make lima-broker-e2e   # broker egress mode (ADR 0026): no NIC, vsock-only, credential injection`}</code></pre>
      <table>
        <thead>
          <tr><th>Target</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><code>make lima-up</code></td><td>Creates the VM from <code>firecracker-dev.yaml</code> if absent, starts it if stopped, does nothing if running. Fails fast on M1/M2 or macOS older than 15.</td></tr>
          <tr><td><code>make lima-image</code></td><td>Builds <code>vmlinux</code> + <code>rootfs.ext4</code> with the current harness as PID 1. Cached at <code>~/.cache/lantern-lima/image</code> in the VM; rebuilt only when the harness binary or <code>build-image.sh</code> changes.</td></tr>
          <tr><td><code>make lima-e2e</code></td><td><code>lima-image</code>, then builds the runtime-manager and runs <code>infra/firecracker/integration-test.sh</code> jailed with <code>EXPECT_VENDSECRET=1</code>: boot, snapshot, stop, restore, fork ×3. Timing table saved to <code>~/.cache/lantern-lima/timing/lifecycle-timing.md</code> in the VM.</td></tr>
          <tr><td><code>make lima-broker-e2e</code></td><td>Same build, then <code>infra/firecracker/broker-e2e.sh</code>. Needs outbound HTTPS to httpbin.org.</td></tr>
          <tr><td><code>make lima-down</code></td><td>Stops the VM.</td></tr>
          <tr><td><code>make lima-clean</code></td><td>Drops the VM&apos;s cached cargo target and microVM image.</td></tr>
        </tbody>
      </table>
      <p>
        Both e2e targets fail if a run leaves a firecracker process, snapshot directory or jail behind. If another run
        already holds the manager port (<code>:50054</code>, broker <code>:51054</code>) they wait for it, up to{" "}
        <code>LIMA_PORT_WAIT_SECS</code> (default 1800), instead of killing it. Builds refuse to start when the VM disk
        is over <code>LIMA_DISK_MAX_PCT</code> (default 85%); <code>make lima-clean</code> frees the caches. All build
        output goes to <code>~/.cache/lantern-lima</code> in the VM, never into the repo.
      </p>

      <h2 id="manual">Manual steps</h2>
      <p>What the targets automate, for debugging. Run them yourself only when a target fails and you need to see why.</p>

      <h3 id="start-guest">Start the Lima guest</h3>
      <pre><code>{`limactl start infra/lima/firecracker-dev.yaml   # creates "firecracker-dev"
limactl shell firecracker-dev                   # /dev/kvm exists in here`}</code></pre>

      <h3 id="smoke-boot">Smoke-boot a microVM</h3>
      <p>Inside the guest, with the official Firecracker CI artifacts (v1.15.1 kernel series):</p>
      <pre><code>{`mkdir -p ~/fc-demo && cd ~/fc-demo
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.15/aarch64/vmlinux-5.10.245
curl -sO http://spec.ccfc.min.s3.amazonaws.com/firecracker-ci/v1.15/aarch64/ubuntu-22.04.ext4
cat > vm.json <<'EOF'
{
  "boot-source": {"kernel_image_path": "vmlinux-5.10.245", "boot_args": "keep_bootcon console=ttyS0 reboot=k panic=1 pci=off"},
  "drives": [{"drive_id": "rootfs", "path_on_host": "ubuntu-22.04.ext4", "is_root_device": true, "is_read_only": false}],
  "machine-config": {"vcpu_count": 2, "mem_size_mib": 512}
}
EOF
firecracker --no-api --config-file vm.json   # boots to a root login on ttyS0`}</code></pre>
      <p>On an M4 Max this boots Ubuntu 22.04 to login in about 1.6 s.</p>

      <h3 id="lifecycle-test">Run the lifecycle test</h3>
      <p>
        The repo is mounted read-only at the same host path inside the guest. The test boots a VM, then snapshots,
        stops and restores it, forks three copies and prints timings. Inside the guest:
      </p>
      <pre><code>{`cd /path/to/repo

# Build deps (first time only)
sudo apt-get install -y musl-tools e2fsprogs jq curl protobuf-compiler
rustup target add aarch64-unknown-linux-musl

# The repo is read-only in the guest: build into a cache under ~
TARGET=~/.cache/lantern-lima/target

# Harness (musl, static)
cargo build --release --bin lantern-harness --target aarch64-unknown-linux-musl \\
  --manifest-path services/harness/Cargo.toml --target-dir "$TARGET"
HARNESS_BIN="$TARGET/aarch64-unknown-linux-musl/release/lantern-harness"

# Kernel + rootfs (sudo for loop-mount; harness passed via env)
sudo FC_HARNESS_BIN="$HARNESS_BIN" \\
  bash infra/firecracker/build-image.sh /tmp/fc-image

# Jail root for the fork step
sudo mkdir -p /srv/jailer

# Runtime-manager
cargo build --release --manifest-path services/runtime-manager/Cargo.toml --target-dir "$TARGET"
MANAGER_BIN="$TARGET/release/lantern-runtime-manager"

# The test (root: TAP + firecracker + loop devices)
sudo \\
  FC_KERNEL_PATH=/tmp/fc-image/vmlinux \\
  FC_ROOTFS_PATH=/tmp/fc-image/rootfs.ext4 \\
  RUNTIME_BACKEND=firecracker \\
  LANTERN_RUNTIME_BACKEND=firecracker \\
  MANAGER_BIN="$MANAGER_BIN" \\
  EXPECT_VENDSECRET=1 \\
  FIRECRACKER_JAILER_PATH=/usr/local/bin/jailer \\
  FIRECRACKER_JAILER_UID=123 \\
  FIRECRACKER_JAILER_GID=100 \\
  FIRECRACKER_CHROOT_BASE=/srv/jailer \\
  LIFECYCLE_TIMING_DIR=/tmp/fc-timing \\
  bash infra/firecracker/integration-test.sh

cat /tmp/fc-timing/lifecycle-timing.md`}</code></pre>
      <p>
        The fork step runs only when <code>FIRECRACKER_JAILER_PATH</code> points at the jailer (the Lima provision
        script installs it at <code>/usr/local/bin/jailer</code>; being on <code>PATH</code> is not enough, because the
        manager must be started with it). Without it the test prints{" "}
        <code>[integration] SKIP: fork test SKIPPED</code> and still passes.
      </p>

      <h3 id="cleanup">Clean up</h3>
      <pre><code>{`limactl stop firecracker-dev && limactl delete firecracker-dev`}</code></pre>

      <h2 id="connect">Point Lantern at it</h2>
      <p>
        Build and run the runtime-manager <em>inside</em> the guest (it needs <code>/dev/kvm</code>) with{" "}
        <code>RUNTIME_BACKEND=firecracker</code>; it listens on <code>0.0.0.0:50054</code> by default
        (<code>LISTEN_ADDR</code>). Then, on the Mac, point the control-plane and scheduler at it through the Lima
        port forward. These are the variables the stack already reads; the values assume the manager is reachable at{" "}
        <code>localhost:50054</code>:
      </p>
      <table>
        <thead>
          <tr><th>Env var</th><th>Set on</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td><code>LANTERN_SCHEDULER_GRPC_ADDR</code></td><td>control-plane</td><td><code>localhost:50055</code></td></tr>
          <tr><td><code>LANTERN_DEFAULT_MANAGER_ADDR</code></td><td>scheduler</td><td><code>localhost:50054</code></td></tr>
          <tr><td><code>LANTERN_NODE_ADDR_&lt;NODE&gt;</code></td><td>scheduler</td><td><code>host:port</code>, only when the scheduler picks a named node whose address is not discoverable</td></tr>
        </tbody>
      </table>
      <p>
        The repo does not spell out the forward end to end: <code>firecracker-dev.yaml</code> defines no explicit{" "}
        <code>portForwards</code> and <code>infra/lima/README.md</code> only says to use &quot;the Lima port
        forward&quot;. Confirm that <code>localhost:50054</code> reaches the manager before debugging anything else.
      </p>
      <p>
        Dev setups without a shared service token warn and allow unauthenticated gRPC; production requires{" "}
        <code>LANTERN_GRPC_SERVICE_TOKEN</code> on every hop. See <Link href="/runtime/isolation">Isolation tiers</Link>{" "}
        for the other backends.
      </p>

      <h2 id="verify">Verify it works</h2>
      <ul>
        <li>In the guest, <code>/dev/kvm</code> exists and <code>firecracker --version</code> prints v1.15.1.</li>
        <li>The smoke-boot reaches a root login on <code>ttyS0</code>.</li>
        <li><code>make lima-e2e</code> ends with <code>ALL ASSERTIONS PASSED</code>, including the fork step, and prints the timing table.</li>
        <li>With the stack pointed at the guest, a scheduled VM&apos;s node is not <code>node-stub</code> and <code>GET /v1/runtime/vms/&#123;id&#125;</code> shows it running.</li>
      </ul>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <table>
        <thead>
          <tr><th>Symptom</th><th>Cause and fix</th></tr>
        </thead>
        <tbody>
          <tr><td><code>FATAL: /dev/kvm missing</code> during provisioning</td><td>Mac is M1/M2 or older than macOS 15. Use CI, a remote Linux host, or <code>RUNTIME_BACKEND=docker</code>.</td></tr>
          <tr><td>Fork step prints <code>SKIP: fork test SKIPPED</code> (manual run)</td><td><code>FIRECRACKER_JAILER_PATH</code> unset. Set it to <code>/usr/local/bin/jailer</code> (<code>make lima-e2e</code> sets it for you).</td></tr>
          <tr><td>Build refuses to start: VM disk over the limit</td><td><code>make lima-clean</code>, or raise <code>LIMA_DISK_MAX_PCT</code>.</td></tr>
          <tr><td>An e2e target sits waiting on <code>:50054</code></td><td>Another manager run is using the port in the VM. It waits up to <code>LIMA_PORT_WAIT_SECS</code>; check <code>ss -ltnp | grep 50054</code> in the guest.</td></tr>
          <tr><td>First exec after a restore takes about 3 s</td><td>The manager holds it until the restored harness re-identifies and heartbeats; the guest work is slow under nested virtualization. See <Link href="/runtime/sandbox-lifecycle#snapshot-cost">Sandbox lifecycle</Link>.</td></tr>
          <tr><td>Node shows <code>node-stub</code></td><td><code>LANTERN_SCHEDULER_GRPC_ADDR</code> is unset on the control-plane, so its stub scheduler client fakes placement.</td></tr>
        </tbody>
      </table>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>Nested virtualization is for development. Lima timings are indicative, not bare-metal numbers.</li>
        <li>The examples are aarch64 (Apple Silicon) only.</li>
        <li>The repo mount is read-only, so build outputs land inside the guest.</li>
        <li>Not a supported production topology.</li>
      </ul>
      <p>
        Related: <Link href="/runtime/sandbox-lifecycle">Sandbox lifecycle</Link>,{" "}
        <Link href="/runtime/egress">Egress and credentials</Link>.
      </p>
    </>
  );
}
