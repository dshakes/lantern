"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

// Map of path segments to display labels
const segmentLabels: Record<string, string> = {
  agents: "Agents",
  runs: "Runs",
  surfaces: "Channels",
  connectors: "Connectors",
  deployments: "Deployments",
  settings: "Settings",
  editor: "Editor",
  create: "Create",
};

function formatSegment(segment: string): string {
  if (segmentLabels[segment]) return segmentLabels[segment];
  // Truncate long IDs like run_01hqa1b2c3d4
  if (segment.length > 14) return segment.slice(0, 12) + "...";
  return segment;
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;
  // Hide on top-level pages — the PageHeader below already shows the same
  // word in large type, no point repeating it tiny in the top bar.
  if (segments.length === 1) return null;

  const crumbs = segments.map((segment, i) => {
    const href = "/" + segments.slice(0, i + 1).join("/");
    const isLast = i === segments.length - 1;
    const label = formatSegment(segment);

    return { href, label, isLast };
  });

  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => (
        <div key={crumb.href} className="flex items-center gap-1">
          {i > 0 && (
            <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
          )}
          {crumb.isLast ? (
            <span className="font-medium text-zinc-300">{crumb.label}</span>
          ) : (
            <Link
              href={crumb.href}
              className="text-zinc-500 transition-colors hover:text-zinc-300"
            >
              {crumb.label}
            </Link>
          )}
        </div>
      ))}
    </nav>
  );
}
