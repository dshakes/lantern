# Demo 03 — stateful-research

A long-running research agent that maintains a workspace across invocations.
Proves the **HA + state plane** — snapshot, restore, drain, reschedule.

**Isolation:** `devcontainer` (long-lived pod + PVC + Firecracker snapshot
support for live migration).

## What it does

1. Reads `{"topic": "...", "max_steps": 5}` from stdin.
2. Writes a running `state.json` to `./workspace/` (PVC-backed).
3. Loops: think → take a note → save → sleep 2s. Repeats `max_steps` times.
4. Responds to `SIGUSR1` (harness snapshot signal) by flushing state and
   writing `/run/lantern/snapshot.ready`. The harness then triggers
   Firecracker to take a microVM snapshot.
5. On resume from snapshot: the workload sees `LANTERN_RESTORE_HINT` set,
   loads `state.json`, and continues from where it left off.

## Run it

```bash
docker build -t lantern/demos/stateful-research:latest examples/headless-agents/03-stateful-research

lantern run examples/headless-agents/03-stateful-research/agent.yaml \
  --input '{"topic": "Firecracker snapshots", "max_steps": 10}' \
  --follow

# In another terminal — drain the node mid-run:
lantern node drain $(lantern node list -o name)

# Watch the dashboard at localhost:3000/runtime — you'll see:
#   * state: running → draining → snapshotting → terminated  (on the old node)
#   * state: pending → spawning → running  (on a new node, with restore_snapshot_id set)
#   * the workload picks up at step N, not step 1
```

## What this proves

- **Snapshot integrity**: the SHA-256 of the snapshot file is verified
  before restore. If it fails, the scheduler cold-boots instead and
  flags the snapshot for forensics.
- **Snapshot retention** (per ADR 0007): the last 3 snapshots per
  `(agent_version_id, vm_id)` are kept for 7 days.
- **Drain semantics**: when a node enters `draining=true` (manual,
  K8s NoSchedule, or scheduler-initiated for upgrade), running VMs
  get a `HeartbeatAck.snapshot=true` push. They have N seconds to
  flush + ack; after the deadline, they're force-snapshotted (some
  in-flight work may be lost on non-idempotent workloads — flagged in
  audit as `snapshot.forced`).
- **State portability**: PVC snapshot is taken at the same point as the
  microVM snapshot. The restore on a different node mounts the PVC
  snapshot first, then restores the microVM. Result: file-system state
  + process memory are consistent.

## Caveats

- `devcontainer` is the most expensive isolation class — each one
  holds a persistent pod + PVC. Use it only when state-across-calls is
  genuinely required.
- Set `idempotent: false` in the spec so the scheduler doesn't try to
  preempt + retry mid-workspace mutation.
