import {
  type ChatGptSpeechStatus,
  CodexSettings,
  ProviderInstanceId,
  type ProviderInstanceConfig,
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
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** Codex refreshes a ChatGPT access token this long before it expires; so do we. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const headerSafe = /^[!-~]{1,8192}$/;
const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
// Codex adds fields over time; unknown keys are ignored, and only a usable shape is required.
const decodeAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: NullableString,
      OPENAI_API_KEY: NullableString,
      tokens: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            access_token: NullableString,
            refresh_token: NullableString,
            account_id: NullableString,
          }),
        ),
      ),
    }),
  ),
);
const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      exp: Schema.optionalKey(Schema.Finite),
      "https://api.openai.com/auth": Schema.optionalKey(
        Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

/** Reads `exp` and the ChatGPT account id from a JWT without verifying it; the server checks it. */
export function chatGptTokenClaims(token: string) {
  const payload = token.split(".")[1];
  const claims = payload
    ? decodeClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(Option.getOrUndefined)
    : undefined;
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim();
  return {
    expiresAt: claims?.exp === undefined ? undefined : claims.exp * 1000,
    accountId: accountId && headerSafe.test(accountId) ? accountId : undefined,
  };
}

export type CodexLogin =
  | {
      readonly kind: "chatgpt";
      readonly accessToken: string;
      readonly refreshable: boolean;
      readonly accountId: string | undefined;
      readonly expiresAt: number | undefined;
    }
  | { readonly kind: "api-key" | "signed-out" | "unreadable" | "keychain" };

/** Classifies `$CODEX_HOME/auth.json`; `raw` is undefined when the file does not exist. */
export function parseCodexLogin(raw: string | undefined, store: string | undefined): CodexLogin {
  if (store === "keyring") return { kind: "keychain" };
  if (raw === undefined) return { kind: store === "auto" ? "keychain" : "signed-out" };
  const file = Option.getOrUndefined(decodeAuthFile(raw));
  if (!file) return { kind: "unreadable" };
  // Codex writes `chatgpt`, or `chatgptAuthTokens` when a host supplied the tokens.
  if (file.auth_mode && !file.auth_mode.startsWith("chatgpt")) return { kind: "api-key" };
  const accessToken = file.tokens?.access_token?.trim();
  if (accessToken) {
    if (!headerSafe.test(accessToken)) return { kind: "unreadable" };
    const claims = chatGptTokenClaims(accessToken);
    const accountId = file.tokens?.account_id?.trim();
    return {
      kind: "chatgpt",
      accessToken,
      refreshable: Boolean(file.tokens?.refresh_token?.trim()),
      accountId: accountId && headerSafe.test(accountId) ? accountId : claims.accountId,
      expiresAt: claims.expiresAt,
    };
  }
  return { kind: file.OPENAI_API_KEY?.trim() ? "api-key" : "signed-out" };
}

/** The top-level `cli_auth_credentials_store` of a Codex `config.toml`, lowercased. */
export function codexCredentialStore(config: string) {
  const topLevel = config.split(/^\s*\[/m)[0] ?? "";
  return /^\s*cli_auth_credentials_store\s*=\s*["']?([a-z]+)["']?/im
    .exec(topLevel)?.[1]
    ?.toLowerCase();
}

const stale = (login: Extract<CodexLogin, { kind: "chatgpt" }>, now: number) =>
  login.expiresAt !== undefined && login.expiresAt - REFRESH_WINDOW_MS <= now;

export function chatGptLoginStatus(login: CodexLogin, now: number): ChatGptSpeechStatus {
  if (login.kind !== "chatgpt") return login.kind;
  return stale(login, now) && !login.refreshable ? "expired" : "ready";
}

/** `signed-out`: no ChatGPT sign-in to use; `rejected`: Codex could not supply a current token. */
export type ChatGptSpeechAuthFailure = "signed-out" | "rejected";

export interface ChatGptSpeechCredentials {
  readonly token: Redacted.Redacted<string>;
  readonly accountId: string | undefined;
}

export interface ChatGptSpeechSession {
  /** `refresh` asks Codex to renew the sign-in after ChatGPT refused the current token. */
  readonly credentials: (
    refresh: boolean,
  ) => Effect.Effect<ChatGptSpeechCredentials, ChatGptSpeechAuthFailure, Scope.Scope>;
}

export class ChatGptSpeechAuth extends Context.Service<
  ChatGptSpeechAuth,
  {
    /** Local reads only: never starts Codex or calls the network. */
    readonly status: Effect.Effect<ChatGptSpeechStatus>;
    /** Any Codex process a session starts closes with the scope. */
    readonly open: Effect.Effect<ChatGptSpeechSession, ChatGptSpeechAuthFailure, Scope.Scope>;
  }
>()("t3/speech/ChatGptSpeechAuth") {}

export const layer = Layer.effect(
  ChatGptSpeechAuth,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostCwd = yield* HostProcess.WorkingDirectory;
    const hostEnvironment = yield* HostProcess.Environment;
    // The layer's own scope must not replace the per-request scope that closes spawned processes.
    const services = Context.omit(Scope.Scope)(
      yield* Effect.context<
        Exclude<
          | Effect.Services<ReturnType<typeof withCodexAppServerClient>>
          | Effect.Services<ReturnType<typeof resolveCodexHomeLayout>>
          | Effect.Services<ReturnType<typeof mergeProviderInstanceEnvironment>>,
          Scope.Scope
        >
      >(),
    );

    /** The Codex instance dictation borrows: the default model's, then `codex`, then any other. */
    const locate = Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const ids = new Set([
        settings.defaultModelSelection?.instanceId,
        "codex",
        ...Object.keys(settings.providerInstances),
      ]);
      let managed = false;
      for (const id of ids) {
        if (!id) continue;
        const entry: ProviderInstanceConfig | undefined =
          settings.providerInstances[ProviderInstanceId.make(id)] ??
          (id === "codex" ? { driver: "codex" as never } : undefined);
        if (entry?.driver !== "codex" || entry.enabled === false) continue;
        const config = yield* decodeCodexSettings(entry.config ?? {}).pipe(Effect.option);
        if (Option.isNone(config) || !config.value.enabled) continue;
        if (config.value.setupMode === "managed") {
          managed = true;
          continue;
        }
        const environment = yield* mergeProviderInstanceEnvironment(
          entry.environment,
          hostEnvironment,
        );
        const layout = yield* resolveCodexHomeLayout(config.value);
        const home =
          layout.effectiveHomePath ?? (environment.CODEX_HOME?.trim() || layout.sharedHomePath);
        return { home, config: config.value, environment, managedOnly: false };
      }
      if (!managed) return "codex-off" as const;
      // T3's managed tokens are scoped to the API, but a `codex login` on this machine still works.
      const config = yield* decodeCodexSettings({}).pipe(Effect.orDie);
      const layout = yield* resolveCodexHomeLayout(config);
      return {
        home: hostEnvironment.CODEX_HOME?.trim() || layout.sharedHomePath,
        config,
        environment: hostEnvironment,
        managedOnly: true,
      };
    }).pipe(Effect.provide(services));

    const readLogin = Effect.fn("ChatGptSpeechAuth.readLogin")(function* (home: string) {
      const store = yield* fs.readFileString(path.join(home, "config.toml")).pipe(
        Effect.map(codexCredentialStore),
        Effect.orElseSucceed(() => undefined),
      );
      const raw = yield* fs.readFileString(path.join(home, "auth.json")).pipe(
        Effect.map((text): string | undefined => text),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
        Effect.option,
      );
      return Option.isNone(raw)
        ? ({ kind: "unreadable" } as const)
        : parseCodexLogin(raw.value, store);
    });

    const status = Effect.gen(function* () {
      const target = yield* locate;
      if (typeof target === "string") return target;
      const status = chatGptLoginStatus(
        yield* readLogin(target.home),
        yield* Clock.currentTimeMillis,
      );
      return target.managedOnly && status === "signed-out" ? "managed" : status;
    }).pipe(
      Effect.catchCause(() => Effect.succeed<ChatGptSpeechStatus>("unreadable")),
      Effect.withSpan("ChatGptSpeechAuth.status"),
    );

    const open = Effect.gen(function* () {
      const target = yield* locate.pipe(Effect.mapError(() => "rejected" as const));
      if (typeof target === "string") return yield* Effect.fail("signed-out" as const);
      const { home, config, environment } = target;
      const login = yield* readLogin(home);
      if (login.kind !== "chatgpt" && login.kind !== "keychain")
        return yield* Effect.fail("signed-out" as const);
      // Codex owns the sign-in: it refreshes and stores renewed tokens, so T3 never writes them.
      let connection: Effect.Success<ReturnType<typeof withCodexAppServerClient>> | undefined;
      const fromCodex = Effect.fn("ChatGptSpeechAuth.fromCodex")(function* (refresh: boolean) {
        connection ??= yield* withCodexAppServerClient({
          binaryPath: config.binaryPath,
          homePath: home,
          launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
          cwd: hostCwd,
          environment,
        });
        if (refresh)
          yield* connection.client.request("getAuthStatus", {
            includeToken: false,
            refreshToken: true,
          });
        const result = yield* connection.client.request("getAuthStatus", {
          includeToken: true,
          refreshToken: false,
        });
        const token = result.authToken?.trim();
        if (typeof result.authMethod !== "string" || !result.authMethod.startsWith("chatgpt"))
          return yield* Effect.fail("signed-out" as const);
        if (!token || !headerSafe.test(token)) return yield* Effect.fail("rejected" as const);
        return {
          token: Redacted.make(token),
          accountId:
            chatGptTokenClaims(token).accountId ??
            (login.kind === "chatgpt" ? login.accountId : undefined),
        } satisfies ChatGptSpeechCredentials;
      });
      const credentials = Effect.fn("ChatGptSpeechAuth.credentials")(
        function* (refresh: boolean) {
          const now = yield* Clock.currentTimeMillis;
          if (!refresh && login.kind === "chatgpt" && !stale(login, now))
            return {
              token: Redacted.make(login.accessToken),
              accountId: login.accountId,
            } satisfies ChatGptSpeechCredentials;
          return yield* fromCodex(refresh || login.kind === "chatgpt");
        },
        Effect.mapError((error) => (error === "signed-out" ? error : ("rejected" as const))),
        Effect.provide(services),
      );
      return {
        credentials,
      } satisfies ChatGptSpeechSession;
    });
    return ChatGptSpeechAuth.of({ status, open });
  }),
);
