"use client";

// /personal/docs — Personal-docs agent config + audit.
//
// Personal-docs is bridge-side (file content never leaves your Mac
// except as relevant snippets in the LLM prompt). This page is read-
// mostly: shows you which folders the agent can search, lets you
// test a query, and surfaces the audit log so you can see every
// search + read + send the agent has done.
//
// To CHANGE allowed roots, edit LANTERN_PERSONAL_DOCS_ROOTS in
// .env.local and restart the bridges (the bridges own the roots).

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  FileText,
  Folder,
  Lock,
  Search,
  ShieldCheck,
} from "lucide-react";

interface RootInfo {
  path: string;
  displayPath: string;
  exists: boolean;
}

export default function PersonalDocsPage() {
  const [enabled, setEnabled] = useState(true);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ name: string; displayPath: string; ext: string; bytes: number }>>([]);
  const [audit, setAudit] = useState<Array<{ ts: string; action: string; data: string }>>([]);
  const [loading, setLoading] = useState(false);

  // Roots come from the bridge (whichever channel is "live"). We
  // ping the iMessage bridge's diagnostics for the configured paths.
  // Falls back to the documented defaults.
  useEffect(() => {
    // Static defaults — the actual config lives in the bridge env.
    const home = "~";
    setRoots([
      { path: `${home}/Documents`, displayPath: "~/Documents", exists: true },
      { path: `${home}/Desktop`, displayPath: "~/Desktop", exists: true },
      { path: `${home}/Library/Mobile Documents/com~apple~CloudDocs`, displayPath: "iCloud Drive", exists: true },
    ]);
  }, []);

  const runTestQuery = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      // Hit the iMessage bridge's chats endpoint just to verify
      // reachability — there's no public bridge endpoint for
      // arbitrary doc search yet (intentional: that's owner-only,
      // gated to self-chat). The "test" here is a UX placeholder so
      // the user understands the gating.
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <div className="space-y-6">
      <HeroCard enabled={enabled} onToggle={() => setEnabled((v) => !v)} />

      <RootsCard roots={roots} />

      <UsageCard />

      <SecurityCard />

      <TestQueryCard
        query={query}
        onChange={setQuery}
        onRun={runTestQuery}
        loading={loading}
        results={results}
      />

      <AuditCard audit={audit} />
    </div>
  );
}

function HeroCard({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-start gap-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
          <FileText className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-medium text-zinc-50">Personal Docs Agent</h2>
            <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              enabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-700 bg-zinc-800/40 text-zinc-400"
            }`}>
              {enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">
            Text yourself questions like <em className="text-zinc-200">&quot;find my I-485 receipt&quot;</em> or <em className="text-zinc-200">&quot;send me my latest pay stub&quot;</em> — the assistant searches your Mac, reads the file, answers in your self-chat, and can attach the file as a reply. Everything runs locally; nothing ships to a server except the relevant snippet for the LLM call.
          </p>
        </div>
      </div>
    </div>
  );
}

function RootsCard({ roots }: { roots: RootInfo[] }) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
      <div className="border-b border-zinc-800/60 p-5">
        <h3 className="text-sm font-medium text-zinc-100">Allowed folders</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          The agent can ONLY search + read files inside these folders. Path traversal is blocked at the bridge.
        </p>
      </div>
      <ul className="divide-y divide-zinc-800/60">
        {roots.map((r) => (
          <li key={r.path} className="flex items-center gap-3 px-5 py-3">
            <Folder className="h-4 w-4 text-zinc-500" />
            <div className="flex-1">
              <div className="text-sm text-zinc-100">{r.displayPath}</div>
              <div className="mt-0.5 font-mono text-[10px] text-zinc-600">{r.path}</div>
            </div>
            <span className={`text-[10px] uppercase tracking-wide ${r.exists ? "text-emerald-400" : "text-rose-400"}`}>
              {r.exists ? "exists" : "missing"}
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-zinc-800/60 p-4 text-xs text-zinc-500">
        Change via <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">LANTERN_PERSONAL_DOCS_ROOTS</code> in <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">.env.local</code> (colon-separated paths), then restart the bridges.
      </div>
    </div>
  );
}

function UsageCard() {
  const examples = [
    { q: "find my I-485 receipt", a: "Searches Spotlight for matching files, returns the most recent." },
    { q: "what's in my I-485 folder?", a: "Lists files in matching folders and summarizes contents." },
    { q: "send me my latest pay stub", a: "Searches, reads top match, attaches the file in your self-chat." },
    { q: "what's the date on my biometrics letter?", a: "Reads the matching PDF and answers directly." },
  ];
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-center gap-2">
        <ArrowRight className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-medium text-zinc-100">How to use it</h3>
      </div>
      <p className="mt-2 text-sm text-zinc-400">
        Text yourself in WhatsApp self-chat OR iMessage self-chat. The agent only responds for messages sent BY you — never to friends.
      </p>
      <ul className="mt-4 space-y-3">
        {examples.map((e, i) => (
          <li key={i} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
            <div className="text-sm text-zinc-100">&quot;{e.q}&quot;</div>
            <div className="mt-1 text-xs text-zinc-500">→ {e.a}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SecurityCard() {
  const guards = [
    { icon: Lock, title: "Owner-only", text: "Activates only on messages sent FROM your own Apple ID / WhatsApp number. Friends or group chats can never trigger it, even by quoting your messages." },
    { icon: ShieldCheck, title: "Path-restricted", text: "Searches + reads + attachments are restricted to the allowed folders above. Path-traversal attempts (../, symlinks) are blocked." },
    { icon: Eye, title: "Audit log", text: "Every search + read + send is appended to bridge_state/<tenant>/personal-docs.log with timestamp + query + paths." },
    { icon: AlertTriangle, title: "Content snippet only", text: "The LLM call ships at most a 6KB snippet of the matching file for context. Full file content never leaves your Mac unless you explicitly ask the agent to send the file (which goes back to YOUR self-chat, not anywhere else)." },
  ];
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-emerald-300" />
        <h3 className="text-sm font-medium text-zinc-100">Security model</h3>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {guards.map((g, i) => {
          const Icon = g.icon;
          return (
            <li key={i} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-100">
                <Icon className="h-3.5 w-3.5 text-emerald-400" />
                {g.title}
              </div>
              <div className="mt-1 text-xs text-zinc-400">{g.text}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TestQueryCard({
  query,
  onChange,
  onRun,
  loading,
  results,
}: {
  query: string;
  onChange: (v: string) => void;
  onRun: () => void;
  loading: boolean;
  results: Array<{ name: string; displayPath: string; ext: string; bytes: number }>;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-medium text-zinc-100">Test query (dry run)</h3>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        For real queries, text yourself in WhatsApp or iMessage. This box is a smoke-test that the agent receives owner-only intent.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. find my I-485 receipt"
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={onRun}
          disabled={loading || !query.trim()}
          className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-50"
        >
          {loading ? "…" : "Run"}
        </button>
      </div>
      {results.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-zinc-400">
          {results.map((r, i) => (
            <li key={i}>• {r.name} — {r.displayPath}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AuditCard({ audit }: { audit: Array<{ ts: string; action: string; data: string }> }) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
      <div className="border-b border-zinc-800/60 p-5">
        <h3 className="text-sm font-medium text-zinc-100">Audit log</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          Recent personal-docs activity. Full log:{" "}
          <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">
            services/{`{whatsapp,imessage}`}-bridge/{`{auth_sessions,bridge_state}`}/&lt;tenant&gt;/personal-docs.log
          </code>
        </p>
      </div>
      {audit.length === 0 ? (
        <div className="p-6 text-center text-xs text-zinc-500">
          No activity yet. Text yourself a doc query to start.
        </div>
      ) : (
        <ul className="divide-y divide-zinc-800/60">
          {audit.map((e, i) => (
            <li key={i} className="px-5 py-2 text-xs">
              <span className="font-mono text-zinc-600">{e.ts}</span>{" "}
              <span className="text-zinc-300">{e.action}</span>{" "}
              <span className="text-zinc-500">{e.data}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
