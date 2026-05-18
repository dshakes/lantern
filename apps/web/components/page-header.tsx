import { type ReactNode } from "react";
import clsx from "clsx";

interface PageHeaderProps {
  title: string;
  description?: string;
  badge?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  badge,
  action,
  secondaryAction,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={clsx(
        // Solid header — opaque so scrolling content doesn't bleed through.
        // Gradient sheen is clipped to the header via a wrapper, not the
        // header itself, so long descriptions never get vertically cropped.
        "relative isolate border-b border-zinc-800 bg-surface-1 px-6 py-5 md:px-8",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div
          className="absolute -left-12 -top-12 h-48 w-96 rounded-full opacity-[0.07]"
          style={{
            background:
              "radial-gradient(circle, var(--color-accent), transparent 70%)",
          }}
        />
      </div>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-500">
              {description}
            </p>
          )}
        </div>
        {(action || secondaryAction) && (
          <div className="flex shrink-0 items-center gap-2">
            {secondaryAction}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full bg-surface-3 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
      {count}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
      Demo data
    </span>
  );
}
