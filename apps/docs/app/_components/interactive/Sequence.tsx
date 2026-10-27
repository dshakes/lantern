"use client";

import { useEffect, useId, useRef, useState } from "react";
import "./interactive.css";
import { SourceLinks } from "./SourceLinks";
import {
  EGRESS_SEQUENCE, LIFECYCLE_SEQUENCE, RUN_SEQUENCE, TOOL_SEQUENCE, type SequenceDef,
} from "./sequences";

const COL = 150;
const PAD = 16;
const TOP = 92;
const ROW = 46;
const TICK_MS = 2200;

const SEQUENCES = { run: RUN_SEQUENCE, tool: TOOL_SEQUENCE, egress: EGRESS_SEQUENCE, lifecycle: LIFECYCLE_SEQUENCE };

export function Sequence({ name }: { name: keyof typeof SEQUENCES }) {
  return <SequencePlayer def={SEQUENCES[name]} />;
}

function SequencePlayer({ def }: { def: SequenceDef }) {
  const uid = useId().replace(/:/g, "");
  const canvas = useRef<HTMLDivElement>(null);
  const [scn, setScn] = useState(0);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  const scenario = def.scenarios[scn];
  const steps = scenario.steps;
  const step = steps[idx];
  const last = steps.length - 1;
  const col = new Map(def.lifelines.map((l, i) => [l.id, PAD + COL * i + COL / 2]));
  const W = PAD * 2 + COL * def.lifelines.length;
  const H = TOP + ROW * steps.length + 8;
  const rowY = (i: number) => TOP + ROW * i + 16;

  useEffect(() => {
    if (!playing) return;
    if (idx >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(i + 1, last)), TICK_MS);
    return () => clearTimeout(t);
  }, [playing, idx, last]);

  // Keep the active message in view when the diagram is wider than the screen.
  useEffect(() => {
    const c = canvas.current;
    if (!c || c.scrollWidth <= c.clientWidth) return;
    const mid = ((col.get(step.from)! + col.get(step.to)!) / 2) * (c.scrollWidth / W);
    c.scrollTo({ left: mid - c.clientWidth / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [idx, scn]);

  const go = (i: number) => {
    setPlaying(false);
    setIdx(Math.max(0, Math.min(last, i)));
  };
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (idx >= last) setIdx(0);
    setPlaying(true);
  };

  return (
    <figure className="ix ix-seq not-prose my-8">
      <figcaption className="mb-3">
        <span className="block font-semibold text-ink">{def.title}</span>
        <span className="block text-sm text-ink-2 mt-1">{def.caption}</span>
        {def.badge && <span className="ix-badge mt-2">{def.badge}</span>}
      </figcaption>

      {def.scenarios.length > 1 && (
        <div className="ix-bar mb-3" role="group" aria-label="Scenario">
          {def.scenarios.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="ix-btn"
              aria-pressed={scn === i}
              onClick={() => {
                setScn(i);
                setIdx(0);
                setPlaying(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div
        className="ix-canvas"
        ref={canvas}
        tabIndex={0}
        data-focus
        aria-label={`${def.title}, ${scenario.label}. Left and right arrow keys step through the sequence.`}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
          else if (e.key === "Home") { e.preventDefault(); go(0); }
          else if (e.key === "End") { e.preventDefault(); go(last); }
          else if (e.key === " ") { e.preventDefault(); toggle(); }
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: def.lifelines.length * 140, maxWidth: W, margin: "0 auto" }} aria-hidden="true">
          <defs>
            <marker id={`${uid}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" className="ix-arrow" />
            </marker>
          </defs>
          <rect className="ix-rowband" x={0} y={rowY(idx) - 26} width={W} height={ROW - 4} />
          {def.lifelines.map((l) => {
            const x = col.get(l.id)!;
            const on = l.id === step.from || l.id === step.to;
            return (
              <g key={l.id}>
                <line className={`life${on ? " on" : ""}`} x1={x} x2={x} y1={58} y2={H - 4} />
                <g className={`head tone-${l.tone}${on ? " on" : ""}`}>
                  <rect className="box" x={x - COL / 2 + 8} y={10} width={COL - 16} height={46} rx={9} />
                  <text className="t1" x={x} y={l.sub ? 30 : 38} textAnchor="middle">{l.label}</text>
                  {l.sub && <text className="t2 mono" x={x} y={46} textAnchor="middle">{l.sub}</text>}
                </g>
              </g>
            );
          })}
          {steps.map((s, i) => {
            const y = rowY(i);
            const x1 = col.get(s.from)!;
            const x2 = col.get(s.to)!;
            const cls = `ix-msg k-${s.kind ?? "call"}${i === idx ? " on draw" : ""}${i > idx ? " future" : ""}`;
            const text = `${i + 1}. ${s.label}`;
            if (x1 === x2) {
              // Loop to the right, or to the left on the last lifelines so the label stays inside.
              const s1 = x1 > W - 230 ? -1 : 1;
              const d = `M${x1} ${y - 8} h${36 * s1} v16 h${-33 * s1}`;
              return (
                <g key={`${scn}-${i}`} className={cls} onClick={() => go(i)}>
                  <path className="hit" d={d} />
                  <path d={d} markerEnd={`url(#${uid}-a)`} />
                  <text x={x1 + 44 * s1} y={y + 4} textAnchor={s1 > 0 ? "start" : "end"}>{text}</text>
                </g>
              );
            }
            const dir = x2 > x1 ? 1 : -1;
            return (
              <g key={`${scn}-${i}`} className={cls} onClick={() => go(i)}>
                <line className="hit" x1={x1} x2={x2} y1={y} y2={y} />
                <line x1={x1 + dir * 2} x2={x2 - dir * 4} y1={y} y2={y} markerEnd={`url(#${uid}-a)`} />
                <text x={(x1 + x2) / 2} y={y - 7} textAnchor="middle">{text}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="ix-bar" role="group" aria-label="Playback">
          <button type="button" className="ix-btn" onClick={() => go(0)} disabled={idx === 0} aria-label="First step">⏮</button>
          <button type="button" className="ix-btn" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Previous step">◀</button>
          <button type="button" className="ix-btn" onClick={toggle} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button type="button" className="ix-btn" onClick={() => go(idx + 1)} disabled={idx === last} aria-label="Next step">▶</button>
        </div>
        <label className="flex min-w-[160px] flex-1 items-center gap-2 text-sm text-ink-3">
          <span className="sr-only">Scrub through steps</span>
          <input
            type="range"
            className="ix-range"
            min={0}
            max={last}
            value={idx}
            onChange={(e) => go(Number(e.target.value))}
            aria-valuetext={`Step ${idx + 1} of ${steps.length}: ${step.label}`}
          />
          <span className="whitespace-nowrap font-mono text-xs">{idx + 1} / {steps.length}</span>
        </label>
      </div>

      <div className="ix-panel ix-cap mt-3" aria-live="polite">
        <p className="lbl text-ink">
          {idx + 1}. <code>{step.label}</code>
        </p>
        <p className="mt-1">{step.note}</p>
        {step.src && step.src.length > 0 && (
          <p className="mt-2">
            <SourceLinks src={step.src} />
          </p>
        )}
      </div>
    </figure>
  );
}
