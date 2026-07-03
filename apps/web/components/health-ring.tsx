// HealthRing — a small conic progress ring for a REAL 0–100 health signal
// (agent success rate today). Honest by construction: it renders only what it's
// given, color-grades by the value, and shows the number in the middle. No
// fabricated "confidence" — the caller passes a real percentage.

import clsx from "clsx";

interface HealthRingProps {
  /** 0–100. */
  value: number;
  /** px diameter. Default 34. */
  size?: number;
  /** Accessible label, e.g. "Success rate". */
  label?: string;
  className?: string;
}

function gradeColor(v: number): string {
  if (v >= 95) return "#34d399"; // emerald — healthy
  if (v >= 80) return "#2dd4bf"; // teal
  if (v >= 50) return "#fbbf24"; // amber — watch
  return "#fb7185"; // rose — hurting
}

export function HealthRing({ value, size = 34, label = "Success rate", className }: HealthRingProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const color = gradeColor(v);
  const stroke = Math.max(2.5, size * 0.09);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (v / 100) * c;

  return (
    <div
      className={clsx("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label}: ${v} percent`}
      title={`${label}: ${v}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          className="transition-[stroke-dasharray] duration-500"
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono font-semibold tabular-nums text-zinc-100"
        style={{ fontSize: size * 0.31 }}
      >
        {v}
      </span>
    </div>
  );
}
