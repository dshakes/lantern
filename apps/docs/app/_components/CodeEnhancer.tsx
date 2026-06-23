"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// CodeEnhancer upgrades every <pre><code> in the article: syntax highlighting
// (highlight.js, loaded client-side) + a copy button + a terminal-dots chrome.
// Runs on mount and on every route change.
export function CodeEnhancer() {
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      let hljs;
      try {
        hljs = (await import("highlight.js/lib/common")).default;
      } catch {
        return; // highlighter unavailable — leave code as-is, never break the page
      }
      if (cancelled) return;

      document.querySelectorAll<HTMLElement>("article pre").forEach((pre) => {
        const code = pre.querySelector("code");
        if (!code) return;

        // 1) Highlight once.
        if (!code.dataset.hl) {
          try { hljs.highlightElement(code); } catch { /* noop */ }
          code.dataset.hl = "1";
        }

        // 2) Add chrome + copy button once.
        if (pre.dataset.enhanced) return;
        pre.dataset.enhanced = "1";

        const chrome = document.createElement("div");
        chrome.className = "code-chrome";
        chrome.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-btn";
        btn.setAttribute("aria-label", "Copy code");
        btn.textContent = "Copy";
        btn.addEventListener("click", () => {
          navigator.clipboard?.writeText(code.innerText).then(() => {
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
          }).catch(() => {});
        });

        pre.prepend(chrome);
        pre.appendChild(btn);
      });
    };

    const id = requestAnimationFrame(() => { void run(); });
    return () => { cancelled = true; cancelAnimationFrame(id); };
  }, [pathname]);

  return null;
}
