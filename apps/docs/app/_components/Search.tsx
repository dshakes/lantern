"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search as SearchIcon, CornerDownLeft } from "lucide-react";
import clsx from "clsx";

// Entry shape written by scripts/build-search-index.mjs: u=page path, a=anchor id,
// p=page title, h=section heading, b=section text.
type Entry = { u: string; a: string; p: string; h: string; b: string };
type Hit = { e: Entry; score: number; snippet: string };

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function search(index: Entry[], q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const e of index) {
    const h = e.h.toLowerCase(), p = e.p.toLowerCase(), b = e.b.toLowerCase();
    let score = 0, ok = true;
    for (const t of terms) {
      const inH = h.includes(t), inP = p.includes(t), inB = b.includes(t);
      if (!inH && !inP && !inB) { ok = false; break; }
      score += (inH ? 10 : 0) + (inP ? 4 : 0) + (inB ? 1 : 0);
    }
    if (!ok) continue;
    if (!e.h) score += 8; // a page's intro section
    const at = b.indexOf(terms[0]);
    const snippet = at < 0 ? e.b.slice(0, 110) : (at > 40 ? "…" : "") + e.b.slice(Math.max(0, at - 40), at + 90);
    hits.push({ e, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 20);
}

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [index, setIndex] = useState<Entry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ(""); setSel(0);
    input.current?.focus();
    if (index || failed) return;
    fetch(`${BASE}/search-index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Entry[]>) : Promise.reject(new Error(String(r.status)))))
      .then(setIndex)
      .catch(() => setFailed(true));
  }, [open, index, failed]);

  const hits = useMemo(() => (index ? search(index, q) : []), [index, q]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.children[sel]?.scrollIntoView({ block: "nearest" }); }, [sel]);

  if (!open) return null;
  const go = (h: Hit) => { onClose(); router.push(h.e.u + (h.e.a ? `#${h.e.a}` : "")); };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") onClose();
    else if (ev.key === "ArrowDown") { ev.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (ev.key === "Enter" && hits[sel]) { ev.preventDefault(); go(hits[sel]); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-3 pt-[10vh]" role="dialog" aria-modal="true" aria-label="Search docs" onKeyDown={onKey}>
      <div className="absolute inset-0 bg-ink/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <SearchIcon className="h-4 w-4 text-ink-3" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the docs"
            aria-label="Search query" role="combobox" aria-expanded="true" aria-controls="search-results"
            className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3" />
          <kbd className="rounded border border-line px-1 font-mono text-[10px] text-ink-3">esc</kbd>
        </div>
        <ul id="search-results" ref={list} role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {hits.map((h, i) => (
            <li key={h.e.u + h.e.a} role="option" aria-selected={i === sel}
              onMouseMove={() => setSel(i)} onClick={() => go(h)}
              className={clsx("cursor-pointer rounded-lg px-3 py-2", i === sel ? "bg-surface-2 shadow-[inset_2px_0_0_var(--lx-flame)]" : "")}>
              <div className="flex items-center gap-2 text-sm text-ink">
                <span className="font-medium">{h.e.h || h.e.p}</span>
                {h.e.h && <span className="text-xs text-ink-3">{h.e.p}</span>}
                {i === sel && <CornerDownLeft className="ml-auto h-3 w-3 text-ink-3" />}
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-2">{h.snippet}</p>
            </li>
          ))}
          {q && index && !hits.length && <li className="px-3 py-6 text-center text-sm text-ink-3">No results for “{q}”</li>}
          {failed && <li className="px-3 py-6 text-center text-sm text-signal">Search index failed to load.</li>}
          {!q && !failed && <li className="px-3 py-6 text-center text-sm text-ink-3">Type to search titles, headings and text.</li>}
        </ul>
      </div>
    </div>
  );
}
