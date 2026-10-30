# Runtime Latency Benchmarks

Measured with `scripts/bench/runtime-latency.sh` on a Linux host with KVM access
and a live PAL stack. All times are wall-clock milliseconds; RSS delta is
host-side `/proc/meminfo` MemUsed change (an upper bound, not a per-fork
isolated measurement).

**These numbers are NOT from real hardware yet.**  Run the harness on a KVM host
to populate them.

<!-- results-start -->

_Results placeholder — run `scripts/bench/runtime-latency.sh` on a KVM host to populate._

<!-- results-end -->

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

## Running the benchmark

```bash
# Prerequisites: Linux + KVM, running PAL stack
export PAL_API_URL=http://localhost:8080
export PAL_API_TOKEN=<your-admin-token>
bash scripts/bench/runtime-latency.sh --iterations 10
```

The script outputs JSON to stdout.  Pipe to `jq .` for formatted output.
Results are also written as a markdown table to this file between the
`<!-- results-start -->` / `<!-- results-end -->` markers.

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

Cold boot (Spawn, no restore) is not in the timing table because the test
begins timing after the boot assertions pass.  On bare Linux hardware
Firecracker cold-boots a musl guest in ~125 ms; nested virt in Lima adds
~2–4 s.

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
