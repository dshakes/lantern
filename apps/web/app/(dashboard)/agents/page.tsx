"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Bot, Archive, X, Wand2, Code, Workflow, MessageSquare, Calendar, ShieldCheck } from "lucide-react";
import { format } from "date-fns";
import { agents as initialAgents } from "@/lib/mock-data";
import { DataTable, type Column } from "@/components/data-table";
import type { Agent } from "@/lib/mock-data";

const templates = [
  { id: "blank", name: "Blank agent", desc: "Start from scratch", icon: Code },
  { id: "research", name: "Research agent", desc: "Web search and synthesis", icon: Wand2 },
  { id: "connector", name: "Connector agent", desc: "Integrates with external services", icon: Workflow },
  { id: "chatbot", name: "Conversational agent", desc: "WhatsApp, Slack, or web chat", icon: MessageSquare },
  { id: "scheduled", name: "Scheduled pipeline", desc: "Runs on a cron schedule", icon: Calendar },
  { id: "approval", name: "Human-in-the-loop", desc: "Approval gates and review flows", icon: ShieldCheck },
];

const columns: Column<Agent>[] = [
  {
    key: "name",
    header: "Name",
    render: (agent) => (
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-3">
          <Bot className="h-3.5 w-3.5 text-lantern-400" />
        </div>
        <span className="font-medium text-zinc-100">{agent.name}</span>
      </div>
    ),
  },
  {
    key: "description",
    header: "Description",
    render: (agent) => (
      <span className="max-w-xs truncate text-zinc-400">
        {agent.description}
      </span>
    ),
  },
  {
    key: "version",
    header: "Version",
    render: (agent) => (
      <span className="font-mono text-xs text-zinc-500">
        {agent.currentVersionId.slice(0, 12)}
      </span>
    ),
  },
  {
    key: "created",
    header: "Created",
    render: (agent) => (
      <span className="text-zinc-500">
        {format(agent.createdAt, "MMM d, yyyy")}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (agent) =>
      agent.status === "active" ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          active
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
          <Archive className="h-3 w-3" />
          archived
        </span>
      ),
  },
];

export default function AgentsPage() {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [agents, setAgents] = useState(initialAgents);
  const [form, setForm] = useState({ name: "", description: "", template: "blank", model: "auto" });
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    setCreating(true);

    // Simulate API call — in production this calls the gateway
    await new Promise((r) => setTimeout(r, 600));

    const newAgent: Agent = {
      id: `ag_${Date.now()}`,
      name: form.name.trim().toLowerCase().replace(/\s+/g, "-"),
      description: form.description || `Agent created from ${form.template} template`,
      currentVersionId: "v_initial",
      createdAt: new Date(),
      status: "active",
    };

    setAgents((prev) => [newAgent, ...prev]);
    setShowCreate(false);
    setForm({ name: "", description: "", template: "blank", model: "auto" });
    setCreating(false);
    router.push(`/agents/${newAgent.name}`);
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Agents</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Manage your deployed AI agents.
            </p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
          >
            <Plus className="h-4 w-4" />
            New Agent
          </button>
        </div>
      </div>

      <div className="flex-1 p-8">
        <DataTable
          columns={columns}
          rows={agents}
          rowKey={(a) => a.id}
          onRowClick={(agent) => router.push(`/agents/${agent.name}`)}
        />
      </div>

      {/* Create Agent Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Create agent</h2>
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Form */}
            <div className="space-y-5 px-6 py-5">
              {/* Name */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Name
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="my-agent"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
                <p className="mt-1 text-xs text-zinc-600">
                  Lowercase, hyphens only. e.g. research-agent
                </p>
              </div>

              {/* Description */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Description
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="What does this agent do?"
                  rows={2}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 resize-none"
                />
              </div>

              {/* Template picker */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Template
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setForm({ ...form, template: t.id })}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all ${
                        form.template === t.id
                          ? "border-lantern-500 bg-lantern-500/10 text-zinc-100"
                          : "border-zinc-800 bg-surface-2 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                      }`}
                    >
                      <t.icon className="h-4 w-4 shrink-0" />
                      <div>
                        <div className="text-xs font-medium">{t.name}</div>
                        <div className="text-[11px] text-zinc-500">{t.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Default model
                </label>
                <select
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                >
                  <option value="auto">Auto (recommended)</option>
                  <option value="reasoning-large">Reasoning Large</option>
                  <option value="reasoning-small">Reasoning Small</option>
                  <option value="chat-large">Chat Large</option>
                  <option value="chat-small">Chat Small</option>
                  <option value="code-large">Code Large</option>
                </select>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!form.name.trim() || creating}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Creating...
                  </>
                ) : (
                  "Create agent"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
