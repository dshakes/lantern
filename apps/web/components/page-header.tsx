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
        // Subtle glass effect — backdrop-blur on a translucent surface
        // gives every page header a consistent "floating" feel against
        // scrolling content. Sticky so it stays visible on long pages.
        "sticky top-0 z-10 border-b border-zinc-800 bg-surface-1/85 px-6 py-5 backdrop-blur-md md:px-8",
        // Soft gradient sheen behind the title — pure CSS, no asset.
        "relative isolate overflow-hidden",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -left-12 -top-12 -z-10 h-48 w-96 rounded-full opacity-[0.07]"
        style={{
          background:
            "radial-gradient(circle, var(--color-accent), transparent 70%)",
        }}
      />
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-(--text-xl) font-semibold tracking-tight text-zinc-100">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-(--text-sm) leading-(--leading-relaxed) text-zinc-500">
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
