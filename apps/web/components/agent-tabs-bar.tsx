"use client";

// AgentTabsBar — sticky tab strip rendered by the agent shell layout.
//
// Routes (sub-pages live under /agents/[name]/):
//   ""           -- Overview (the existing single-page detail)
//   /channels    -- Channels (WhatsApp pair, webchat embed, voice etc.)
//   /editor      -- Visual workflow editor
// Future tabs (Runs / Memory / Budget / Receipts / Settings) link to their
// existing top-level pages, scoped to this agent via ?agent= query param.

import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  GitBranch,
  MessageSquare,
  Play,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { Tabs } from "@/components/tabs";

export function AgentTabsBar({ name }: { name: string }) {
  const router = useRouter();
  const base = `/agents/${encodeURIComponent(name)}`;

  const tabs = [
    { id: "overview", label: "Overview", icon: FileText, href: base },
    { id: "channels", label: "Channels", icon: MessageSquare, href: `${base}/channels` },
    { id: "editor", label: "Workflow", icon: GitBranch, href: `${base}/editor` },
    // The next four point at the existing top-level pages with an agent
    // filter. We'll fold these into per-agent sub-routes in a follow-up.
    { id: "runs", label: "Runs", icon: Play, href: `/runs?agent=${encodeURIComponent(name)}` },
    { id: "receipts", label: "Receipts", icon: ShieldCheck, href: `/proof` },
    { id: "settings", label: "Settings", icon: SettingsIcon, href: `/settings?agent=${encodeURIComponent(name)}` },
  ] as const;

  return (
    <header className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b border-zinc-800 bg-surface-1/95 px-6 pb-0 pt-4 backdrop-blur-md md:px-8">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push("/agents")}
          aria-label="Back to agents list"
          className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Link
          href={`/agents/${encodeURIComponent(name)}`}
          className="truncate font-mono text-sm font-semibold text-zinc-100 hover:text-lantern-300"
          title={name}
        >
          {name}
        </Link>
      </div>
      <Tabs tabs={tabs} variant="underline" size="md" />
    </header>
  );
}
