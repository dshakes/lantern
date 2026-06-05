// Per-agent layout shell. Used to render its own sticky header + tab strip
// (AgentTabsBar) but that created a duplicate row of tabs on top of the
// inner tabs that already live in page.tsx (Build / Chat / Runs / Schedule
// / Settings). Now we keep this layout minimal — page.tsx owns the tab
// strip and back-nav — and the layout's only remaining job is recording
// the slug as "last visited agent" so the home page can route back.

import type { ReactNode } from "react";
import { RememberAgentVisit } from "@/components/remember-agent-visit";

// Next.js 15: dynamic route `params` is a Promise and must be awaited.
export default async function AgentLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <RememberAgentVisit name={name} />
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
