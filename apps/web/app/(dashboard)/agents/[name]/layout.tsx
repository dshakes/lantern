// Per-agent workspace shell. Wraps every route under /agents/[name]/* with a
// sticky agent header + tab strip so the agent reads like one workspace, not
// six unrelated pages.
//
// The existing /agents/[name]/page.tsx remains the "Overview" tab. New tabs:
//   - Channels    /agents/[name]/channels         (and /channels/whatsapp etc.)
//   - Workflow    /agents/[name]/editor           (existing visual editor)
//   - (future)    /agents/[name]/runs, /memory, /budget, /receipts
//
// Also records the slug as "last visited agent" so the home page can route
// the user straight back here on next visit.

import type { ReactNode } from "react";
import { AgentTabsBar } from "@/components/agent-tabs-bar";
import { RememberAgentVisit } from "@/components/remember-agent-visit";

export default function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { name: string };
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <RememberAgentVisit name={params.name} />
      {/* Sticky tab strip — sits beneath the dashboard top-bar; never scrolls. */}
      <AgentTabsBar name={params.name} />
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
