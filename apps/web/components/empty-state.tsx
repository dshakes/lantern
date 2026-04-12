import { type LucideIcon } from "lucide-react";
import Link from "next/link";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-surface-1 px-8 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-3">
        <Icon className="h-6 w-6 text-zinc-500" />
      </div>
      <h3 className="mb-1 text-sm font-medium text-zinc-200">{title}</h3>
      <p className="mb-6 max-w-sm text-sm text-zinc-500">{description}</p>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-lantern-400"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
