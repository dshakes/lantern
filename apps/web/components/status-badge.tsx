import clsx from "clsx";
import type { RunStatus } from "@/lib/mock-data";

const statusConfig: Record<
  RunStatus,
  { bg: string; text: string; dot: string; pulse?: boolean }
> = {
  queued: {
    bg: "bg-zinc-500/10",
    text: "text-zinc-400",
    dot: "bg-zinc-400",
  },
  running: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    dot: "bg-blue-400",
    pulse: true,
  },
  paused: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    dot: "bg-yellow-400",
  },
  succeeded: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
  },
  failed: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    dot: "bg-red-400",
  },
  cancelled: {
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    dot: "bg-amber-400",
  },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const config = statusConfig[status];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        config.bg,
        config.text
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full",
          config.dot,
          config.pulse && "status-running"
        )}
      />
      {status}
    </span>
  );
}
