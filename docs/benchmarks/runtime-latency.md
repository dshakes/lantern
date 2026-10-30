# Runtime Latency Benchmarks

Real Firecracker microVMs, measured on 2026-10-29 with
`scripts/bench/microvm-latency.sh` (`make lima-bench`). Raw samples (one row
per measurement) and the computed summary are in
[`results/2026-10-29-lima-m4max/`](results/2026-10-29-lima-m4max/).

**Read this first: these numbers come from nested virtualization on a laptop.**
The microVMs run under KVM inside a Lima VM, which itself runs on Apple
Virtualization.framework. Guest CPU work is much slower there than on
bare-metal Linux, so cold boot and harness reconnect are slow here. Expect
bare-metal Linux/KVM to be faster, but we have not measured it yet. Use these
numbers to compare changes on the same host, not as production SLOs.

### Hardware and software

| | |
|---|---|
| Host | MacBook Pro `Mac16,6`, Apple M4 Max (12P + 4E cores), 128 GiB, macOS 26.6 |
| Hypervisor stack | Lima 2.1.2 (`vz`), nested virtualization → KVM in the Lima guest |
| Lima VM (`firecracker-dev`) | 4 vCPU, 8 GiB, Ubuntu 24.04.4 LTS, kernel 6.8.0-136-generic, ext4 root (no reflink) |
| Firecracker / jailer | v1.15.1 / v1.15.1, jailed mode (`/srv/jailer`, uid 123:100) |
| microVM | 1 vCPU, 128 MiB, aarch64 guest kernel 5.10.245, 64 MiB rootfs, `lantern-harness` as PID 1 |
| runtime-manager | release build from `perf/real-benchmarks` (master `ed00dc95` merged), mTLS on |

### Results (ms, wall clock, 20 iterations unless noted)

| Operation | n | p50 | p95 | p99 | min | max |
|---|--:|--:|--:|--:|--:|--:|
| gRPC client floor (`grpcurl` → NotFound) | 20 | 18 | 25 | 26 | 17 | 26 |
| **Cold boot**: Spawn RPC returns | 20 | 143 | 157 | 357 | 126 | 357 |
| **Cold boot**: Spawn → first exec answered | 20 | 12 300 | 18 101 | 19 430 | 11 469 | 19 430 |
| **Exec round-trip** (`shell_exec true`, warm VM) | 100 | 115 | 190 | 235 | 26 | 236 |
| Snapshot RPC (pause guest, write mem + disk, resume) | 20 | 702 | 847 | 920 | 665 | 920 |
| Stop RPC | 20 | 198 | 210 | 211 | 191 | 211 |
| **Pause** (snapshot + stop) | 20 | 905 | 1 057 | 1 130 | 857 | 1 130 |
| **Restore**: Spawn{restore} RPC returns | 20 | 131 | 155 | 195 | 121 | 195 |
| **Resume**: restore → first exec answered | 20 | 2 491 | 2 720 | 2 737 | 2 195 | 2 737 |
| **Fork N=1**: Spawn RPC returns | 20 | 151 | 182 | 211 | 142 | 211 |
| **Fork N=1**: fork → first exec answered | 20 | 2 722 | 2 893 | 2 940 | 2 481 | 2 940 |
| **Fork N=10**: all 10 Spawns return (16 in flight) | 20 | 562 | 646 | 660 | 415 | 660 |
| Fork N=10: each Spawn | 200 | 473 | 579 | 631 | 222 | 637 |
| **Fork N=50**: all 50 Spawns return (16 in flight) | 20 | 7 695 | 8 896 | 9 239 | 7 065 | 9 239 |
| Fork N=50: each successful Spawn | 990 | 1 992 | 4 225 | 4 690 | 301 | 5 144 |
| Broker mode: exec baseline (`shell_exec true`) | 20 | 53 | 194 | 259 | 20 | 259 |
| Broker mode: allowed HTTPS `http_fetch` (guest → vsock → broker → example.com) | 20 | 94 | 188 | 375 | 69 | 375 |
| Broker mode: denied `http_fetch` (broker refuses, no upstream dial) | 20 | 32 | 102 | 396 | 23 | 396 |
| Host `curl` to the same upstream (reference) | 20 | 49 | 59 | 193 | 42 | 193 |

Snapshot size: 201 MB (128 MiB guest memory + the 64 MiB disk captured with it).
Percentiles are nearest-rank. With n=20, p95 is the 19th-fastest sample and p99
is the maximum.

### How to read it

- **Every number includes about 18 ms of client overhead.** Each sample is one
  `grpcurl` process (start + mTLS handshake). Subtract the floor to get the time
  spent in the manager. For example, an exec takes about 97 ms in the manager
  and guest.
- **The RPC times are fast. Waiting for the guest is slow.** Spawn, restore and
  fork RPCs return in 130–150 ms: that covers the jail, the TAP device, the
  Firecracker process and `PUT /snapshot/load`. The "first exec answered" rows
  are what a user feels. They add the guest's own work: kernel boot, harness
  start and mTLS heartbeat on cold boot, or re-identify and reconnect after a
  restore. That work is CPU-bound and runs slowly under nested virtualization
  (see the per-step breakdown further down).
- **Cold boot to first exec is about 12 s here.** Firecracker's published
  cold boot for a minimal guest is about 125 ms on bare metal. Most of the gap
  is the harness's boot work (cert drive, `spawn.json`, mTLS) running on a
  starved vCPU.
- **Resume beats cold boot by about 5×** (2.5 s vs 12.3 s to first exec). This
  is the case for pause/resume and idle-suspend.
- **Fork N=50 had 10 failed spawns out of 1 000 (1%).** In an earlier run
  whose manager log we inspected, the failure was Firecracker's API socket
  refusing the connection (`PUT /snapshot/load: Connection refused`) while 16
  forks started at once on 4 vCPUs. The log for this run's failures was not
  kept. Fork N=1 and N=10 had no failures in 220 spawns. Failures are counted, not hidden:
  `fork_50_spawn_failures` in the raw CSV.
- **Fork readiness is measured only for N=1.** On this host, 10 or more forks
  resumed at the same time never all answered an exec, even after waiting
  5 minutes. During that time the Lima VM showed about 97% guest CPU time with
  10 runnable threads, and the forks re-identified only a few minutes later, if
  at all. 3 concurrent forks took about 25–30 s to be ready, compared with
  2.7 s for one. Treat this as **an open finding, not a property of fork**: we
  do not know yet whether the restored guests spin (a harness or kernel
  busy-loop after restore) or whether 1-vCPU guests are simply starved on a
  4-vCPU nested host. It needs a run on bare-metal KVM. Until then the fork
  N=10/50 rows measure spawn latency only.
- **Broker egress overhead is small next to the network.** An allowed HTTPS
  fetch through the broker took 94 ms (p50). The same request from the host
  took 49 ms. The extra ~45 ms covers the guest tool call, vsock, and the
  broker's policy check and upstream dial. A denied request (32 ms) never
  leaves the host, which shows how much of that is the guest + vsock + policy
  path. Note that `shell_exec` in broker mode (53 ms) is faster than in guest
  mode (115 ms): broker mode runs exec over host-initiated vsock, while guest
  mode dials the harness over its TAP link.
- **Disk staging was a full byte copy.** The VM's ext4 root has no reflink
  (FICLONE), so each restore/fork copies the 64 MiB rootfs. Guest memory is
  still hard-linked (MAP_PRIVATE CoW). On XFS/btrfs, fork spawn should be
  faster.

### Root-cause findings (fix/microvm-readiness)

Two of the slow paths above were traced to root cause on this same Lima VM by
capturing the guest serial console (the manager logs it) and the harness's own
per-phase log:

- **Cold boot was CRNG-starved. FIXED.** The guest console showed
  `random: crng init done` only at guest-time **9.3 s**, and `jitterentropy:
  Initialization failed` — the Firecracker CI guest kernel has no usable entropy
  source, so the CRNG seeds only from scarce interrupt entropy. The harness's
  first blocking `getrandom()` (the mTLS handshake) therefore stalled: its own
  log went silent for **~5.2 s** between "mTLS client cert loaded" and the first
  heartbeat. (`bootenv::report_entropy_source` reads `/dev/urandom`, which never
  blocks pre-init, so it reported "ok" — a false all-clear; rustls/ring use the
  blocking `getrandom` syscall.) **Fix:** the Firecracker backend now attaches a
  virtio-rng device (`PUT /entropy`) at boot (the CI guest kernel ships the
  `virtio_rng` driver). `crng init done` moves to **2.6 s**, the harness
  start→first-heartbeat gap drops from ~5.9 s to **0.72 s**, and cold-boot
  Spawn→first-exec drops from **~11.4 s to ~5.7 s** (3-sample p50 5.9 s). The
  residual ~5 s is the guest kernel's own boot under nested virt (cert-drive
  ext4 mount lands at guest-time ~6.5 s), unrelated to entropy. Resume/fork
  inherit the device from the snapshot; fork N=1 readiness improved ~2.7 s →
  ~1.9 s as a side effect.

- **Fork N≥10 concurrent readiness is resource contention, NOT a spin or a
  reconnect storm.** With the entropy fix in place, N=10 still fails (10/10 never
  answered exec in 20 s). The manager log for that run rules out the leading
  hypotheses: `crng init done` fires only once (the source cold boot), so the
  restored guests are **not** entropy-blocked; there were **0** superseded-cert
  heartbeat drops and only 2 heartbeat streams ever opened, so it is **not** a
  stale-identity reconnect storm. Instead the restored guests are stuck mid
  re-identify with **no errors**: of 10 forks, 7 noticed the swapped cert drive
  but only 1 finished adopting the new identity, and 9 never re-opened their
  heartbeat stream. Combined with the super-linear scaling (N=1 ≈ 1.9 s, N=3 ≈
  25–30 s, N=10 never), the cause is the aggregate CPU/IO of resuming many VMs at
  once on a 4-vCPU nested host — the manager's per-fork work (cert issuance +, on
  this no-reflink ext4, a 64 MiB rootfs byte-copy per fork) plus each 1-vCPU
  guest's re-identify (ext4 mount + two mTLS reconnects) all contend for the same
  4 vCPUs, so individual guests cannot finish re-identify inside the window. This
  is environmental, not a harness/manager bug; the levers are to stagger
  concurrent resumes (lower `LANTERN_FORK_CONCURRENCY`), reflink the rootfs
  (XFS/btrfs), push the new identity over vsock to skip the per-fork ext4 mount,
  and confirm on bare-metal KVM. No code change is made for fork here.

### Reproduce

```bash
make lima-up          # once: creates the firecracker-dev VM (M3+ Mac, macOS 15+)
make lima-bench       # ITERATIONS=20 FORK_SIZES="1 10 50" by default
# results land in ./bench-out/{samples.csv,summary.json,summary.md}
```

On any Linux/KVM host, run the script directly as root with `FC_KERNEL_PATH`,
`FC_ROOTFS_PATH`, `MANAGER_BIN` and (for fork) `FIRECRACKER_JAILER_PATH` set.
See the header of `scripts/bench/microvm-latency.sh` for every knob. The script
drives the runtime-manager's gRPC API directly, so it needs no control plane,
Postgres or scheduler. It stops every VM it spawns, deletes its snapshots, and
`make lima-bench` fails if a firecracker process, jail or snapshot dir is left
behind. The broker phase needs outbound HTTPS from the VM, because the broker
refuses private IPs and non-443 ports.

For the 2026-10-29 run, the broker phase was re-run on its own
(`ONLY_BROKER=1`) after one broker exec failed late in the full run. That
failure was not reproduced (0/20). The run was then changed to count failures
instead of aborting. The CSV contains the guest-mode phase of the full run plus
the broker re-run.

`scripts/bench/runtime-latency.sh` measures the same operations through the
REST API (`/v1/runtime/...`). It needs the full stack and has not been run on
real hardware.

## What the shared-memory fork optimization changes

Before this optimization, `fork N` performed `N` full byte-copies of the guest
memory file (`PAL_VM_MEM_GiB` × N GiB of I/O).  After:

- The snapshot store marks the `mem` artifact read-only (0444) after writing.
- `restore_after_tap` hard-links the read-only mem file into every fork's jail
  directory instead of copying it.
- Firecracker maps the linked file with `mem_backend backend_type: File`
  (already the default), which is `MAP_PRIVATE`.  Pages are shared via the host
  page cache until a guest write triggers copy-on-write.
- The per-fork disk I/O for the mem file drops from O(mem_size) to O(1).

Expected effect on the benchmark numbers:

| Metric | Sequential-copy baseline | Hard-link CoW |
|--------|--------------------------|---------------|
| fork 1 latency | mem_size / disk_bw | ≈ metadata ops only |
| fork N latency | N × mem_size / disk_bw | ≈ N × metadata ops |
| RSS Δ / fork | mem_size (new file) | 0 until first write |

## Fallback behavior

- **Cross-device (EXDEV):** if the snapshot store and the jail chroot are on
  different filesystems, `hard_link` returns `EXDEV`; the staging code falls back
  to a full byte-copy automatically.  This is logged at DEBUG level.
- **chmod failure:** if `make_mem_readonly` fails (unusual), `restore_with_identity`
  logs a WARN and falls back to the copy path for that restore.
- **Non-jailed bare Firecracker (`fc://` URIs):** the copy path is always used
  because bare restores share the source VM's host paths and file ownership is
  not known at staging time.

## Running the REST-API benchmark

The numbers at the top come from `make lima-bench` (see "Reproduce"). The
REST-API harness below measures the same operations through the control plane
and needs the whole stack running:

```bash
# Prerequisites: Linux + KVM, running PAL stack
export PAL_API_URL=http://localhost:8080
export PAL_API_TOKEN=<your-admin-token>
bash scripts/bench/runtime-latency.sh --iterations 10
```

The script outputs JSON to stdout (pipe it to `jq .`) and a markdown table to
stderr. It no longer edits this file.

---

## Lima / CI indicative results

Indicative timing for the Firecracker lifecycle operations exercised by
`infra/firecracker/integration-test.sh`.  Numbers are per-operation
wall-clock milliseconds as measured by the test script and emitted to the
`microvm-lifecycle-timing` CI artifact.

**Environment:** Lima VM (`infra/lima/firecracker-dev.yaml`) on Apple Silicon
M4 Max, macOS 15, nested KVM via Virtualization.framework. Guest: Ubuntu 24.04
LTS, 4 vCPU, 8 GiB RAM.  VM spec: 1 vCPU, 128 MiB RAM, musl harness as PID 1,
aarch64 vmlinux-5.10.245.  Run at: 2026-10-27T05:08:06Z (jailed mode,
`FIRECRACKER_JAILER_PATH=/usr/local/bin/jailer`, UID 123:100, chroot
`/srv/jailer`).

**These are measured values from a real Lima run** (nested-virt, aarch64,
indicative of dev-laptop performance — not bare-metal production numbers).

| step | duration_ms | notes |
|------|-----------:|-------|
| `shell_exec` | 1 393 | ExecTool round-trip after heartbeat bidi stream established |
| `write_file` | 265 | ExecTool write_file to /workspace |
| `snapshot` | 634 | 128 MiB mem snapshot to disk (134 MB written) |
| `stop` | 207 | graceful SendCtrlAltDel (aarch64 not supported) + SIGKILL fallback |
| `restore` | 138 | Spawn RPC turnaround (PUT /snapshot/load + PATCH /drives + PATCH /vm) |
| `read_file_after_restore` | 4 204 → **2 857** | before WP1: 2 ExecTool retries × 2 s wait. After WP1: one ExecTool held by the manager until the restored harness re-identifies — median of 5 runs, see below |
| `stop_before_fork` | 197 | Stop restored VM before fork test |
| `fork_spawn_1` | 131 | jailer: hard-link mem + per-VM rootfs copy + jail chroot setup |
| `fork_spawn_2` | 145 | |
| `fork_spawn_3` | 160 | |
| **total** | **7 474** | fork×3 included; see notes below |

**Hard-link inode proof (PR #295):** all 3 fork mem files shared inode 1354345
(link_count=4 = 1 source snapshot + 3 forks), confirming MAP_PRIVATE CoW is
active and each fork pays O(1) disk I/O for the 128 MiB mem file.

**`read_file_after_restore` after WP1 (fast restore)** — measured 2026-10-27,
same Lima VM, jailed mode, guest (TAP) egress. **Indicative only: nested virt.**

| run | 1 | 2 | 3 | 4 | 5 | p50 | max |
|-----|--:|--:|--:|--:|--:|----:|----:|
| first exec after restore (ms) | 2 571 | 3 053 | 2 847 | 2 924 | 2 857 | **2 857** | 3 053 |

The test now makes ONE ExecTool call with no retry loop. The manager holds it
(`PAL_HARNESS_READY_TIMEOUT_MS`, default 5 s) until the restored guest's
first cert-pinned heartbeat, then dispatches it. The fixed 2 s retry
quantization is gone, and so are the 1 s re-identify poll and the doubled
heartbeat backoff. The gate hard-fails above 3 500 ms and warns above 1 500 ms.

**Sub-second is not met on Lima.** The time left is CPU-bound guest work that
runs very slowly under nested virt, not waiting. One instrumented run (guest
clock, after restore):

| step | ms |
|------|---:|
| re-identify: mount cert drive, copy material, read `spawn.json`, unmount | ~600 |
| re-address eth0, egress rules, broker CA, identity swap | ~130 |
| old heartbeat stream noticed and torn down | ~150 |
| mTLS connect + handshake to the manager | ~480 |
| Heartbeat RPC + first heartbeat + ack | ~260 |
| manager → guest exec dial + `read_file` | ~320 |

The same mTLS connect takes ~430 ms at cold boot on this VM, so the slowness is
general to this VM, not caused by restore. On bare-metal KVM each of these
steps should take milliseconds, but that has not been measured. If Lima still
matters, the next levers are: skip the ext4 mount on the critical path (the
manager could push the new identity over vsock), and reuse TLS sessions on
reconnect.

---

## How to update this file

Run the lifecycle test inside the Lima guest or in CI and copy the real numbers
from `lifecycle-timing.md` into the table above:

```bash
# Inside the Lima guest after a successful run:
cat /tmp/fc-timing/lifecycle-timing.md
```

Replace the values above with the measured `duration_ms` from that output.

---

## What the numbers mean

| Operation | Firecracker mechanism | Latency driver |
|-----------|----------------------|----------------|
| cold boot | kernel decompress + initrd + PID 1 exec | vmlinux size, memory bus |
| snapshot | `PUT /snapshot/create` — guest paused, mem written to file | memory size × disk throughput |
| stop | `PUT /actions SendCtrlAltDel` + SIGKILL | guest ACPI handler / kernel shutdown |
| restore (Spawn RPC) | `PUT /snapshot/load` + `PATCH /drives/{certs,rootfs}` + `PATCH /vm Resumed` | mem file read + page fault warm-up |
| ExecTool ready | guest re-identify (≤ 250 ms poll, or at once when a manager stream dies) + mTLS heartbeat reconnect; the manager holds exec until the first pinned heartbeat | cert-drive mount + TLS handshake |
| ExecTool operation | vsock gRPC (harness) → tool exec → result | vsock latency + tool work |
| fork spawn | same as restore, new vm_id, per-VM rootfs copy | mem read + `cp` of rootfs file |

Cold boot (Spawn, no restore) is not in the integration-test timing table
because that test starts timing after the boot assertions pass. The benchmark
at the top measures it: the Spawn RPC returns in ~143 ms, and the first exec is
answered ~12.3 s after Spawn on Lima (nested virt). On bare Linux,
Firecracker cold-boots a minimal musl guest in ~125 ms. We have not measured
the harness's boot work on bare metal.

Snapshot size scales linearly with **dirty memory** at snapshot time (a
freshly-booted 128 MiB VM has a small working set; a VM that has run Python
code will be larger).  Restore latency scales with the **on-disk snapshot
size**, not the VM's configured memory limit.

## Tradeoffs

- **Unjailed per-VM rootfs copy** (added for COW isolation): adds ~5–50 ms
  per restore/fork for a typical 20–100 MiB rootfs ext4 image (`cp` on a
  tmpfs or fast NVMe).  Without this, writes from one restored VM are visible
  in every other VM that shares the same snapshot — a correctness issue, not
  just a latency one.  The fork_spawn timings (134–152 ms) include this copy.
- **Jailer chroot staging**: the jailer staging path copies rootfs + cert
  image into the per-VM chroot (`plan_jailed_snapshot_staging`), which has
  the same ~5–50 ms cost.  It runs in parallel with the Firecracker process
  spawn, so the observable latency is dominated by the binary exec time.
- **Memory backend**: `file` (default) is slower to restore than `uffd`
  (userfaultfd on-demand paging), but `uffd` requires kernel 5.14+ and
  `CAP_SYS_PTRACE`.  The CI runner uses `file`.
- **ExecTool channel warm-up**: the ~2–5 s delay before ExecTool is usable
  after a restore/fork is a harness reconnect latency, not a Firecracker
  property.  A ready-state signal from the heartbeat stream would eliminate
  the retry loop and reduce perceived restore latency from ~4 s to ~200 ms.
