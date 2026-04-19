// Custom inline SVG illustrations for empty states.
// Stroke-based, monochrome violet/zinc — match the dashboard palette.
// Each illustration is purposely sparse (≤25 elements) so it renders crisply
// at 96–160px and never feels "stock illustration"-y.

import clsx from "clsx";

interface IllustrationProps {
  className?: string;
  size?: number;
}

const grad = "url(#lantern-grad)";
const stroke = "rgb(168 85 247)";

function GradDef() {
  return (
    <defs>
      <linearGradient id="lantern-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="rgb(168 85 247 / 0.25)" />
        <stop offset="100%" stopColor="rgb(168 85 247 / 0.05)" />
      </linearGradient>
    </defs>
  );
}

// ── Agents ──────────────────────────────────────────────────────────────────
export function AgentsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="20" y="40" width="80" height="56" rx="10" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <circle cx="44" cy="60" r="3" fill={stroke} />
      <circle cx="76" cy="60" r="3" fill={stroke} />
      <path d="M44 78 Q60 86 76 78" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="60" y1="40" x2="60" y2="28" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="60" cy="24" r="4" fill="rgb(168 85 247 / 0.4)" stroke={stroke} strokeWidth="1.5" />
      <line x1="20" y1="100" x2="100" y2="100" stroke="rgb(63 63 70)" strokeWidth="1" strokeDasharray="3 3" />
    </svg>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────────
export function RunsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="20" y="32" width="80" height="10" rx="3" fill={grad} stroke={stroke} strokeWidth="1.2" />
      <rect x="20" y="50" width="64" height="10" rx="3" fill="rgb(63 63 70 / 0.4)" stroke="rgb(82 82 91)" strokeWidth="1.2" />
      <rect x="20" y="68" width="48" height="10" rx="3" fill="rgb(63 63 70 / 0.4)" stroke="rgb(82 82 91)" strokeWidth="1.2" />
      <circle cx="92" cy="86" r="14" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <path d="M88 86 L92 90 L98 82" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Budgets ─────────────────────────────────────────────────────────────────
export function BudgetsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <circle cx="60" cy="60" r="36" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <path d="M60 24 A36 36 0 0 1 96 60 L60 60 Z" fill="rgb(168 85 247 / 0.35)" />
      <text x="60" y="66" textAnchor="middle" fill={stroke} fontSize="14" fontFamily="ui-monospace" fontWeight="600">$</text>
      <line x1="20" y1="106" x2="100" y2="106" stroke="rgb(82 82 91)" strokeWidth="1" />
      <line x1="40" y1="106" x2="40" y2="100" stroke="rgb(82 82 91)" strokeWidth="1" />
      <line x1="80" y1="106" x2="80" y2="100" stroke="rgb(82 82 91)" strokeWidth="1" />
    </svg>
  );
}

// ── Experiments ─────────────────────────────────────────────────────────────
export function ExperimentsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="20" y="36" width="36" height="60" rx="6" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <rect x="64" y="48" width="36" height="48" rx="6" fill="rgb(34 197 94 / 0.15)" stroke="rgb(34 197 94)" strokeWidth="1.5" />
      <text x="38" y="68" textAnchor="middle" fill={stroke} fontSize="12" fontWeight="700">A</text>
      <text x="82" y="74" textAnchor="middle" fill="rgb(34 197 94)" fontSize="12" fontWeight="700">B</text>
      <path d="M30 24 L60 16 L90 24" fill="none" stroke="rgb(82 82 91)" strokeWidth="1.5" strokeDasharray="3 3" />
      <circle cx="60" cy="14" r="3" fill={stroke} />
    </svg>
  );
}

// ── Eval suites ─────────────────────────────────────────────────────────────
export function EvalIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="22" y="22" width="76" height="76" rx="8" fill={grad} stroke={stroke} strokeWidth="1.5" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x="32" y={36 + i * 14} width="10" height="10" rx="2" fill={i < 3 ? "rgb(34 197 94 / 0.3)" : "rgb(239 68 68 / 0.3)"} stroke={i < 3 ? "rgb(34 197 94)" : "rgb(239 68 68)"} strokeWidth="1" />
          <line x1="48" y1={41 + i * 14} x2="86" y2={41 + i * 14} stroke="rgb(82 82 91)" strokeWidth="1" />
        </g>
      ))}
    </svg>
  );
}

// ── Marketplace ─────────────────────────────────────────────────────────────
export function MarketplaceIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      {[
        { x: 22, y: 26 },
        { x: 64, y: 26 },
        { x: 22, y: 68 },
        { x: 64, y: 68 },
      ].map((p, i) => (
        <rect key={i} x={p.x} y={p.y} width="34" height="26" rx="5" fill={i === 0 ? grad : "rgb(63 63 70 / 0.4)"} stroke={i === 0 ? stroke : "rgb(82 82 91)"} strokeWidth="1.2" />
      ))}
      <path d="M30 38 L34 42 L42 32" fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="98" cy="98" r="12" fill="rgb(168 85 247 / 0.2)" stroke={stroke} strokeWidth="1.5" />
      <path d="M98 92 L98 104 M92 98 L104 98" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Connectors ──────────────────────────────────────────────────────────────
export function ConnectorsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <circle cx="32" cy="32" r="14" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <circle cx="88" cy="32" r="14" fill="rgb(63 63 70 / 0.5)" stroke="rgb(82 82 91)" strokeWidth="1.5" />
      <circle cx="60" cy="86" r="18" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <line x1="42" y1="40" x2="56" y2="72" stroke={stroke} strokeWidth="1.5" strokeDasharray="4 3" />
      <line x1="78" y1="40" x2="64" y2="72" stroke="rgb(82 82 91)" strokeWidth="1.5" strokeDasharray="4 3" />
      <text x="60" y="92" textAnchor="middle" fill={stroke} fontSize="14" fontFamily="ui-monospace" fontWeight="700">↔</text>
    </svg>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────
export function SurfacesIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="22" y="24" width="36" height="50" rx="5" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <rect x="62" y="32" width="36" height="42" rx="5" fill="rgb(63 63 70 / 0.4)" stroke="rgb(82 82 91)" strokeWidth="1.5" />
      <rect x="42" y="84" width="36" height="14" rx="3" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <circle cx="40" cy="40" r="2" fill={stroke} />
      <line x1="46" y1="40" x2="54" y2="40" stroke={stroke} strokeWidth="1.2" />
      <circle cx="80" cy="48" r="2" fill="rgb(82 82 91)" />
      <line x1="68" y1="48" x2="78" y2="48" stroke="rgb(82 82 91)" strokeWidth="1.2" />
    </svg>
  );
}

// ── Deployments ─────────────────────────────────────────────────────────────
export function DeploymentsIllustration({ className, size = 120 }: IllustrationProps) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={clsx(className)}>
      <GradDef />
      <rect x="22" y="68" width="76" height="32" rx="6" fill={grad} stroke={stroke} strokeWidth="1.5" />
      <rect x="32" y="78" width="56" height="4" rx="2" fill="rgb(168 85 247 / 0.4)" />
      <rect x="32" y="88" width="40" height="4" rx="2" fill="rgb(82 82 91)" />
      <path d="M60 56 L60 24 M50 34 L60 24 L70 34" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="60" cy="60" r="3" fill={stroke} />
    </svg>
  );
}
