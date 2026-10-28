"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <span aria-hidden="true" className="text-ink-3">
        $
      </span>
      <code aria-label={label}>{command}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            // clipboard blocked (insecure context or permissions): the text stays selectable
          }
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
