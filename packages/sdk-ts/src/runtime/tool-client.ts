/**
 * Production tool client that routes tool invocations through the
 * runtime sidecar.
 *
 * Built-in tools (web, python, fs, browser) are invoked via the
 * sidecar's ToolInvoke RPC. The sidecar dispatches to the appropriate
 * tool service:
 * - web.search / web.fetch: routed to the web tool service
 * - python.exec: routed to a sub-sandbox Python executor
 * - fs.read / fs.write: scoped to the agent's scratch workspace
 */

import type { ToolClient } from "../types.js";
import type { Runtime } from "./runtime.js";
import type { RequestMeta } from "./grpc-client.js";
import { LanternToolError } from "./errors.js";
import { traced } from "./tracing.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of a web search operation. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Result of a Python code execution. */
export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  result?: unknown;
}

// ---------------------------------------------------------------------------
// RuntimeToolClient
// ---------------------------------------------------------------------------

/**
 * Production tool client that sends all tool invocations through the
 * runtime sidecar.
 *
 * Each tool method creates a traced span and calls the sidecar's
 * InvokeTool RPC with the tool name and JSON-serialized input.
 */
export class RuntimeToolClient implements ToolClient {
  private readonly runtime: Runtime;

  /** Web search and fetch tools. */
  readonly web: {
    /** Search the web and return ranked results. */
    search(query: string): Promise<SearchResult[]>;
    /** Fetch the content of a URL as text. */
    fetch(url: string): Promise<string>;
  };

  /** Python code execution tool. */
  readonly python: {
    /** Execute Python code in a sandboxed sub-environment. */
    exec(code: string): Promise<PythonResult>;
  };

  /** Filesystem operations scoped to the agent's scratch workspace. */
  readonly fs: {
    /** Read a file from the agent's scratch space. */
    read(path: string): Promise<string>;
    /** Write a file to the agent's scratch space. */
    write(path: string, content: string): Promise<void>;
  };

  constructor(runtime: Runtime) {
    this.runtime = runtime;

    this.web = {
      search: (query: string) => this.invokeWebSearch(query),
      fetch: (url: string) => this.invokeWebFetch(url),
    };

    this.python = {
      exec: (code: string) => this.invokePythonExec(code),
    };

    this.fs = {
      read: (path: string) => this.invokeFsRead(path),
      write: (path: string, content: string) => this.invokeFsWrite(path, content),
    };
  }

  // -- Web ------------------------------------------------------------------

  /**
   * Search the web for a query and return structured results.
   *
   * @param query - The search query string.
   * @returns An array of search results with title, URL, and snippet.
   * @throws {LanternToolError} If the search fails.
   */
  private async invokeWebSearch(query: string): Promise<SearchResult[]> {
    return traced("tool.web.search", { query: query.slice(0, 100) }, async () => {
      const output = await this.invoke("lantern.web", { action: "search", query });
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        throw new LanternToolError("lantern.web", `Expected array of search results, got: ${typeof parsed}`);
      }
      return parsed as SearchResult[];
    });
  }

  /**
   * Fetch the text content of a URL.
   *
   * @param url - The URL to fetch.
   * @returns The response body as a string.
   * @throws {LanternToolError} If the fetch fails.
   */
  private async invokeWebFetch(url: string): Promise<string> {
    return traced("tool.web.fetch", { url: url.slice(0, 200) }, async () => {
      const output = await this.invoke("lantern.web", { action: "fetch", url });
      return output;
    });
  }

  // -- Python ---------------------------------------------------------------

  /**
   * Execute Python code in a sandboxed sub-environment.
   *
   * The code runs in an isolated Python interpreter with access to
   * pre-installed packages. The result includes stdout, stderr, exit
   * code, and an optional structured return value.
   *
   * @param code - Python source code to execute.
   * @returns Execution results.
   * @throws {LanternToolError} If execution fails at the infrastructure level.
   */
  private async invokePythonExec(code: string): Promise<PythonResult> {
    return traced("tool.python.exec", {}, async () => {
      const output = await this.invoke("lantern.python", { action: "exec", code });
      const parsed = JSON.parse(output);
      return {
        stdout: parsed.stdout ?? "",
        stderr: parsed.stderr ?? "",
        exitCode: parsed.exitCode ?? 0,
        result: parsed.result,
      } as PythonResult;
    });
  }

  // -- Filesystem -----------------------------------------------------------

  /**
   * Read a file from the agent's scoped scratch workspace.
   *
   * @param path - Relative path within the scratch workspace.
   * @returns The file content as a string.
   * @throws {LanternToolError} If the file does not exist or cannot be read.
   */
  private async invokeFsRead(path: string): Promise<string> {
    return traced("tool.fs.read", { path }, async () => {
      return this.invoke("lantern.fs", { action: "read", path });
    });
  }

  /**
   * Write a file to the agent's scoped scratch workspace.
   *
   * @param path - Relative path within the scratch workspace.
   * @param content - The content to write.
   * @throws {LanternToolError} If the write fails.
   */
  private async invokeFsWrite(path: string, content: string): Promise<void> {
    return traced("tool.fs.write", { path }, async () => {
      await this.invoke("lantern.fs", { action: "write", path, content });
    });
  }

  // -- Core invocation ------------------------------------------------------

  /**
   * Invoke a tool via the sidecar.
   *
   * @param toolName - The tool identifier (e.g. "lantern.web").
   * @param input - The tool input object.
   * @returns The raw output string from the sidecar.
   * @throws {LanternToolError} If the tool invocation fails.
   */
  private async invoke(toolName: string, input: Record<string, unknown>): Promise<string> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternToolError(toolName, "Tool client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };

    try {
      const response = await sidecar.invokeTool({
        meta,
        toolName,
        inputJson: JSON.stringify(input),
      });
      return response.outputJson;
    } catch (err) {
      if (err instanceof LanternToolError) throw err;
      throw new LanternToolError(
        toolName,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
