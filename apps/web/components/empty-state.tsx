import { type LucideIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode } from "react";

interface EmptyStateProps {
  icon?: LucideIcon;
  illustration?: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  secondaryActionHref?: string;
  onSecondaryAction?: () => void;
}

export function EmptyState({
  icon: Icon,
  illustration,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  secondaryActionLabel,
  secondaryActionHref,
  onSecondaryAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700/60 bg-surface-1 px-8 py-20 text-center">
      {illustration ? (
        <div className="mb-6">{illustration}</div>
      ) : Icon ? (
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-3/60">
          <Icon className="h-7 w-7 text-zinc-500" />
        </div>
      ) : null}
      <h3 className="mb-1.5 text-sm font-semibold text-zinc-200">{title}</h3>
      <p className="mb-8 max-w-xs text-sm leading-relaxed text-zinc-500">
        {description}
      </p>
      <div className="flex items-center gap-3">
        {actionLabel && actionHref && !onAction && (
          <Link
            href={actionHref}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 active:scale-[0.98]"
          >
            {actionLabel}
          </Link>
        )}
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 active:scale-[0.98]"
          >
            {actionLabel}
          </button>
        )}
        {secondaryActionLabel && secondaryActionHref && !onSecondaryAction && (
          <Link
            href={secondaryActionHref}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
          >
            {secondaryActionLabel}
          </Link>
        )}
        {secondaryActionLabel && onSecondaryAction && (
          <button
            onClick={onSecondaryAction}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
          >
            {secondaryActionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
