"use client";

import { useEffect, useRef, useState } from "react";

type Tab = { label: string; lang: string; code: string };

// Tabbed code sample (curl / TypeScript / Python …). Self-highlights on tab
// change and renders its own copy button — it opts out of the global
// CodeEnhancer via the .code-tabs wrapper.
export function CodeTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let hljs;
      try {
        hljs = (await import("highlight.js/lib/common")).default;
      } catch {
        return;
      }
      const el = codeRef.current;
      if (cancelled || !el) return;
      el.textContent = tabs[active].code;
      delete el.dataset.highlighted;
      try { hljs.highlightElement(el); } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [active, tabs]);

  const copy = () => {
    navigator.clipboard?.writeText(tabs[active].code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  return (
    <div className="code-tabs">
      <div className="code-tabs-bar">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            className={i === active ? "active" : ""}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
        <button type="button" className={`code-tabs-copy ${copied ? "copied" : ""}`} onClick={copy} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code ref={codeRef} className={`language-${tabs[active].lang}`}>{tabs[active].code}</code>
      </pre>
    </div>
  );
}
