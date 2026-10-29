import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderDriverKind,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  MemoryGenerationRunnerError,
  withMemoryExecution,
  type MemoryGenerationRunnerContext,
} from "@t3tools/provider-core/server/memoryGenerationRunner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toStrictJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_TIMEOUT_MS = 180_000;
/**
 * Memory generation answers from its prompt alone: no user config (and so no configured MCP
 * servers), no exec rules, and no shell, apps, plugins, browser, computer, image, or hook tools.
 */
const CODEX_MEMORY_ARGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "--disable",
  "shell_tool",
  "--disable",
  "unified_exec",
  "--disable",
  "apps",
  "--disable",
  "plugins",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
  "--disable",
  "view_image",
  "--disable",
  "hooks",
] as const;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
  memoryRunnerContext?: MemoryGenerationRunnerContext,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  /**
   * Memory runs in its own home so the user's global AGENTS.md stays out. Only auth.json is
   * linked in; Codex refreshes it in place, and a replaced link is copied back so no rotated
   * token is lost. Without the link the run fails before spawning.
   */
  const makeMemoryCodexHome = Effect.fn("makeMemoryCodexHome")(function* (
    operation: TextGenerationOperations.Operation,
    userHome: string,
  ) {
    const memoryHome = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-codex-memory-home-" })
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError("codex", operation, cause, "Failed to create memory Codex home"),
        ),
      );
    const userAuth = path.join(userHome, "auth.json");
    const memoryAuth = path.join(memoryHome, "auth.json");
    // API-key users have no auth.json to link; the fresh home still keeps user config out.
    if (!(yield* fileSystem.exists(userAuth).pipe(Effect.orElseSucceed(() => false))))
      return memoryHome;
    const linked = yield* fileSystem.symlink(userAuth, memoryAuth).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!linked)
      return yield* new TextGenerationError({
        operation,
        detail: "Codex memory generation could not isolate its authentication home.",
        // Typed so memory pauses this model: this host cannot link the auth file.
        cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
      });
    yield* Effect.addFinalizer(() =>
      fileSystem.readLink(memoryAuth).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.void,
          onFailure: () =>
            fileSystem
              .readFile(memoryAuth)
              .pipe(Effect.flatMap((auth) => fileSystem.writeFile(userAuth, auth))),
        }),
        Effect.ignore,
      ),
    );
    return memoryHome;
  });

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    { readonly result: S["Type"]; readonly effectiveModel: string },
    TextGenerationError,
    S["DecodingServices"]
  > {
    const isMemory = TextGenerationOperations.isMemoryOperation(operation);
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      yield* toStrictJsonSchemaObject(operation, outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              // The setup error stays as the cause so memory can pause a model it cannot run.
              (cause) => new TextGenerationError({ operation, detail: cause.detail, cause }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      if (isMemory && !effectiveConfig.enabled)
        return yield* new TextGenerationError({
          operation,
          detail: "Codex is disabled in settings.",
        });
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      // Memory runs in an empty directory so nothing in a checkout reaches the model.
      const workingDirectory = isMemory
        ? yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3code-codex-memory-" })
            .pipe(
              Effect.mapError((cause) =>
                normalizeCliError("codex", operation, cause, "Failed to create memory directory"),
              ),
            )
        : cwd;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const configuredHome = effectiveConfig.homePath
        ? expandHomePath(effectiveConfig.homePath, homeDirectory)
        : undefined;
      const codexHome = isMemory
        ? yield* makeMemoryCodexHome(
            operation,
            configuredHome ?? effectiveEnvironment.CODEX_HOME ?? path.join(homeDirectory, ".codex"),
          )
        : configuredHome;
      const env = {
        ...effectiveEnvironment,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      };
      const execLaunchArgs = isMemory ? [...CODEX_MEMORY_ARGS] : codexExecLaunchArgs(launchArgs);
      const mcpServersOff = isMemory
        ? null
        : yield* listEnabledMcpServers({
            binary,
            cwd,
            env,
            // `codex mcp` rejects --strict-config; the overrides still apply.
            launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
          }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...execLaunchArgs,
          // A user's MCP server could act on the text-generation prompt.
          ...CODEX_NO_PLUGIN_ARGS,
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
      return model;
    });

    const cleanup = Effect.all([removeTempFileDir(schemaPath), removeTempFileDir(outputPath)], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      const effectiveModel = yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      const decodeOutput = (json: string) =>
        Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
          json,
          TextGenerationOperations.outputDecodeOptions(operation),
        );

      const result = yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
      return { result, effectiveModel };
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner(
    "CodexTextGeneration",
    (request) => runCodexJson(request).pipe(Effect.map((selected) => selected.result)),
    { memoryRunner: withMemoryExecution(memoryRunnerContext, CODEX_DRIVER, runCodexJson) },
  );
});
