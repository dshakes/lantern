"use client";

// Tiny client island mounted by the agent shell layout. Records the
// current agent slug as "last visited" on mount + when the slug
// changes. Keeps the home-page redirect honest without making the
// layout itself a client component.

import { useEffect } from "react";
import { setLastAgent } from "@/lib/last-agent";

export function RememberAgentVisit({ name }: { name: string }) {
  useEffect(() => {
    setLastAgent(name);
  }, [name]);
  return null;
}
