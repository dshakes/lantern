/**
 * Production memory client that routes memory operations through the
 * runtime sidecar to the Lantern memory service.
 *
 * Memory tiers:
 * - **core**: Key-value store for structured agent state (fast, small).
 * - **recall**: Vector search over recent conversation/context (pgvector).
 * - **archival**: Vector search over long-term knowledge (pgvector, larger).
 *
 * All operations are scoped to the tenant and agent/run by the sidecar.
 */

import type { MemoryClient, MemoryEntry } from "../types.js";
import type { Runtime } from "./runtime.js";
import type { RequestMeta } from "./grpc-client.js";
import { LanternMemoryError } from "./errors.js";
import { traced } from "./tracing.js";

/**
 * Production memory client that sends all operations through the
 * runtime sidecar's memory gRPC interface.
 */
export class RuntimeMemoryClient implements MemoryClient {
  private readonly runtime: Runtime;

  /** Core key-value memory tier. */
  readonly core: {
    /** Get a value by key. Returns null if the key does not exist. */
    get(key: string): Promise<string | null>;
    /** Set a key-value pair. Overwrites any existing value. */
    set(key: string, value: string): Promise<void>;
  };

  /** Recall memory tier: vector search over recent context. */
  readonly recall: {
    /** Search recall memory with a natural-language query. */
    search(query: string, opts?: { topK?: number }): Promise<MemoryEntry[]>;
  };

  /** Archival memory tier: long-term vector storage and search. */
  readonly archival: {
    /** Search archival memory with a natural-language query. */
    search(query: string, opts?: { topK?: number }): Promise<MemoryEntry[]>;
    /** Add a text entry to archival memory. */
    add(text: string, metadata?: Record<string, unknown>): Promise<void>;
  };

  constructor(runtime: Runtime) {
    this.runtime = runtime;

    this.core = {
      get: (key: string) => this.coreGet(key),
      set: (key: string, value: string) => this.coreSet(key, value),
    };

    this.recall = {
      search: (query: string, opts?: { topK?: number }) =>
        this.vectorSearch("recall", query, opts?.topK ?? 10),
    };

    this.archival = {
      search: (query: string, opts?: { topK?: number }) =>
        this.vectorSearch("archival", query, opts?.topK ?? 10),
      add: (text: string, metadata?: Record<string, unknown>) =>
        this.archivalAdd(text, metadata),
    };
  }

  // -- Core KV --------------------------------------------------------------

  /**
   * Get a value from the core key-value tier.
   *
   * @param key - The key to look up.
   * @returns The value string, or null if the key does not exist.
   * @throws {LanternMemoryError} If the operation fails.
   */
  private async coreGet(key: string): Promise<string | null> {
    return traced("memory.core.get", { key }, async () => {
      const sidecar = this.runtime.sidecar;
      if (!sidecar) {
        throw new LanternMemoryError("core", "Memory client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...this.runtime.meta };

      try {
        const response = await sidecar.memoryGet({ meta, tier: "core", key });
        if (!response.found) {
          return null;
        }
        return response.value ?? null;
      } catch (err) {
        if (err instanceof LanternMemoryError) throw err;
        throw new LanternMemoryError("core", err instanceof Error ? err.message : String(err));
      }
    });
  }

  /**
   * Set a value in the core key-value tier.
   *
   * @param key - The key to set.
   * @param value - The value to store.
   * @throws {LanternMemoryError} If the operation fails.
   */
  private async coreSet(key: string, value: string): Promise<void> {
    return traced("memory.core.set", { key }, async () => {
      const sidecar = this.runtime.sidecar;
      if (!sidecar) {
        throw new LanternMemoryError("core", "Memory client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...this.runtime.meta };

      try {
        await sidecar.memorySet({ meta, tier: "core", key, value });
      } catch (err) {
        if (err instanceof LanternMemoryError) throw err;
        throw new LanternMemoryError("core", err instanceof Error ? err.message : String(err));
      }
    });
  }

  // -- Vector search (recall / archival) ------------------------------------

  /**
   * Search a vector memory tier with a natural-language query.
   *
   * @param tier - The memory tier to search ("recall" or "archival").
   * @param query - Natural-language search query.
   * @param topK - Maximum number of results to return.
   * @returns An array of memory entries sorted by relevance.
   * @throws {LanternMemoryError} If the search fails.
   */
  private async vectorSearch(
    tier: "recall" | "archival",
    query: string,
    topK: number,
  ): Promise<MemoryEntry[]> {
    return traced(`memory.${tier}.search`, { topK }, async () => {
      const sidecar = this.runtime.sidecar;
      if (!sidecar) {
        throw new LanternMemoryError(tier, "Memory client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...this.runtime.meta };

      try {
        const response = await sidecar.memorySearch({ meta, tier, query, topK });
        return response.entries.map((entry) => ({
          id: entry.id,
          text: entry.text,
          score: entry.score,
          metadata: entry.metadata,
          createdAt: new Date(entry.createdAt),
        }));
      } catch (err) {
        if (err instanceof LanternMemoryError) throw err;
        throw new LanternMemoryError(tier, err instanceof Error ? err.message : String(err));
      }
    });
  }

  // -- Archival add ---------------------------------------------------------

  /**
   * Add a text entry to the archival memory tier.
   *
   * The entry is embedded by the memory service and stored for future
   * vector search queries.
   *
   * @param text - The text content to store.
   * @param metadata - Optional metadata to attach to the entry.
   * @throws {LanternMemoryError} If the operation fails.
   */
  private async archivalAdd(
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return traced("memory.archival.add", {}, async () => {
      const sidecar = this.runtime.sidecar;
      if (!sidecar) {
        throw new LanternMemoryError("archival", "Memory client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...this.runtime.meta };

      try {
        await sidecar.memoryAdd({ meta, tier: "archival", text, metadata });
      } catch (err) {
        if (err instanceof LanternMemoryError) throw err;
        throw new LanternMemoryError("archival", err instanceof Error ? err.message : String(err));
      }
    });
  }
}
