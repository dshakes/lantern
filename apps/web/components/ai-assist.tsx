"use client";

import { useState, useCallback } from "react";
import { Sparkles, Loader2, X, Check } from "lucide-react";
import { api } from "@/lib/api";

/**
 * AI-powered input helper. Wraps any input field and adds a ✨ button
 * that generates/converts the value using AI.
 *
 * Examples:
 * - Cron expression: "every Monday at 9am" → "0 9 * * 1"
 * - JSON input: "search for quantum computing papers" → {"topic":"quantum computing","depth":"deep"}
 * - Agent name: "build me a support bot" → "customer-support-bot"
 */

interface AiAssistProps {
  /** What kind of value to generate */
  mode: "cron" | "json" | "name" | "description" | "prompt";
  /** Current input value */
  value: string;
  /** Called when AI generates a new value */
  onChange: (value: string) => void;
  /** Placeholder for the AI prompt input */
  placeholder?: string;
  /** Context passed to the AI (e.g., agent name for JSON generation) */
  context?: string;
}

const MODE_PROMPTS: Record<string, string> = {
  cron: "Convert the following natural language schedule description into a standard 5-field cron expression (minute hour day month weekday). Return ONLY the cron expression, nothing else. Description: ",
  json: "Convert the following natural language description into a valid JSON object suitable as input for an AI agent. Return ONLY the JSON, no explanation. Description: ",
  name: "Generate a short, lowercase, hyphen-separated agent name (max 30 chars) based on this description. Return ONLY the name, nothing else. Description: ",
  description: "Write a concise one-sentence description for an AI agent based on this prompt. Return ONLY the description. Prompt: ",
  prompt: "Improve and expand the following prompt to be more specific and effective for an AI agent. Return ONLY the improved prompt. Original: ",
};

export function AiAssistButton({
  mode,
  value,
  onChange,
  placeholder,
  context,
}: AiAssistProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const systemPrompt = MODE_PROMPTS[mode] || MODE_PROMPTS.prompt;
    const fullPrompt = context
      ? `${systemPrompt}${prompt}\n\nContext: ${context}`
      : `${systemPrompt}${prompt}`;

    try {
      const response = await api.complete({
        messages: [
          { role: "system", content: "You are a helpful assistant. Follow instructions precisely. Return only what is asked for, no explanations or markdown." },
          { role: "user", content: fullPrompt },
        ],
        model: "chat-small",
        stream: false,
      });

      if (!response.ok) {
        throw new Error("AI generation failed");
      }

      const data = await response.json();
      const generated = (data.content || data.message?.content || "").trim();

      if (generated) {
        setResult(generated);
      } else {
        // Fallback: generate locally for common patterns
        setResult(generateLocally(mode, prompt));
      }
    } catch {
      // Fallback: generate locally without AI
      const local = generateLocally(mode, prompt);
      if (local) {
        setResult(local);
      } else {
        setError("AI unavailable. Type the value manually.");
      }
    } finally {
      setLoading(false);
    }
  }, [prompt, mode, context]);

  const handleAccept = () => {
    if (result) {
      onChange(result);
      setOpen(false);
      setPrompt("");
      setResult(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-md bg-lantern-500/10 px-2 py-1 text-[11px] font-medium text-lantern-400 transition-colors hover:bg-lantern-500/20"
        title="Generate with AI"
      >
        <Sparkles className="h-3 w-3" />
        AI
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-lantern-500/20 bg-lantern-500/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1 text-xs font-medium text-lantern-400">
          <Sparkles className="h-3 w-3" />
          {mode === "cron" ? "Describe your schedule" : mode === "json" ? "Describe your input" : "Describe what you want"}
        </span>
        <button
          onClick={() => { setOpen(false); setPrompt(""); setResult(null); setError(null); }}
          className="text-zinc-500 hover:text-zinc-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleGenerate(); }}
          placeholder={placeholder || (mode === "cron" ? "e.g., every weekday at 9am" : "Describe in natural language...")}
          className="flex-1 rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50"
          autoFocus
        />
        <button
          onClick={handleGenerate}
          disabled={loading || !prompt.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          Generate
        </button>
      </div>

      {result && (
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 rounded-md bg-surface-0 border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 font-mono">
            {result}
          </code>
          <button
            onClick={handleAccept}
            className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2.5 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/30"
          >
            <Check className="h-3 w-3" />
            Use
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}

/**
 * Local fallback for common AI-assist patterns (no API needed).
 */
function generateLocally(mode: string, prompt: string): string | null {
  const lower = prompt.toLowerCase().trim();

  if (mode === "cron") {
    // Common cron patterns
    if (lower.includes("every minute")) return "* * * * *";
    if (lower.includes("every hour")) return "0 * * * *";
    if (lower.includes("every day at midnight") || lower.includes("daily at midnight")) return "0 0 * * *";
    if (lower.includes("every day at 9") || lower.includes("daily at 9")) return "0 9 * * *";
    if (lower.includes("every day at noon") || lower.includes("daily at noon")) return "0 12 * * *";
    if (lower.includes("every monday at 9") || lower.includes("mondays at 9")) return "0 9 * * 1";
    if (lower.includes("every weekday at 9") || lower.includes("weekdays at 9")) return "0 9 * * 1-5";
    if (lower.includes("every weekday at 8")) return "0 8 * * 1-5";
    if (lower.includes("every friday at 5") || lower.includes("fridays at 5")) return "0 17 * * 5";
    if (lower.includes("every sunday at 10")) return "0 10 * * 0";
    if (lower.includes("every 5 minutes")) return "*/5 * * * *";
    if (lower.includes("every 15 minutes")) return "*/15 * * * *";
    if (lower.includes("every 30 minutes")) return "*/30 * * * *";
    if (lower.includes("twice a day")) return "0 9,17 * * *";
    if (lower.includes("first of every month") || lower.includes("monthly")) return "0 0 1 * *";
    if (lower.includes("every quarter")) return "0 0 1 1,4,7,10 *";

    // Try to parse "at X" patterns
    const atMatch = lower.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (atMatch) {
      let hour = parseInt(atMatch[1]);
      const minute = atMatch[2] ? parseInt(atMatch[2]) : 0;
      if (atMatch[3] === "pm" && hour < 12) hour += 12;
      if (atMatch[3] === "am" && hour === 12) hour = 0;

      // Day patterns
      if (lower.includes("monday")) return `${minute} ${hour} * * 1`;
      if (lower.includes("tuesday")) return `${minute} ${hour} * * 2`;
      if (lower.includes("wednesday")) return `${minute} ${hour} * * 3`;
      if (lower.includes("thursday")) return `${minute} ${hour} * * 4`;
      if (lower.includes("friday")) return `${minute} ${hour} * * 5`;
      if (lower.includes("saturday")) return `${minute} ${hour} * * 6`;
      if (lower.includes("sunday")) return `${minute} ${hour} * * 0`;
      if (lower.includes("weekday")) return `${minute} ${hour} * * 1-5`;
      if (lower.includes("weekend")) return `${minute} ${hour} * * 0,6`;
      return `${minute} ${hour} * * *`;
    }

    return null;
  }

  if (mode === "name") {
    // Generate a name from description
    return lower
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => !["a", "an", "the", "for", "to", "and", "or", "that", "which", "with", "my", "me", "i", "build", "create", "make"].includes(w))
      .slice(0, 4)
      .join("-")
      || "my-agent";
  }

  return null;
}
