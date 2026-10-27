// The brand mark: a flame held inside glass. Same geometry as docs/brand and
// the landing site's LanternMark; colors come from the --lx-* tokens in
// app/globals.css so it follows the theme.
export function LanternMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M9 3.5h6" stroke="var(--lx-ink-2)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <rect x="5" y="6" width="14" height="15" rx="4" fill="none" stroke="var(--lx-glass)" strokeWidth="1.8" />
      <path
        d="M12 9.2c1.9 2 3 3.6 3 5.4a3 3 0 0 1-6 0c0-1.2.6-2.1 1.4-2.9.1 1 .6 1.6 1.2 1.8-.4-1.4-.1-2.8.4-4.3Z"
        fill="var(--lx-flame)"
      />
    </svg>
  );
}
