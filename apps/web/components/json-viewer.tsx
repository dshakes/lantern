"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import clsx from "clsx";

// Escape HTML BEFORE adding highlight spans, so attacker-controlled run I/O
// (inbound messages, tool results) can't inject markup. Only our own <span>
// tags below contain real angle brackets; any in the data become entities.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function syntaxHighlight(json: string): string {
  return escapeHtml(json)
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)/g,
      (match) => {
        if (match.endsWith(":")) {
          return `<span class="text-blue-400">${match.slice(0, -1)}</span>:`;
        }
        return `<span class="text-emerald-400">${match}</span>`;
      }
    )
    .replace(/\b(true|false)\b/g, '<span class="text-amber-400">$1</span>')
    .replace(/\b(null)\b/g, '<span class="text-zinc-500">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="text-purple-400">$1</span>');
}

interface JsonViewerProps {
  data: unknown;
  label: string;
  defaultOpen?: boolean;
}

export function JsonViewer({ data, label, defaultOpen = false }: JsonViewerProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (data === undefined || data === null) return null;

  const formatted = JSON.stringify(data, null, 2);
  const highlighted = syntaxHighlight(formatted);

  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <pre
            className={clsx(
              "max-h-64 overflow-auto font-mono text-xs leading-relaxed text-zinc-300"
            )}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </div>
      )}
    </div>
  );
}
