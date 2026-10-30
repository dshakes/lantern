"use client";

// Inline "Ask PAL" bar for the home pages. Hands the query to the one ⌘K
// engine (openAsk) so every command bar shares validation + confirm steps.

import { useState, type FormEvent } from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { openAsk } from "@/lib/ask-events";

export function AskBar({ placeholder, examples }: { placeholder: string; examples: string[] }) {
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    openAsk({ query: q.trim(), submit: true });
    setQ("");
  };
  return (
    <div>
      <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-surface-1 px-3 py-2 shadow-sm transition-colors focus-within:border-pal-500/50">
        <Sparkles className="h-4 w-4 shrink-0 text-pal-400" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label="Ask PAL"
          className="min-w-0 flex-1 bg-transparent py-1 text-sm text-zinc-100 !shadow-none !outline-none placeholder:text-zinc-500"
        />
        <button
          type="submit"
          aria-label="Send to PAL"
          disabled={q.trim().length < 2}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-pal-400 text-on-flame transition-opacity disabled:opacity-30"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => openAsk({ query: ex, submit: true })}
            className="rounded-full border border-zinc-800 bg-surface-1 px-2.5 py-1 text-[12px] text-zinc-400 transition-colors hover:border-pal-500/40 hover:text-zinc-100"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
