/**
 * Agent runner entry point.
 *
 * This is the main entry point that the Firecracker sandbox calls to
 * execute an agent. It is also usable in local dev mode for testing.
 *
 * Usage (production — called by the runtime manager):
 *   node runner.js --bundle /path/to/agent-bundle
 *
 * Usage (dev mode):
 *   npx lantern-run ./my-agent.ts
 *
 * The runner:
 * 1. Parses CLI arguments to locate the agent bundle.
 * 2. Dynamically imports the agent bundle.
 * 3. Initializes the runtime (production or dev).
 * 4. Builds the full AgentContext.
 * 5. Calls agent.init() if defined.
 * 6. Calls agent.run({ input, ctx }).
 * 7. Reports the result (or error) back to the runtime.
 * 8. Exits.
 */

import type { AgentConfig } from "./types.js";
import { LanternRuntime } from "./runtime/runtime.js";
import type { Runtime } from "./runtime/runtime.js";
import { buildContext } from "./runtime/context.js";
import { resetStepCounter } from "./runtime/step-runtime.js";
import { setStepRuntime } from "./step.js";
import { LanternError } from "./runtime/errors.js";
import { traced } from "./runtime/tracing.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface RunnerArgs {
  /** Path to the agent bundle (directory or entry file). */
  bundlePath: string;
  /** Optional JSON input to override the engine-provided input. */
  inputOverride?: string;
}

/**
 * Parse command-line arguments.
 *
 * Expected formats:
 *   --bundle <path>
 *   --input <json>  (optional, for dev/testing)
 */
function parseArgs(argv: string[]): RunnerArgs {
  let bundlePath: string | undefined;
  let inputOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle" && argv[i + 1]) {
      bundlePath = argv[i + 1];
      i++;
    } else if (argv[i] === "--input" && argv[i + 1]) {
      inputOverride = argv[i + 1];
      i++;
    }
  }

  if (!bundlePath) {
    // If no --bundle flag, try the first positional argument.
    const positional = argv.filter((a) => !a.startsWith("--"));
    bundlePath = positional[0];
  }

  if (!bundlePath) {
    throw new LanternError(
      "RUNNER_ARGS",
      "No agent bundle path provided. Usage: node runner.js --bundle <path>",
    );
  }

  return { bundlePath, inputOverride };
}

// ---------------------------------------------------------------------------
// Agent bundle loading
// ---------------------------------------------------------------------------

/**
 * Dynamically import the agent bundle and extract the AgentConfig.
 *
 * The bundle must have a default export or a named `agent` export
 * that is an AgentConfig object (created via the `agent()` function).
 *
 * @param bundlePath - Path to the agent bundle entry file.
 * @returns The agent configuration.
 * @throws {LanternError} If the bundle cannot be loaded or has no valid export.
 */
async function loadAgentBundle(bundlePath: string): Promise<AgentConfig> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(bundlePath);
  } catch (err) {
    throw new LanternError(
      "BUNDLE_LOAD",
      `Failed to load agent bundle from "${bundlePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Try `default` export first, then named `agent` export.
  const config = (mod.default as AgentConfig | undefined) ?? (mod.agent as AgentConfig | undefined);

  if (!config || typeof config.run !== "function") {
    throw new LanternError(
      "BUNDLE_LOAD",
      `Agent bundle at "${bundlePath}" does not export a valid AgentConfig. ` +
        "Expected a default export or named 'agent' export with a 'run' function.",
    );
  }

  return config;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute an agent run.
 *
 * This is the core runner logic, extracted so it can be called both
 * from the CLI entry point and programmatically in tests.
 *
 * @param agentConfig - The agent configuration to run.
 * @param runtime - The initialized runtime.
 * @param inputOverride - Optional input override (for dev/testing).
 * @returns The agent's output.
 */
export async function executeAgent<TInput = unknown, TOutput = unknown>(
  agentConfig: AgentConfig<TInput, TOutput>,
  runtime: Runtime,
  inputOverride?: string,
): Promise<TOutput> {
  const runInfo = runtime.runInfo;

  // Determine the input.
  const inputJson = inputOverride ?? runInfo.inputJson;
  let input: TInput;
  try {
    input = JSON.parse(inputJson) as TInput;
  } catch {
    throw new LanternError("INPUT_PARSE", `Failed to parse agent input as JSON: ${inputJson.slice(0, 500)}`);
  }

  // Reset step counter for clean replay.
  resetStepCounter();

  // Build the full context.
  const ctx = buildContext(runtime, runInfo);

  return traced(
    "agent.run",
    {
      agent: runInfo.agentName,
      version: runInfo.agentVersion,
      runId: runInfo.runId,
      tenantId: runInfo.tenantId,
    },
    async () => {
      // Call init() if defined.
      if (agentConfig.init) {
        await traced("agent.init", { agent: runInfo.agentName }, async () => {
          await agentConfig.init!();
        });
      }

      // Call run().
      const output = await agentConfig.run({ input, ctx });
      return output;
    },
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main function. Called when the runner is executed as a script.
 *
 * Exit codes:
 * - 0: success
 * - 1: agent error (reported to the engine)
 * - 2: infrastructure error (bundle not found, sidecar unreachable, etc.)
 */
export async function main(): Promise<void> {
  let runtime: Runtime | undefined;

  try {
    // Parse arguments.
    const args = parseArgs(process.argv.slice(2));

    // Load the agent bundle.
    const agentConfig = await loadAgentBundle(args.bundlePath);

    // Initialize the runtime.
    runtime = await LanternRuntime.initialize({
      agentName: agentConfig.name,
      agentVersion: agentConfig.version ?? "0.0.0",
    });

    // Install the production step proxy if in production mode.
    // This must happen before agent.run() so that any call to the
    // global `step()` function routes through the sidecar.
    if (runtime.isProduction) {
      setStepRuntime(runtime);
    }

    // Execute the agent.
    const output = await executeAgent(agentConfig, runtime, args.inputOverride);

    // Report success.
    if (runtime.isProduction && runtime.sidecar) {
      await runtime.sidecar.reportResult({
        meta: runtime.meta,
        resultJson: JSON.stringify(output),
      });
    } else {
      // Dev mode: print the output.
      console.log(JSON.stringify(output, null, 2));
    }

    runtime.close();
    process.exit(0);
  } catch (err) {
    // Report the error.
    const errorCode = err instanceof LanternError ? err.code : "AGENT_ERROR";
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (runtime?.isProduction && runtime.sidecar) {
      try {
        await runtime.sidecar.reportResult({
          meta: runtime.meta,
          errorCode,
          errorMessage,
        });
      } catch {
        // If we can't report the error, log it and exit with infra error code.
        console.error("[lantern:runner] Failed to report error to sidecar:", errorMessage);
      }
    } else {
      console.error("[lantern:runner] Agent execution failed:", errorMessage);
    }

    runtime?.close();

    // Exit code 1 for agent errors, 2 for infra errors.
    const exitCode = err instanceof LanternError && err.code === "BUNDLE_LOAD" ? 2 : 1;
    process.exit(exitCode);
  }
}

// Auto-run when executed as a script.
const isMainModule = typeof require !== "undefined"
  ? require.main === module
  : process.argv[1]?.endsWith("runner.js") || process.argv[1]?.endsWith("runner.ts");

if (isMainModule) {
  main();
}
