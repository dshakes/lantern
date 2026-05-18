// Per-agent layout shell. Used to render its own sticky header + tab strip
// (AgentTabsBar) but that created a duplicate row of tabs on top of the
// inner tabs that already live in page.tsx (Build / Chat / Runs / Schedule
// / Settings). Now we keep this layout minimal — page.tsx owns the tab
// strip and back-nav — and the layout's only remaining job is recording
// the slug as "last visited agent" so the home page can route back.

import type { ReactNode } from "react";
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
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
