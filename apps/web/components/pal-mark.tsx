import { useId } from "react";

// The PAL "Held" p-mark (geometry of site/public/brand/mark.svg): a stem and a
// ring holding an ember. The strokes follow the theme via currentColor; the
// ember is the brand coral -> magenta gradient.
export function PalMark({ className = "h-6 w-6 text-zinc-50" }: { className?: string }) {
  const id = `pal-ember-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="8 5.5 49 56" className={className} role="img" aria-label="PAL">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff7a3d" />
          <stop offset="1" stopColor="#e5207f" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.5 13 V54" />
        <circle cx="32.5" cy="28" r="15" />
      </g>
      <circle cx="32.5" cy="28" r="6.5" fill={`url(#${id})`} />
    </svg>
  );
}
