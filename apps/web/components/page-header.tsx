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
        "border-b border-zinc-800 bg-surface-1 px-8 py-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
              {title}
            </h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">
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
