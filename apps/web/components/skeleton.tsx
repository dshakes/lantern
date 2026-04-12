import clsx from "clsx";

// ---------------------------------------------------------------------------
// Base skeleton block with pulse animation
// ---------------------------------------------------------------------------

export function Skeleton({
  className,
}: {
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "animate-pulse rounded-md bg-surface-3/60",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Table skeleton — matches DataTable layout
// ---------------------------------------------------------------------------

export function TableSkeleton({
  columns = 5,
  rows = 6,
}: {
  columns?: number;
  rows?: number;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      <table className="data-table">
        <thead>
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i}>
                <Skeleton className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, row) => (
            <tr key={row}>
              {Array.from({ length: columns }).map((_, col) => (
                <td key={col}>
                  <Skeleton
                    className={clsx(
                      "h-4",
                      col === 0 ? "w-32" : col === 1 ? "w-24" : "w-16",
                    )}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card skeleton — matches StatCard layout
// ---------------------------------------------------------------------------

export function CardSkeleton() {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 px-5 py-4">
      <Skeleton className="mb-2 h-3 w-20" />
      <Skeleton className="h-6 w-14" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page header skeleton
// ---------------------------------------------------------------------------

export function HeaderSkeleton() {
  return (
    <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
      <Skeleton className="mb-2 h-6 w-40" />
      <Skeleton className="h-4 w-64" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full page loading skeleton (agents / runs pages)
// ---------------------------------------------------------------------------

export function PageSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <HeaderSkeleton />
      <div className="flex-1 p-8">
        <TableSkeleton />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent detail skeleton
// ---------------------------------------------------------------------------

export function AgentDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <Skeleton className="mb-4 h-3 w-24" />
        <div className="flex items-start gap-3">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="mt-6 flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-8">
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run detail skeleton
// ---------------------------------------------------------------------------

export function RunDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-shrink-0 border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <Skeleton className="mb-3 h-3 w-24" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="mt-2 h-4 w-32" />
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-[2] flex-col border-r border-zinc-800">
          <div className="border-b border-zinc-800/50 bg-surface-1/50 px-6 py-3">
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-4 w-4 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        </div>
        <div className="w-96 space-y-4 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="mb-2 h-3 w-16" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="mt-1 h-4 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
