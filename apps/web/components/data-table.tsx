"use client";

import { ReactNode, useState, useCallback, useMemo, useRef } from "react";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Inbox,
} from "lucide-react";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
  sortFn?: (a: T, b: T) => number;
  width?: number;
  minWidth?: number;
}

interface RowAction<T> {
  label: string;
  icon: typeof Eye;
  onClick: (row: T) => void;
  variant?: "default" | "danger";
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
  pageSize?: number;
  rowActions?: RowAction<T>[];
  emptyIcon?: typeof Inbox;
  emptyTitle?: string;
  emptyDescription?: string;
}

type SortDir = "asc" | "desc" | null;

export function DataTable<T>({
  columns,
  rows,
  onRowClick,
  rowKey,
  pageSize = 10,
  rowActions,
  emptyIcon: EmptyIcon = Inbox,
  emptyTitle = "No data",
  emptyDescription = "There are no items to display.",
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [page, setPage] = useState(0);
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  // Sort
  const sortedRows = useMemo(() => {
    if (!sortKey || !sortDir) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortFn) return rows;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => col.sortFn!(a, b) * direction);
  }, [rows, sortKey, sortDir, columns]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const paginatedRows = sortedRows.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev !== key) {
        setSortDir("asc");
        return key;
      }
      setSortDir((d) => {
        if (d === "asc") return "desc";
        if (d === "desc") return null;
        return "asc";
      });
      return key;
    });
  }, []);

  // Resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, colKey: string, defaultWidth: number) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = columnWidths[colKey] ?? defaultWidth;
      resizingRef.current = { key: colKey, startX, startWidth };

      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const diff = ev.clientX - resizingRef.current.startX;
        const minW = columns.find((c) => c.key === colKey)?.minWidth ?? 60;
        const newWidth = Math.max(minW, resizingRef.current.startWidth + diff);
        setColumnWidths((prev) => ({ ...prev, [colKey]: newWidth }));
      };

      const onUp = () => {
        resizingRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [columnWidths, columns],
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700/60 bg-surface-1 px-8 py-20 text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-3/60">
          <EmptyIcon className="h-7 w-7 text-zinc-500" />
        </div>
        <h3 className="mb-1.5 text-sm font-semibold text-zinc-200">{emptyTitle}</h3>
        <p className="max-w-xs text-sm leading-relaxed text-zinc-500">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          {/* Sticky header */}
          <thead className="sticky top-0 z-10 bg-surface-1">
            <tr>
              {columns.map((col) => {
                const isSorted = sortKey === col.key;
                const width = columnWidths[col.key] ?? col.width;
                return (
                  <th
                    key={col.key}
                    className={`relative border-b border-zinc-800 px-4 py-3 text-left text-xs font-medium uppercase tracking-[0.05em] text-zinc-500 ${
                      col.sortable ? "cursor-pointer select-none hover:text-zinc-300" : ""
                    } ${col.className ?? ""}`}
                    style={width ? { width, minWidth: col.minWidth ?? 60 } : undefined}
                    onClick={() => col.sortable && handleSort(col.key)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{col.header}</span>
                      {col.sortable && (
                        <span className="inline-flex flex-col">
                          {isSorted && sortDir === "asc" ? (
                            <ChevronUp className="h-3.5 w-3.5 text-lantern-400" />
                          ) : isSorted && sortDir === "desc" ? (
                            <ChevronDown className="h-3.5 w-3.5 text-lantern-400" />
                          ) : (
                            <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-600" />
                          )}
                        </span>
                      )}
                    </div>
                    {/* Resize handle */}
                    <div
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-lantern-500/30"
                      onMouseDown={(e) => handleResizeStart(e, col.key, width ?? 150)}
                    />
                  </th>
                );
              })}
              {/* Actions column placeholder */}
              {rowActions && rowActions.length > 0 && (
                <th className="w-10 border-b border-zinc-800" />
              )}
            </tr>
          </thead>
          <tbody>
            {paginatedRows.map((row) => {
              const key = rowKey(row);
              const isHovered = hoveredRowKey === key;
              return (
                <tr
                  key={key}
                  className={`border-b border-zinc-800/40 transition-colors hover:bg-surface-2 ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                  onClick={() => onRowClick?.(row)}
                  onMouseEnter={() => setHoveredRowKey(key)}
                  onMouseLeave={() => setHoveredRowKey(null)}
                >
                  {columns.map((col) => {
                    const width = columnWidths[col.key] ?? col.width;
                    return (
                      <td
                        key={col.key}
                        className={`px-4 py-3 text-sm text-zinc-300 ${col.className ?? ""}`}
                        style={width ? { width, minWidth: col.minWidth ?? 60 } : undefined}
                      >
                        {col.render(row)}
                      </td>
                    );
                  })}
                  {/* Row actions */}
                  {rowActions && rowActions.length > 0 && (
                    <td
                      className="px-3 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        className={`flex items-center gap-1 transition-opacity ${
                          isHovered ? "opacity-100" : "opacity-0"
                        }`}
                      >
                        {rowActions.map((action) => (
                          <button
                            key={action.label}
                            onClick={() => action.onClick(row)}
                            className={`rounded-md p-1.5 transition-colors ${
                              action.variant === "danger"
                                ? "text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
                                : "text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
                            }`}
                            title={action.label}
                          >
                            <action.icon className="h-3.5 w-3.5" />
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2.5">
        <span className="text-xs text-zinc-500">
          Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sortedRows.length)} of{" "}
          {sortedRows.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="px-2 text-xs text-zinc-400">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
