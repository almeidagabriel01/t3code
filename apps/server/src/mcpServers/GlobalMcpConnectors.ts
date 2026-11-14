import {
  type AssistantIntegrations,
  INTEGRATIONS_PROXY_PATH_PREFIX,
  type T3McpServer,
  t3McpProviderName,
} from "@t3tools/contracts";
import type {
  McpProviderSessionConfig,
  ThreadConnector,
} from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";

import type * as ServerSettings from "../serverSettings.ts";

/** What a thread brings to the choice of T3 MCP servers. */
export interface ThreadMcpContext {
  /** The thread's assistant selection; undefined for any other thread. */
  readonly assistant: { readonly integrations: AssistantIntegrations } | undefined;
  /** The thread's T3 session: proxied integrations need its endpoint and token. */
  readonly session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader"> | undefined;
  /** Catalog entries the thread's provider instance already loads itself; they win there (D7). */
  readonly native?: ReadonlySet<string>;
}

/**
 * Whether a thread may use a T3 MCP server. Other threads get only servers available to all
 * threads (hand-made ones always are); an assistant gets what its selection names. The proxy asks
 * this again on every request, so a change applies without restarting the session.
 */
export const t3ServerAllowed = (
  name: string,
  server: T3McpServer,
  assistant: ThreadMcpContext["assistant"],
): boolean => {
  if (!server.enabled) return false;
  if (assistant === undefined) {
    return server.transport === "stdio" || server.integration?.availability !== "assistants";
  }
  return assistant.integrations.mode === "all" || assistant.integrations.names.includes(name);
};

const integrationProxyUrl = (endpoint: string, name: string): string =>
  new URL(`${INTEGRATIONS_PROXY_PATH_PREFIX}/${name}`, endpoint).href;

/**
 * The T3-global MCP servers a thread may use, as thread connectors with secrets resolved. An
 * integration points at T3's proxy with the thread's session token, never at the service, and only
 * an assistant thread pre-approves it (T3's gate decides there). Unreadable settings add none, so
 * a session never fails to start over them.
 */
export const globalMcpConnectors = (
  settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">,
  thread: ThreadMcpContext,
): Effect.Effect<ReadonlyArray<ThreadConnector>> =>
  settings.getSettings.pipe(
    Effect.map((current) =>
      Object.entries(current.mcpServers).flatMap(([name, server]): ThreadConnector[] => {
        if (!t3ServerAllowed(name, server, thread.assistant)) return [];
        if (server.transport === "stdio") {
          return [
            {
              name: t3McpProviderName(name),
              transport: "stdio",
              command: server.command,
              args: server.args,
              headers: {},
              env: server.env,
            },
          ];
        }
        if (server.integration === undefined) {
          return [
            {
              name: t3McpProviderName(name),
              transport: "http",
              url: server.url,
              args: [],
              headers: server.headers,
              env: {},
            },
          ];
        }
        if (thread.session === undefined || thread.native?.has(server.integration.catalogId)) {
          return [];
        }
        return [
          {
            name: t3McpProviderName(name),
            transport: "http",
            url: integrationProxyUrl(thread.session.endpoint, name),
            args: [],
            headers: { Authorization: thread.session.authorizationHeader },
            env: {},
            proxy: { preApproved: thread.assistant !== undefined },
          },
        ];
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("T3 MCP servers skipped: settings unreadable", { cause }).pipe(
        Effect.as([]),
      ),
    ),
  );
