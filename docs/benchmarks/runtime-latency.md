# Runtime Latency Benchmarks

Measured with `scripts/bench/runtime-latency.sh` on a Linux host with KVM access
and a live Lantern stack. All times are wall-clock milliseconds; RSS delta is
host-side `/proc/meminfo` MemUsed change (an upper bound, not a per-fork
isolated measurement).

**These numbers are NOT from real hardware yet.**  Run the harness on a KVM host
to populate them.

<!-- results-start -->

_Results placeholder — run `scripts/bench/runtime-latency.sh` on a KVM host to populate._

<!-- results-end -->

## What the shared-memory fork optimization changes

Before this optimization, `fork N` performed `N` full byte-copies of the guest
memory file (`LANTERN_VM_MEM_GiB` × N GiB of I/O).  After:

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
# Prerequisites: Linux + KVM, running Lantern stack
export LANTERN_API_URL=http://localhost:8080
export LANTERN_API_TOKEN=<your-admin-token>
bash scripts/bench/runtime-latency.sh --iterations 10
```

The script outputs JSON to stdout.  Pipe to `jq .` for formatted output.
Results are also written as a markdown table to this file between the
`<!-- results-start -->` / `<!-- results-end -->` markers.
