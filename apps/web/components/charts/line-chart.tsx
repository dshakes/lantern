"use client";

import { useMemo, useRef, useState } from "react";
import clsx from "clsx";

export interface LineSeries {
  name: string;
  values: number[];
  color?: string;
}

interface LineChartProps {
  series: LineSeries[];
  labels?: string[];
  width?: number;
  height?: number;
  className?: string;
  formatY?: (n: number) => string;
  yTicks?: number;
}

export function LineChart({
  series,
  labels,
  height = 240,
  className,
  formatY = (n) => n.toLocaleString(),
  yTicks = 4,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(640);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Resize observer (light)
  useMemo(() => {
    if (typeof window === "undefined") return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = Math.max(40, w - padL - padR);
  const innerH = height - padT - padB;

  const { allValues, max, min, n, paths, points } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    if (all.length === 0) {
      return { allValues: [], max: 1, min: 0, n: 0, paths: [], points: [] };
    }
    const max = Math.max(...all);
    const min = Math.min(0, ...all);
    const n = Math.max(...series.map((s) => s.values.length));
    const range = max - min || 1;
    const stepX = n > 1 ? innerW / (n - 1) : 0;

    const paths = series.map((s) => {
      const pts = s.values.map((v, i) => ({
        x: padL + i * stepX,
        y: padT + innerH - ((v - min) / range) * innerH,
      }));
      return {
        d: pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
          .join(" "),
        color: s.color ?? "rgb(168 85 247)",
        name: s.name,
      };
    });

    const points = Array.from({ length: n }, (_, i) =>
      series.map((s) => ({
        seriesName: s.name,
        color: s.color ?? "rgb(168 85 247)",
        v: s.values[i] ?? 0,
        x: padL + i * stepX,
        y: padT + innerH - (((s.values[i] ?? 0) - min) / range) * innerH,
      })),
    );

    return { allValues: all, max, min, n, paths, points };
  }, [series, innerW, innerH, padL, padT]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= yTicks; i++) {
      out.push(min + ((max - min) * i) / yTicks);
    }
    return out;
  }, [min, max, yTicks]);

  const hoverPoints = hoverIdx != null ? points[hoverIdx] : null;
  const hoverLabel =
    hoverIdx != null ? (labels?.[hoverIdx] ?? `t${hoverIdx}`) : null;

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n <= 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left - padL;
    const stepX = innerW / (n - 1);
    const idx = Math.round(relX / stepX);
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  if (allValues.length === 0) {
    return (
      <div
        style={{ height }}
        className={clsx(
          "flex items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-surface-1 text-xs text-zinc-600",
          className,
        )}
      >
        No data yet
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={clsx("relative w-full", className)} style={{ height }}>
      <svg
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="block"
      >
        {/* Y gridlines + labels */}
        {ticks.map((t, i) => {
          const y = padT + innerH - ((t - min) / (max - min || 1)) * innerH;
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={w - padR}
                y2={y}
                stroke="rgb(39 39 42)"
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-zinc-500 font-mono text-[10px]"
              >
                {formatY(t)}
              </text>
            </g>
          );
        })}

        {/* X axis labels (sparse) */}
        {labels &&
          labels.map((l, i) => {
            if (n > 8 && i % Math.ceil(n / 8) !== 0) return null;
            const stepX = n > 1 ? innerW / (n - 1) : 0;
            const x = padL + i * stepX;
            return (
              <text
                key={i}
                x={x}
                y={height - 6}
                textAnchor="middle"
                className="fill-zinc-500 font-mono text-[10px]"
              >
                {l}
              </text>
            );
          })}

        {/* Series paths */}
        {paths.map((p) => (
          <path
            key={p.name}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Hover crosshair + dots */}
        {hoverPoints && (
          <>
            <line
              x1={hoverPoints[0].x}
              y1={padT}
              x2={hoverPoints[0].x}
              y2={padT + innerH}
              stroke="rgb(82 82 91)"
              strokeDasharray="3,3"
              strokeWidth={1}
            />
            {hoverPoints.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={4}
                fill={p.color}
                stroke="rgb(9 9 11)"
                strokeWidth={2}
              />
            ))}
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hoverPoints && (
        <div
          className="pointer-events-none absolute z-10 min-w-[140px] -translate-y-full rounded-lg border border-zinc-700 bg-zinc-900/95 p-2.5 text-xs shadow-xl backdrop-blur"
          style={{
            left: Math.min(w - 160, Math.max(0, hoverPoints[0].x + 8)),
            top: padT - 4,
          }}
        >
          {hoverLabel && (
            <div className="mb-1.5 border-b border-zinc-800 pb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
              {hoverLabel}
            </div>
          )}
          {hoverPoints.map((p, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: p.color }}
              />
              <span className="text-zinc-400">{p.seriesName}</span>
              <span className="ml-auto font-mono text-zinc-100 tabular-nums">
                {formatY(p.v)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
