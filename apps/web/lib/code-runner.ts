// ---------------------------------------------------------------------------
// Code Runner — lightweight browser-based code execution
//
// JavaScript: runs via new Function() in a sandboxed scope
// Python/SQL: shows a message that the sandbox runtime is required
// ---------------------------------------------------------------------------

export type CodeLanguage = "javascript" | "python" | "sql";

export interface CodeRunResult {
  output: string;
  error: boolean;
  duration: number;
}

export function detectLanguage(code: string): CodeLanguage {
  const trimmed = code.trim().toLowerCase();
  if (trimmed.startsWith("select ") || trimmed.startsWith("insert ") || trimmed.startsWith("update ") || trimmed.startsWith("delete ") || trimmed.startsWith("create ") || trimmed.startsWith("alter ")) return "sql";
  if (/\bdef\s+\w+|import\s+\w+|print\s*\(|from\s+\w+\s+import/.test(trimmed)) return "python";
  return "javascript";
}

export async function runCode(code: string, language: CodeLanguage): Promise<CodeRunResult> {
  const start = Date.now();

  if (language === "python") {
    return { output: "Python execution requires the sandbox runtime. Deploy to your cloud to enable.", error: false, duration: Date.now() - start };
  }
  if (language === "sql") {
    return { output: "SQL execution requires the sandbox runtime. Deploy to your cloud to enable.", error: false, duration: Date.now() - start };
  }

  // JavaScript: execute inside a Web Worker, NOT on the main thread. The
  // snippets we run here can come from assistant/LLM output (a prompt-injected
  // agent could emit hostile JS). A Worker has no DOM, no `window`, and — most
  // importantly — no `localStorage`, so executed code cannot read the bearer
  // token or touch the dashboard origin's session. Hard timeout + terminate.
  return runJsInWorker(code, start);
}

const WORKER_TIMEOUT_MS = 2000;

function runJsInWorker(code: string, start: number): Promise<CodeRunResult> {
  // SSR / no-Worker guard.
  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return Promise.resolve({
      output: "Sandbox unavailable (no Worker support in this environment).",
      error: true,
      duration: Date.now() - start,
    });
  }
  const workerSrc = `
    const logs = [];
    function fmt(a){ try { return (a !== null && typeof a === "object") ? JSON.stringify(a, null, 2) : String(a); } catch (_) { return String(a); } }
    const sandboxConsole = {
      log:  (...a) => logs.push(a.map(fmt).join(" ")),
      error:(...a) => logs.push("[error] " + a.map(fmt).join(" ")),
      warn: (...a) => logs.push("[warn] " + a.map(fmt).join(" ")),
      info: (...a) => logs.push(a.map(fmt).join(" ")),
    };
    self.onmessage = (e) => {
      try {
        const fn = new Function("console", e.data);
        const result = fn(sandboxConsole);
        if (result !== undefined && logs.length === 0) logs.push(fmt(result));
        self.postMessage({ ok: true, output: logs.join("\\n") || "(no output)" });
      } catch (err) {
        self.postMessage({ ok: false, output: (err && err.message) ? err.message : String(err) });
      }
    };
  `;
  return new Promise<CodeRunResult>((resolve) => {
    let worker: Worker | null = null;
    let settled = false;
    const finish = (r: CodeRunResult) => {
      if (settled) return;
      settled = true;
      try { worker?.terminate(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ output: `Execution timed out (${WORKER_TIMEOUT_MS}ms)`, error: true, duration: Date.now() - start }),
      WORKER_TIMEOUT_MS,
    );
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = (e: MessageEvent<{ ok: boolean; output: string }>) => {
        clearTimeout(timer);
        finish({ output: e.data.output, error: !e.data.ok, duration: Date.now() - start });
      };
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer);
        finish({ output: e.message || "Sandbox worker error", error: true, duration: Date.now() - start });
      };
      worker.postMessage(code);
    } catch (err) {
      clearTimeout(timer);
      finish({ output: "Sandbox unavailable: " + (err instanceof Error ? err.message : String(err)), error: true, duration: Date.now() - start });
    }
  });
}

/** Extract code blocks from markdown text. Returns array of {language, code} pairs. */
export function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || "text", code: match[2].trim() });
  }
  return blocks;
}
