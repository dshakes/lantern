"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Sparkles, Loader2, FileText, Puzzle, Play, Square, Save, CheckCircle2, AlertCircle, Search, Headphones, Code, Mail, BarChart3, PenTool, ClipboardList, ShieldCheck, Star, Link2 } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { useToast } from "@/components/toast";
import { OneClickTemplates } from "@/components/one-click-templates";
import { ConnectorChips } from "@/components/connector-chips";

const PRIVACY_LEVELS = [
  { value: "standard", label: "Standard", badge: "", desc: "Data encrypted at rest" },
  { value: "private", label: "Private (E2E encrypted)", badge: "\uD83D\uDD12", desc: "End-to-end encryption, no plaintext stored" },
  { value: "audit", label: "Audit-logged", badge: "\uD83D\uDEE1\uFE0F", desc: "Full audit trail for compliance" },
] as const;

type CreationPath = "ai" | "manual" | "template";
type WizardStep = "choose" | "configure" | "test";

const TEMPLATES = [
  { id: "research", name: "research-agent", description: "Researches a topic and produces a structured report with citations", model: "auto", prompt: "You are a research analyst. Given a topic, write a comprehensive research briefing with key findings, trends, and implications. Use clear headers and bullet points.", tags: ["Research", "Data"], icon: "search", popular: true, connectors: [] },
  { id: "support", name: "customer-support", description: "Handles customer support tickets with empathetic, helpful responses", model: "auto", prompt: "You are a customer support agent. Draft a professional, empathetic response to the customer's issue. Include specific next steps and offer to escalate if needed.", tags: ["Email", "Support"], icon: "headphones", popular: true, connectors: ["Email", "Slack"] },
  { id: "code-review", name: "code-reviewer", description: "Reviews pull requests for correctness, security, and style", model: "code-large", prompt: "You are a senior code reviewer. Given a PR description, provide a thorough code review covering correctness, security, style, and performance. Be specific and actionable.", tags: ["Code", "Engineering"], icon: "code", popular: false, connectors: ["GitHub"] },
  { id: "email-digest", name: "email-digest", description: "Summarizes emails and highlights urgent items", model: "auto", prompt: "You are an email assistant. Summarize the provided emails concisely, grouping by priority. Highlight anything urgent or time-sensitive.", tags: ["Email", "Productivity"], icon: "mail", popular: false, connectors: ["Gmail"] },
  { id: "data-analyst", name: "data-analyst", description: "Analyzes datasets, finds patterns, and generates visualizations", model: "reasoning-large", prompt: "You are a data analyst. Given data or a question about data, provide thorough analysis with key insights, statistical summaries, and actionable recommendations. Format output with clear sections.", tags: ["Data", "Analytics"], icon: "chart", popular: true, connectors: [] },
  { id: "content-writer", name: "content-writer", description: "Writes blog posts, social media content, and marketing copy", model: "auto", prompt: "You are a professional content writer. Create engaging, well-structured content optimized for the target audience and platform. Include compelling hooks, clear structure, and strong calls to action.", tags: ["Content", "Marketing"], icon: "pen", popular: false, connectors: [] },
  { id: "meeting-notes", name: "meeting-notes", description: "Processes meeting transcripts into structured action items and summaries", model: "auto", prompt: "You are a meeting notes specialist. Given a meeting transcript, extract: 1) Key decisions made, 2) Action items with owners and deadlines, 3) Open questions, 4) Brief summary. Format clearly with bullet points.", tags: ["Productivity", "Meetings"], icon: "clipboard", popular: false, connectors: ["Calendar", "Slack"] },
  { id: "security-scanner", name: "security-scanner", description: "Scans code and configurations for security vulnerabilities", model: "code-large", prompt: "You are a security analyst. Review the provided code or configuration for security vulnerabilities, following OWASP guidelines. Rate severity (Critical/High/Medium/Low), explain the risk, and provide specific remediation steps.", tags: ["Security", "Code"], icon: "shield", popular: false, connectors: ["GitHub"] },
];

function ModelSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={clsx("rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50", className)}>
      <option value="auto">Auto (recommended)</option>
      <optgroup label="Anthropic">
        <option value="reasoning-frontier">Reasoning Frontier -- Claude Opus 4</option>
        <option value="reasoning-large">Reasoning Large -- Claude Sonnet 4</option>
        <option value="reasoning-small">Reasoning Small -- Claude Haiku 4</option>
        <option value="code-large">Code Large -- Claude Sonnet 4</option>
      </optgroup>
      <optgroup label="OpenAI">
        <option value="chat-large">Chat Large -- GPT-4o</option>
        <option value="chat-small">Chat Small -- GPT-4o Mini</option>
      </optgroup>
      <optgroup label="Google">
        <option value="vision-large">Vision Large -- Gemini 2.5 Pro</option>
      </optgroup>
    </select>
  );
}

export default function CreatePageWrapper() {
  return (<Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-600" /></div>}><CreatePage /></Suspense>);
}

function CreatePage() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<WizardStep>("choose");
  const [path, setPath] = useState<CreationPath | null>(null);
  const [aiDescription, setAiDescription] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("auto");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [privacy, setPrivacy] = useState("standard");
  const [guardrails, setGuardrails] = useState({ contentFilter: false, blockPII: false, blockedTopics: "" });
  const [environment, setEnvironment] = useState({ runtime: "node22", memory: "512mb", timeout: "5m", network: "allow-all" });
  const [selectedConnectors, setSelectedConnectors] = useState<string[]>([]);
  const [generatingInstructions, setGeneratingInstructions] = useState(false);
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testModel, setTestModel] = useState("auto");
  const [testRunning, setTestRunning] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [testDone, setTestDone] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const testRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (testRef.current) testRef.current.scrollTop = testRef.current.scrollHeight; }, [testOutput]);

  const handleAiGenerate = useCallback(async () => {
    if (!aiDescription.trim()) return;
    setAiGenerating(true);
    try {
      const resp = await api.complete({ messages: [
        { role: "system", content: "Given a user's description of an AI agent, generate JSON: {name (kebab-case), description (one sentence), model (\"auto\"), instructions (what the agent does - goals, scope, constraints), systemPrompt (personality, tone, output format)}. Return ONLY valid JSON." },
        { role: "user", content: aiDescription }], model: "auto", stream: false });
      if (resp.ok) {
        const data = await resp.json();
        const match = (data.content || "").match(/\{[\s\S]*\}/);
        if (match) {
          const p = JSON.parse(match[0]);
          const str = (v: unknown): string => typeof v === "string" ? v : v ? JSON.stringify(v, null, 2) : "";
          setName(str(p.name)); setDescription(str(p.description)); setModel(typeof p.model === "string" ? p.model : "auto");
          setInstructions(str(p.instructions)); setSystemPrompt(str(p.systemPrompt));
          setStep("configure"); toast.success("AI generated your agent configuration"); setAiGenerating(false); return;
        }
      }
      throw new Error("Parse failed");
    } catch {
      setName(aiDescription.trim().toLowerCase().split(/\s+/).slice(0, 3).join("-").replace(/[^a-z0-9-]/g, "") || "my-agent");
      setDescription(aiDescription.trim()); setStep("configure"); toast.info("Fill in the remaining fields manually");
    } finally { setAiGenerating(false); }
  }, [aiDescription, toast]);

  const handleTemplateSelect = useCallback((tpl: typeof TEMPLATES[number]) => {
    setName(tpl.name); setDescription(tpl.description); setModel(tpl.model); setSystemPrompt(tpl.prompt); setPath("template"); setStep("configure");
  }, []);

  const handleGeneratePrompt = useCallback(async () => {
    setGeneratingPrompt(true);
    try {
      const resp = await api.complete({ messages: [{ role: "user", content: `Generate a system prompt for "${name}". Description: "${description}". Return ONLY the prompt text.` }], model: "auto", stream: false });
      if (resp.ok) { const d = await resp.json(); const g = (d.content || "").trim(); if (g) { setSystemPrompt(g); toast.success("System prompt generated"); setGeneratingPrompt(false); return; } }
      toast.error("Failed to generate prompt");
    } catch { toast.error("LLM unavailable. Configure a provider in Settings."); } finally { setGeneratingPrompt(false); }
  }, [name, description, toast]);

  const handleTestRun = useCallback(async () => {
    if (!testInput.trim()) return;
    setTestOutput(""); setTestDone(false); setTestError(null); setTestRunning(true);
    const messages: Array<{ role: string; content: string }> = [];
    const fullPrompt = [instructions ? `<instructions>\n${instructions}\n</instructions>` : "", systemPrompt].filter(Boolean).join("\n\n");
    if (fullPrompt) messages.push({ role: "system", content: fullPrompt });
    messages.push({ role: "user", content: testInput });
    try {
      const response = await api.complete({ messages, model: testModel, stream: true, temperature: 1.0, maxTokens: 4096 });
      if (!response.ok) { const b = await response.text().catch(() => ""); let m: string; try { m = JSON.parse(b).error || `API error ${response.status}`; } catch { m = b || `API error ${response.status}`; } throw new Error(m); }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader(); if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder(); let full = ""; let buffer = "";
        while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) { if (!line.startsWith("data: ")) continue; try { const evt = JSON.parse(line.slice(6).trim()); if (evt.type === "delta" && evt.content) { full += evt.content; setTestOutput(full); } } catch { /* */ } } }
      } else { const result = await response.json(); setTestOutput(result.content || JSON.stringify(result, null, 2)); }
      setTestDone(true); setTestRunning(false);
    } catch (err) { setTestError(err instanceof Error ? err.message : "Unknown error"); setTestRunning(false); setTestDone(true); }
  }, [testInput, testModel, systemPrompt, instructions]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) { toast.error("Agent name is required"); return; }
    setCreating(true);
    const agentName = name.trim().toLowerCase().replace(/\s+/g, "-");
    try {
      const agent = await api.createAgent({ name: agentName, description, model });
      // Save all config to localStorage (mirrors what the agent detail page reads)
      if (systemPrompt) {
        const prompts = JSON.parse(localStorage.getItem("lantern_agent_prompts") || "{}");
        prompts[agentName] = systemPrompt;
        localStorage.setItem("lantern_agent_prompts", JSON.stringify(prompts));
      }
      if (instructions) {
        localStorage.setItem(`lantern_instructions_${agentName}`, instructions);
      }
      // Save settings (model, environment, guardrails, privacy, connectors)
      localStorage.setItem(`lantern_agent_settings_${agentName}`, JSON.stringify({
        model, privacy, environment, guardrails, connectors: selectedConnectors,
      }));
      try { await api.updateAgent(agentName, { systemPrompt, description }); } catch { /* saved locally */ }
      toast.success(`Agent "${agentName}" created`);
      router.push(`/agents/${agentName}`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to create agent"); } finally { setCreating(false); }
  }, [name, description, model, systemPrompt, instructions, privacy, environment, guardrails, selectedConnectors, router, toast]);

  const stepIdx = ["choose", "configure", "test"].indexOf(step);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <button onClick={() => step === "choose" ? router.push("/agents") : setStep(step === "test" ? "configure" : "choose")} className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"><ArrowLeft className="h-3 w-3" /> {step === "choose" ? "Back to Agents" : "Back"}</button>
        <h1 className="text-lg font-semibold text-zinc-100">Create Agent</h1>
        <div className="mt-4 flex items-center gap-2 text-xs">
          {(["Choose", "Configure", "Test & Deploy"] as const).map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <div className={clsx("h-px w-8", stepIdx >= i ? "bg-indigo-500" : "bg-zinc-700")} />}
              <span className={clsx("rounded-lg px-3 py-1.5 font-medium", stepIdx === i ? "bg-indigo-500/10 text-indigo-400" : stepIdx > i ? "text-zinc-300" : "text-zinc-600")}>{i + 1}. {label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 p-8">
        {step === "choose" && (
          <div className="mx-auto max-w-3xl">
            {/* One-click recipes — atomic agent + budget + schedule. The
                tiles show the user up-front which connectors they'll need
                and whether those are already installed. */}
            <OneClickTemplates />

            <div className="my-8 flex items-center gap-3">
              <span className="h-px flex-1 bg-zinc-800" />
              <span className="text-(--text-xs) uppercase tracking-wider text-zinc-600">
                or start from scratch
              </span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>

            <h2 className="mb-6 text-center text-xl font-semibold text-zinc-100">How do you want to create?</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-6 hover:border-indigo-500/50">
                <Sparkles className="mb-3 h-6 w-6 text-indigo-400" />
                <h3 className="mb-1 text-sm font-semibold text-zinc-100">AI Assisted</h3>
                <p className="mb-4 flex-1 text-xs text-zinc-500">Describe what you want and AI builds it</p>
                <button onClick={() => setPath("ai")} className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">Get started</button>
              </div>
              <div className="flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-6 hover:border-zinc-600">
                <FileText className="mb-3 h-6 w-6 text-zinc-400" />
                <h3 className="mb-1 text-sm font-semibold text-zinc-100">Manual</h3>
                <p className="mb-4 flex-1 text-xs text-zinc-500">Configure from scratch with full control</p>
                <button onClick={() => { setPath("manual"); setStep("configure"); }} className="w-full rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-surface-3">Get started</button>
              </div>
              <div className="flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-6 hover:border-zinc-600">
                <Puzzle className="mb-3 h-6 w-6 text-teal-400" />
                <h3 className="mb-1 text-sm font-semibold text-zinc-100">Template</h3>
                <p className="mb-4 flex-1 text-xs text-zinc-500">Start from a pre-built template</p>
                <button onClick={() => setPath("template")} className="w-full rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-surface-3">Browse</button>
              </div>
            </div>
            {path === "ai" && (
              <div className="mx-auto mt-8 max-w-xl space-y-3">
                {/* Suggestion chips — empty-state nudges so users see what
                    kinds of agents Lantern is good at without staring at
                    a blank textarea. Click fills the description; user
                    can edit before generating. */}
                {!aiDescription && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                    <span className="text-zinc-600">Try:</span>
                    {[
                      "Reply to my WhatsApp DMs as me — casual, brief, like I'm texting",
                      "Triage my GitHub issues every morning and draft responses",
                      "Summarize my Slack channels each evening into a single digest",
                      "Watch my Gmail for invoices and create Linear tasks for each",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setAiDescription(suggestion)}
                        className="rounded-full border border-zinc-800 bg-surface-1 px-2.5 py-1 text-left text-[11px] text-zinc-400 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/5 hover:text-indigo-300"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
                <textarea value={aiDescription} onChange={(e) => setAiDescription(e.target.value)} rows={4} placeholder="Describe what your agent should do..." className="w-full resize-none rounded-xl border border-zinc-800 bg-surface-0 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-2 focus:ring-lantern-500/20" autoFocus onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAiGenerate(); }} />

                {/* Context-aware connector chips. Detects keywords in the
                    user's description (gmail, github, slack, …) and shows
                    each one's install status. Click an uninstalled chip to
                    jump to the install flow without losing the draft. */}
                <ConnectorChips description={aiDescription} />

                <button onClick={handleAiGenerate} disabled={!aiDescription.trim() || aiGenerating} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                  {aiGenerating ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="h-4 w-4" /> Generate Agent</>}
                </button>
                <p className="text-center text-[11px] text-zinc-600">
                  Lantern drafts the agent — you review and edit before saving. Nothing ships until you say so.
                </p>
              </div>
            )}
            {path === "template" && (() => {
              const ICON_MAP: Record<string, React.ComponentType<{className?: string}>> = { search: Search, headphones: Headphones, code: Code, mail: Mail, chart: BarChart3, pen: PenTool, clipboard: ClipboardList, shield: ShieldCheck };
              const allTags = Array.from(new Set(TEMPLATES.flatMap(t => t.tags)));
              const filtered = selectedTag ? TEMPLATES.filter(t => t.tags.includes(selectedTag)) : TEMPLATES;
              return (
                <div className="mt-8 space-y-4">
                  {/* Tag filter */}
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => setSelectedTag(null)} className={clsx("rounded-full px-3 py-1 text-[11px] font-medium transition-colors", !selectedTag ? "bg-indigo-500/20 text-indigo-400" : "bg-surface-2 text-zinc-500 hover:text-zinc-300")}>All</button>
                    {allTags.map(tag => (
                      <button key={tag} onClick={() => setSelectedTag(selectedTag === tag ? null : tag)} className={clsx("rounded-full px-3 py-1 text-[11px] font-medium transition-colors", selectedTag === tag ? "bg-indigo-500/20 text-indigo-400" : "bg-surface-2 text-zinc-500 hover:text-zinc-300")}>{tag}</button>
                    ))}
                  </div>
                  {/* Template cards */}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {filtered.map((tpl) => {
                      const Icon = ICON_MAP[tpl.icon] || Puzzle;
                      const isPreview = previewTemplate === tpl.id;
                      return (
                        <div key={tpl.id} className="group relative rounded-xl border border-zinc-800 bg-surface-1 p-4 hover:border-zinc-600 transition-all">
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-3">
                              <Icon className="h-4 w-4 text-zinc-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-medium text-zinc-200">{tpl.name}</h4>
                                {tpl.popular && <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-400"><Star className="h-2.5 w-2.5" /> Popular</span>}
                              </div>
                              <p className="mt-0.5 text-xs text-zinc-500">{tpl.description}</p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {tpl.tags.map(tag => <span key={tag} className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">{tag}</span>)}
                                {tpl.connectors.length > 0 && (
                                  <span className="inline-flex items-center gap-0.5 text-[9px] text-zinc-600"><Link2 className="h-2.5 w-2.5" /> {tpl.connectors.join(", ")}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          {/* Preview prompt on click */}
                          {isPreview && (
                            <div className="mt-3 rounded-lg border border-zinc-800 bg-surface-0 p-2">
                              <p className="text-[10px] font-medium text-zinc-500 mb-1">System Prompt Preview</p>
                              <p className="text-xs text-zinc-400 leading-relaxed">{tpl.prompt}</p>
                            </div>
                          )}
                          <div className="mt-3 flex items-center gap-2">
                            <button onClick={() => handleTemplateSelect(tpl)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500">Use Template</button>
                            <button onClick={() => setPreviewTemplate(isPreview ? null : tpl.id)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] font-medium text-zinc-400 hover:bg-surface-3">{isPreview ? "Hide" : "Preview"}</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {step === "configure" && (
          <div className="mx-auto max-w-2xl space-y-5">
            {/* Basic Info */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Basic Info</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="mb-1 flex items-center justify-between"><label className="text-xs font-medium text-zinc-400">Name</label><AiAssistButton mode="name" value={name} onChange={setName} placeholder="e.g., build me a support bot" /></div>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="my-agent" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50" />
                </div>
                <div><label className="mb-1 block text-xs font-medium text-zinc-400">Model</label><ModelSelect value={model} onChange={setModel} className="w-full" /></div>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between"><label className="text-xs font-medium text-zinc-400">Description</label><AiAssistButton mode="description" value={description} onChange={setDescription} context={name} /></div>
                <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50" />
              </div>
            </div>

            {/* Instructions — WHAT the agent does */}
            <div className="rounded-xl border border-teal-500/20 bg-teal-500/[0.02] p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-teal-400"><ClipboardList className="h-3.5 w-3.5" /> Instructions</h3>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-600">Goals, scope, constraints</span>
                  <button disabled={generatingInstructions} onClick={async () => {
                    if (!name && !description) { toast.info("Add a name or description first"); return; }
                    setGeneratingInstructions(true);
                    try {
                      const resp = await api.complete({ messages: [{ role: "user", content: `Generate clear instructions for an AI agent called "${name}". Description: "${description}". Write 3-5 bullet points defining: goals, scope, constraints, and expected behavior. Return ONLY the instructions text.` }], model: "auto", stream: false });
                      if (resp.ok) { const d = await resp.json(); const g = (d.content || "").trim(); if (g) { setInstructions(g); toast.success("Instructions generated"); setGeneratingInstructions(false); return; } }
                    } catch { /* ignore */ }
                    setGeneratingInstructions(false);
                    toast.error("Could not generate — add description first or configure LLM in Settings");
                  }} className="inline-flex items-center gap-1 rounded-md bg-teal-500/10 px-2 py-0.5 text-[10px] font-medium text-teal-400 hover:bg-teal-500/20 disabled:opacity-50">{generatingInstructions ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />} {generatingInstructions ? "Generating..." : "Generate"}</button>
                </div>
              </div>
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder="Define the agent's purpose, goals, and constraints..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-teal-500/30" />
            </div>

            {/* System Prompt — HOW the agent behaves */}
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.02] p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-indigo-400"><FileText className="h-3.5 w-3.5" /> System Prompt</h3>
                <button onClick={handleGeneratePrompt} disabled={generatingPrompt} className="inline-flex items-center gap-1 rounded-md bg-lantern-500/10 px-2 py-1 text-[11px] font-medium text-lantern-400 hover:bg-lantern-500/20 disabled:opacity-50">{generatingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Generate</button>
              </div>
              <span className="text-[10px] text-zinc-600">Personality, tone, output format</span>
              <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5} spellCheck={false} placeholder="You are a helpful assistant that..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-indigo-500/30" />
            </div>

            {/* Connectors — only show connected ones */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Connectors</h3>
                <a href="/connectors" className="text-[10px] text-lantern-400 hover:text-lantern-300">+ Connect more</a>
              </div>
              {(() => {
                const stored = typeof window !== "undefined" ? JSON.parse(localStorage.getItem("lantern_connectors") || "{}") : {};
                const connected = Object.entries(stored).filter(([, v]: [string, any]) => v.installed).map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));
                if (connected.length === 0) {
                  return (
                    <div className="rounded-lg border border-dashed border-zinc-700 py-4 text-center">
                      <p className="text-xs text-zinc-500">No connectors configured yet</p>
                      <a href="/connectors" className="mt-1 inline-block text-[11px] text-lantern-400 hover:text-lantern-300">Go to Connectors to set up Gmail, Slack, GitHub, etc.</a>
                    </div>
                  );
                }
                return (
                  <div>
                    <p className="text-[10px] text-zinc-600 mb-2">Select which connected services this agent can use</p>
                    <div className="flex flex-wrap gap-2">
                      {connected.map(c => (
                        <button key={c} onClick={() => setSelectedConnectors(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])}
                          className={clsx("rounded-lg border px-3 py-1.5 text-[11px] font-medium transition-all", selectedConnectors.includes(c) ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-zinc-700 text-zinc-400 hover:border-zinc-500")}>
                          <span className={clsx("mr-1.5 inline-block h-1.5 w-1.5 rounded-full", selectedConnectors.includes(c) ? "bg-emerald-400" : "bg-zinc-600")} />
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Environment + Privacy + Guardrails — compact row */}
            <div className="grid grid-cols-3 gap-4">
              {/* Environment */}
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4 space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Environment</h3>
                <select value={environment.runtime} onChange={(e) => setEnvironment({...environment, runtime: e.target.value})} className="w-full rounded border border-zinc-800 bg-surface-0 px-2 py-1 text-[11px] text-zinc-300 outline-none">
                  <option value="node22">Node.js 22</option><option value="python312">Python 3.12</option><option value="custom">Custom</option>
                </select>
                <select value={environment.memory} onChange={(e) => setEnvironment({...environment, memory: e.target.value})} className="w-full rounded border border-zinc-800 bg-surface-0 px-2 py-1 text-[11px] text-zinc-300 outline-none">
                  <option value="256mb">256 MB</option><option value="512mb">512 MB</option><option value="1gb">1 GB</option><option value="2gb">2 GB</option>
                </select>
              </div>
              {/* Privacy */}
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4 space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Privacy</h3>
                {PRIVACY_LEVELS.map(lv => (
                  <label key={lv.value} className={clsx("flex items-center gap-2 rounded px-2 py-1 text-[11px] cursor-pointer", privacy === lv.value ? "text-lantern-400 bg-lantern-500/5" : "text-zinc-500 hover:text-zinc-300")}>
                    <input type="radio" name="priv" value={lv.value} checked={privacy === lv.value} onChange={(e) => setPrivacy(e.target.value)} className="accent-lantern-500 h-3 w-3" />
                    {lv.badge}{lv.label}
                  </label>
                ))}
              </div>
              {/* Guardrails */}
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4 space-y-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Guardrails</h3>
                <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer"><input type="checkbox" checked={guardrails.contentFilter} onChange={(e) => setGuardrails({...guardrails, contentFilter: e.target.checked})} className="accent-lantern-500 h-3 w-3" /> Content filter</label>
                <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer"><input type="checkbox" checked={guardrails.blockPII} onChange={(e) => setGuardrails({...guardrails, blockPII: e.target.checked})} className="accent-lantern-500 h-3 w-3" /> Block PII</label>
                <input type="text" value={guardrails.blockedTopics} onChange={(e) => setGuardrails({...guardrails, blockedTopics: e.target.value})} placeholder="Blocked topics..." className="w-full rounded border border-zinc-800 bg-surface-0 px-2 py-1 text-[10px] text-zinc-300 outline-none" />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => setStep("choose")} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-surface-3"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
              <button onClick={() => setStep("test")} disabled={!name.trim()} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">Test & Deploy <ArrowRight className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )}

        {step === "test" && (
          <div className="mx-auto max-w-2xl space-y-6">
            {/* Agent Summary */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Agent Summary</h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-zinc-500">Name:</span> <span className="text-zinc-200 font-medium">{name}</span></div>
                <div><span className="text-zinc-500">Model:</span> <span className="text-zinc-200">{model === "auto" ? "Auto (recommended)" : model}</span></div>
                <div className="col-span-2"><span className="text-zinc-500">Description:</span> <span className="text-zinc-300">{description || "—"}</span></div>
                {instructions && <div className="col-span-2"><span className="text-zinc-500">Instructions:</span> <span className="text-zinc-400 text-[11px]">{instructions.slice(0, 100)}{instructions.length > 100 ? "..." : ""}</span></div>}
                {selectedConnectors.length > 0 && <div className="col-span-2"><span className="text-zinc-500">Connectors:</span> <span className="text-zinc-300">{selectedConnectors.join(", ")}</span></div>}
                <div><span className="text-zinc-500">Privacy:</span> <span className="text-zinc-300">{PRIVACY_LEVELS.find(l => l.value === privacy)?.label}</span></div>
                <div><span className="text-zinc-500">Guardrails:</span> <span className="text-zinc-300">{[guardrails.contentFilter && "Content filter", guardrails.blockPII && "PII blocking"].filter(Boolean).join(", ") || "None"}</span></div>
              </div>
            </div>

            {/* Quick Test — optional */}
            <div className="rounded-xl border border-dashed border-zinc-700 bg-surface-1/50 p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-400"><Play className="h-4 w-4 text-zinc-500" /> Quick Test <span className="text-[10px] text-zinc-600">(optional)</span></h3>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-600">Model:</span>
                  <ModelSelect value={testModel} onChange={setTestModel} className="h-7 w-44 text-[11px]" />
                </div>
              </div>
              <p className="text-[11px] text-zinc-600 mb-3">Skip this step or type a message to verify your agent works. You can always test later.</p>
              <textarea value={testInput} onChange={(e) => setTestInput(e.target.value)} rows={2}
                placeholder={description ? `e.g., "${description.slice(0, 60)}${description.length > 60 ? "..." : ""}"` : "Type a test message (or skip and create the agent directly)"}
                className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
              <div className="mt-2 flex items-center gap-2">
                {testRunning ? (<button onClick={() => { setTestRunning(false); setTestDone(true); }} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-500"><Square className="h-3 w-3" /> Stop</button>
                ) : (<button onClick={handleTestRun} disabled={!testInput.trim()} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-surface-3 disabled:opacity-50"><Play className="h-3 w-3" /> Run Test</button>)}
              </div>
              {(testOutput || testRunning || testError) && (
                <div className="mt-3 rounded-lg border border-zinc-800 bg-surface-0">
                  {testError ? (<div className="p-3"><div className="flex items-center gap-2 text-xs font-medium text-red-400"><AlertCircle className="h-3 w-3" /> Error</div><p className="mt-1 text-xs text-red-300/70">{testError}</p></div>
                  ) : (<div ref={testRef} className="max-h-48 overflow-auto p-3"><div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{testOutput}{testRunning && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />}</div></div>)}
                  {testDone && !testError && (<div className="border-t border-zinc-800 px-3 py-2"><span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Test passed</span></div>)}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between">
              <button onClick={() => setStep("configure")} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-surface-3"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
              <button onClick={handleCreate} disabled={creating || !name.trim()} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {creating ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</> : <><Save className="h-4 w-4" /> Create Agent</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
