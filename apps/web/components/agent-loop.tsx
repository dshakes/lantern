// Cyclic SVG loop diagram for one personal-suite agent — ported from apps/docs.
// ponytail: inline SVG, no deps; CSS classes live in app/globals.css.

type Tone = "sky" | "amber" | "violet" | "emerald" | "rose";
type ExecModel = "scheduled" | "bridge" | "reactive";

export type AgentLoopProps = {
  title: string;
  cadence: string;
  stages: string[];
  tone: Tone;
  ownerFacing: boolean;
  execModel?: ExecModel;
  interface?: string;
};

const COLORS: Record<Tone, { stroke: string; fill: string; text: string; border: string }> = {
  sky:     { stroke: "#38bdf8", fill: "rgba(56,189,248,0.13)",   text: "#7dd3fc", border: "rgba(56,189,248,0.45)" },
  amber:   { stroke: "#f59e0b", fill: "rgba(245,158,11,0.13)",   text: "#fcd34d", border: "rgba(245,158,11,0.50)" },
  violet:  { stroke: "#a78bfa", fill: "rgba(167,139,250,0.13)",  text: "#c4b5fd", border: "rgba(167,139,250,0.45)" },
  emerald: { stroke: "#34d399", fill: "rgba(52,211,153,0.13)",   text: "#6ee7b7", border: "rgba(52,211,153,0.45)" },
  rose:    { stroke: "#fb7185", fill: "rgba(251,113,133,0.13)",  text: "#fda4af", border: "rgba(251,113,133,0.50)" },
};

// ponytail: inline styles so no CSS change needed for exec-model badges
const EXEC_BADGE: Record<ExecModel, { bg: string; color: string; label: string }> = {
  scheduled: { bg: "rgba(56,189,248,0.15)",  color: "#7dd3fc", label: "scheduled"  },
  bridge:    { bg: "rgba(167,139,250,0.15)", color: "#c4b5fd", label: "bridge loop" },
  reactive:  { bg: "rgba(52,211,153,0.15)",  color: "#6ee7b7", label: "reactive"    },
};

const NW  = 110;
const NH  = 42;
const GAP = 32;
const PX  = 16;
const PT  = 18;
const DIP = 44; // deep enough that the loop arc clears the "↻ repeats" label

export function AgentLoop({ title, cadence, stages, tone, ownerFacing, execModel, interface: iface }: AgentLoopProps) {
  const c = COLORS[tone];
  const n = stages.length;
  const svgW = PX + n * (NW + GAP) - GAP + PX;
  const svgH = PT + NH + DIP + 10;

  const nx  = (i: number) => PX + i * (NW + GAP);
  const midY = PT + NH / 2;

  const uid = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const mid = `al-${uid}`;

  const ay  = PT + NH + DIP;
  const nodeBottom = PT + NH;
  const firstCx = nx(0) + NW / 2;
  const lastCx  = nx(n - 1) + NW / 2;
  const loopMidX = (firstCx + lastCx) / 2;
  // Loop-back arc: exit the LAST node's bottom-center straight down, sweep under
  // the row, and re-enter the FIRST node's bottom-center straight UP. Both ends
  // are vertical, so the arrowhead is axis-aligned (points up) — never the
  // crooked tilt a side-entry curve produces with orient="auto".
  const loopPath = `M ${lastCx} ${nodeBottom} C ${lastCx} ${ay}, ${firstCx} ${ay}, ${firstCx} ${nodeBottom}`;

  const eb = execModel ? EXEC_BADGE[execModel] : null;

  return (
    <div className={`agent-loop agent-loop-${tone}`}>
      <div className="agent-loop-head">
        <span className="agent-loop-title">{title}</span>
        <span className="agent-loop-cadence" style={{ marginLeft: "0.1rem" }}>· {cadence}</span>
        {eb && (
          <span style={{ fontSize: "0.62rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", background: eb.bg, color: eb.color, borderRadius: "999px", padding: "0.14rem 0.5rem" }}>
            {eb.label}
          </span>
        )}
        {!ownerFacing && (
          <span className="agent-loop-contact-badge">talks to your contacts</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        width="100%"
        role="img"
        aria-label={`${title} loop: ${stages.join(" → ")} → repeat`}
        style={{ display: "block", overflow: "visible" }}
      >
        <defs>
          <marker id={mid} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L0,7 L7,3.5z" fill={c.stroke} />
          </marker>
        </defs>

        {stages.map((stage, i) => (
          <g key={i}>
            <rect x={nx(i)} y={PT} width={NW} height={NH} rx={8} fill={c.fill} stroke={c.border} strokeWidth={1.5} />
            <text x={nx(i) + NW / 2} y={midY} textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight={600} fill={c.text} style={{ fontFamily: "inherit" }}>
              {stage}
            </text>
          </g>
        ))}

        {Array.from({ length: n - 1 }, (_, i) => (
          <line key={i} x1={nx(i) + NW + 2} y1={midY} x2={nx(i + 1) - 2} y2={midY} stroke={c.stroke} strokeWidth={1.5} markerEnd={`url(#${mid})`} />
        ))}

        <path d={loopPath} fill="none" stroke={c.stroke} strokeWidth={1.5} strokeDasharray="5 3" markerEnd={`url(#${mid})`} />
        {/* Explicit loop label so the dashed arc reads clearly as "this repeats". */}
        {/* Label sits in the clear gap just below the boxes; the arc dips
            BELOW it (DIP is tuned so they never overlap). */}
        <g>
          <rect x={loopMidX - 34} y={nodeBottom + 4} width={68} height={18} rx={9} fill={c.fill} stroke={c.border} strokeWidth={1} />
          <text x={loopMidX} y={nodeBottom + 14} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight={700} fill={c.text} style={{ fontFamily: "inherit" }}>↻ repeats</text>
        </g>
      </svg>
      {iface && (
        <p style={{ margin: "0.15rem 0 0", fontSize: "0.69rem", color: "#71717a" }}>{iface}</p>
      )}
    </div>
  );
}
