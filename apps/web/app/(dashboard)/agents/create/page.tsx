"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Sparkles, Loader2, FileText, Puzzle, Play, Square, Save, CheckCircle2, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { useToast } from "@/components/toast";

const PRIVACY_LEVELS = [
  { value: "standard", label: "Standard", badge: "", desc: "Data encrypted at rest" },
  { value: "private", label: "Private (E2E encrypted)", badge: "\uD83D\uDD12", desc: "End-to-end encryption, no plaintext stored" },
  { value: "audit", label: "Audit-logged", badge: "\uD83D\uDEE1\uFE0F", desc: "Full audit trail for compliance" },
] as const;

type CreationPath = "ai" | "manual" | "template";
type WizardStep = "choose" | "configure" | "test";

const TEMPLATES = [
  { id: "research", name: "research-agent", description: "Researches a topic and produces a structured report with citations", model: "auto", prompt: "You are a research analyst. Given a topic, write a comprehensive research briefing with key findings, trends, and implications. Use clear headers and bullet points." },
  { id: "support", name: "customer-support", description: "Handles customer support tickets with empathetic, helpful responses", model: "auto", prompt: "You are a customer support agent. Draft a professional, empathetic response to the customer's issue. Include specific next steps and offer to escalate if needed." },
  { id: "code-review", name: "code-reviewer", description: "Reviews pull requests for correctness, security, and style", model: "code-large", prompt: "You are a senior code reviewer. Given a PR description, provide a thorough code review covering correctness, security, style, and performance. Be specific and actionable." },
  { id: "email-digest", name: "email-digest", description: "Summarizes emails and highlights urgent items", model: "auto", prompt: "You are an email assistant. Summarize the provided emails concisely, grouping by priority. Highlight anything urgent or time-sensitive." },
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
  const [privacy, setPrivacy] = useState("standard");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [testModel, setTestModel] = useState("auto");
  const [testRunning, setTestRunning] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [testDone, setTestDone] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const testRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (testRef.current) testRef.current.scrollTop = testRef.current.scrollHeight; }, [testOutput]);

  const handleAiGenerate = useCallback(async () => {
    if (!aiDescription.trim()) return;
    setAiGenerating(true);
    try {
      const resp = await api.complete({ messages: [
        { role: "system", content: "Given a user's description of an AI agent, generate JSON: {name (kebab-case), description (one sentence), model (\"auto\"), systemPrompt}. Return ONLY valid JSON." },
        { role: "user", content: aiDescription }], model: "auto", stream: false });
      if (resp.ok) {
        const data = await resp.json();
        const match = (data.content || "").match(/\{[\s\S]*\}/);
        if (match) { const p = JSON.parse(match[0]); setName(p.name || ""); setDescription(p.description || ""); setModel(p.model || "auto"); setSystemPrompt(p.systemPrompt || ""); setStep("configure"); toast.success("AI generated your agent configuration"); setAiGenerating(false); return; }
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
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
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
  }, [testInput, testModel, systemPrompt]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) { toast.error("Agent name is required"); return; }
    setCreating(true);
    try {
      const agent = await api.createAgent({ name: name.trim().toLowerCase().replace(/\s+/g, "-"), description, model });
      if (systemPrompt) { try { await api.updateAgent(agent.name, { systemPrompt }); } catch { /* saved locally */ } }
      toast.success(`Agent "${agent.name}" created`); router.push(`/agents/${agent.name}`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to create agent"); } finally { setCreating(false); }
  }, [name, description, model, systemPrompt, router, toast]);

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
                <textarea value={aiDescription} onChange={(e) => setAiDescription(e.target.value)} rows={4} placeholder="Describe what your agent should do..." className="w-full resize-none rounded-xl border border-zinc-800 bg-surface-0 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-2 focus:ring-lantern-500/20" autoFocus onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAiGenerate(); }} />
                <button onClick={handleAiGenerate} disabled={!aiDescription.trim() || aiGenerating} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                  {aiGenerating ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="h-4 w-4" /> Generate Agent</>}
                </button>
              </div>
            )}
            {path === "template" && (
              <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
                {TEMPLATES.map((tpl) => (
                  <button key={tpl.id} onClick={() => handleTemplateSelect(tpl)} className="rounded-xl border border-zinc-800 bg-surface-1 p-4 text-left hover:border-zinc-600">
                    <h4 className="text-sm font-medium text-zinc-200">{tpl.name}</h4>
                    <p className="mt-1 text-xs text-zinc-500">{tpl.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "configure" && (
          <div className="mx-auto max-w-2xl space-y-5">
            <div>
              <div className="mb-1 flex items-center justify-between"><label className="text-xs font-medium text-zinc-400">Name</label><AiAssistButton mode="name" value={name} onChange={setName} placeholder="e.g., build me a support bot" /></div>
              <input type="text" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="my-agent" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><label className="text-xs font-medium text-zinc-400">Description</label><AiAssistButton mode="description" value={description} onChange={setDescription} context={name} /></div>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this agent do?" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50" />
            </div>
            <div><label className="mb-1 block text-xs font-medium text-zinc-400">Model</label><ModelSelect value={model} onChange={setModel} className="w-full" /></div>
            <div>
              <div className="mb-1 flex items-center justify-between"><label className="text-xs font-medium text-zinc-400">System Prompt</label>
                <button onClick={handleGeneratePrompt} disabled={generatingPrompt} className="inline-flex items-center gap-1 rounded-md bg-lantern-500/10 px-2 py-1 text-[11px] font-medium text-lantern-400 hover:bg-lantern-500/20 disabled:opacity-50">{generatingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Generate</button>
              </div>
              <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={6} spellCheck={false} placeholder="Define what this agent does..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-zinc-400">Privacy Level</label>
              <div className="space-y-2">
                {PRIVACY_LEVELS.map((lv) => (
                  <label key={lv.value} className={clsx("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5", privacy === lv.value ? "border-lantern-500/50 bg-lantern-500/5" : "border-zinc-800 hover:border-zinc-600")}>
                    <input type="radio" name="privacy" value={lv.value} checked={privacy === lv.value} onChange={(e) => setPrivacy(e.target.value)} className="accent-lantern-500" />
                    <div><div className="text-xs font-medium text-zinc-200">{lv.badge ? `${lv.badge} ` : ""}{lv.label}</div><div className="text-[10px] text-zinc-500">{lv.desc}</div></div>
                  </label>
                ))}
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
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><Play className="h-4 w-4 text-emerald-400" /> Test Your Agent</h3>
              <div className="mb-3 flex items-center gap-2"><label className="text-xs text-zinc-500">Model:</label><ModelSelect value={testModel} onChange={setTestModel} className="h-8 text-xs" /></div>
              <textarea value={testInput} onChange={(e) => setTestInput(e.target.value)} rows={3} placeholder="Type a test message..." className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
              <div className="mt-2 flex items-center gap-2">
                {testRunning ? (<button onClick={() => { setTestRunning(false); setTestDone(true); }} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-500"><Square className="h-3 w-3" /> Stop</button>
                ) : (<button onClick={handleTestRun} disabled={!testInput.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50"><Play className="h-3 w-3" /> Run</button>)}
              </div>
              {(testOutput || testRunning || testError) && (
                <div className="mt-3 rounded-lg border border-zinc-800 bg-surface-0">
                  {testError ? (<div className="p-3"><div className="flex items-center gap-2 text-xs font-medium text-red-400"><AlertCircle className="h-3 w-3" /> Error</div><p className="mt-1 text-xs text-red-300/70">{testError}</p></div>
                  ) : (<div ref={testRef} className="max-h-64 overflow-auto p-3"><div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-200">{testOutput}{testRunning && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />}</div></div>)}
                  {testDone && !testError && (<div className="border-t border-zinc-800 px-3 py-2"><span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Completed</span></div>)}
                </div>
              )}
            </div>
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
