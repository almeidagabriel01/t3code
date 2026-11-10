import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatGptSpeechAuth from "./ChatGptSpeechAuth.ts";

const codex = vi.hoisted(() => ({
  signedIn: true,
  authStatus: { authMethod: "chatgpt", authToken: "app-token" } as Record<string, unknown>,
  spawns: [] as unknown[],
  requests: [] as unknown[],
  closed: 0,
  authInstances: [] as string[],
}));

vi.mock("../provider/CodexChatGptAuth.ts", async () => {
  const Effect = await import("effect/Effect");
  const Option = await import("effect/Option");
  return {
    makeCodexChatGptAuth: ({ instanceId }: { instanceId: string }) =>
      Effect.sync(() => {
        codex.authInstances.push(instanceId);
        return {
          read: Effect.sync(() => (codex.signedIn ? Option.some({}) : Option.none())),
          access: codex.signedIn
            ? Effect.succeed({ accessToken: "managed-token" })
            : Effect.fail("signed out"),
        };
      }),
  };
});

vi.mock("../provider/CodexProvider.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    withCodexAppServerClient: (input: unknown) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          codex.spawns.push(input);
          return {
            client: {
              request: (_method: string, params: unknown) =>
                Effect.sync(() => {
                  codex.requests.push(params);
                  return codex.authStatus;
                }),
            },
          };
        }),
        () => Effect.sync(() => void codex.closed++),
      ),
  };
});

const instance = (config: Record<string, unknown> = {}, enabled = true) => ({
  driver: "codex",
  enabled,
  config: { binaryPath: "codex", ...config },
});
const managed = instance({ setupMode: "managed" });

// The mocked Codex modules never touch the services the real ones require.
// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
const layer = ChatGptSpeechAuth.layer as Layer.Layer<
  ChatGptSpeechAuth.ChatGptSpeechAuth,
  never,
  ServerSettings.ServerSettingsService | Path.Path
>;

const authWith = (settings: Record<string, unknown>) =>
  ChatGptSpeechAuth.ChatGptSpeechAuth.pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(ServerSettings.ServerSettingsService.layerTest(settings as never)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const reset = () => {
  codex.signedIn = true;
  codex.authStatus = { authMethod: "chatgpt", authToken: "app-token" };
  codex.spawns.length = 0;
  codex.requests.length = 0;
  codex.authInstances.length = 0;
  codex.closed = 0;
};

it.effect.each([
  { name: "no Codex instance", instances: {}, expected: false, signedIn: true },
  {
    name: "a disabled instance",
    instances: { codex: instance({}, false) },
    expected: false,
    signedIn: true,
  },
  {
    name: "an unmanaged instance",
    instances: { codex: instance() },
    expected: true,
    signedIn: false,
  },
  {
    name: "a managed instance signed in",
    instances: { codex: managed },
    expected: true,
    signedIn: true,
  },
  {
    name: "a managed instance signed out",
    instances: { codex: managed },
    expected: false,
    signedIn: false,
  },
])(
  "available is $expected with $name and never spawns Codex",
  ({ instances, expected, signedIn }) =>
    Effect.gen(function* () {
      reset();
      codex.signedIn = signedIn;
      const auth = yield* authWith({ providerInstances: instances });
      expect(yield* auth.available).toBe(expected);
      expect(codex.spawns).toEqual([]);
    }),
);

it.effect("prefers the default model's Codex instance, then codex, then any enabled one", () =>
  Effect.gen(function* () {
    reset();
    const pick = (settings: Record<string, unknown>) =>
      Effect.gen(function* () {
        codex.authInstances.length = 0;
        yield* (yield* authWith(settings)).available;
        return codex.authInstances[0];
      });
    expect(
      yield* pick({
        providerInstances: { codex: managed, work: managed },
        defaultModelSelection: { instanceId: "work", model: "gpt-5" },
      }),
    ).toBe("work");
    expect(
      yield* pick({
        providerInstances: { other: managed, codex: managed },
        defaultModelSelection: { instanceId: "missing", model: "x" },
      }),
    ).toBe("codex");
    expect(
      yield* pick({
        providerInstances: { off: instance({ setupMode: "managed" }, false), spare: managed },
      }),
    ).toBe("spare");
  }),
);

it.effect("managed setups return the renewed access token without spawning", () =>
  Effect.gen(function* () {
    reset();
    const auth = yield* authWith({ providerInstances: { codex: managed } });
    const session = yield* Effect.scoped(auth.open);
    expect(yield* Effect.scoped(session.token(false))).toBe("managed-token");
    codex.signedIn = false;
    const signedOut = yield* Effect.scoped(auth.open);
    expect(yield* Effect.flip(Effect.scoped(signedOut.token(true)))).toBe("rejected");
    expect(codex.spawns).toEqual([]);
  }),
);

it.effect("unmanaged setups ask one scoped app-server for the token and close it", () =>
  Effect.gen(function* () {
    reset();
    const auth = yield* authWith({ providerInstances: { codex: instance() } });
    const scope = yield* Scope.make();
    const session = yield* auth.open.pipe(Scope.provide(scope));
    expect(codex.spawns).toEqual([]);
    expect(yield* session.token(false).pipe(Scope.provide(scope))).toBe("app-token");
    expect(yield* session.token(true).pipe(Scope.provide(scope))).toBe("app-token");
    expect(codex.spawns).toHaveLength(1);
    expect(codex.requests).toEqual([
      { includeToken: true, refreshToken: false },
      { includeToken: true, refreshToken: true },
    ]);
    expect(codex.closed).toBe(0);
    yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
    expect(codex.closed).toBe(1);
  }),
);

it.effect.each([
  { name: "an API-key sign-in", status: { authMethod: "apikey", authToken: "x" } },
  { name: "no token", status: { authMethod: "chatgpt" } },
])("unmanaged setups report $name as signed out", ({ status }) =>
  Effect.gen(function* () {
    reset();
    codex.authStatus = status;
    const auth = yield* authWith({ providerInstances: { codex: instance() } });
    expect(
      yield* Effect.flip(
        Effect.scoped(Effect.flatMap(auth.open, (session) => session.token(false))),
      ),
    ).toBe("signed-out");
  }),
);

it.effect("opening with no Codex instance is signed out", () =>
  Effect.gen(function* () {
    reset();
    const auth = yield* authWith({ providerInstances: {} });
    expect(yield* Effect.flip(Effect.scoped(auth.open))).toBe("signed-out");
  }),
);
