"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type Head = { id: string; text: string; level: number };

// Toc renders an "On this page" rail from the article's h2/h3 headings and
// highlights the section in view. Scans the DOM so it works for every page
// automatically (the pages are TSX, not markdown).
export function Toc() {
  const pathname = usePathname();
  const [heads, setHeads] = useState<Head[]>([]);
  const [active, setActive] = useState("");

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const els = Array.from(
        document.querySelectorAll<HTMLElement>("article h2[id], article h3[id]")
      );
      setHeads(els.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H3" ? 3 : 2 })));

      const obs = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) setActive((e.target as HTMLElement).id);
          });
        },
        { rootMargin: "0px 0px -72% 0px", threshold: 0 }
      );
      els.forEach((h) => obs.observe(h));
      cleanup = () => obs.disconnect();
    });
    let cleanup = () => {};
    return () => { cancelAnimationFrame(id); cleanup(); };
  }, [pathname]);

  if (heads.length < 2) return null;

  return (
    <aside className="toc-rail hidden xl:block">
      <div className="toc-rail-title">On this page</div>
      <ul>
        {heads.map((h) => (
          <li key={h.id} className={h.level === 3 ? "toc-sub" : ""}>
            <a href={`#${h.id}`} className={active === h.id ? "active" : ""}>{h.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
