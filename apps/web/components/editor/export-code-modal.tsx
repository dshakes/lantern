"use client";

import { useState, useCallback } from "react";
import { X, Copy, Check } from "lucide-react";
import type { WorkflowDefinition } from "@/lib/workflow-types";
import { compileWorkflow } from "@/lib/workflow-compiler";

// ---------------------------------------------------------------------------
// Compile to TypeScript agent code
// ---------------------------------------------------------------------------

function compileToTypeScript(def: WorkflowDefinition): string {
  const config = compileWorkflow(def);
  const lines: string[] = [];

  lines.push('import { agent, step } from "@lantern/sdk";');
  lines.push("");
  lines.push(`export default agent({`);
  lines.push(`  name: "${config.name}",`);
  lines.push(`  version: "${config.version}",`);
  if (config.description) {
    lines.push(`  description: "${config.description}",`);
  }
  lines.push("");
  lines.push("  async run({ input, ctx }) {");

  for (const s of config.steps) {
    lines.push("");
    const varName = s.id.replace(/[^a-zA-Z0-9]/g, "_");

    switch (s.kind) {
      case "ai-step": {
        const prompt = (s.config.prompt as string) || "...";
        const cap = (s.config.capability as string) || "auto";
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = await step("${s.id}", async () => {`);
        lines.push(`      return ctx.llm.complete({`);
        lines.push(`        prompt: \`${prompt.replace(/`/g, "\\`")}\`,`);
        lines.push(`        capability: "${cap}",`);
        if (s.config.temperature !== undefined) {
          lines.push(`        temperature: ${s.config.temperature},`);
        }
        if (s.config.maxTokens !== undefined) {
          lines.push(`        maxTokens: ${s.config.maxTokens},`);
        }
        lines.push(`      });`);
        lines.push(`    });`);
        break;
      }
      case "tool": {
        const toolName = (s.config.tool as string) || "unknown";
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = await step("${s.id}", async () => {`);
        const [ns, method] = toolName.split(".");
        if (ns && method) {
          lines.push(`      return ctx.tools.${ns}.${method}(${JSON.stringify(s.config.parameters ?? {})});`);
        } else {
          lines.push(`      return ctx.tools.web.search(${JSON.stringify(s.config.parameters ?? {})});`);
        }
        lines.push(`    });`);
        break;
      }
      case "condition": {
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = ${s.config.expression || "true"};`);
        if (s.next && typeof s.next === "object") {
          lines.push(`    if (${varName}) {`);
          lines.push(`      // true branch -> ${s.next.true}`);
          lines.push(`    } else {`);
          lines.push(`      // false branch -> ${s.next.false}`);
          lines.push(`    }`);
        }
        break;
      }
      case "loop": {
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = await step.map(`);
        lines.push(`      "${s.id}",`);
        lines.push(`      ${s.config.array || "[]"},`);
        lines.push(`      async (item, index) => {`);
        lines.push(`        // Process each item`);
        lines.push(`        return item;`);
        lines.push(`      },`);
        if (s.config.concurrency) {
          lines.push(`      { concurrency: ${s.config.concurrency} },`);
        }
        lines.push(`    );`);
        break;
      }
      case "approval": {
        lines.push(`    // ${s.id}`);
        lines.push(`    await ctx.approval.request({`);
        lines.push(`      reason: "${(s.config.reason as string) || "Approval needed"}",`);
        if (s.config.approvers) {
          lines.push(`      approvers: ${JSON.stringify(s.config.approvers)},`);
        }
        lines.push(`    });`);
        break;
      }
      case "connector": {
        const conn = (s.config.connector as string) || "unknown";
        const action = (s.config.action as string) || "unknown";
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = await step("${s.id}", async () => {`);
        lines.push(`      return ctx.connectors["${conn}"]["${action}"](${JSON.stringify(s.config.input ?? {})});`);
        lines.push(`    });`);
        break;
      }
      case "subagent": {
        const agentName = (s.config.agent as string) || "unknown";
        lines.push(`    // ${s.id}`);
        lines.push(`    const ${varName} = await step("${s.id}", async () => {`);
        lines.push(`      return ctx.subagent("${agentName}", ${JSON.stringify(s.config.input ?? {})});`);
        lines.push(`    });`);
        break;
      }
      case "end": {
        const outputExpr = (s.config.output as string) || "{}";
        lines.push(`    // ${s.id}`);
        lines.push(`    return ${outputExpr};`);
        break;
      }
    }
  }

  lines.push("  },");
  lines.push("});");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Modal component
// ---------------------------------------------------------------------------

interface ExportCodeModalProps {
  open: boolean;
  onClose: () => void;
  workflow: WorkflowDefinition;
}

export function ExportCodeModal({
  open,
  onClose,
  workflow,
}: ExportCodeModalProps) {
  const [copied, setCopied] = useState(false);
  const [format, setFormat] = useState<"typescript" | "yaml">("typescript");

  const code =
    format === "typescript"
      ? compileToTypeScript(workflow)
      : JSON.stringify(compileWorkflow(workflow), null, 2);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (!open) return null;

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="modal-content mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-5 py-4">
          <h2 className="text-sm font-semibold text-zinc-200">
            Export as Code
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Format toggle */}
        <div className="flex gap-2 border-b border-zinc-700/50 px-5 py-3">
          <button
            onClick={() => setFormat("typescript")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              format === "typescript"
                ? "bg-lantern-500/20 text-lantern-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            TypeScript
          </button>
          <button
            onClick={() => setFormat("yaml")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              format === "yaml"
                ? "bg-lantern-500/20 text-lantern-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Agent Config (JSON)
          </button>
        </div>

        {/* Code */}
        <div className="flex-1 overflow-auto px-5 py-4">
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-surface-0 p-4 text-xs leading-relaxed text-zinc-300">
            <code>{code}</code>
          </pre>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-zinc-700 px-5 py-3">
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2 text-xs font-medium text-black transition-colors hover:bg-lantern-400"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy to Clipboard
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
