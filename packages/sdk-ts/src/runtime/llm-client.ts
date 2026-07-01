/**
 * Production LLM client that routes all model calls through the
 * runtime sidecar to the Lantern model router.
 *
 * The model router handles:
 * - Capability-to-model resolution (e.g. "reasoning-large" -> claude-opus)
 * - Vendor failover and load balancing
 * - Semantic caching
 * - Token metering and cost tracking
 * - Rate limiting per tenant
 *
 * The SDK never talks to a model vendor directly.
 */

import type {
  LlmClient,
  LlmOptions,
  LlmJsonOptions,
  LlmStreamOptions,
  Capability,
  Message,
  ToolDef,
  GroundedResult,
} from "../types.js";
import type { Runtime } from "./runtime.js";
import type {
  CompleteRequest,
  GrpcMessage,
  GrpcToolDef,
  RequestMeta,
} from "./grpc-client.js";
import { LanternLlmError, LanternLlmJsonError } from "./errors.js";
import { traced } from "./tracing.js";

// ---------------------------------------------------------------------------
// Message / tool conversion
// ---------------------------------------------------------------------------

/** Convert SDK Message to gRPC message format. */
function toGrpcMessage(msg: Message): GrpcMessage {
  return {
    role: msg.role,
    content: msg.content,
    name: msg.name,
    toolCalls: msg.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
    toolCallId: msg.toolCallId,
  };
}

/** Convert SDK ToolDef to gRPC tool definition format. */
function toGrpcToolDef(td: ToolDef): GrpcToolDef {
  return {
    name: td.name,
    description: td.description,
    parametersJson: JSON.stringify(td.parameters),
  };
}

/** Build the messages array for a CompleteRequest. */
/**
 * Build the ground-or-abstain system contract for a grounded completion.
 * Pure + exported so it's unit-testable without a runtime sidecar.
 */
export function buildGroundingContract(sources: string[]): string {
  const list = sources.length
    ? sources.map((s, i) => `[${i + 1}] ${s}`).join("\n")
    : "(none provided)";
  return (
    "GROUND-OR-ABSTAIN: Assert ONLY what the SOURCES below support. " +
    "If the answer is not in the sources, say you don't know or state it as intent — never as fact. " +
    "Never invent names, numbers, dates, statuses, or completed actions. Cite the source you used.\n\n" +
    "SOURCES:\n" +
    list
  );
}

function buildMessages(opts: LlmOptions): GrpcMessage[] {
  if (opts.messages) {
    return opts.messages.map(toGrpcMessage);
  }
  if (opts.prompt) {
    return [{ role: "user", content: opts.prompt }];
  }
  throw new LanternLlmError("Either 'prompt' or 'messages' must be provided");
}

/** Resolve the capability string, defaulting to "auto". */
function resolveCapability(opts: LlmOptions): string {
  return opts.capability ?? "auto";
}

/** Resolve the optimize target to a string for the gRPC request. */
function resolveOptimize(opts: LlmOptions): string | undefined {
  if (!opts.optimize) return undefined;
  if (typeof opts.optimize === "string") return opts.optimize;
  return JSON.stringify(opts.optimize);
}

// ---------------------------------------------------------------------------
// RuntimeLlmClient
// ---------------------------------------------------------------------------

/** Maximum number of retries for JSON schema validation failures. */
const JSON_VALIDATION_MAX_RETRIES = 3;

/**
 * Production LLM client that sends all requests through the runtime
 * sidecar's model router interface.
 */
export class RuntimeLlmClient implements LlmClient {
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /**
   * Send a completion request and return the full text response.
   *
   * @param opts - Completion options (prompt or messages, capability, etc.).
   * @returns The model's text response.
   * @throws {LanternLlmError} If the model call fails.
   */
  async complete(opts: LlmOptions): Promise<string> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternLlmError("LLM client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    const capability = resolveCapability(opts);

    return traced("llm.complete", { capability }, async (span) => {
      const req: CompleteRequest = {
        meta,
        messages: buildMessages(opts),
        capability,
        optimize: resolveOptimize(opts),
        tools: opts.tools?.map(toGrpcToolDef),
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        stop: opts.stop,
        noCache: opts.noCache,
      };

      try {
        const res = await sidecar.complete(req);
        span.setAttribute("model", res.model);
        span.setAttribute("tokensIn", res.tokensIn);
        span.setAttribute("tokensOut", res.tokensOut);
        span.setAttribute("costUsd", res.costUsd);
        return res.text;
      } catch (err) {
        if (err instanceof LanternLlmError) throw err;
        throw new LanternLlmError(
          err instanceof Error ? err.message : String(err),
          undefined,
          true,
        );
      }
    });
  }

  /**
   * Complete under a ground-or-abstain contract. The model is instructed to
   * assert only what the supplied `sources` support and to say it doesn't know
   * (or state intent) rather than fabricate. Returns the reply plus the sources
   * it was grounded against. The platform's server-side action guard still runs
   * on top; this adds the citation contract at the agent's own boundary.
   */
  async completeGrounded(
    opts: LlmOptions & { sources: string[] },
  ): Promise<GroundedResult> {
    const { sources = [], prompt, messages, ...rest } = opts;
    const contract = buildGroundingContract(sources);
    const base: Message[] = messages
      ? [...messages]
      : prompt
        ? [{ role: "user", content: prompt }]
        : [];
    const text = await this.complete({
      ...rest,
      messages: [{ role: "system", content: contract }, ...base],
    });
    return { text, sources, grounded: sources.length > 0 };
  }

  /**
   * Send a completion request with `response_format: json`, validate the
   * response against a Zod schema, and return the parsed object.
   *
   * If the model output fails validation, the request is retried up to
   * {@link JSON_VALIDATION_MAX_RETRIES} times with the validation errors
   * appended as a correction prompt.
   *
   * @param opts - Completion options including a Zod schema.
   * @returns The parsed and validated response object.
   * @throws {LanternLlmJsonError} If validation fails after all retries.
   * @throws {LanternLlmError} If the model call itself fails.
   */
  async json<T>(opts: LlmJsonOptions<T>): Promise<T> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternLlmError("LLM client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    const capability = resolveCapability(opts);

    return traced("llm.json", { capability }, async (span) => {
      let messages = buildMessages(opts);
      let lastRaw = "";
      let lastValidationErrors = "";

      for (let attempt = 0; attempt < JSON_VALIDATION_MAX_RETRIES; attempt++) {
        const req: CompleteRequest = {
          meta,
          messages,
          capability,
          optimize: resolveOptimize(opts),
          tools: opts.tools?.map(toGrpcToolDef),
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          stop: opts.stop,
          responseFormat: "json",
          noCache: opts.noCache || attempt > 0, // Don't cache retries
        };

        let rawText: string;
        try {
          const res = await sidecar.complete(req);
          rawText = res.text;
          span.setAttribute("model", res.model);
          span.setAttribute("tokensIn", res.tokensIn);
          span.setAttribute("tokensOut", res.tokensOut);
        } catch (err) {
          if (err instanceof LanternLlmError) throw err;
          throw new LanternLlmError(
            err instanceof Error ? err.message : String(err),
            undefined,
            true,
          );
        }

        lastRaw = rawText;

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          lastValidationErrors = `Response is not valid JSON: ${rawText.slice(0, 500)}`;
          // Append correction and retry
          messages = [
            ...messages,
            { role: "assistant", content: rawText },
            {
              role: "user",
              content: `Your response was not valid JSON. Please try again and respond with only valid JSON. Error: ${lastValidationErrors}`,
            },
          ];
          continue;
        }

        // Validate against Zod schema
        const result = opts.schema.safeParse(parsed);
        if (result.success) {
          span.setAttribute("attempts", attempt + 1);
          return result.data;
        }

        // Validation failed: build error message and retry
        lastValidationErrors = result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");

        messages = [
          ...messages,
          { role: "assistant", content: rawText },
          {
            role: "user",
            content: `Your JSON response did not match the expected schema. Please fix the following issues and try again:\n${lastValidationErrors}`,
          },
        ];
      }

      // All retries exhausted
      throw new LanternLlmJsonError(lastRaw, lastValidationErrors);
    });
  }

  /**
   * Send a streaming completion request and yield text deltas as an
   * async iterator.
   *
   * The stream is end-to-end: tokens flow from the model through the
   * sidecar to the SDK without buffering. Each yielded string is a
   * text delta (not the full response so far).
   *
   * @param opts - Completion options.
   * @yields Text delta strings.
   * @throws {LanternLlmError} If the stream fails.
   */
  async *stream(opts: LlmStreamOptions): AsyncIterable<string> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternLlmError("LLM client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    const capability = resolveCapability(opts);

    const req: CompleteRequest = {
      meta,
      messages: buildMessages(opts),
      capability,
      optimize: resolveOptimize(opts),
      tools: opts.tools?.map(toGrpcToolDef),
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      stop: opts.stop,
      noCache: opts.noCache,
    };

    try {
      for await (const chunk of sidecar.streamComplete(req)) {
        if (chunk.delta) {
          yield chunk.delta;
        }
        if (chunk.done) {
          return;
        }
      }
    } catch (err) {
      if (err instanceof LanternLlmError) throw err;
      throw new LanternLlmError(
        err instanceof Error ? err.message : String(err),
        undefined,
        true,
      );
    }
  }

  /**
   * Compute embeddings for one or more texts.
   *
   * @param texts - The texts to embed.
   * @param capability - Embedding capability (defaults to "embed-large").
   * @returns A 2D array of vectors, one per input text.
   * @throws {LanternLlmError} If the embedding call fails.
   */
  async embed(texts: string[], capability?: Capability): Promise<number[][]> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternLlmError("LLM client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    const cap = capability ?? "embed-large";

    return traced("llm.embed", { capability: cap, count: texts.length }, async (span) => {
      try {
        const res = await sidecar.embed({ meta, texts, capability: cap });
        span.setAttribute("model", res.model);
        span.setAttribute("tokensIn", res.tokensIn);
        return res.vectors;
      } catch (err) {
        if (err instanceof LanternLlmError) throw err;
        throw new LanternLlmError(
          err instanceof Error ? err.message : String(err),
          undefined,
          true,
        );
      }
    });
  }
}
