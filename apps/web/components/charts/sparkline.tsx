"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  className?: string;
  showDots?: boolean;
  formatValue?: (n: number) => string;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  stroke = "rgb(168 85 247)",
  fill = "rgb(168 85 247 / 0.12)",
  strokeWidth = 1.5,
  className,
  showDots = false,
  formatValue,
}: SparklineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { path, area, points, min, max } = useMemo(() => {
    if (data.length === 0) {
      return { path: "", area: "", points: [], min: 0, max: 0 };
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = data.length > 1 ? width / (data.length - 1) : 0;
    const pts = data.map((v, i) => ({
      x: i * stepX,
      y: height - ((v - min) / range) * (height - strokeWidth * 2) - strokeWidth,
      v,
    }));
    const path = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");
    const area = `${path} L${width.toFixed(2)},${height} L0,${height} Z`;
    return { path, area, points: pts, min, max };
  }, [data, width, height, strokeWidth]);

  if (data.length === 0) {
    return (
      <div
        style={{ width, height }}
        className={clsx("text-[10px] text-zinc-600", className)}
      >
        no data
      </div>
    );
  }

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const idx = Math.round((relX / rect.width) * (data.length - 1));
    setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
  };

  const hover = hoverIdx != null ? points[hoverIdx] : null;

  return (
    <div className={clsx("relative inline-block", className)} style={{ width, height }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        className="block overflow-visible"
      >
        <path d={area} fill={fill} />
        <path
          d={path}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {showDots &&
          points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={1.5}
              fill={stroke}
              opacity={0.6}
            />
          ))}
        {hover && (
          <>
            <line
              x1={hover.x}
              y1={0}
              x2={hover.x}
              y2={height}
              stroke="rgb(82 82 91)"
              strokeWidth={1}
              strokeDasharray="2,2"
            />
            <circle
              cx={hover.x}
              cy={hover.y}
              r={3}
              fill={stroke}
              stroke="rgb(9 9 11)"
              strokeWidth={2}
            />
          </>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-zinc-700 bg-zinc-900/95 px-1.5 py-0.5 font-mono text-[10px] text-zinc-100 shadow-lg"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          {formatValue ? formatValue(hover.v) : hover.v.toFixed(2)}
        </div>
      )}
      <span className="sr-only">
        sparkline min {min.toFixed(2)} max {max.toFixed(2)}
      </span>
    </div>
  );
}
