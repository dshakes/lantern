"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Store,
  Search,
  GitFork,
  Star,
  Upload,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { api, type MarketplaceAgent } from "@/lib/api";
import { Skeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { LinkButton, Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

const CATEGORIES = [
  "general",
  "email",
  "code",
  "research",
  "support",
  "analytics",
  "security",
];

export default function MarketplacePage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [forking, setForking] = useState<string | null>(null);
  const [starring, setStarring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listMarketplaceAgents({
        category: category ?? undefined,
        q: search || undefined,
      });
      setAgents(items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
      setAgents([]);
    }
    setLoading(false);
  }, [category, search, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFork = async (agent: MarketplaceAgent) => {
    setForking(agent.slug);
    try {
      const res = await api.forkMarketplaceAgent(agent.slug);
      toast.success(`Forked to "${res.agentName}"`);
      setAgents((prev) =>
        prev.map((a) =>
          a.slug === agent.slug ? { ...a, forksCount: a.forksCount + 1 } : a,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fork failed");
    }
    setForking(null);
  };

  const handleStar = async (agent: MarketplaceAgent) => {
    setStarring(agent.slug);
    try {
      const res = agent.starred
        ? await api.unstarMarketplaceAgent(agent.slug)
        : await api.starMarketplaceAgent(agent.slug);
      setAgents((prev) =>
        prev.map((a) =>
          a.slug === agent.slug
            ? {
                ...a,
                starred: res.starred,
                starsCount: a.starsCount + (res.starred ? 1 : -1),
              }
            : a,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Star failed");
    }
    setStarring(null);
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Marketplace"
        description="Discover, fork, and star community agents. Apache 2.0 — your fork runs in your own VPC, no gate."
        action={
          <LinkButton
            variant="secondary"
            size="md"
            icon={<Upload className="h-3.5 w-3.5" />}
            href="/agents"
          >
            Publish an agent
          </LinkButton>
        }
      />

      <div className="flex-1 space-y-6 p-8">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, description, or tag..."
              className="w-full rounded-lg border border-zinc-800 bg-surface-1 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto">
            <CategoryChip
              label="All"
              active={!category}
              onClick={() => setCategory(null)}
            />
            {CATEGORIES.map((cat) => (
              <CategoryChip
                key={cat}
                label={cat}
                active={category === cat}
                onClick={() =>
                  setCategory(category === cat ? null : cat)
                }
              />
            ))}
          </div>
        </div>

        {loading ? (
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
        ) : agents.length === 0 ? (
          <EmptyState
            icon={Store}
            title={search || category ? "No matches" : "Marketplace is empty"}
            description={
              search || category
                ? "Nothing matched that filter. Try clearing it."
                : "Publish your first agent from the Agents page. Marketplace agents are visible to all tenants and fork directly into their workspace."
            }
            actionLabel={search || category ? "Clear filters" : "Go to Agents"}
            onAction={
              search || category
                ? () => {
                    setSearch("");
                    setCategory(null);
                  }
                : undefined
            }
            actionHref={search || category ? undefined : "/agents"}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.slug}
                agent={agent}
                forking={forking === agent.slug}
                starring={starring === agent.slug}
                onFork={() => handleFork(agent)}
                onStar={() => handleStar(agent)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium capitalize transition-all",
        active
          ? "border-lantern-500/40 bg-lantern-500/10 text-lantern-300"
          : "border-zinc-800 bg-surface-1 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
      )}
    >
      {label}
    </button>
  );
}

function AgentCard({
  agent,
  forking,
  starring,
  onFork,
  onStar,
}: {
  agent: MarketplaceAgent;
  forking: boolean;
  starring: boolean;
  onFork: () => void;
  onStar: () => void;
}) {
  return (
    <div className="group flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all hover:border-zinc-700 hover:shadow-lg hover:shadow-black/20">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold tracking-tight text-zinc-100">
            {agent.name}
          </h3>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            by <span className="text-zinc-400">{agent.author}</span>
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-zinc-800 bg-surface-2 px-2 py-0.5 text-[10px] font-medium capitalize text-zinc-400">
          {agent.category}
        </span>
      </div>
      <p className="mb-3 min-h-[34px] text-xs leading-relaxed text-zinc-400 line-clamp-2">
        {agent.description}
      </p>
      {agent.tags && agent.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {agent.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-surface-2/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-zinc-800 pt-3">
        <div className="flex items-center gap-3 font-mono text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1">
            <Star
              className={clsx(
                "h-3 w-3",
                agent.starred && "fill-amber-400 text-amber-400",
              )}
            />
            {agent.starsCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <GitFork className="h-3 w-3" />
            {agent.forksCount}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onStar}
            loading={starring}
            icon={
              !starring && (
                <Star
                  className={clsx(
                    "h-3 w-3",
                    agent.starred && "fill-amber-400 text-amber-400",
                  )}
                />
              )
            }
          >
            {agent.starred ? "Starred" : "Star"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onFork}
            loading={forking}
            icon={!forking && <GitFork className="h-3 w-3" />}
          >
            Fork
          </Button>
        </div>
      </div>
    </div>
  );
}
