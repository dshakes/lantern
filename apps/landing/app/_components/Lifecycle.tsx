"use client";

import { useEffect, useState } from "react";

// Sandbox lifecycle as a walkable state machine. Auto-advances every 2.6s until
// the visitor picks a step; never auto-advances under prefers-reduced-motion.

type StateId = "scheduled" | "running" | "suspended" | "paused" | "forks" | "terminated";
type EdgeId = "sr" | "rs" | "sR" | "rp" | "pr" | "rf" | "rt";

const PHASES: { state: StateId; edge: EdgeId; title: string; body: string }[] = [
  {
    state: "running",
    edge: "sr",
    title: "Schedule it",
    body: "Placement weighs warm pool, region, fair share, cost and health. Over the per-tenant quota, the request gets HTTP 402.",
  },
  {
    state: "suspended",
    edge: "rs",
    title: "It goes idle and suspends",
    body: "No exec, tool call or file request for idleTimeoutSecs: the VM is snapshotted and its compute and quota slot released.",
  },
  {
    state: "running",
    edge: "sR",
    title: "A request wakes it",
    body: "The next exec or file request restores it. The caller sees a slower first response (~4 s) while the in-guest exec channel re-establishes.",
  },
  {
    state: "paused",
    edge: "rp",
    title: "You pause it",
    body: "lantern vm pause snapshots the VM and frees its quota slot.",
  },
  {
    state: "running",
    edge: "pr",
    title: "You resume it",
    body: "lantern vm resume restores it under the same vm_id.",
  },
  {
    state: "forks",
    edge: "rf",
    title: "You fork it",
    body: "lantern vm fork --count N starts children from one snapshot that share its memory copy-on-write. Each gets its own vm_id, certificate and identity; up to 100 by default, configurable to 1000.",
  },
];

const NODES: { id: StateId; x: number; y: number; w: number; label: string; sub: string }[] = [
  { id: "scheduled", x: 16, y: 152, w: 128, label: "Scheduled", sub: "placed" },
  { id: "running", x: 200, y: 152, w: 150, label: "Running", sub: "exec, tools, files" },
  { id: "suspended", x: 200, y: 20, w: 150, label: "Suspended", sub: "idle, no compute" },
  { id: "paused", x: 200, y: 284, w: 150, label: "Paused", sub: "snapshot, slot freed" },
  { id: "terminated", x: 16, y: 284, w: 128, label: "Terminated", sub: "drained" },
];

const EDGES: { id: EdgeId; d: string }[] = [
  { id: "sr", d: "M144 180 H198" },
  { id: "rs", d: "M255 152 V78" },
  { id: "sR", d: "M295 76 V150" },
  { id: "rp", d: "M255 208 V282" },
  { id: "pr", d: "M295 284 V210" },
  { id: "rf", d: "M350 180 H404" },
  { id: "rt", d: "M200 196 H170 V284" },
];

export function Lifecycle() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % PHASES.length), 2600);
    return () => clearInterval(t);
  }, [auto]);

  const p = PHASES[i];
  const on = (s: StateId) => p.state === s;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      <ol className="space-y-1" aria-label="Sandbox lifecycle steps">
        {PHASES.map((ph, n) => (
          <li key={ph.title}>
                <button
              type="button"
              onClick={() => {
                setAuto(false);
                setI(n);
              }}
              aria-current={n === i ? "step" : undefined}
              className={`w-full rounded-[var(--lx-radius-m)] px-4 py-3 text-left transition-colors duration-150 ${
                n === i ? "bg-surface" : "hover:bg-surface/60"
              }`}
                >
              <span className="flex items-baseline gap-3">
                <span className={`font-mono text-xs ${n === i ? "text-flame" : "text-ink-3"}`}>{n + 1}</span>
                <span className={n === i ? "font-medium text-ink" : "text-ink-2"}>{ph.title}</span>
              </span>
              {n === i && <span className="mt-1 block pl-6 text-sm text-ink-2">{ph.body}</span>}
            </button>
          </li>
        ))}
      </ol>

      <svg viewBox="0 0 640 360" className="fx w-full" role="img" aria-label={`Sandbox lifecycle, step ${i + 1}: ${p.title}`}>
        <defs>
          <marker id="lc-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10z" fill="var(--lx-ink-3)" />
          </marker>
          <marker id="lc-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10z" fill="var(--lx-flame)" />
          </marker>
        </defs>

        {EDGES.map((e) => (
          <path
            key={e.id}
            d={e.d}
            fill="none"
            stroke={p.edge === e.id ? "var(--lx-flame)" : "var(--lx-line)"}
            strokeWidth={p.edge === e.id ? 2.5 : 1.5}
            strokeDasharray={e.id === "rt" ? "4 4" : undefined}
            markerEnd={`url(#${p.edge === e.id ? "lc-on" : "lc-a"})`}
            style={{ transition: "stroke 160ms" }}
          />
        ))}
        <text className="t-s mono" x={262} y={120}>
          idleTimeoutSecs
        </text>
        <text className="t-s" x={210} y={250} textAnchor="end">
          pause
        </text>
        <text className="t-s" x={302} y={250}>
          resume
        </text>

        {NODES.map((n) => (
          <g key={n.id}>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={56}
              rx={10}
              fill={on(n.id) ? "var(--lx-flame-soft)" : "var(--lx-surface)"}
              stroke={on(n.id) ? "var(--lx-flame)" : "var(--lx-line)"}
              strokeWidth={on(n.id) ? 2.5 : 1.5}
              style={{ transition: "fill 160ms, stroke 160ms" }}
            />
            <text className="t-h" x={n.x + 14} y={n.y + 24}>
              {n.label}
            </text>
            <text className="t-s" x={n.x + 14} y={n.y + 43}>
              {n.sub}
            </text>
          </g>
        ))}

        <g opacity={on("forks") ? 1 : 0.55} style={{ transition: "opacity 160ms" }}>
          {[0, 1, 2].map((k) => (
            <g key={k}>
              <rect
                x={408}
                y={96 + k * 60}
                width={216}
                height={44}
                rx={10}
                fill={on("forks") ? "var(--lx-flame-soft)" : "var(--lx-surface)"}
                stroke={on("forks") ? "var(--lx-flame)" : "var(--lx-line)"}
                strokeWidth={1.5}
              />
              <text className="t-h" x={422} y={123 + k * 60}>
                {`Fork ${k + 1}`}
              </text>
              <text className="t-s mono" x={610} y={123 + k * 60} textAnchor="end">
                {`own vm_id`}
              </text>
            </g>
          ))}
          <rect x={408} y={284} width={216} height={56} rx={10} fill="var(--lx-glass-soft)" stroke="var(--lx-glass)" strokeWidth={1.5} />
          <text className="t-h" x={422} y={307}>
            Parent memory
          </text>
          <text className="t-s" x={422} y={326}>
            shared copy-on-write
          </text>
          <path d="M516 262 V282" stroke="var(--lx-glass)" strokeWidth={1.5} strokeDasharray="3 3" />
        </g>
      </svg>
    </div>
  );
}
