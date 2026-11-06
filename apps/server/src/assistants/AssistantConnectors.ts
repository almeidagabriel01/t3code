// @effect-diagnostics nodeBuiltinImport:off -- A synchronous hash names secret files without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import {
  type AssistantError as AssistantErrorType,
  AssistantError,
  type AssistantMcpServer,
  type AssistantMcpServerInput,
  assistantMcpServersProblem,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadConnector } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AssistantDirectory from "./AssistantDirectory.ts";

type Kind = "header" | "env";

/** Hashed so a header name of any length or characters is a safe file name. */
const connectorSecretName = (
  assistantId: string,
  server: string,
  kind: Kind,
  key: string,
): string =>
  `assistant-mcp-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([assistantId, server, kind, key]))
    .digest("hex")
    .slice(0, 40)}`;

const savedSecretNames = (assistantId: string, server: AssistantMcpServer) => [
  ...server.headers
    .filter((row) => row.hasValue)
    .map((row) => connectorSecretName(assistantId, server.name, "header", row.key)),
  ...server.env
    .filter((row) => row.hasValue)
    .map((row) => connectorSecretName(assistantId, server.name, "env", row.key)),
];

export interface SavedConnectors {
  /** What the row stores: names and flags only, never a value. */
  readonly servers: ReadonlyArray<AssistantMcpServer>;
  /** Removes the secrets the new list no longer references; run after the row is written. */
  readonly removeStale: Effect.Effect<void, AssistantErrorType>;
}

export class AssistantConnectors extends Context.Service<
  AssistantConnectors,
  {
    /** Validates the list, writes its secret values and returns the secret-free form to store. */
    readonly save: (
      assistantId: string,
      previous: ReadonlyArray<AssistantMcpServer>,
      input: ReadonlyArray<AssistantMcpServerInput>,
    ) => Effect.Effect<SavedConnectors, AssistantErrorType>;
    /** Deletes every secret the servers hold. */
    readonly purge: (
      assistantId: string,
      servers: ReadonlyArray<AssistantMcpServer>,
    ) => Effect.Effect<void, AssistantErrorType>;
    /** Enabled connectors of the thread's assistant with values resolved; none for any other thread. */
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadConnector>>;
  }
>()("t3/assistants/AssistantConnectors") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const directory = yield* AssistantDirectory.AssistantDirectory;

  // Secret store errors name the secret file; only the stage is logged.
  const secretFailure = <A>(effect: Effect.Effect<A, ServerSecretStore.SecretStoreError>) =>
    effect.pipe(
      Effect.catch(() =>
        Effect.logWarning("Connector secrets could not be read or saved.").pipe(
          Effect.andThen(
            Effect.fail(
              new AssistantError({
                reason: "storage",
                message: "Could not save the connector's secret values.",
              }),
            ),
          ),
        ),
      ),
    );
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const removeAll = (names: Iterable<string>) =>
    Effect.forEach(names, (name) => secretFailure(secrets.remove(name)), { discard: true });

  const save: AssistantConnectors["Service"]["save"] = Effect.fn("AssistantConnectors.save")(
    function* (assistantId, previous, input) {
      const problem = assistantMcpServersProblem(input);
      if (problem !== null)
        return yield* new AssistantError({ reason: "invalid", message: problem });
      const stale = new Set(previous.flatMap((server) => savedSecretNames(assistantId, server)));
      const rows = Effect.fn("AssistantConnectors.rows")(function* (
        serverName: string,
        kind: Kind,
        given: ReadonlyArray<{ readonly key: string; readonly value?: string | undefined }>,
        before: ReadonlyArray<{ readonly key: string; readonly hasValue: boolean }>,
      ) {
        return yield* Effect.forEach(given, (row) =>
          Effect.gen(function* () {
            const name = connectorSecretName(assistantId, serverName, kind, row.key);
            if (row.value === undefined) {
              const kept = before.some((entry) => entry.key === row.key && entry.hasValue);
              if (kept) stale.delete(name);
              return { key: row.key, hasValue: kept };
            }
            if (row.value === "") return { key: row.key, hasValue: false };
            yield* secretFailure(secrets.set(name, encoder.encode(row.value)));
            stale.delete(name);
            return { key: row.key, hasValue: true };
          }),
        );
      });
      const servers: Array<AssistantMcpServer> = [];
      for (const server of input) {
        const before = previous.find((entry) => entry.name === server.name);
        const http = server.transport === "http";
        servers.push({
          name: server.name,
          transport: server.transport,
          ...(http
            ? { url: (server.url ?? "").trim() }
            : { command: (server.command ?? "").trim() }),
          args: http ? [] : (server.args ?? []),
          headers: http
            ? yield* rows(server.name, "header", server.headers ?? [], before?.headers ?? [])
            : [],
          env: http ? [] : yield* rows(server.name, "env", server.env ?? [], before?.env ?? []),
          enabled: server.enabled,
        });
      }
      return { servers, removeStale: removeAll(stale) } satisfies SavedConnectors;
    },
  );

  const purge: AssistantConnectors["Service"]["purge"] = (assistantId, servers) =>
    removeAll(servers.flatMap((server) => savedSecretNames(assistantId, server)));

  const resolveRows = (
    assistantId: string,
    serverName: string,
    kind: Kind,
    rows: AssistantMcpServer["headers"],
  ) =>
    Effect.forEach(
      rows.filter((row) => row.hasValue),
      (row) =>
        secrets
          .get(connectorSecretName(assistantId, serverName, kind, row.key))
          .pipe(Effect.map(Option.map((bytes) => [row.key, decoder.decode(bytes)] as const))),
    ).pipe(Effect.map((entries) => Object.fromEntries(entries.flatMap(Option.toArray))));

  const forThread: AssistantConnectors["Service"]["forThread"] = Effect.fn(
    "AssistantConnectors.forThread",
  )(function* (threadId) {
    const found = yield* directory.forThread(threadId);
    if (Option.isNone(found)) return [];
    const assistant = found.value.assistant;
    const resolved = yield* Effect.forEach(
      assistant.mcpServers.filter((server) => server.enabled),
      (server) =>
        Effect.gen(function* () {
          const usable = server.transport === "http" ? server.url : server.command;
          if (usable === undefined || usable === "") return undefined;
          return {
            name: server.name,
            transport: server.transport,
            ...(server.url === undefined ? {} : { url: server.url }),
            ...(server.command === undefined ? {} : { command: server.command }),
            args: server.args,
            headers: yield* resolveRows(assistant.id, server.name, "header", server.headers),
            env: yield* resolveRows(assistant.id, server.name, "env", server.env),
          } satisfies ThreadConnector;
          // One unreadable secret drops only that connector, never the assistant's other tools.
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning("A connector was left out: its secrets could not be read.", {
              server: server.name,
            }).pipe(Effect.as(undefined)),
          ),
        ),
    );
    return resolved.filter((entry) => entry !== undefined);
  });

  return AssistantConnectors.of({ save, purge, forThread });
});

export const layer = Layer.effect(AssistantConnectors, make);
