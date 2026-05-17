"use client";

// Tabs — keyboard-accessible, URL-synced segmented control.
//
// Designed for the per-agent workspace (W12) where one route owns a row
// of sub-views (Chat · Runs · Workflow · …). The active tab lives in a
// URL search param so deep links + browser back work natively. Optional
// `pathSync` mode pushes tabs into the route segment instead — used for
// the agent shell where each tab is a separate file under
// `(dashboard)/agents/[name]/[tab]/page.tsx`.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export interface TabDef {
  id: string;
  label: string;
  icon?: LucideIcon;
  href?: string;        // when set, tab is a Link (used by route-based tabs)
  badge?: number | string;
  disabled?: boolean;
  // For the underline indicator's nice spring animation we measure each
  // tab's width on mount. Components don't need to provide anything — the
  // ref is captured internally.
}

interface TabsProps {
  tabs: readonly TabDef[];
  // Either a controlled value + onChange, OR omit both to let the URL
  // search param (`?tab=`) drive it. URL mode is preferred for deep-link
  // friendliness.
  value?: string;
  onChange?: (id: string) => void;
  paramName?: string;         // defaults to "tab"
  className?: string;
  // Visual variant — "underline" (default) is the spec tabs; "pills"
  // is a softer rounded look for shallower nesting.
  variant?: "underline" | "pills";
  size?: "sm" | "md";
}

export function Tabs({
  tabs,
  value,
  onChange,
  paramName = "tab",
  className,
  variant = "underline",
  size = "md",
}: TabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve which tab is currently active. Order of precedence:
  //   1. controlled `value` from caller
  //   2. URL search param (?tab=...)
  //   3. matching tab.href === pathname (route-tabbed shell)
  //   4. first non-disabled tab
  const resolveActive = useCallback(() => {
    if (value) return value;
    const fromURL = params.get(paramName);
    if (fromURL && tabs.some((t) => t.id === fromURL)) return fromURL;
    const matchedHref = tabs.find(
      (t) => t.href && (pathname === t.href || pathname.startsWith(t.href + "/"))
    );
    if (matchedHref) return matchedHref.id;
    return tabs.find((t) => !t.disabled)?.id ?? tabs[0]?.id;
  }, [value, params, paramName, pathname, tabs]);

  const [activeId, setActiveId] = useState<string | undefined>(() => resolveActive());

  // Re-derive when URL/value changes. Avoids stale state after a Link nav.
  useEffect(() => {
    setActiveId(resolveActive());
  }, [resolveActive]);

  const select = useCallback(
    (id: string) => {
      const next = tabs.find((t) => t.id === id);
      if (!next || next.disabled) return;
      onChange?.(id);
      if (next.href) {
        // Route-based tabs let Next handle the navigation — Link does it
        // for us when the user clicks, but for keyboard arrows we router.push.
        router.push(next.href);
        return;
      }
      if (!value) {
        const sp = new URLSearchParams(params.toString());
        sp.set(paramName, id);
        router.replace(`${pathname}?${sp.toString()}`);
      }
      setActiveId(id);
    },
    [tabs, onChange, router, pathname, params, paramName, value]
  );

  // Keyboard nav: left/right arrows cycle through enabled tabs.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!activeId) return;
      const enabled = tabs.filter((t) => !t.disabled);
      const idx = enabled.findIndex((t) => t.id === activeId);
      if (idx < 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        select(enabled[(idx + 1) % enabled.length].id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        select(enabled[(idx - 1 + enabled.length) % enabled.length].id);
      } else if (e.key === "Home") {
        e.preventDefault();
        select(enabled[0].id);
      } else if (e.key === "End") {
        e.preventDefault();
        select(enabled[enabled.length - 1].id);
      }
    },
    [activeId, tabs, select]
  );

  return (
    <div
      role="tablist"
      ref={containerRef}
      onKeyDown={onKeyDown}
      className={clsx(
        "flex items-center",
        variant === "underline"
          ? "gap-1 border-b border-zinc-800 overflow-x-auto"
          : "gap-1 rounded-lg bg-surface-2 p-1",
        className
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const Icon = tab.icon;
        const content = (
          <>
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
            <span className="whitespace-nowrap">{tab.label}</span>
            {tab.badge != null && (
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                  isActive
                    ? "bg-lantern-500/20 text-lantern-200"
                    : "bg-surface-3 text-zinc-500"
                )}
              >
                {tab.badge}
              </span>
            )}
          </>
        );
        const baseCls = clsx(
          "relative inline-flex items-center gap-1.5 transition-colors duration-150",
          size === "sm" ? "h-7 px-2.5 text-[11px]" : "h-9 px-3 text-[12px]",
          "font-medium",
          tab.disabled && "cursor-not-allowed opacity-40",
          variant === "underline"
            ? clsx(
                isActive ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
              )
            : clsx(
                "rounded-md",
                isActive
                  ? "bg-surface-0 text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              )
        );

        if (tab.href) {
          return (
            <Link
              key={tab.id}
              href={tab.href}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={baseCls}
              onClick={(e) => {
                // Allow modifier-clicks through to default Link behavior
                // (open in new tab etc) but for plain clicks let our
                // select() drive the active state so the indicator
                // animates immediately, before Next finishes nav.
                if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                setActiveId(tab.id);
              }}
            >
              {content}
              {variant === "underline" && (
                <span
                  className={clsx(
                    "absolute inset-x-0 -bottom-px h-0.5 transition-opacity duration-150",
                    isActive ? "bg-lantern-400 opacity-100" : "opacity-0"
                  )}
                />
              )}
            </Link>
          );
        }

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => select(tab.id)}
            className={baseCls}
          >
            {content}
            {variant === "underline" && (
              <span
                className={clsx(
                  "absolute inset-x-0 -bottom-px h-0.5 transition-opacity duration-150",
                  isActive ? "bg-lantern-400 opacity-100" : "opacity-0"
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- TabPanel — optional wrapper for content panels. Keeps the
// role/aria correct without forcing it on every consumer.
export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className="outline-none"
    >
      {active && children}
    </div>
  );
}

// useTabBadgeMemo — small helper that returns a stable badge object so
// callers can pass `{ badge: badges.runs }` without re-rendering the
// Tabs on every parent re-render.
export function useTabBadges<T extends Record<string, number | string | undefined>>(
  badges: T
): T {
  return useMemo(() => badges, [JSON.stringify(badges)]);
}
