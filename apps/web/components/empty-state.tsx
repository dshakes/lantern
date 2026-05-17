import { type LucideIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode } from "react";
import clsx from "clsx";

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
  // Optional contextual suggestion chips — surfaced beneath the action
  // buttons to nudge the user toward the most useful next move.
  suggestions?: Array<{ label: string; onClick?: () => void; href?: string }>;
  // Compact mode (lower padding, smaller icon) for inline empties
  // inside cards. Default is hero-sized for whole-page empties.
  size?: "hero" | "compact";
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
  suggestions,
  size = "hero",
}: EmptyStateProps) {
  const isHero = size === "hero";
  return (
    <div
      className={clsx(
        "relative isolate flex flex-col items-center justify-center overflow-hidden text-center",
        "rounded-(--radius-xl) border border-dashed border-zinc-700/60 bg-surface-1",
        isHero ? "px-8 py-20" : "px-6 py-10"
      )}
    >
      {/* Soft halo behind the icon for a hint of depth — pure CSS, no asset. */}
      {isHero && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-12 -z-10 h-40 w-40 -translate-x-1/2 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, var(--color-accent), transparent 70%)" }}
        />
      )}
      {illustration ? (
        <div className="mb-6">{illustration}</div>
      ) : Icon ? (
        <div
          className={clsx(
            "mb-5 flex items-center justify-center rounded-2xl",
            "bg-surface-3/60 ring-1 ring-zinc-800",
            isHero ? "h-14 w-14" : "h-10 w-10"
          )}
        >
          <Icon className={clsx("text-zinc-400", isHero ? "h-6 w-6" : "h-5 w-5")} />
        </div>
      ) : null}
      <h3 className="mb-1.5 text-(--text-base) font-semibold text-zinc-100">{title}</h3>
      <p className={clsx(
        "max-w-sm text-(--text-sm) leading-(--leading-relaxed) text-zinc-500",
        (actionLabel || secondaryActionLabel || suggestions) && "mb-7"
      )}>
        {description}
      </p>
      <div className="flex flex-col items-center gap-3">
        {(actionLabel || secondaryActionLabel) && (
          <div className="flex items-center gap-3">
            {actionLabel && actionHref && !onAction && (
              <Link
                href={actionHref}
                className="inline-flex items-center gap-2 rounded-(--radius-md) bg-lantern-500 px-5 py-2.5 text-(--text-sm) font-medium text-white shadow-(--elev-1) transition-all duration-(--motion-fast) hover:bg-lantern-400 hover:shadow-(--elev-2) active:scale-[0.98]"
              >
                {actionLabel}
              </Link>
            )}
            {actionLabel && onAction && (
              <button
                onClick={onAction}
                className="inline-flex items-center gap-2 rounded-(--radius-md) bg-lantern-500 px-5 py-2.5 text-(--text-sm) font-medium text-white shadow-(--elev-1) transition-all duration-(--motion-fast) hover:bg-lantern-400 hover:shadow-(--elev-2) active:scale-[0.98]"
              >
                {actionLabel}
              </button>
            )}
            {secondaryActionLabel && secondaryActionHref && !onSecondaryAction && (
              <Link
                href={secondaryActionHref}
                className="inline-flex items-center gap-2 rounded-(--radius-md) border border-zinc-700 px-5 py-2.5 text-(--text-sm) font-medium text-zinc-300 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-100"
              >
                {secondaryActionLabel}
              </Link>
            )}
            {secondaryActionLabel && onSecondaryAction && (
              <button
                onClick={onSecondaryAction}
                className="inline-flex items-center gap-2 rounded-(--radius-md) border border-zinc-700 px-5 py-2.5 text-(--text-sm) font-medium text-zinc-300 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-100"
              >
                {secondaryActionLabel}
              </button>
            )}
          </div>
        )}
        {suggestions && suggestions.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {suggestions.map((s, i) => {
              const cls =
                "rounded-full border border-zinc-800 bg-surface-1 px-3 py-1 text-(--text-xs) text-zinc-400 transition-colors duration-(--motion-fast) hover:border-lantern-500/40 hover:bg-lantern-500/5 hover:text-lantern-200";
              if (s.href) {
                return (
                  <Link key={i} href={s.href} className={cls}>
                    {s.label}
                  </Link>
                );
              }
              return (
                <button key={i} onClick={s.onClick} className={cls}>
                  {s.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
