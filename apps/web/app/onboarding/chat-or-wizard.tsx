"use client";

// Conversation first; the step wizard is the labelled fallback (ADR 0051).
// `?mode=steps` opens the wizard directly (bookmarks, the CLI's printed link).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/button";
import { Notice } from "./parts";
import { AgentChat } from "./agent-chat";
import type { ChatProduct } from "./agent-chat-logic";

export function ChatOrWizard({ product, wizard }: { product: ChatProduct; wizard: ReactNode }) {
  // null until the URL is read, so ?mode=steps never mounts (and starts) the chat.
  const [view, setView] = useState<{ kind: "chat" } | { kind: "wizard"; reason: string } | null>(null);
  useEffect(() => {
    setView(
      new URLSearchParams(window.location.search).get("mode") === "steps"
        ? { kind: "wizard", reason: "You opened the step-by-step setup." }
        : { kind: "chat" },
    );
  }, []);
  const toWizard = useCallback((reason: string) => setView({ kind: "wizard", reason }), []);

  if (!view) return <div className="min-h-screen bg-surface-0" aria-busy="true" />;
  if (view.kind === "chat") return <AgentChat key="chat" product={product} onUseWizard={toWizard} />;
  return (
    <div className="bg-surface-0">
      <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6">
        <Notice tone="warn">
          <p>
            <span className="font-medium">Step-by-step mode.</span> {view.reason} Your progress is shared with the conversation.
          </p>
          <div className="mt-2">
            <Button size="sm" variant="secondary" icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={() => setView({ kind: "chat" })}>
              Back to the conversation
            </Button>
          </div>
        </Notice>
      </div>
      {wizard}
    </div>
  );
}
