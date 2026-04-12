/**
 * Dynamic connector proxy using JavaScript Proxy.
 *
 * Connectors are third-party integrations (GitHub, Slack, Jira, etc.)
 * configured at the tenant level. The SDK does not need to know the
 * connector schema at compile time: every property access on the
 * connector proxy is intercepted and turned into a sidecar RPC.
 *
 * @example
 * ```ts
 * // ctx.connectors.github.getPullRequest({ owner: "foo", repo: "bar", number: 42 })
 * // becomes:
 * // ConnectorInvokeRequest {
 * //   connectorId: "github",
 * //   actionId: "getPullRequest",
 * //   inputJson: '{"owner":"foo","repo":"bar","number":42}'
 * // }
 * ```
 */

import type { ConnectorClient, ConnectorAction } from "../types.js";
import type { Runtime } from "./runtime.js";
import type { RequestMeta } from "./grpc-client.js";
import { LanternConnectorError } from "./errors.js";
import { traced } from "./tracing.js";

/**
 * Create a connector proxy that dynamically routes connector calls
 * through the runtime sidecar.
 *
 * The returned object uses nested JavaScript Proxies:
 * - Level 1: `ctx.connectors.<connectorId>` returns a connector proxy.
 * - Level 2: `ctx.connectors.<connectorId>.<actionId>(input)` invokes the action.
 *
 * @param runtime - The initialized runtime.
 * @returns A ConnectorClient that intercepts all property access.
 */
export function createConnectorProxy(runtime: Runtime): ConnectorClient {
  return new Proxy({} as ConnectorClient, {
    get(_target, connectorId: string) {
      // Return a second-level proxy for this connector.
      return new Proxy(
        {} as Record<string, ConnectorAction>,
        {
          get(_actionTarget, actionId: string) {
            // Return the action function.
            return async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
              return invokeConnectorAction(runtime, connectorId, actionId, input);
            };
          },
        },
      );
    },
  });
}

/**
 * Invoke a single connector action through the sidecar.
 *
 * @param runtime - The runtime with sidecar access.
 * @param connectorId - The connector identifier (e.g. "github").
 * @param actionId - The action name (e.g. "getPullRequest").
 * @param input - The action input payload.
 * @returns The action's output payload.
 * @throws {LanternConnectorError} If the invocation fails.
 */
async function invokeConnectorAction(
  runtime: Runtime,
  connectorId: string,
  actionId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sidecar = runtime.sidecar;
  if (!sidecar) {
    throw new LanternConnectorError(
      connectorId,
      actionId,
      "Connector proxy requires a production runtime with sidecar",
    );
  }

  const meta: RequestMeta = { ...runtime.meta };

  return traced(
    "connector.invoke",
    { connector: connectorId, action: actionId },
    async () => {
      try {
        const response = await sidecar.invokeConnector({
          meta,
          connectorId,
          actionId,
          inputJson: JSON.stringify(input),
        });
        return JSON.parse(response.outputJson) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof LanternConnectorError) throw err;
        throw new LanternConnectorError(
          connectorId,
          actionId,
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}
