import type { ToolDef } from "./types.js";

export const tool = {
  web: {
    name: "lantern.web",
    description: "Web search and fetch. Search the web or fetch a URL.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "fetch"] },
        query: { type: "string", description: "Search query (for search)" },
        url: { type: "string", description: "URL to fetch (for fetch)" },
      },
      required: ["action"],
    },
  } satisfies ToolDef,

  python: {
    name: "lantern.python",
    description: "Execute Python code in a sandboxed environment.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute" },
        packages: {
          type: "array",
          items: { type: "string" },
          description: "Pip packages to install before execution",
        },
      },
      required: ["code"],
    },
  } satisfies ToolDef,

  fs: {
    name: "lantern.fs",
    description: "Read and write files in the agent's scoped workspace.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "list"] },
        path: { type: "string" },
        content: { type: "string", description: "Content to write (for write)" },
      },
      required: ["action", "path"],
    },
  } satisfies ToolDef,

  browser: {
    name: "lantern.browser",
    description: "Control a headless browser for web automation.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "click", "type", "screenshot", "extract"],
        },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    },
  } satisfies ToolDef,
} as const;
