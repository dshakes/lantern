"use client";

import { useState, useRef, useEffect } from "react";
import { MessageSquare, X, Send, Bot, User } from "lucide-react";
import clsx from "clsx";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Mock conversation
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: number;
  role: "user" | "agent";
  text: string;
  time: string;
}

const mockConversation: ChatMessage[] = [
  { id: 1, role: "agent", text: "Hi! I'm your Lantern agent. How can I help you today?", time: "10:01 AM" },
  { id: 2, role: "user", text: "Can you check my calendar for tomorrow?", time: "10:02 AM" },
  { id: 3, role: "agent", text: "Sure! Let me look at your calendar for tomorrow. You have 3 events:\n\n- 9:00 AM: Team standup\n- 11:30 AM: Design review\n- 3:00 PM: 1:1 with Sarah\n\nWould you like me to prepare briefing docs for any of these?", time: "10:02 AM" },
  { id: 4, role: "user", text: "Yes, prepare a brief for the design review", time: "10:03 AM" },
  { id: 5, role: "agent", text: "On it! I'll search your Notion and Google Drive for relevant docs and prepare a one-page brief. I'll send it to you 15 minutes before the meeting.", time: "10:03 AM" },
];

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

export function WebChatWidget({ onClose }: { onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>(mockConversation);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg: ChatMessage = {
      id: Date.now(),
      role: "user",
      text: input.trim(),
      time: format(new Date(), "HH:mm"),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      setIsTyping(false);
      const agentMsg: ChatMessage = {
        id: Date.now() + 1,
        role: "agent",
        text: "I understand. Let me work on that for you. I'll update you once it's ready.",
        time: format(new Date(), "HH:mm"),
      };
      setMessages((prev) => [...prev, agentMsg]);
    }, 1500);
  };

  if (!isOpen) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => setIsOpen(true)}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-lantern-500 text-white shadow-lg shadow-lantern-500/30 transition-transform hover:scale-105"
        >
          <MessageSquare className="h-6 w-6" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col w-[380px] h-[520px] rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl overflow-hidden">
      {/* Preview badge */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10">
        <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-3 py-0.5 text-[10px] font-medium text-amber-400">
          This is a preview
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-lantern-500/10">
            <Bot className="h-4 w-4 text-lantern-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-100">Lantern Agent</p>
            <p className="text-[10px] text-emerald-400">Online</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <span className="text-xs">Minimize</span>
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={clsx(
              "flex gap-2",
              msg.role === "user" ? "flex-row-reverse" : "flex-row"
            )}
          >
            <div
              className={clsx(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                msg.role === "agent" ? "bg-lantern-500/10" : "bg-surface-3"
              )}
            >
              {msg.role === "agent" ? (
                <Bot className="h-3 w-3 text-lantern-400" />
              ) : (
                <User className="h-3 w-3 text-zinc-400" />
              )}
            </div>
            <div
              className={clsx(
                "max-w-[75%] rounded-xl px-3 py-2",
                msg.role === "agent"
                  ? "bg-surface-2 text-zinc-300"
                  : "bg-lantern-500/10 text-zinc-200"
              )}
            >
              <p className="text-xs leading-relaxed whitespace-pre-line">{msg.text}</p>
              <p className={clsx(
                "mt-1 text-[10px]",
                msg.role === "agent" ? "text-zinc-600" : "text-lantern-400/50"
              )}>
                {msg.time}
              </p>
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lantern-500/10">
              <Bot className="h-3 w-3 text-lantern-400" />
            </div>
            <div className="rounded-xl bg-surface-2 px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" style={{ animationDelay: "0ms" }} />
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" style={{ animationDelay: "200ms" }} />
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 animate-pulse" style={{ animationDelay: "400ms" }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 px-3 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            className="flex-1 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-lantern-500 text-white transition-colors hover:bg-lantern-400 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-zinc-600">
          Powered by Lantern
        </p>
      </div>
    </div>
  );
}
