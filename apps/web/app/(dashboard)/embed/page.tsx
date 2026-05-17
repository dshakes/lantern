"use client";

// /embed — Webchat install center.
//
// Generates the <script> tag a customer pastes into their site to embed
// a Lantern agent as a chat bubble. Pre-fills with the user's API key
// (when they have one), agent selector, theme, and position. The widget
// itself is served from /widget.js at the same origin.

import { useEffect, useMemo, useState } from "react";
import { Copy, Check, Code2, Settings as SettingsIcon, MessageSquare, Loader2 } from "lucide-react";
import clsx from "clsx";
import { PageHeader } from "@/components/page-header";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import type { Agent } from "@/lib/mock-data";

type Theme = "dark" | "light";
type Position = "bottom-right" | "bottom-left";

export default function EmbedPage() {
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentName, setAgentName] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("lk_replace_with_your_api_key");
  const [theme, setTheme] = useState<Theme>("dark");
  const [position, setPosition] = useState<Position>("bottom-right");
  const [brand, setBrand] = useState<string>("Lantern");
  const [greeting, setGreeting] = useState<string>("How can I help?");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        if (list.length > 0 && !agentName) setAgentName(list[0].name);
      })
      .catch(() => {
        // Empty list is fine; user can type a name manually.
      })
      .finally(() => !cancelled && setLoadingAgents(false));
    return () => {
      cancelled = true;
    };
  }, [agentName]);

  // Derive an apiBase that works for both prod (where Lantern is hosted)
  // and dev (where the widget points back to localhost:8080). At publish
  // time the user replaces this with their public URL.
  const apiBase = useMemo(() => {
    if (typeof window === "undefined") return "https://your-lantern";
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "http://localhost:8080";
    }
    return window.location.origin;
  }, []);

  const widgetSrc = useMemo(() => {
    return typeof window !== "undefined"
      ? `${window.location.origin}/widget.js`
      : "https://your-lantern/widget.js";
  }, []);

  const snippet = useMemo(() => {
    return [
      `<!-- Lantern Webchat widget -->`,
      `<script src="${widgetSrc}"`,
      `        data-api-key="${apiKey}"`,
      `        data-agent="${agentName || "your-agent"}"`,
      `        data-api-base="${apiBase}"`,
      `        data-theme="${theme}"`,
      `        data-position="${position}"`,
      `        data-brand="${brand}"`,
      `        data-greeting="${greeting}"`,
      `        async defer></script>`,
    ].join("\n");
  }, [widgetSrc, apiKey, agentName, apiBase, theme, position, brand, greeting]);

  const copy = () => {
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    toast.success("Embed code copied");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Embed Webchat"
        description="Drop a Lantern agent into any website with one script tag. The widget renders a chat bubble in the corner and talks to the same /v1/sessions API your dashboard uses."
      />

      <div className="grid flex-1 grid-cols-1 gap-6 p-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* Config panel */}
        <div className="space-y-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <SettingsIcon className="h-4 w-4 text-zinc-500" />
            Configure
          </h2>

          <ConfigField label="Agent" hint="Which agent answers messages">
            {loadingAgents ? (
              <div className="flex items-center gap-2 text-[12px] text-zinc-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading agents…
              </div>
            ) : agents.length === 0 ? (
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="agent-name"
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              />
            ) : (
              <select
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.name}>{a.name}</option>
                ))}
              </select>
            )}
          </ConfigField>

          <ConfigField label="API key" hint="From Settings → API keys (scope: sessions:create, messages:send)">
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="lk_..."
              className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
            />
          </ConfigField>

          <div className="grid grid-cols-2 gap-3">
            <ConfigField label="Theme">
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </ConfigField>
            <ConfigField label="Position">
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value as Position)}
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              >
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
              </select>
            </ConfigField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ConfigField label="Brand label">
              <input
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              />
            </ConfigField>
            <ConfigField label="Greeting">
              <input
                type="text"
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
              />
            </ConfigField>
          </div>

          <hr className="border-zinc-800" />

          <div>
            <h3 className="text-[12px] font-semibold text-zinc-200">Install</h3>
            <p className="mt-1 text-[11px] text-zinc-500">
              Paste this snippet anywhere inside your site&apos;s <code className="rounded bg-surface-0 px-1 font-mono text-zinc-300">&lt;body&gt;</code>.
            </p>
            <div className="relative mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-surface-0">
              <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-zinc-200">
                {snippet}
              </pre>
              <button
                onClick={copy}
                className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-surface-1 px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:bg-surface-2"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              Embedding an API key makes it visible to anyone viewing your page source. Scope it tightly (sessions:create + messages:send only) and rate-limit it server-side.
            </p>
          </div>
        </div>

        {/* Live preview */}
        <PreviewPanel theme={theme} brand={brand} greeting={greeting} />
      </div>
    </div>
  );
}

function ConfigField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-zinc-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}

function PreviewPanel({
  theme,
  brand,
  greeting,
}: {
  theme: Theme;
  brand: string;
  greeting: string;
}) {
  const isDark = theme === "dark";
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <Code2 className="h-3.5 w-3.5 text-zinc-500" />
        <h2 className="text-sm font-semibold text-zinc-200">Preview</h2>
      </div>
      <div
        className={clsx(
          "relative h-[440px]",
          isDark ? "bg-zinc-950" : "bg-zinc-100"
        )}
      >
        {/* Fake site backdrop */}
        <div className={clsx("h-10 border-b", isDark ? "border-zinc-800 bg-zinc-900" : "border-zinc-300 bg-white")} />
        <div className="grid grid-cols-3 gap-2 p-4">
          <div className={clsx("h-12 rounded", isDark ? "bg-zinc-900" : "bg-zinc-200")} />
          <div className={clsx("h-12 rounded", isDark ? "bg-zinc-900" : "bg-zinc-200")} />
          <div className={clsx("h-12 rounded", isDark ? "bg-zinc-900" : "bg-zinc-200")} />
        </div>

        {/* Mock chat panel */}
        <div
          className={clsx(
            "absolute bottom-4 right-4 w-72 overflow-hidden rounded-2xl border shadow-2xl",
            isDark
              ? "border-zinc-800 bg-zinc-900 text-zinc-100"
              : "border-zinc-300 bg-white text-zinc-900"
          )}
        >
          <div className={clsx("flex items-center justify-between px-3 py-2", isDark ? "border-zinc-800" : "border-zinc-200", "border-b")}>
            <span className="text-[12px] font-semibold">{brand}</span>
            <span className={clsx("text-[14px]", isDark ? "text-zinc-500" : "text-zinc-400")}>×</span>
          </div>
          <div className="space-y-2 px-3 py-3 text-[12px]">
            <div className={clsx("text-center", isDark ? "text-zinc-500" : "text-zinc-500")}>{greeting}</div>
            <div className="flex justify-end">
              <span className="rounded-2xl rounded-br-sm bg-violet-500 px-3 py-1.5 text-white">Hey, what hours are you open?</span>
            </div>
            <div className="flex justify-start">
              <span className={clsx("rounded-2xl rounded-bl-sm px-3 py-1.5", isDark ? "bg-zinc-800" : "bg-zinc-200")}>
                we're open 9-6 mon-fri, 10-4 sat. closed sundays
              </span>
            </div>
          </div>
          <div className={clsx("flex gap-1.5 border-t px-3 py-2", isDark ? "border-zinc-800" : "border-zinc-200")}>
            <div className={clsx("h-7 flex-1 rounded-lg", isDark ? "bg-zinc-800" : "bg-zinc-100")} />
            <div className="h-7 w-12 rounded-lg bg-violet-500" />
          </div>
        </div>

        {/* The actual bubble button */}
        <div className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-violet-600 shadow-xl">
          <MessageSquare className="h-5 w-5 text-white" />
        </div>
      </div>
    </div>
  );
}
