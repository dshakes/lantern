import { type LucideIcon } from "lucide-react";
import Link from "next/link";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700/60 bg-surface-1 px-8 py-20 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-3/60">
        <Icon className="h-7 w-7 text-zinc-500" />
      </div>
      <h3 className="mb-1.5 text-sm font-semibold text-zinc-200">{title}</h3>
      <p className="mb-8 max-w-xs text-sm leading-relaxed text-zinc-500">{description}</p>
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
    </div>
  );
}
