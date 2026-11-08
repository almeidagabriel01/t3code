import { t3McpProviderName } from "@t3tools/contracts";
import type { ThreadConnector } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";

import type * as ServerSettings from "../serverSettings.ts";

/**
 * The enabled T3-global MCP servers as thread connectors, secrets resolved. Each provider adapter
 * that reads a thread's connectors delivers them; unreadable settings add none, so a session
 * never fails to start over them.
 */
export const globalMcpConnectors = (
  settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">,
): Effect.Effect<ReadonlyArray<ThreadConnector>> =>
  settings.getSettings.pipe(
    Effect.map((current) =>
      Object.entries(current.mcpServers).flatMap(([name, server]): ThreadConnector[] =>
        !server.enabled
          ? []
          : server.transport === "stdio"
            ? [
                {
                  name: t3McpProviderName(name),
                  transport: "stdio",
                  command: server.command,
                  args: server.args,
                  headers: {},
                  env: server.env,
                },
              ]
            : [
                {
                  name: t3McpProviderName(name),
                  transport: "http",
                  url: server.url,
                  args: [],
                  headers: server.headers,
                  env: {},
                },
              ],
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("T3 MCP servers skipped: settings unreadable", { cause }).pipe(
        Effect.as([]),
      ),
    ),
  );
