// Cyclic SVG loop diagram for one personal-suite agent.
// Renders a horizontal row of stage nodes with forward arrows and a dashed
// arc looping from the last stage back to the first.
// ponytail: inline SVG, no deps; all sizing is fixed constants so the viewBox
// scales down correctly on mobile via width="100%".

type Tone = "sky" | "amber" | "violet" | "emerald" | "rose";
type ExecModel = "scheduled" | "bridge" | "reactive";

export type AgentLoopProps = {
  title: string;
  cadence: string;
  stages: string[];
  tone: Tone;
  ownerFacing: boolean;
  /** Optional execution-model badge shown in the header. */
  execModel?: ExecModel;
  /** Optional one-liner shown below the diagram: where the owner sees output. */
  interface?: string;
};

const COLORS: Record<Tone, { stroke: string; fill: string; text: string; border: string }> = {
  sky:     { stroke: "var(--lx-glass)", fill: "color-mix(in srgb, var(--lx-glass) 13%, transparent)",   text: "var(--lx-glass)", border: "color-mix(in srgb, var(--lx-glass) 45%, transparent)" },
  amber:   { stroke: "var(--lx-flame)", fill: "color-mix(in srgb, var(--lx-flame) 13%, transparent)",   text: "var(--lx-flame)", border: "color-mix(in srgb, var(--lx-flame) 50%, transparent)" },
  violet:  { stroke: "var(--lx-glass)", fill: "color-mix(in srgb, var(--lx-glass) 13%, transparent)",  text: "var(--lx-glass)", border: "color-mix(in srgb, var(--lx-glass) 45%, transparent)" },
  emerald: { stroke: "var(--lx-patina)", fill: "color-mix(in srgb, var(--lx-patina) 13%, transparent)",   text: "var(--lx-patina)", border: "color-mix(in srgb, var(--lx-patina) 45%, transparent)" },
  rose:    { stroke: "var(--lx-signal)", fill: "color-mix(in srgb, var(--lx-signal) 13%, transparent)",  text: "var(--lx-signal)", border: "color-mix(in srgb, var(--lx-signal) 50%, transparent)" },
};

// ponytail: inline styles so no CSS change needed for the new badges
const EXEC_BADGE: Record<ExecModel, { bg: string; color: string; label: string }> = {
  scheduled: { bg: "color-mix(in srgb, var(--lx-glass) 15%, transparent)",  color: "var(--lx-glass)", label: "scheduled"  },
  bridge:    { bg: "color-mix(in srgb, var(--lx-glass) 15%, transparent)", color: "var(--lx-glass)", label: "bridge loop" },
  reactive:  { bg: "color-mix(in srgb, var(--lx-patina) 15%, transparent)",  color: "var(--lx-patina)", label: "reactive"    },
};

const NW  = 110; // node width
const NH  = 42;  // node height
const GAP = 32;  // gap between nodes
const PX  = 16;  // horizontal padding (each side)
const PT  = 18;  // top padding
const DIP = 44;  // deep enough that the loop arc clears the "↻ repeats" label

export function AgentLoop({ title, cadence, stages, tone, ownerFacing, execModel, interface: iface }: AgentLoopProps) {
  const c = COLORS[tone];
  const n = stages.length;
  const svgW = PX + n * (NW + GAP) - GAP + PX;
  const svgH = PT + NH + DIP + 10;

  const nx  = (i: number) => PX + i * (NW + GAP); // left edge of node i
  const midY = PT + NH / 2;                        // vertical center of nodes

  // Unique marker ID per agent so document-global SVG defs don't collide.
  const uid = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const mid = `al-${uid}`;

  // Loop-back arc: exit the LAST node's bottom-center straight down, sweep under
  // the row, and re-enter the FIRST node's bottom-center straight UP — both ends
  // vertical, so the arrowhead is axis-aligned (points up), never a crooked tilt.
  const ay  = PT + NH + DIP;
  const nodeBottom = PT + NH;
  const firstCx = nx(0) + NW / 2;
  const lastCx  = nx(n - 1) + NW / 2;
  const loopMidX = (firstCx + lastCx) / 2;
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
        {/* Explicit loop label so the dashed arc reads clearly as "this repeats". */}
        <g>
          <rect x={loopMidX - 34} y={nodeBottom + 4} width={68} height={18} rx={9} fill={c.fill} stroke={c.border} strokeWidth={1} />
          <text x={loopMidX} y={nodeBottom + 14} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight={700} fill={c.text} style={{ fontFamily: "inherit" }}>↻ repeats</text>
        </g>
      </svg>
      {iface && (
        <p style={{ margin: "0.15rem 0 0", fontSize: "0.69rem", color: "var(--lx-ink-3)" }}>
          {iface}
        </p>
      )}
    </div>
  );
}
