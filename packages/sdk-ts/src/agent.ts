import type { AgentConfig } from "./types.js";

export function agent<TInput = unknown, TOutput = unknown>(
  config: AgentConfig<TInput, TOutput>,
): AgentConfig<TInput, TOutput> {
  if (!config.name || !/^[a-z0-9-]{1,63}$/.test(config.name)) {
    throw new Error(
      `Agent name must match [a-z0-9-]{1,63}, got: "${config.name}"`,
    );
  }

  if (!config.run || typeof config.run !== "function") {
    throw new Error("Agent must have a run function");
  }

  return Object.freeze({ ...config });
}
