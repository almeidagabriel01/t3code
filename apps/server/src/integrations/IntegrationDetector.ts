// Foreign config files are parsed tolerantly by hand; schema decoding would drop unknown shapes.
// @effect-diagnostics globalJsonInEffect:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- keyed hash for detected ids.
import * as NodeCrypto from "node:crypto";

import {
  ASSISTANT_MCP_RESERVED_NAMES,
  ClaudeSettings,
  CodexSettings,
  type DetectedServer,
  type DetectionSource,
  defaultInstanceIdForDriver,
  EnvKey,
  HeaderName,
  IntegrationCatalogEntry,
  IntegrationError,
  type IntegrationErrorReason,
  type IntegrationMakeAvailableResult,
  isMcpServerUrl,
  loadedNatively,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type T3McpServer,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { parse as parseToml } from "smol-toml";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  mergeClaudeProcessEnvironment,
  resolveClaudeConfigJsonPath,
  resolveClaudeHomePath,
} from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";
import catalogJson from "./catalog.json" with { type: "json" };

/** A server as its source wrote it, values included. It never leaves this module's service. */
export interface FoundServer {
  readonly name: string;
  readonly transport: string;
  readonly url?: string | undefined;
  readonly command?: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly needsValue: ReadonlyArray<string>;
  readonly enabled: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const strings = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value) ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const interpolated = (value: string) => /\$\{[^}]*\}/.test(value);

/** A Claude Code `mcpServers` map. An entry with neither a URL nor a command is unusable. */
export const parseClaudeServers = (value: unknown): Array<FoundServer> =>
  Object.entries(record(value) ?? {}).flatMap(([name, raw]) => {
    const entry = record(raw);
    const url = text(entry?.url);
    const command = text(entry?.command);
    if (entry === undefined || (url === undefined && command === undefined)) return [];
    const headers = stringMap(entry.headers);
    const env = stringMap(entry.env);
    return [
      {
        name,
        transport: text(entry.type) ?? (url === undefined ? "stdio" : "http"),
        url,
        command,
        args: strings(entry.args),
        headers,
        env,
        needsValue: [...Object.entries(headers), ...Object.entries(env)]
          .filter(([, value]) => interpolated(value))
          .map(([key]) => key),
        enabled: true,
      },
    ];
  });

/** Codex `[mcp_servers.<name>]` tables; throws on a file that is not TOML. */
export const parseCodexServers = (toml: string): Array<FoundServer> =>
  Object.entries(record(parseToml(toml).mcp_servers) ?? {}).flatMap(([name, raw]) => {
    const entry = record(raw);
    const url = text(entry?.url);
    const command = text(entry?.command);
    if (entry === undefined || (url === undefined && command === undefined)) return [];
    return [
      {
        name,
        transport: url === undefined ? "stdio" : "http",
        url,
        command,
        args: strings(entry.args),
        headers: stringMap(entry.http_headers),
        env: stringMap(entry.env),
        needsValue: [
          ...(typeof entry.bearer_token_env_var === "string" ? ["Authorization"] : []),
          ...Object.keys(record(entry.env_http_headers) ?? {}),
          ...strings(entry.env_vars),
        ],
        enabled: entry.enabled !== false,
      },
    ];
  });

/** Scheme and host lowercased (by URL), default port, query, fragment and trailing slash dropped. */
const normalizeMcpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
};

/** `@scope/pkg@1.2` and `pkg@latest` name the package without the version. */
const packageName = (word: string) => word.replace(/(?<=.)@[^/@]*$/, "");

/** URL, then npm package in the command or args, then name (INT-31); only catalog data decides. */
export const matchCatalog = (
  catalog: ReadonlyArray<IntegrationCatalogEntry>,
  server: Pick<FoundServer, "name" | "url" | "command" | "args">,
): string | null => {
  const url = server.url === undefined ? undefined : normalizeMcpUrl(server.url);
  const byUrl =
    url === undefined
      ? undefined
      : catalog.find((entry) =>
          entry.match.urls.some((candidate) => normalizeMcpUrl(candidate) === url),
        );
  if (byUrl !== undefined) return byUrl.id;
  const words = [server.command ?? "", ...server.args].map(packageName);
  const byPackage = catalog.find((entry) =>
    entry.match.packages.some((candidate) => words.includes(candidate)),
  );
  if (byPackage !== undefined) return byPackage.id;
  // A plugin server is `plugin:<plugin>:<server>`.
  const names = [server.name, server.name.split(":").at(-1) ?? ""].map((name) =>
    name.toLowerCase(),
  );
  return (
    catalog.find((entry) =>
      entry.match.names.some((candidate) => names.includes(candidate.toLowerCase())),
    )?.id ?? null
  );
};

/** `.mcp.json` approval: a disabled listing wins, then enable-all or an enabled listing. */
export const mcpJsonApproval = (
  name: string,
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
): "approved" | "pending" | "disabled" => {
  const listed = (key: string) => sources.some((source) => strings(source?.[key]).includes(name));
  if (listed("disabledMcpjsonServers")) return "disabled";
  if (sources.some((source) => source?.enableAllProjectMcpServers === true)) return "approved";
  return listed("enabledMcpjsonServers") ? "approved" : "pending";
};

/** A T3 server name from any source name: lowercase, dashes, at most 40 characters. */
export const serverNameFrom = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");
  return slug === "" ? "server" : slug;
};

const freeName = (base: string, taken: Readonly<Record<string, unknown>>) => {
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base}-${index}`;
    if (taken[name] === undefined) return name;
  }
};

interface ClaudeSessionRecord {
  readonly seenAt: number;
  readonly servers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
}

const decodeSessionRecord = (bytes: Uint8Array): ClaudeSessionRecord | undefined => {
  try {
    const value = record(JSON.parse(new TextDecoder().decode(bytes)));
    if (typeof value?.seenAt !== "number" || !Array.isArray(value.servers)) return undefined;
    return {
      seenAt: value.seenAt,
      servers: value.servers.flatMap((entry) => {
        const server = record(entry);
        return typeof server?.name === "string" && typeof server.status === "string"
          ? [{ name: server.name, status: server.status }]
          : [];
      }),
    };
  } catch {
    return undefined;
  }
};

/** T3's own servers appear in Claude's list too; they are never "set up outside T3". */
const injectedByT3 = (name: string) =>
  ASSISTANT_MCP_RESERVED_NAMES.includes(name) || name.endsWith("_t3");

const sessionSecret = (instanceId: string) =>
  `integration-claude-session-${NodeCrypto.createHash("sha256").update(instanceId).digest("hex").slice(0, 24)}`;

const readCodexConfig = (
  result: ReadResult,
): { readonly result: ReadResult; readonly servers: ReadonlyArray<FoundServer> } => {
  if (result.status !== "ok") return { result, servers: [] };
  try {
    return { result, servers: parseCodexServers(result.text) };
  } catch {
    return { result: { status: "unreadable", reason: "invalid-format" }, servers: [] };
  }
};

type ReadResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly reason: NonNullable<DetectionSource["reason"]> };

interface ScanRow {
  readonly view: DetectedServer;
  readonly found: FoundServer | undefined;
}

export interface Detection {
  readonly detected: ReadonlyArray<DetectedServer>;
  readonly sources: ReadonlyArray<DetectionSource>;
}

export class IntegrationDetector extends Context.Service<
  IntegrationDetector,
  {
    /** Read-only scan of every source (INT-29); one unreadable source never hides the others. */
    readonly detect: Effect.Effect<Detection>;
    /** Fires when a Claude session reports a different list of loaded servers. */
    readonly changes: Stream.Stream<void>;
    /** What a Claude session's init reported loading; kept per instance across restarts (D11). */
    readonly recordClaudeSession: (
      instanceId: ProviderInstanceId,
      servers: ReadonlyArray<{ readonly name: string; readonly status: string }>,
    ) => Effect.Effect<void>;
    /** Catalog entries the instance already loads itself, so T3 does not inject them (D7). */
    readonly nativeCatalogIds: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlySet<string>>;
    /** Copies a detected Claude Code or Codex server into T3's MCP servers (INT-36..38). */
    readonly makeAvailable: (input: {
      readonly detectedId: string;
    }) => Effect.Effect<IntegrationMakeAvailableResult, IntegrationError>;
  }
>()("t3/integrations/IntegrationDetector") {}

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const isHeaderName = Schema.is(HeaderName);
const isEnvKey = Schema.is(EnvKey);

const fail = (reason: IntegrationErrorReason) => Effect.fail(new IntegrationError({ reason }));

const make = Effect.fn("IntegrationDetector.make")(function* (
  catalog: ReadonlyArray<IntegrationCatalogEntry>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcess.Environment;
  const services = yield* Effect.context<
    | Effect.Services<ReturnType<typeof mergeClaudeProcessEnvironment>>
    | Effect.Services<ReturnType<typeof resolveClaudeConfigJsonPath>>
    | Effect.Services<ReturnType<typeof resolveCodexHomeLayout>>
    | Effect.Services<ReturnType<typeof mergeProviderInstanceEnvironment>>
  >();
  const changesPubSub = yield* PubSub.unbounded<void>();
  // Ids are keyed so they reveal nothing about the values they cover; a restart re-keys them.
  const idKey = NodeCrypto.randomBytes(32);

  const readText = (file: string): Effect.Effect<ReadResult> =>
    fs.readFileString(file).pipe(
      Effect.map((value): ReadResult => ({ status: "ok", text: value })),
      Effect.catch((error) =>
        Effect.succeed<ReadResult>(
          error.reason._tag === "NotFound"
            ? { status: "missing" }
            : {
                status: "unreadable",
                reason:
                  error.reason._tag === "PermissionDenied" ? "permission-denied" : "read-failed",
              },
        ),
      ),
    );
  // Rebuilds follow every settings write and session start; an unchanged file is never re-parsed.
  // ponytail: one entry per path ever read, never evicted; paths are config files, so few.
  const parsed = new Map<string, { readonly stamp: string; readonly value: unknown }>();
  const memoRead = <A>(file: string, parse: (result: ReadResult) => A): Effect.Effect<A> =>
    fs.stat(file).pipe(
      Effect.map((info) => `${Option.getOrUndefined(info.mtime)?.getTime()}:${info.size}`),
      Effect.option,
      Effect.flatMap((stamp) => {
        const hit = parsed.get(file);
        if (Option.isSome(stamp) && hit?.stamp === stamp.value) {
          return Effect.succeed(hit.value as A);
        }
        return readText(file).pipe(
          Effect.map(parse),
          Effect.tap((value) =>
            Effect.sync(() => {
              if (Option.isSome(stamp)) parsed.set(file, { stamp: stamp.value, value });
              else parsed.delete(file);
            }),
          ),
        );
      }),
    );
  const readJson = (file: string) =>
    memoRead(file, (result) => {
      if (result.status !== "ok") return { result, value: undefined };
      try {
        const value = record(JSON.parse(result.text));
        if (value !== undefined) return { result, value };
      } catch {
        // falls through to invalid-format
      }
      return {
        result: { status: "unreadable", reason: "invalid-format" } as ReadResult,
        value: undefined,
      };
    });
  const sourceOf = (
    base: Pick<DetectionSource, "origin" | "instanceId" | "path">,
    result: ReadResult,
  ): DetectionSource => ({
    ...base,
    status: result.status === "ok" ? "ok" : result.status,
    ...(result.status === "unreadable" ? { reason: result.reason } : {}),
  });

  const readSession = (instanceId: string) =>
    secrets.get(sessionSecret(instanceId)).pipe(
      Effect.map((bytes) => (Option.isSome(bytes) ? decodeSessionRecord(bytes.value) : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const projectPaths = sql<{ readonly workspace_root: string }>`
      SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL
    `.pipe(
    Effect.map((rows) => [...new Set(rows.map((row) => row.workspace_root))]),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const idOf = (parts: ReadonlyArray<unknown>) =>
    NodeCrypto.createHmac("sha256", idKey).update(JSON.stringify(parts)).digest("hex").slice(0, 32);

  const rowOf = (
    found: FoundServer,
    base: Pick<DetectedServer, "origin"> &
      Partial<Pick<DetectedServer, "instanceId" | "scope" | "projectPath" | "loaded" | "approval">>,
  ): ScanRow => {
    const url = found.url === undefined ? undefined : normalizeMcpUrl(found.url);
    const runnable = found.transport === "http" || found.transport === "stdio";
    const copyable =
      (base.origin === "claude-code" || base.origin === "codex") &&
      base.scope !== "plugin" &&
      runnable &&
      !(found.url !== undefined && interpolated(found.url));
    // The id covers what a copy would write, not the status that changes between sessions.
    const { loaded: _loaded, ...identity } = base;
    return {
      found,
      view: {
        id: idOf([identity, found]),
        name: found.name,
        ...base,
        catalogId: matchCatalog(catalog, found),
        transport: found.transport,
        ...(url === undefined ? {} : { url }),
        ...(found.command === undefined ? {} : { command: found.command }),
        enabled: found.enabled,
        copyable,
        secretKeys: [...Object.keys(found.headers), ...Object.keys(found.env)].filter(
          (key) => !found.needsValue.includes(key),
        ),
        needsValue: [...found.needsValue],
      },
    };
  };

  const instances = serverSettings.getSettings.pipe(
    Effect.map((settings) => {
      const entries = new Map<string, ProviderInstanceConfig>(
        Object.entries(settings.providerInstances),
      );
      for (const driver of [CLAUDE, CODEX]) {
        const id = defaultInstanceIdForDriver(driver);
        if (!entries.has(id)) entries.set(id, { driver });
      }
      return { settings, entries: [...entries].filter(([, entry]) => entry.enabled !== false) };
    }),
  );

  const scanClaude = Effect.fn("IntegrationDetector.scanClaude")(function* (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
    projects: ReadonlyArray<string>,
  ) {
    const config = decodeClaude(entry.config ?? {});
    if (Option.isNone(config) || !config.value.enabled) return { rows: [], sources: [] };
    const environment = yield* mergeClaudeProcessEnvironment(
      config.value,
      entry.environment,
      hostEnvironment,
    );
    const file = yield* resolveClaudeConfigJsonPath(config.value, environment);
    const home = yield* resolveClaudeHomePath(config.value, environment);
    const claudeJson = yield* readJson(file);
    const session = yield* readSession(instanceId);
    const loaded = (name: string) => {
      const status = session?.servers.find((server) => server.name === name)?.status;
      return status === undefined ? {} : { loaded: status };
    };
    const sources: Array<DetectionSource> = [
      sourceOf({ origin: "claude-code", instanceId, path: file }, claudeJson.result),
      {
        origin: "claude-ai",
        instanceId,
        ...(session === undefined
          ? { status: "not-seen" as const }
          : { status: "ok" as const, seenAt: session.seenAt }),
      },
    ];
    const rows: Array<ScanRow> = parseClaudeServers(claudeJson.value?.mcpServers).map((found) =>
      rowOf(found, { origin: "claude-code", instanceId, scope: "user", ...loaded(found.name) }),
    );
    for (const server of session?.servers ?? []) {
      const plugin = server.name.startsWith("plugin:");
      if (!plugin && !server.name.startsWith("claude.ai ")) continue;
      // Names only: the catalog lists claude.ai connectors by their full name.
      rows.push(
        rowOf(
          {
            name: server.name,
            transport: "unknown",
            args: [],
            headers: {},
            env: {},
            needsValue: [],
            enabled: true,
          },
          {
            origin: plugin ? "claude-code" : "claude-ai",
            instanceId,
            ...(plugin ? { scope: "plugin" } : {}),
            loaded: server.status,
          },
        ),
      );
    }
    if (projects.length === 0) return { rows, sources };
    const homeSettings = (yield* readJson(path.join(home, "settings.json"))).value;
    const projectEntries = record(claudeJson.value?.projects);
    for (const projectPath of projects) {
      const local = record(projectEntries?.[projectPath]);
      for (const found of parseClaudeServers(local?.mcpServers)) {
        rows.push(
          rowOf(found, {
            origin: "claude-code",
            instanceId,
            scope: "local",
            projectPath,
            ...loaded(found.name),
          }),
        );
      }
      const mcpJsonPath = path.join(projectPath, ".mcp.json");
      const mcpJson = yield* readJson(mcpJsonPath);
      // A project without `.mcp.json` is the usual case, not a source to report.
      if (mcpJson.result.status === "missing") continue;
      if (mcpJson.result.status === "unreadable") {
        sources.push(
          sourceOf({ origin: "claude-code", instanceId, path: mcpJsonPath }, mcpJson.result),
        );
        continue;
      }
      const approvals = [
        local,
        homeSettings,
        (yield* readJson(path.join(projectPath, ".claude", "settings.json"))).value,
        (yield* readJson(path.join(projectPath, ".claude", "settings.local.json"))).value,
      ];
      for (const found of parseClaudeServers(mcpJson.value?.mcpServers)) {
        const approval = mcpJsonApproval(found.name, approvals);
        rows.push(
          rowOf(
            { ...found, enabled: approval === "approved" },
            {
              origin: "claude-code",
              instanceId,
              scope: "project",
              projectPath,
              approval,
              ...loaded(found.name),
            },
          ),
        );
      }
    }
    return { rows, sources };
  });

  const scanCodex = Effect.fn("IntegrationDetector.scanCodex")(function* (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
  ) {
    const config = decodeCodex(entry.config ?? {});
    if (Option.isNone(config) || !config.value.enabled) return { rows: [], sources: [] };
    const environment = yield* mergeProviderInstanceEnvironment(entry.environment, hostEnvironment);
    // The same home dictation reads Codex's sign-in from.
    const layout = yield* resolveCodexHomeLayout(config.value);
    const home =
      layout.effectiveHomePath ?? (environment.CODEX_HOME?.trim() || layout.sharedHomePath);
    const file = path.join(home, "config.toml");
    const { result, servers } = yield* memoRead(file, readCodexConfig);
    return {
      rows: servers.map((found) => rowOf(found, { origin: "codex", instanceId })),
      sources: [sourceOf({ origin: "codex", instanceId, path: file }, result)],
    };
  });

  const scan = Effect.fn("IntegrationDetector.scan")(function* (options: {
    readonly only?: ProviderInstanceId;
    readonly projects: boolean;
  }) {
    const { settings, entries } = yield* instances;
    const projects = options.projects ? yield* projectPaths : [];
    const rows: Array<ScanRow> = [];
    const sources: Array<DetectionSource> = [];
    for (const [id, entry] of entries) {
      if (options.only !== undefined && id !== options.only) continue;
      const instanceId = ProviderInstanceId.make(id);
      const found =
        entry.driver === CLAUDE
          ? yield* scanClaude(instanceId, entry, projects)
          : entry.driver === CODEX
            ? yield* scanCodex(instanceId, entry)
            : { rows: [], sources: [] };
      rows.push(...found.rows);
      sources.push(...found.sources);
    }
    if (options.only === undefined) {
      sources.push({ origin: "t3", status: "ok" });
      for (const [name, server] of Object.entries(settings.mcpServers)) {
        if (server.transport === "http" && server.integration !== undefined) continue;
        const row = rowOf(
          {
            name,
            transport: server.transport,
            ...(server.transport === "http"
              ? { url: server.url, command: undefined }
              : { command: server.command, url: undefined }),
            args: server.transport === "stdio" ? server.args : [],
            headers: {},
            env: {},
            needsValue: [],
            enabled: server.enabled,
          },
          { origin: "t3" },
        );
        rows.push({ view: row.view, found: undefined });
      }
    }
    return { rows, sources };
  });

  // Detection must never break the integrations state, so any defect reads as no rows.
  const detect = scan({ projects: true }).pipe(
    Effect.map(({ rows, sources }) => ({ detected: rows.map((row) => row.view), sources })),
    Effect.provide(services),
    Effect.catchCause((cause) =>
      Effect.logWarning("Integration detection failed", { cause }).pipe(
        Effect.as({ detected: [], sources: [] }),
      ),
    ),
  );

  const nativeCatalogIds = (instanceId: ProviderInstanceId) =>
    scan({ only: instanceId, projects: false }).pipe(
      Effect.map(
        ({ rows }) =>
          new Set(
            rows.flatMap((row) =>
              loadedNatively(row.view) && row.view.catalogId !== null ? [row.view.catalogId] : [],
            ),
          ) as ReadonlySet<string>,
      ),
      Effect.provide(services),
      Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
    );

  const recordClaudeSession = Effect.fn("IntegrationDetector.recordClaudeSession")(function* (
    instanceId: ProviderInstanceId,
    reported: ReadonlyArray<{ readonly name: string; readonly status: string }>,
  ) {
    const servers = reported
      .filter((server) => typeof server?.name === "string" && !injectedByT3(server.name))
      .map((server) => ({ name: server.name, status: String(server.status) }));
    const before = yield* readSession(instanceId);
    const next: ClaudeSessionRecord = { seenAt: yield* Clock.currentTimeMillis, servers };
    yield* secrets
      .set(sessionSecret(instanceId), new TextEncoder().encode(JSON.stringify(next)))
      .pipe(Effect.catch(() => Effect.logWarning("Claude session servers could not be saved")));
    if (JSON.stringify(before?.servers) !== JSON.stringify(servers)) {
      yield* PubSub.publish(changesPubSub, undefined);
    }
  });

  const sameTarget = (server: T3McpServer, found: FoundServer) =>
    server.transport === "http"
      ? found.transport === "http" && server.url === found.url
      : found.transport === "stdio" &&
        server.command === found.command &&
        JSON.stringify(server.args) === JSON.stringify(found.args);

  const makeAvailable = Effect.fn("IntegrationDetector.makeAvailable")(function* (input: {
    readonly detectedId: string;
  }) {
    const { rows } = yield* scan({ projects: true }).pipe(
      Effect.provide(services),
      Effect.mapError(() => new IntegrationError({ reason: "storage-failed" })),
    );
    const row = rows.find((candidate) => candidate.view.id === input.detectedId);
    if (row === undefined) return yield* fail("detected-not-found");
    const found = row.found;
    if (!row.view.copyable || found === undefined) return yield* fail("not-copyable");
    const http = found.transport === "http";
    // No static credential: the source signs in with OAuth, which T3 cannot borrow (INT-37).
    if (
      http &&
      row.view.catalogId !== null &&
      Object.keys(found.headers).length === 0 &&
      found.needsValue.length === 0
    ) {
      return { outcome: "connect", catalogId: row.view.catalogId } as const;
    }
    if (http && !isMcpServerUrl(found.url ?? "")) return yield* fail("url-not-allowed");
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => new IntegrationError({ reason: "storage-failed" })),
    );
    const values = http ? found.headers : found.env;
    const valid = http ? isHeaderName : isEnvKey;
    const kept = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => valid(key) && !found.needsValue.includes(key) && !interpolated(value),
      ),
    );
    const leftOut = [
      ...new Set([...found.needsValue, ...Object.keys(values).filter((key) => !(key in kept))]),
    ];
    // A repeated request lands on the copy it made instead of adding another.
    const existing = Object.entries(settings.mcpServers).find(([, server]) =>
      sameTarget(server, found),
    );
    if (existing !== undefined) {
      return { outcome: "copied", name: existing[0], leftOut } as const;
    }
    const name = freeName(serverNameFrom(found.name), settings.mcpServers);
    const server: T3McpServer = http
      ? { enabled: true, transport: "http", url: found.url ?? "", headers: kept }
      : {
          enabled: true,
          transport: "stdio",
          command: found.command ?? "",
          args: [...found.args],
          env: kept,
        };
    yield* serverSettings.updateSettings({ mcpServers: { [name]: server } }).pipe(
      // The cause may carry the values being written; only the stage is logged.
      Effect.catch(() =>
        Effect.logWarning("Make available could not save the server").pipe(
          Effect.andThen(fail("storage-failed")),
        ),
      ),
    );
    return { outcome: "copied", name, leftOut } as const;
  });

  return IntegrationDetector.of({
    detect,
    changes: Stream.fromPubSub(changesPubSub),
    recordClaudeSession,
    nativeCatalogIds,
    makeAvailable,
  });
});

const decodeEntry = Schema.decodeUnknownOption(IntegrationCatalogEntry);

export const layer = Layer.effect(
  IntegrationDetector,
  make(catalogJson.flatMap((entry) => Option.toArray(decodeEntry(entry)))),
);
