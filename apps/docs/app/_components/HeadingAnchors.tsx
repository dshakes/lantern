"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// HeadingAnchors adds a clickable "#" deep-link to every section heading that
// has an id, so readers can grab a link straight to any sub-section (and the
// heading itself becomes a stable anchor target). Idempotent; runs on mount and
// every route change. Mirrors CodeEnhancer's enhance-the-DOM pattern.
export function HeadingAnchors() {
  const pathname = usePathname();

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>("article h2[id], article h3[id]")
        .forEach((h) => {
          if (h.dataset.anchored) return;
          h.dataset.anchored = "1";
          h.classList.add("has-anchor");

          const a = document.createElement("a");
          a.href = "#" + h.id;
          a.className = "heading-anchor";
          a.setAttribute("aria-label", `Link to "${h.textContent?.trim() ?? h.id}"`);
          a.textContent = "#";
          h.appendChild(a);
        });
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return null;
}
