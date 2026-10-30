import type {
  ClaudeChromeLaunchOverride,
  ClaudeChromeStatus,
  ClaudeSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { parseCliArgs } from "@t3tools/shared/cliArgs";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

/** Mirrors the CLI: `<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json` (not under `~/.claude`). */
export const resolveClaudeConfigJsonPath = Effect.fn("resolveClaudeConfigJsonPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const hasConfigDir =
    config.homePath.trim().length > 0 || (environment?.CLAUDE_CONFIG_DIR?.trim() ?? "").length > 0;
  return hasConfigDir
    ? path.join(yield* resolveClaudeHomePath(config, environment), ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

export const claudeChromeLaunchOverride = (
  launchFlags: Readonly<Record<string, unknown>>,
): ClaudeChromeLaunchOverride | null =>
  "chrome" in launchFlags ? "on" : "no-chrome" in launchFlags ? "off" : null;

const parseClaudeConfigObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Never throws: a file the CLI is mid-write or the user mangled reads as "nothing set". */
export const readClaudeChromeConfig = (text: string | null) => {
  const config = text === null ? null : parseClaudeConfigObject(text);
  const extension = config?.chromeExtension;
  const paired =
    typeof extension === "object" && extension !== null
      ? (extension as Record<string, unknown>).pairedDeviceName
      : undefined;
  return {
    enabledByDefault: config?.claudeInChromeDefaultEnabled === true,
    extensionInstalled:
      typeof config?.cachedChromeExtensionInstalled === "boolean"
        ? config.cachedChromeExtensionInstalled
        : null,
    pairedBrowser: typeof paired === "string" && paired.length > 0 ? paired : null,
  };
};

export class ClaudeChromeConfigError extends Data.TaggedError("ClaudeChromeConfigError")<{
  readonly detail: string;
}> {}

type ClaudeChromeTarget = {
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<ClaudeSettings, "homePath" | "launchArgs">;
  readonly environment?: NodeJS.ProcessEnv;
};

const claudeChromeStatusOf = (
  target: ClaudeChromeTarget,
  text: string | null,
): ClaudeChromeStatus => {
  const config = readClaudeChromeConfig(text);
  const launchOverride = claudeChromeLaunchOverride(parseCliArgs(target.settings.launchArgs).flags);
  return {
    instanceId: target.instanceId,
    enabledByDefault: config.enabledByDefault,
    launchOverride,
    effective: launchOverride === null ? config.enabledByDefault : launchOverride === "on",
    extensionInstalled: config.extensionInstalled,
    pairedBrowser: config.pairedBrowser,
    sharedConfig:
      target.settings.homePath.trim().length === 0 &&
      (target.environment?.CLAUDE_CONFIG_DIR?.trim() ?? "").length === 0,
  };
};

export const readClaudeChromeStatus = Effect.fn("readClaudeChromeStatus")(function* (
  target: ClaudeChromeTarget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* resolveClaudeConfigJsonPath(target.settings, target.environment);
  const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  return claudeChromeStatusOf(target, text);
});

export const writeClaudeChromeDefault = Effect.fn("writeClaudeChromeDefault")(function* (
  target: ClaudeChromeTarget,
  enabled: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* resolveClaudeConfigJsonPath(target.settings, target.environment);
  const current = yield* fileSystem.readFileString(file).pipe(
    Effect.map((text): string | null => text),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError(
      (cause) =>
        new ClaudeChromeConfigError({ detail: `Could not read ${file}: ${cause.message}` }),
    ),
  );
  const existing =
    current === null || current.trim().length === 0 ? {} : parseClaudeConfigObject(current);
  if (existing === null) {
    return yield* new ClaudeChromeConfigError({
      detail: `${file} is not a JSON object. Fix or remove it, then try again.`,
    });
  }
  // @effect-diagnostics-next-line preferSchemaOverJson:off -- keeps the CLI's two-space layout; no wire codec.
  const next = JSON.stringify({ ...existing, claudeInChromeDefaultEnabled: enabled }, null, 2);
  // ponytail: the CLI also rewrites this file; a change it lands between the read above and the rename is lost. Add a lock only if the CLI ever exposes one.
  yield* writeFileStringAtomically({ filePath: file, contents: next }).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeChromeConfigError({ detail: `Could not write ${file}: ${cause.message}` }),
    ),
  );
  return claudeChromeStatusOf(target, next);
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
