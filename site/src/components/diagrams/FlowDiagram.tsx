import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import "./interactive.css";
import { along, route, toPath, type Pt } from "./geometry";
import { SourceLinks } from "./SourceLinks";
import type { Src, Tone } from "./types";

// The shared diagram kit: boxes, edges with animated flow, frames, a hover
// tooltip, and an optional step-through (scenarios of steps that light up a
// path). Every new PAL diagram is a FlowDef handed to this one component.

export type FTone = Tone | "pal" | "rt" | "ok";
export type FNode = {
  id: string; label: string; sub?: string; tone?: FTone;
  x: number; y: number; w?: number; h?: number;
  /** One or two sentences shown in the tooltip and the details panel. */
  detail?: string; src?: Src[];
};
export type FEdge = {
  from: string; to: string; label?: string; via?: Pt[]; at?: number;
  kind?: "deny" | "inject" | "store" | "guest"; bidi?: boolean; dashed?: boolean;
};
export type FFrame = { label: string; x: number; y: number; w: number; h: number; kind?: "cp" | "dp" | "wall" | "host" | "zone" | "deny" };
/** `edges` names edges as "from>to". */
export type FStep = { title: string; note: string; nodes?: string[]; edges?: string[]; deny?: boolean; src?: Src[] };
export type FScenario = { id: string; label: string; steps: FStep[] };
export type FlowDef = {
  id: string; title: string; caption: string; badge?: string;
  vb: [number, number];
  nodes: FNode[]; edges: FEdge[]; frames?: FFrame[];
  scenarios?: FScenario[];
  /** Legend chips under the diagram. */
  legend?: [FTone | "wall", string][];
  /** Accent for the lit path; inferred from the node tones when omitted. */
  brand?: "pal" | "rt";
};

const NW = 150, NH = 54, TICK_MS = 2400;
/** Condense text that would overflow its box (estimated per-char width). */
const fitText = (t: string, cw: number, w: number) =>
  t.length * cw > w - 14 ? { textLength: w - 14, lengthAdjust: "spacingAndGlyphs" as const } : {};
const ek = (e: FEdge) => `${e.from}>${e.to}`;
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function FlowDiagram({ def, autoplay = true, compact = false }: { def: FlowDef; autoplay?: boolean; compact?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [scn, setScn] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [touched, setTouched] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [fit, setFit] = useState(false);
  const [motion, setMotion] = useState(false);
  // Phones get a readable stacked list of the steps by default; the full map is one tap away.
  const [stacked, setStacked] = useState(false);
  const brand = def.brand ?? (def.nodes.some((n) => n.tone === "pal") ? "pal" : "rt");

  const nodes = useMemo(() => def.nodes.map((n) => ({ ...n, w: n.w ?? NW, h: n.h ?? NH })), [def]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const steps = def.scenarios?.[scn]?.steps ?? [];
  const last = steps.length - 1;
  const step = steps[idx];
  const selNode = sel ? byId.get(sel) : undefined;

  useEffect(() => {
    setMotion(!reduced());
    if (typeof matchMedia !== "undefined" && matchMedia("(max-width: 760px)").matches) setStacked(true);
  }, []);

  // Start playing the first time the diagram scrolls into view (never under reduced motion).
  useEffect(() => {
    if (!autoplay || !steps.length || reduced() || touched) return;
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setPlaying(true); io.disconnect(); }
    }, { threshold: 0.45 });
    io.observe(el);
    return () => io.disconnect();
  }, [autoplay, steps.length, touched]);

  useEffect(() => {
    if (!playing) return;
    if (idx >= last) { setPlaying(false); return; }
    const t = setTimeout(() => setIdx((i) => Math.min(i + 1, last)), TICK_MS);
    return () => clearTimeout(t);
  }, [playing, idx, last]);

  const go = (i: number) => { setTouched(true); setPlaying(false); setSel(null); setIdx(Math.max(0, Math.min(last, i))); };
  const toggle = () => {
    setTouched(true); setSel(null);
    if (playing) return setPlaying(false);
    if (idx >= last) setIdx(0);
    setPlaying(true);
  };

  // What is lit: a selected/hovered node and its neighbours, else the current step.
  const focusId = hover ?? sel;
  const litNodes = new Set<string>();
  const litEdges = new Set<string>();
  if (focusId) {
    litNodes.add(focusId);
    def.edges.forEach((e) => { if (e.from === focusId || e.to === focusId) { litEdges.add(ek(e)); litNodes.add(e.from); litNodes.add(e.to); } });
  } else if (step) {
    step.nodes?.forEach((n) => litNodes.add(n));
    step.edges?.forEach((k) => { litEdges.add(k); const [a, b] = k.split(">"); litNodes.add(a); litNodes.add(b); });
  }
  const anyLit = litNodes.size > 0;
  // On a deny step the last edge and its target turn red.
  const denyEdge = !focusId && step?.deny ? step.edges?.at(-1) : undefined;
  const denyNode = !focusId && step?.deny ? step.nodes?.at(-1) ?? denyEdge?.split(">")[1] : undefined;

  const press = (id: string) => ({
    role: "button" as const, tabIndex: 0, "aria-pressed": sel === id,
    onClick: () => { setTouched(true); setPlaying(false); setSel(sel === id ? null : id); },
    onMouseEnter: () => setHover(id), onMouseLeave: () => setHover(null),
    onFocus: () => setHover(id), onBlur: () => setHover(null),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setTouched(true); setPlaying(false); setSel(sel === id ? null : id); }
    },
  });

  const tip = hover && hover !== sel ? byId.get(hover) : undefined;
  const [vw, vh] = def.vb;

  return (
    <figure ref={root} className={`ix ix-flow b-${brand}${compact ? " compact" : ""}${stacked ? " is-stacked" : ""} not-content my-8`} onKeyDown={(e) => e.key === "Escape" && setSel(null)}>
      <figcaption className="mb-3">
        <span className="block font-semibold text-ink">{def.title}</span>
        <span className="block text-sm text-ink-2 mt-1">{def.caption}</span>
        {def.badge && <span className="ix-badge mt-2">{def.badge}</span>}
      </figcaption>

      {(def.scenarios?.length ?? 0) > 1 && (
        <div className="ix-bar mb-3" role="group" aria-label="Scenario">
          {def.scenarios!.map((s, i) => (
            <button key={s.id} type="button" className="ix-btn" aria-pressed={scn === i}
              onClick={() => { setTouched(true); setScn(i); setIdx(0); setSel(null); setPlaying(false); }}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {stacked && (
        <ol className="ix-stack" aria-label={`${def.title}, step by step`}>
          {steps.length > 0 ? steps.map((s, i) => (
            <li key={s.title} className={`${i === idx ? "on" : ""}${i < idx ? " done" : ""}${s.deny ? " deny" : ""}`}>
              <button type="button" onClick={() => go(i)} aria-current={i === idx ? "step" : undefined}>
                <span className="n" aria-hidden="true">{i + 1}</span>
                <span className="b"><span className="t">{s.title}</span><span className="d">{s.note}</span>
                  {s.nodes && s.nodes.length > 0 && (
                    <span className="chips">{s.nodes.map((id) => byId.get(id)).filter(Boolean).map((n) => (
                      <span key={n!.id} className={`chip tone-${n!.tone ?? "plain"}`}>{n!.label}</span>
                    ))}</span>
                  )}
                </span>
              </button>
            </li>
          )) : nodes.map((n) => (
            <li key={n.id} className="node">
              <div className={`nodecard tone-${n.tone ?? "plain"}`}>
                <span className="t">{n.label}{n.sub && <span className="s"> · {n.sub}</span>}</span>
                {n.detail && <span className="d">{n.detail}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="ix-stage" hidden={stacked}>
        <div
          className={`ix-canvas${fit ? " fit" : ""}`}
          ref={canvas}
          tabIndex={steps.length ? 0 : -1}
          data-focus
          aria-label={steps.length ? `${def.title}. Left and right arrow keys step through; Tab reaches each component.` : def.title}
          onKeyDown={(e) => {
            if (!steps.length || e.target !== e.currentTarget) return;
            if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
            else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
            else if (e.key === "Home") { e.preventDefault(); go(0); }
            else if (e.key === "End") { e.preventDefault(); go(last); }
            else if (e.key === " ") { e.preventDefault(); toggle(); }
          }}
        >
          <svg viewBox={`0 0 ${vw} ${vh}`} style={{ minWidth: fit ? 0 : Math.min(vw, 720), maxWidth: vw, margin: "0 auto" }} role="group" aria-label={`${def.title}. ${def.caption}`}>
            <defs>
              <marker id={`${uid}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" className="ix-arrow" />
              </marker>
            </defs>
            {def.frames?.map((f) => (
              <g key={f.label} aria-hidden="true">
                <rect className={`fr-${f.kind ?? "zone"}`} x={f.x} y={f.y} width={f.w} height={f.h} rx={f.kind === "wall" ? 20 : 16} />
                <text className={`fr-label${f.kind === "wall" ? " wall" : ""}`} x={f.x + 14} y={f.y + f.h - 10}>{f.label}</text>
              </g>
            ))}
            {def.edges.map((e) => {
              const a = byId.get(e.from)!, b = byId.get(e.to)!;
              const pts = route({ x: a.x, y: a.y, w: a.w, h: a.h }, { x: b.x, y: b.y, w: b.w, h: b.h }, e.via);
              const d = toPath(pts);
              const [lx, ly] = along(pts, e.at ?? 0.5);
              const on = litEdges.has(ek(e));
              // ponytail: label width estimated at 6.4px/char; a label that won't fit its edge is left to the step text and the panel.
              const len = pts.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
              const showLabel = !!e.label && e.label.length * 6.8 + 16 < len;
              const deny = on && denyEdge === ek(e);
              return (
                <g key={ek(e) + (e.label ?? "")} aria-hidden="true"
                  className={`ix-edge${e.kind ? ` k-${e.kind}` : ""}${e.dashed ? " dashed" : ""}${on ? " on flow" : ""}${deny ? " k-deny" : ""}${anyLit && !on ? " ix-dim" : ""}`}>
                  <path id={`${uid}-${ek(e)}`} d={d} markerEnd={`url(#${uid}-a)`} markerStart={e.bidi ? `url(#${uid}-a)` : undefined} />
                  {on && motion && <circle className="ix-dot" r={4.5}><animateMotion dur="1.4s" repeatCount="indefinite" path={d} /></circle>}
                  {showLabel && <text x={lx} y={ly - 6} textAnchor="middle">{e.label}</text>}
                </g>
              );
            })}
            {nodes.map((n) => {
              const dim = anyLit && !litNodes.has(n.id);
              const denied = denyNode === n.id;
              return (
                <g key={n.id} className={`ix-node tone-${denied ? "deny" : n.tone ?? "plain"}${dim ? " ix-dim" : ""}${litNodes.has(n.id) ? " lit" : ""}`}
                  aria-label={`${n.label}${n.sub ? `, ${n.sub}` : ""}${n.detail ? `. ${n.detail}` : ""}`} {...press(n.id)}>
                  <rect className="ring" x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={13} />
                  <rect className="box" x={n.x} y={n.y} width={n.w} height={n.h} rx={10} />
                  <text className="t1" x={n.x + n.w / 2} y={n.sub ? n.y + n.h / 2 - 3 : n.y + n.h / 2 + 5} textAnchor="middle" {...fitText(n.label, 8.4, n.w)}>{n.label}</text>
                  {n.sub && <text className="t2" x={n.x + n.w / 2} y={n.y + n.h / 2 + 14} textAnchor="middle" {...fitText(n.sub, 6.8, n.w)}>{n.sub}</text>}
                </g>
              );
            })}
          </svg>
          {tip?.detail && (
            <div className="ix-tip" role="tooltip"
              style={{ left: `${((tip.x + tip.w / 2) / vw) * 100}%`, top: `${((tip.y + tip.h) / vh) * 100}%` }}>
              {tip.detail}
            </div>
          )}
        </div>
      </div>
      <div className="ix-mobilebar">
        {!stacked && <span className="ix-pan-hint">{fit ? "Whole diagram. Tap a box for details." : "Swipe sideways to pan."}</span>}
        <span className="ix-mb-btns">
          {!stacked && <button type="button" className="ix-btn" aria-pressed={fit} onClick={() => setFit(!fit)}>{fit ? "Zoom in" : "Fit"}</button>}
          <button type="button" className="ix-btn" aria-pressed={!stacked} onClick={() => setStacked(!stacked)}>{stacked ? "Show diagram" : "Show steps"}</button>
        </span>
      </div>

      {steps.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="ix-bar" role="group" aria-label="Playback">
            <button type="button" className="ix-btn" onClick={() => go(0)} disabled={idx === 0} aria-label="First step">⏮</button>
            <button type="button" className="ix-btn" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous step">◀</button>
            <button type="button" className="ix-btn" onClick={toggle} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
            <button type="button" className="ix-btn" onClick={() => go(idx + 1)} disabled={idx === last} aria-label="Next step">▶</button>
          </div>
          <label className="flex min-w-[160px] flex-1 items-center gap-2 text-sm text-ink-3">
            <span className="sr-only">Scrub through steps</span>
            <input type="range" className="ix-range" min={0} max={last} value={idx} onChange={(e) => go(Number(e.target.value))}
              aria-valuetext={`Step ${idx + 1} of ${steps.length}: ${step?.title}`} />
            <span className="whitespace-nowrap font-mono text-xs">{idx + 1} / {steps.length}</span>
          </label>
        </div>
      )}

      {!stacked && (selNode || step) && (
        <div className={`ix-panel ix-cap mt-3${!selNode && step?.deny ? " deny" : ""}`} aria-live="polite">
          {selNode ? (
            <>
              <button type="button" className="ix-close" aria-label="Close details" onClick={() => setSel(null)}>×</button>
              <p className="lbl text-ink">{selNode.label}{selNode.sub && <span className="text-ink-3 font-mono text-xs"> · {selNode.sub}</span>}</p>
              {selNode.detail && <p className="mt-1">{selNode.detail}</p>}
              {selNode.src && <p className="mt-2"><SourceLinks src={selNode.src} /></p>}
            </>
          ) : step && (
            <>
              <p className="lbl text-ink">{idx + 1}. {step.title}</p>
              <p className="mt-1">{step.note}</p>
              {step.src && <p className="mt-2"><SourceLinks src={step.src} /></p>}
            </>
          )}
        </div>
      )}

      {def.legend && (
        <ul className="ix-legend mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
          {def.legend.map(([t, label]) => (
            <li key={label} className="flex items-center gap-2 text-ink-2"><span className={`ix-sw sw-${t}`} aria-hidden="true" />{label}</li>
          ))}
        </ul>
      )}
    </figure>
  );
}
