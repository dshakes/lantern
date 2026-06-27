// Cyclic SVG loop diagram for one personal-suite agent.
// Renders a horizontal row of stage nodes with forward arrows and a dashed
// arc looping from the last stage back to the first.
// ponytail: inline SVG, no deps; all sizing is fixed constants so the viewBox
// scales down correctly on mobile via width="100%".

type Tone = "sky" | "amber" | "violet" | "emerald" | "rose";

export type AgentLoopProps = {
  title: string;
  cadence: string;
  stages: string[];
  tone: Tone;
  ownerFacing: boolean;
};

const COLORS: Record<Tone, { stroke: string; fill: string; text: string; border: string }> = {
  sky:     { stroke: "#38bdf8", fill: "rgba(56,189,248,0.13)",   text: "#7dd3fc", border: "rgba(56,189,248,0.45)" },
  amber:   { stroke: "#f59e0b", fill: "rgba(245,158,11,0.13)",   text: "#fcd34d", border: "rgba(245,158,11,0.50)" },
  violet:  { stroke: "#a78bfa", fill: "rgba(167,139,250,0.13)",  text: "#c4b5fd", border: "rgba(167,139,250,0.45)" },
  emerald: { stroke: "#34d399", fill: "rgba(52,211,153,0.13)",   text: "#6ee7b7", border: "rgba(52,211,153,0.45)" },
  rose:    { stroke: "#fb7185", fill: "rgba(251,113,133,0.13)",  text: "#fda4af", border: "rgba(251,113,133,0.50)" },
};

const NW  = 110; // node width
const NH  = 42;  // node height
const GAP = 32;  // gap between nodes
const PX  = 16;  // horizontal padding (each side)
const PT  = 18;  // top padding
const DIP = 26;  // loop arc dip below node bottom

export function AgentLoop({ title, cadence, stages, tone, ownerFacing }: AgentLoopProps) {
  const c = COLORS[tone];
  const n = stages.length;
  const svgW = PX + n * (NW + GAP) - GAP + PX;
  const svgH = PT + NH + DIP + 14;

  const nx  = (i: number) => PX + i * (NW + GAP); // left edge of node i
  const midY = PT + NH / 2;                        // vertical center of nodes

  // Unique marker ID per agent so document-global SVG defs don't collide.
  const uid = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const mid = `al-${uid}`;

  // Cubic bezier: right edge of last node → arc below all nodes → left edge of first node
  const ax0 = nx(n - 1) + NW;
  const ax1 = nx(0);
  const ay  = PT + NH + DIP;
  const loopPath = `M ${ax0} ${midY} C ${ax0 + 14} ${ay}, ${ax1 - 14} ${ay}, ${ax1} ${midY}`;

  return (
    <div className={`agent-loop agent-loop-${tone}`}>
      <div className="agent-loop-head">
        <span className="agent-loop-title">{title}</span>
        <span className="agent-loop-cadence">{cadence}</span>
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

        {/* Stage nodes */}
        {stages.map((stage, i) => (
          <g key={i}>
            <rect
              x={nx(i)} y={PT}
              width={NW} height={NH}
              rx={8}
              fill={c.fill}
              stroke={c.border}
              strokeWidth={1.5}
            />
            <text
              x={nx(i) + NW / 2}
              y={midY}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={11}
              fontWeight={600}
              fill={c.text}
              style={{ fontFamily: "inherit" }}
            >
              {stage}
            </text>
          </g>
        ))}

        {/* Forward arrows between consecutive nodes */}
        {Array.from({ length: n - 1 }, (_, i) => (
          <line
            key={i}
            x1={nx(i) + NW + 2} y1={midY}
            x2={nx(i + 1) - 2}  y2={midY}
            stroke={c.stroke}
            strokeWidth={1.5}
            markerEnd={`url(#${mid})`}
          />
        ))}

        {/* Dashed loop-back arc: last → first */}
        <path
          d={loopPath}
          fill="none"
          stroke={c.stroke}
          strokeWidth={1.5}
          strokeDasharray="5 3"
          markerEnd={`url(#${mid})`}
        />
      </svg>
    </div>
  );
}
