"use client";

// Next.js App Router template — re-renders on navigation, so this is the right
// place for cross-page transition animation. Layout is kept stable; template
// fades each page body in for ~180ms when the route changes.

import { type ReactNode } from "react";

export default function DashboardTemplate({ children }: { children: ReactNode }) {
  return (
    <div className="page-transition flex h-full flex-1 flex-col">
      {children}
    </div>
  );
}
