import Link from "next/link";
import { Concept } from "../../_components/Concept";

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
          <tr><th></th><th>Real Firecracker (this page)</th><th>Stub dialer (default)</th></tr>
        </thead>
        <tbody>
          <tr><td>Isolation</td><td>Firecracker microVM on KVM</td><td>none: nothing is spawned</td></tr>
          <tr><td>VM ids</td><td>real VMs you can exec into, pause, resume and fork</td><td>synthesized (<code>node-stub</code>/<code>az-stub</code>)</td></tr>
          <tr><td>Setup</td><td>Lima guest, runtime-manager built inside it</td><td>none</td></tr>
        </tbody>
      </table>
      <p>
        Without <code>LANTERN_SCHEDULER_GRPC_ADDR</code> the control-plane uses a stub scheduler client, and without{" "}
        <code>LANTERN_DEFAULT_MANAGER_ADDR</code> the scheduler keeps a log-only dialer. Both are fine for dashboard
        work and are rejected in production.
      </p>

      <h2 id="setup">Manual setup</h2>
      {/* LIMA-MAKE: swap this section for the make lima-* targets when ga/lima-make merges */}
      <p><em>A one-command setup is coming; until then these are the manual steps.</em></p>

      <h3 id="start-guest">Start the Lima guest</h3>
      <pre><code>{`brew install lima
limactl start infra/lima/firecracker-dev.yaml   # creates "firecracker-dev"
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

# Harness (musl, static)
cargo build --release --target aarch64-unknown-linux-musl \\
  --manifest-path services/harness/Cargo.toml
HARNESS_BIN="$PWD/services/harness/target/aarch64-unknown-linux-musl/release/lantern-harness"

# Kernel + rootfs (sudo for loop-mount; harness passed via env)
sudo FC_HARNESS_BIN="$HARNESS_BIN" \\
  bash infra/firecracker/build-image.sh /tmp/fc-image

# Runtime-manager
cargo build --release --manifest-path services/runtime-manager/Cargo.toml
MANAGER_BIN="$PWD/services/runtime-manager/target/release/lantern-runtime-manager"

# The test (root: TAP + firecracker + loop devices)
sudo \\
  FC_KERNEL_PATH=/tmp/fc-image/vmlinux \\
  FC_ROOTFS_PATH=/tmp/fc-image/rootfs.ext4 \\
  RUNTIME_BACKEND=firecracker \\
  LANTERN_RUNTIME_BACKEND=firecracker \\
  MANAGER_BIN="$MANAGER_BIN" \\
  EXPECT_VENDSECRET=1 \\
  LIFECYCLE_TIMING_DIR=/tmp/fc-timing \\
  bash infra/firecracker/integration-test.sh

cat /tmp/fc-timing/lifecycle-timing.md`}</code></pre>
      <p>
        The fork step needs the jailer, which the Lima provision script installs next to <code>firecracker</code>. If
        it is missing the test prints <code>[SKIP]</code>; set <code>FIRECRACKER_JAILER_PATH</code> to override.
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
        <li>The lifecycle test ends with PASS lines and a timing table in <code>/tmp/fc-timing/lifecycle-timing.md</code>.</li>
        <li>With the stack pointed at the guest, a scheduled VM returns a <code>vm_id</code> that is not a stub (<code>node-stub</code>) and <code>GET /v1/runtime/vms/&#123;id&#125;</code> shows it running.</li>
      </ul>

      <h2 id="troubleshooting">Troubleshooting</h2>
      <table>
        <thead>
          <tr><th>Symptom</th><th>Cause and fix</th></tr>
        </thead>
        <tbody>
          <tr><td><code>FATAL: /dev/kvm missing</code> during provisioning</td><td>Mac is M1/M2 or older than macOS 15. Use CI, a remote Linux host, or <code>RUNTIME_BACKEND=docker</code>.</td></tr>
          <tr><td>Fork step prints <code>[SKIP]</code></td><td>Jailer not found. Set <code>FIRECRACKER_JAILER_PATH</code>.</td></tr>
          <tr><td>First exec after a restore is slow (about 4 s)</td><td>The in-guest exec channel re-establishes after resume; see <Link href="/runtime/sandbox-lifecycle">Sandbox lifecycle</Link>.</td></tr>
          <tr><td>Stubbed VM ids (<code>node-stub</code>)</td><td>The scheduler env vars above are unset, so the stub dialer is active.</td></tr>
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
