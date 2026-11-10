import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

/** `signed-out`: no usable ChatGPT sign-in; `rejected`: it could not be renewed; `failed`: anything else. */
export type ChatGptSpeechAuthFailure = "signed-out" | "rejected" | "failed";

export interface ChatGptSpeechSession {
  /** A refresh asks for a renewed token after the first one was refused. */
  readonly token: (
    refresh: boolean,
  ) => Effect.Effect<string, ChatGptSpeechAuthFailure, Scope.Scope>;
}

export class ChatGptSpeechAuth extends Context.Service<
  ChatGptSpeechAuth,
  {
    /** Local reads only: never spawns a process or calls the network. */
    readonly available: Effect.Effect<boolean>;
    /** Credentials stay on one Codex instance; any process it spawns closes with the scope. */
    readonly open: Effect.Effect<ChatGptSpeechSession, ChatGptSpeechAuthFailure, Scope.Scope>;
  }
>()("t3/speech/ChatGptSpeechAuth") {}

export const layer = Layer.effect(
  ChatGptSpeechAuth,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const hostCwd = yield* HostProcess.WorkingDirectory;
    // The layer's own scope must not replace the per-request scope that closes spawned processes.
    const services = Context.omit(Scope.Scope)(
      yield* Effect.context<
        Exclude<
          | Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>
          | Effect.Services<ReturnType<typeof withCodexAppServerClient>>
          | Path.Path,
          Scope.Scope
        >
      >(),
    );
    const pick = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const usable = (id: string | undefined) => {
        const entry = id ? settings.providerInstances[ProviderInstanceId.make(id)] : undefined;
        return entry?.driver === "codex" && entry.enabled !== false;
      };
      const instanceId = [
        settings.defaultModelSelection?.instanceId,
        "codex",
        ...Object.keys(settings.providerInstances),
      ].find(usable);
      const entry = instanceId
        ? settings.providerInstances[ProviderInstanceId.make(instanceId)]
        : undefined;
      if (!instanceId || !entry) return yield* Effect.fail("signed-out" as const);
      const config = yield* decodeCodexSettings(entry.config ?? {});
      if (!config.enabled) return yield* Effect.fail("signed-out" as const);
      return { instanceId: ProviderInstanceId.make(instanceId), entry, config };
    });

    const available = pick.pipe(
      Effect.flatMap(({ instanceId, config }) =>
        config.setupMode === "managed"
          ? makeCodexChatGptAuth({ instanceId }).pipe(
              Effect.flatMap((auth) => auth.read),
              Effect.map(Option.isSome),
            )
          : Effect.succeed(true),
      ),
      Effect.scoped,
      Effect.provide(services),
      Effect.orElseSucceed(() => false),
    );

    const open = Effect.gen(function* () {
      const { instanceId, entry, config } = yield* pick;
      if (config.setupMode === "managed") {
        const auth = yield* makeCodexChatGptAuth({ instanceId });
        // `access` renews a token that is about to expire, so a retry needs no extra flag.
        return {
          token: () =>
            auth.access.pipe(
              Effect.map((credentials) => credentials.accessToken),
              Effect.mapError(() => "rejected" as const),
            ),
        } satisfies ChatGptSpeechSession;
      }
      const environment = yield* mergeProviderInstanceEnvironment(entry.environment);
      const layout = yield* resolveCodexHomeLayout(config);
      // Spawn lazily so a failed first attempt costs no process.
      let connection: Effect.Success<ReturnType<typeof withCodexAppServerClient>> | undefined;
      const token = Effect.fn("ChatGptSpeechAuth.token")(function* (refresh: boolean) {
        connection ??= yield* withCodexAppServerClient({
          binaryPath: config.binaryPath,
          homePath: layout.effectiveHomePath ?? environment.CODEX_HOME ?? layout.sharedHomePath,
          launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
          cwd: hostCwd,
          environment,
        });
        const result = yield* connection.client.request("getAuthStatus", {
          includeToken: true,
          refreshToken: refresh,
        });
        if (result.authMethod !== "chatgpt" || !result.authToken)
          return yield* Effect.fail("signed-out" as const);
        return result.authToken;
      });
      return {
        token: (refresh: boolean) =>
          token(refresh).pipe(
            Effect.mapError((error) => (error === "signed-out" ? error : ("failed" as const))),
            Effect.provide(services),
          ),
      } satisfies ChatGptSpeechSession;
    }).pipe(
      Effect.mapError((error): ChatGptSpeechAuthFailure =>
        typeof error === "string" ? error : "failed",
      ),
      Effect.provide(services),
    );
    return ChatGptSpeechAuth.of({ available, open });
  }),
);
