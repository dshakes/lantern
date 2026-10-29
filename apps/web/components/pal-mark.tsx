// The PAL "Held" mark (same geometry as site/public/brand/mark.svg): a ring
// holding an ember beside a stem. The ring follows the theme via currentColor.
// Renamed from LanternMark (ADR 0032); all importers updated.
export function PalMark({ className = "h-6 w-6 text-zinc-50" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} role="img" aria-label="PAL">
      <circle cx="32" cy="34" r="15" stroke="currentColor" fill="none" strokeWidth="8" strokeLinecap="round" />
      <path d="M47 19 V49" stroke="currentColor" fill="none" strokeWidth="8" strokeLinecap="round" />
      <circle cx="32" cy="34" r="6" fill="#ff5b2e" />
    </svg>
  );
}

