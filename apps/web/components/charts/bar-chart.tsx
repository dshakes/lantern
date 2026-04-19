"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  data: BarDatum[];
  height?: number;
  className?: string;
  formatValue?: (n: number) => string;
  defaultColor?: string;
  showLabels?: boolean;
  orientation?: "vertical" | "horizontal";
}

export function BarChart({
  data,
  height = 200,
  className,
  formatValue = (n) => n.toLocaleString(),
  defaultColor = "rgb(168 85 247)",
  showLabels = true,
  orientation = "vertical",
}: BarChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const max = useMemo(
    () => Math.max(1, ...data.map((d) => d.value)),
    [data],
  );

  if (data.length === 0) {
    return (
      <div
        style={{ height }}
        className={clsx(
          "flex items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-surface-1 text-xs text-zinc-600",
          className,
        )}
      >
        No data
      </div>
    );
  }

  if (orientation === "horizontal") {
    return (
      <div
        className={clsx("flex flex-col gap-2", className)}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const color = d.color ?? defaultColor;
          const active = hoverIdx === i;
          return (
            <div
              key={d.label + i}
              className="group relative flex items-center gap-3"
              onMouseEnter={() => setHoverIdx(i)}
            >
              {showLabels && (
                <div className="w-28 truncate text-right text-xs text-zinc-400">
                  {d.label}
                </div>
              )}
              <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-surface-2">
                <div
                  className="h-full rounded-md transition-all duration-300"
                  style={{
                    width: `${pct}%`,
                    background: color,
                    opacity: active ? 1 : 0.85,
                  }}
                />
                <div
                  className={clsx(
                    "pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-[11px] tabular-nums",
                    active ? "text-zinc-50" : "text-zinc-400",
                  )}
                >
                  {formatValue(d.value)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // vertical
  const barGap = 4;
  return (
    <div className={clsx("relative", className)} style={{ height }}>
      <div
        className="flex h-full items-end gap-1 px-1"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const color = d.color ?? defaultColor;
          const active = hoverIdx === i;
          return (
            <button
              key={d.label + i}
              onMouseEnter={() => setHoverIdx(i)}
              type="button"
              className="group relative flex h-full flex-1 flex-col items-center justify-end"
              style={{ marginRight: i === data.length - 1 ? 0 : barGap }}
            >
              {active && (
                <div className="pointer-events-none absolute -top-9 z-10 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900/95 px-2 py-1 font-mono text-[10px] text-zinc-100 shadow-lg">
                  <div className="font-sans text-zinc-400">{d.label}</div>
                  <div>{formatValue(d.value)}</div>
                </div>
              )}
              <div
                className="w-full rounded-t-sm transition-all duration-300"
                style={{
                  height: `${pct}%`,
                  background: color,
                  opacity: active ? 1 : 0.75,
                  minHeight: 2,
                }}
              />
              {showLabels && (
                <div className="mt-1 max-w-full truncate text-[10px] text-zinc-500">
                  {d.label}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
