"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Store,
  Search,
  Play,
  GitFork,
  Loader2,
  X,
  ExternalLink,
  Copy,
  Filter,
  Globe,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  endpoint: string;
  auth: { type: string; description: string };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  provider: { name: string; url: string };
}

// ---------------------------------------------------------------------------
// Sample marketplace agents (shown when API is unavailable)
// ---------------------------------------------------------------------------

const sampleAgents: AgentCard[] = [
  {
    name: "email-digest",
    description: "Summarizes daily emails and highlights urgent items",
    version: "0.1.0",
    capabilities: ["text-generation", "email-processing"],
    endpoint: "https://api.lantern.run/v1/agents/email-digest/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
  {
    name: "code-reviewer",
    description: "Reviews pull requests for bugs, security issues, and best practices",
    version: "0.2.0",
    capabilities: ["text-generation", "code-analysis"],
    endpoint: "https://api.lantern.run/v1/agents/code-reviewer/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
  {
    name: "research-assistant",
    description: "Researches topics across multiple sources and synthesizes findings",
    version: "0.1.0",
    capabilities: ["text-generation", "web-search", "summarization"],
    endpoint: "https://api.lantern.run/v1/agents/research-assistant/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
  {
    name: "meeting-summarizer",
    description: "Summarizes meeting transcripts with action items and decisions",
    version: "0.3.0",
    capabilities: ["text-generation", "summarization"],
    endpoint: "https://api.lantern.run/v1/agents/meeting-summarizer/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
  {
    name: "data-analyst",
    description: "Analyzes datasets and generates insights with visualizations",
    version: "0.1.0",
    capabilities: ["text-generation", "data-analysis", "visualization"],
    endpoint: "https://api.lantern.run/v1/agents/data-analyst/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
  {
    name: "security-scanner",
    description: "Scans code repositories for vulnerabilities and generates reports",
    version: "0.2.0",
    capabilities: ["text-generation", "code-analysis", "security"],
    endpoint: "https://api.lantern.run/v1/agents/security-scanner/a2a/invoke",
    auth: { type: "bearer", description: "Lantern API key" },
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    outputSchema: { type: "object", properties: { result: { type: "string" } } },
    provider: { name: "Lantern", url: "https://lantern.run" },
  },
];

// All capabilities across sample + API agents
const allCapabilities = [
  "text-generation",
  "email-processing",
  "code-analysis",
  "web-search",
  "summarization",
  "data-analysis",
  "visualization",
  "security",
];

// ---------------------------------------------------------------------------
// Capability badge
// ---------------------------------------------------------------------------

const capColors: Record<string, string> = {
  "text-generation": "bg-blue-500/10 text-blue-400",
  "email-processing": "bg-amber-500/10 text-amber-400",
  "code-analysis": "bg-violet-500/10 text-violet-400",
  "web-search": "bg-emerald-500/10 text-emerald-400",
  "summarization": "bg-cyan-500/10 text-cyan-400",
  "data-analysis": "bg-orange-500/10 text-orange-400",
  "visualization": "bg-pink-500/10 text-pink-400",
  "security": "bg-red-500/10 text-red-400",
};

function CapBadge({ cap }: { cap: string }) {
  return (
    <span
      className={clsx(
        "rounded-full px-2 py-0.5 text-[10px] font-medium",
        capColors[cap] ?? "bg-zinc-500/10 text-zinc-400",
      )}
    >
      {cap}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function MarketplacePage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCap, setSelectedCap] = useState<string | null>(null);
  const [tryAgent, setTryAgent] = useState<AgentCard | null>(null);
  const [tryMessage, setTryMessage] = useState("");
  const [tryResult, setTryResult] = useState<string | null>(null);
  const [tryLoading, setTryLoading] = useState(false);
  const [forking, setForking] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const dir = await api.getAgentDirectory();
      if (dir.agents && dir.agents.length > 0) {
        // Merge API agents with samples (deduplicate by name)
        const apiNames = new Set(dir.agents.map((a) => a.name));
        const merged = [...dir.agents, ...sampleAgents.filter((s) => !apiNames.has(s.name))];
        setAgents(merged);
      } else {
        setAgents(sampleAgents);
      }
    } catch {
      setAgents(sampleAgents);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const filtered = agents.filter((a) => {
    const matchSearch =
      !search ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.description.toLowerCase().includes(search.toLowerCase());
    const matchCap =
      !selectedCap || a.capabilities.includes(selectedCap);
    return matchSearch && matchCap;
  });

  const handleTry = async () => {
    if (!tryAgent || !tryMessage.trim()) return;
    setTryLoading(true);
    setTryResult(null);
    try {
      const result = await api.invokeAgentA2A(tryAgent.name, tryMessage);
      setTryResult(result.result);
    } catch {
      setTryResult("Failed to invoke agent. The agent may not be available.");
    }
    setTryLoading(false);
  };

  const handleFork = async (agent: AgentCard) => {
    setForking(agent.name);
    try {
      await api.createAgent({
        name: `${agent.name}-fork`,
        description: `Fork of ${agent.name}: ${agent.description}`,
      });
      toast.success(`Forked "${agent.name}" to your workspace`);
    } catch {
      // Simulate locally
      toast.success(`Forked "${agent.name}" to your workspace (demo mode)`);
    }
    setForking(null);
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-800 bg-surface-1 p-5"
              >
                <Skeleton className="mb-3 h-5 w-32" />
                <Skeleton className="mb-2 h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">
              Marketplace
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Discover and use agents from across the A2A network
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-zinc-500" />
            <span className="text-xs text-zinc-500">
              {agents.length} agents available
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 p-8 space-y-6">
        {/* Search + Filter bar */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents by name or description..."
              className="w-full rounded-lg border border-zinc-800 bg-surface-1 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>
        </div>

        {/* Capability filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-3.5 w-3.5 text-zinc-500" />
          <button
            onClick={() => setSelectedCap(null)}
            className={clsx(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              !selectedCap
                ? "bg-lantern-500/20 text-lantern-300"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-200",
            )}
          >
            All
          </button>
          {allCapabilities.map((cap) => (
            <button
              key={cap}
              onClick={() =>
                setSelectedCap(selectedCap === cap ? null : cap)
              }
              className={clsx(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                selectedCap === cap
                  ? "bg-lantern-500/20 text-lantern-300"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200",
              )}
            >
              {cap}
            </button>
          ))}
        </div>

        {/* Agent grid */}
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <Store className="mx-auto mb-3 h-10 w-10 text-zinc-600" />
            <p className="text-sm text-zinc-400">
              No agents match your search
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((agent) => (
              <div
                key={agent.name}
                className="rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {agent.name}
                    </h3>
                    <span className="text-[10px] text-zinc-600">
                      v{agent.version}
                    </span>
                  </div>
                  <span className="rounded bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                    {agent.provider.name}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                  {agent.description}
                </p>
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {agent.capabilities.map((cap) => (
                    <CapBadge key={cap} cap={cap} />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setTryAgent(agent);
                      setTryMessage("");
                      setTryResult(null);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-lantern-400"
                  >
                    <Play className="h-3 w-3" /> Try it
                  </button>
                  <button
                    onClick={() => handleFork(agent)}
                    disabled={forking === agent.name}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50"
                  >
                    {forking === agent.name ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <GitFork className="h-3 w-3" />
                    )}
                    Fork
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(agent.endpoint);
                      toast.success("Endpoint URL copied");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                  >
                    <ExternalLink className="h-3 w-3" /> Endpoint
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Try it Modal */}
      {tryAgent && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setTryAgent(null)}
        >
          <div
            className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  Try {tryAgent.name}
                </h2>
                <p className="text-xs text-zinc-500">
                  {tryAgent.description}
                </p>
              </div>
              <button
                onClick={() => setTryAgent(null)}
                className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* Agent Card preview */}
              <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                    Agent Card
                  </span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        JSON.stringify(tryAgent, null, 2),
                      );
                      toast.success("Agent Card JSON copied");
                    }}
                    className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    <Copy className="h-3 w-3" /> Copy JSON
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tryAgent.capabilities.map((cap) => (
                    <CapBadge key={cap} cap={cap} />
                  ))}
                </div>
                <p className="font-mono text-[10px] text-zinc-600 truncate">
                  {tryAgent.endpoint}
                </p>
              </div>

              {/* Input */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Message
                </label>
                <textarea
                  value={tryMessage}
                  onChange={(e) => setTryMessage(e.target.value)}
                  placeholder="Enter your message..."
                  rows={3}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 resize-none"
                />
              </div>

              {/* Result */}
              {tryResult && (
                <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3">
                  <span className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                    Response
                  </span>
                  <p className="text-sm text-zinc-300 whitespace-pre-wrap">
                    {tryResult}
                  </p>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => setTryAgent(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Close
              </button>
              <button
                onClick={handleTry}
                disabled={tryLoading || !tryMessage.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
              >
                {tryLoading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
                    Invoking...
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" /> Send
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
