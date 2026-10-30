import { useId, useState, type KeyboardEvent } from "react";
import "./interactive.css";
import { center, clip, type Pt, type Rect } from "./geometry";
import { SourceLinks } from "./SourceLinks";
import type { Src } from "./types";

// The sandbox VM state machine (VmState in runtime.proto) and every transition
// the scheduler drives. Click a state or a transition for its trigger, the API
// call, and what it guarantees.

const M = (p: string, l?: number): Src => ({ p, l });
const PROTO = "packages/proto/lantern/v1/runtime.proto";
const LC = "services/runtime-scheduler/internal/handlers/lifecycle.go";
const RL = "services/control-plane/internal/handlers/runtime_lifecycle.go";
const RT = "services/control-plane/internal/handlers/runtime.go";
const MAIN = "services/control-plane/cmd/server/main.go";

type State = { id: string; label: string; box: Rect; cls?: string; meaning: string; src: Src[] };
type Transition = {
  id: string; from: string; to: string; label: string; bend: number; bad?: boolean;
  trigger: string; api: string; guarantees: string[]; src: Src[];
};

const W = 130, H = 46;
const STATES: State[] = [
  { id: "PENDING", label: "PENDING", box: { x: 110, y: 40, w: W, h: H }, meaning: "Scheduler accepted the request, awaiting placement.", src: [M(PROTO, 42)] },
  { id: "SPAWNING", label: "SPAWNING", box: { x: 380, y: 40, w: W, h: H }, meaning: "Node assigned, bootstrapping. Also the state a resume or fork child is in while the manager restores it.", src: [M(PROTO, 43), M(LC, 230)] },
  { id: "RUNNING", label: "RUNNING", cls: "s-run", box: { x: 640, y: 40, w: W, h: H }, meaning: "The harness is reporting heartbeats. Holds one concurrent-VM quota slot.", src: [M(PROTO, 44)] },
  { id: "DRAINING", label: "DRAINING", box: { x: 640, y: 230, w: W, h: H }, meaning: "Graceful shutdown initiated. A pause in progress is persisted here with the scheduler:pausing marker, so a crash never reloads it as PAUSED.", src: [M(PROTO, 45), M(LC, 79)] },
  { id: "PAUSED", label: "PAUSED", cls: "s-paused", box: { x: 380, y: 230, w: W, h: H }, meaning: "Snapshotted and stopped. Holds no quota slot; resumable. Snapshot storage is still kept.", src: [M(PROTO, 48), M(LC, 10)] },
  { id: "FAILED", label: "FAILED", cls: "s-bad", box: { x: 110, y: 330, w: W, h: H }, meaning: "Spawn or health failure; the reason is in the StatusEvent.", src: [M(PROTO, 47)] },
  { id: "TERMINATED", label: "TERMINATED", box: { x: 640, y: 400, w: W, h: H }, meaning: "Resources released.", src: [M(PROTO, 46)] },
];

const TRANSITIONS: Transition[] = [
  {
    id: "schedule", from: "start", to: "PENDING", label: "schedule", bend: 0,
    trigger: "POST /v1/runtime/schedule with an AgentSpec.", api: "RuntimeScheduler.Schedule",
    guarantees: ["Over the tenant's concurrent-VM quota the control plane answers HTTP 402 and nothing is placed."],
    src: [M(MAIN, 787), M(RT, 1730), M(RT, 1814), M("services/runtime-scheduler/internal/handlers/scheduler_grpc.go", 114)],
  },
  {
    id: "place", from: "PENDING", to: "SPAWNING", label: "placed", bend: 0,
    trigger: "The placement engine picks a node: warm pool, region, fair share, cost, health.", api: "RuntimeManager.Spawn",
    guarantees: ["Placement is the only place that filters by capacity."],
    src: [M("services/runtime-scheduler/internal/placement/placement.go", 1), M("services/runtime-scheduler/internal/handlers/scheduler_grpc.go", 601)],
  },
  {
    id: "up", from: "SPAWNING", to: "RUNNING", label: "heartbeats", bend: -22,
    trigger: "Harness PID 1 boots and opens its 5 s heartbeat stream.", api: "RuntimeHarness.Heartbeat",
    guarantees: ["Each heartbeat carries has_active_exec and last_activity_unix_ms for the idle sweeper."],
    src: [M(PROTO, 44), M("services/harness/src/heartbeat.rs", 29)],
  },
  {
    id: "fail", from: "SPAWNING", to: "FAILED", label: "spawn fails", bend: 0, bad: true,
    trigger: "The manager cannot boot or restore the VM.", api: "StatusEvent { state: FAILED, reason }",
    guarantees: ["A failed fork child is reported individually and its quota slot released."],
    src: [M(PROTO, 47), M(LC, 380)],
  },
  {
    id: "drain", from: "RUNNING", to: "DRAINING", label: "pause · idle · delete", bend: -24,
    trigger: "POST /v1/runtime/vms/{id}/pause, the idle sweeper (idle longer than idle_timeout_secs), or DELETE /v1/runtime/vms/{id}.",
    api: "RuntimeScheduler.Pause → RuntimeManager.Snapshot, then Stop",
    guarantees: [
      "The snapshot id is persisted, then the VM is marked DRAINING, before Stop is sent.",
      "A per-VM lock serializes Pause, Resume, Fork and Terminate.",
      "Only RUNNING can be paused; pausing a PAUSED VM returns its existing snapshot.",
    ],
    src: [M(RL, 317), M(LC, 136), M(LC, 155), M(LC, 172), M("services/runtime-scheduler/internal/handlers/idle_sweeper.go", 96)],
  },
  {
    id: "paused", from: "DRAINING", to: "PAUSED", label: "snapshot + stop ok", bend: 0,
    trigger: "Stop succeeded on the node.", api: "StatusEvent { state: PAUSED }",
    guarantees: [
      "The quota slot is released by exactly one of the RPC or reconciliation (compare-and-set).",
      "An idle-suspended VM carries the reason \"auto-suspended (idle timeout)\".",
    ],
    src: [M(LC, 183), M("services/runtime-scheduler/internal/handlers/idle_sweeper.go", 228)],
  },
  {
    id: "stopfail", from: "DRAINING", to: "RUNNING", label: "stop failed", bend: -24, bad: true,
    trigger: "The manager could not stop the VM.", api: "Pause returns Unavailable",
    guarantees: ["The VM is restored to RUNNING and keeps its slot: it is still running on the node."],
    src: [M(LC, 174), M(LC, 176)],
  },
  {
    id: "term", from: "DRAINING", to: "TERMINATED", label: "drained", bend: 0,
    trigger: "DELETE /v1/runtime/vms/{id}?grace=… finished draining.", api: "RuntimeScheduler.Terminate",
    guarantees: ["Resources released on the node."],
    src: [M(MAIN, 791), M(PROTO, 215), M(PROTO, 46)],
  },
  {
    id: "resume", from: "PAUSED", to: "SPAWNING", label: "resume · auto-resume", bend: -24,
    trigger: "POST /v1/runtime/vms/{id}/resume, or an exec or file call on an idle-suspended VM.",
    api: "RuntimeScheduler.Resume → RuntimeManager.Spawn { restore_snapshot_id }",
    guarantees: [
      "Same vm_id, restored from its pause snapshot; the guest re-identifies as a new incarnation.",
      "Quota reserved atomically first: over the cap returns HTTP 402.",
      "A manually paused VM is never auto-resumed: exec answers 409 until you resume it.",
    ],
    src: [M(LC, 200), M(LC, 223), M(LC, 436), M(RL, 250), M(RL, 266), M(RL, 293), M("services/harness/src/reidentify.rs", 1)],
  },
  {
    id: "resumefail", from: "SPAWNING", to: "PAUSED", label: "restore fails", bend: -24, bad: true,
    trigger: "The manager could not restore the snapshot.", api: "Resume returns Unavailable",
    guarantees: ["The VM stays PAUSED and resumable; the reserved slot is given back."],
    src: [M(LC, 233)],
  },
  {
    id: "fork", from: "RUNNING", to: "SPAWNING", label: "fork ×N (children)", bend: -22,
    trigger: "POST /v1/runtime/vms/{id}/fork { count } on a RUNNING or PAUSED source.",
    api: "RuntimeScheduler.Fork → Snapshot { keep_running } + Spawn ×N",
    guarantees: [
      "count is 1..PAL_MAX_FORK_COUNT (default 100, ceiling 1000).",
      "Quota for all N children is reserved up front, all-or-nothing, before any snapshot I/O.",
      "Each child gets a new vm_id and its own agent identity; the source keeps running.",
      "Children hard-link the read-only memory file: MAP_PRIVATE copy-on-write. Lima nested-virt, indicative: 131, 145 and 160 ms per fork spawn.",
    ],
    src: [M(RL, 368), M(LC, 276), M(LC, 313), M(LC, 319), M(LC, 342), M("services/runtime-manager/src/backends/firecracker.rs", 2230), M("docs/benchmarks/runtime-latency.md", 90)],
  },
];

const START: Rect = { x: 8, y: 55, w: 16, h: 16 };
const byId = new Map(STATES.map((s) => [s.id, s.box]));
const boxOf = (id: string) => (id === "start" ? START : byId.get(id)!);

function curve(t: Transition) {
  const a = boxOf(t.from), b = boxOf(t.to);
  const [ax, ay] = center(a), [bx, by] = center(b);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  // Control point: the midpoint pushed `bend` px along the normal.
  const c: Pt = [(ax + bx) / 2 + (-(by - ay) / len) * t.bend, (ay + by) / 2 + ((bx - ax) / len) * t.bend];
  const p0 = clip(a, c);
  const p2 = clip(b, c);
  const mid: Pt = [0.25 * p0[0] + 0.5 * c[0] + 0.25 * p2[0], 0.25 * p0[1] + 0.5 * c[1] + 0.25 * p2[1]];
  // Labels sit beside vertical-ish arrows, above horizontal ones.
  const side = Math.abs(bx - ax) < Math.abs(by - ay) ? (mid[0] < (ax + bx) / 2 - 2 ? -1 : 1) : 0;
  return { d: `M${p0[0]} ${p0[1]} Q${c[0]} ${c[1]} ${p2[0]} ${p2[1]}`, mid, side };
}

export function LifecycleMachine() {
  const uid = useId().replace(/:/g, "");
  const [sel, setSel] = useState<string>("drain");
  const tr = TRANSITIONS.find((t) => t.id === sel);
  const st = STATES.find((s) => s.id === sel);
  const press = (id: string) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-pressed": sel === id,
    onClick: () => setSel(id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSel(id);
      }
    },
  });

  return (
    <figure className="ix not-content my-8">
      <figcaption className="mb-3 text-sm text-ink-2">
        The sandbox state machine. Select a state or a transition to see what triggers it, the call it makes, and what it guarantees.
      </figcaption>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <div>
          <div className="ix-canvas">
            <svg viewBox="0 0 900 470" style={{ minWidth: 720, maxWidth: 940, margin: "0 auto" }} role="group" aria-label="Sandbox VM states and transitions">
              <defs>
                <marker id={`${uid}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" className="ix-arrow" />
                </marker>
              </defs>
              <circle cx={16} cy={63} r={7} fill="var(--lx-ink)" aria-hidden="true" />
              {TRANSITIONS.map((t) => {
                const { d, mid, side } = curve(t);
                return (
                  <g key={t.id} className={`ix-tr${t.bad ? " t-bad" : ""}`} aria-label={`Transition ${t.from === "start" ? "" : `${t.from} to `}${t.to}: ${t.label}`} {...press(t.id)}>
                    <path className="hit" d={d} />
                    <path d={d} markerEnd={`url(#${uid}-a)`} />
                    <text x={mid[0] + side * 8} y={side ? mid[1] + 4 : mid[1] - 7} textAnchor={side < 0 ? "end" : side > 0 ? "start" : "middle"}>
                      {t.label}
                    </text>
                  </g>
                );
              })}
              {STATES.map((s) => (
                <g key={s.id} className={`ix-state ${s.cls ?? ""}`} aria-label={`State ${s.label}`} {...press(s.id)}>
                  <rect x={s.box.x} y={s.box.y} width={s.box.w} height={s.box.h} rx={25} />
                  <text x={s.box.x + s.box.w / 2} y={s.box.y + s.box.h / 2 + 5} textAnchor="middle">{s.label}</text>
                </g>
              ))}
            </svg>
          </div>
          <p className="ix-pan-hint">Swipe sideways to pan. Tap a state or an arrow.</p>
        </div>
        <aside className="ix-panel self-start" aria-live="polite">
          {tr && (
            <div>
              <h3>{tr.label}</h3>
              <p className="mt-1 font-mono text-xs text-ink-3">
                {tr.from === "start" ? "new VM" : tr.from} → {tr.to}
              </p>
              <h4>Trigger</h4>
              <p>{tr.trigger}</p>
              <h4>Call</h4>
              <p><code>{tr.api}</code></p>
              <h4>Guarantees</h4>
              <ul>{tr.guarantees.map((g) => <li key={g}>{g}</li>)}</ul>
              <h4>Source</h4>
              <SourceLinks src={tr.src} />
            </div>
          )}
          {st && (
            <div>
              <h3 className="font-mono">{st.label}</h3>
              <p className="mt-2">{st.meaning}</p>
              <h4>Leaves by</h4>
              <ul>
                {TRANSITIONS.filter((t) => t.from === st.id).map((t) => (
                  <li key={t.id}>
                    <button type="button" className="ix-link" onClick={() => setSel(t.id)}>{t.label}</button> → {t.to}
                  </li>
                ))}
                {!TRANSITIONS.some((t) => t.from === st.id) && <li>Terminal.</li>}
              </ul>
              <h4>Source</h4>
              <SourceLinks src={st.src} />
            </div>
          )}
        </aside>
      </div>
    </figure>
  );
}
