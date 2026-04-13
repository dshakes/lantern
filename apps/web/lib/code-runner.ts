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

  // JavaScript: execute safely
  try {
    const logs: string[] = [];
    const mockConsole = {
      log: (...args: unknown[]) => logs.push(args.map(a => typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)).join(" ")),
      error: (...args: unknown[]) => logs.push("[error] " + args.map(a => String(a)).join(" ")),
      warn: (...args: unknown[]) => logs.push("[warn] " + args.map(a => String(a)).join(" ")),
      info: (...args: unknown[]) => logs.push(args.map(a => String(a)).join(" ")),
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("console", code);
    const result = fn(mockConsole);
    if (result !== undefined && logs.length === 0) {
      logs.push(typeof result === "object" ? JSON.stringify(result, null, 2) : String(result));
    }
    return { output: logs.join("\n") || "(no output)", error: false, duration: Date.now() - start };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), error: true, duration: Date.now() - start };
  }
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
