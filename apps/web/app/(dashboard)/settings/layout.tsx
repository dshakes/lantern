"use client";

// Settings shell: shared header + a nav rendered from lib/settings-nav.ts.
// Other pages slot in by adding a route under /settings and one array entry.

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Cpu, CreditCard, Key, Settings2, Shield, Smartphone, Users, type LucideIcon } from "lucide-react";
import { ToastProvider } from "@/components/settings/toast";
import { PageHeader } from "@/components/page-header";
import { SETTINGS_NAV, isSettingsActive, type SettingsIcon } from "@/lib/settings-nav";

const ICONS: Record<SettingsIcon, LucideIcon> = {
  settings: Settings2, key: Key, cpu: Cpu, users: Users, card: CreditCard, smartphone: Smartphone, shield: Shield,
};

function SettingsNav() {
  const pathname = usePathname() ?? "/settings";
  const tab = useSearchParams().get("tab");
  return (
    <nav aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto pb-1 md:mx-0 md:flex-col md:overflow-visible md:pb-0">
      {SETTINGS_NAV.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isSettingsActive(item, pathname, tab);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition-colors",
              active ? "bg-surface-3 text-zinc-50" : "text-zinc-400 hover:bg-surface-2 hover:text-zinc-100",
            )}
          >
            <Icon className={clsx("h-4 w-4", active ? "text-pal-400" : "text-zinc-500")} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex flex-1 flex-col overflow-auto">
        <PageHeader title="Settings" description="Model providers, API keys, team access and billing for this workspace." />
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:flex-row md:px-8 md:py-8">
          <aside className="md:w-52 md:shrink-0">
            <Suspense fallback={null}>
              <SettingsNav />
            </Suspense>
          </aside>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </div>
    </ToastProvider>
  );
}
