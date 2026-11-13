import { expect, it } from "@effect/vitest";
import {
  type Assistant,
  type DetectedServer,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as IntegrationAuth from "../../../integrations/IntegrationAuth.ts";
import * as IntegrationDetector from "../../../integrations/IntegrationDetector.ts";
import * as IntegrationFetch from "../../../integrations/IntegrationFetch.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as IntegrationHandlers from "./handlers.ts";
import { IntegrationToolkit, type IntegrationParameters } from "./tools.ts";

const SECRETS = ["lin_SECRET_TOKEN", "g-CLIENT-SECRET", "DETECTED-QUERY-SECRET", "DETECTED-ENV"];

const detected: DetectedServer = {
  id: "codex-asana",
  name: "asana",
  origin: "codex",
  instanceId: ProviderInstanceId.make("codex"),
  catalogId: "asana",
  transport: "http",
  url: "https://mcp.asana.com/sse?key=DETECTED-QUERY-SECRET",
  enabled: true,
  copyable: true,
  secretKeys: ["DETECTED-ENV"],
  needsValue: [],
};
// Found, but not working everywhere: claude.ai still wants a sign-in, and a project server loads
// only in that project.
const notLoaded: ReadonlyArray<DetectedServer> = [
  {
    ...detected,
    id: "ai-slack",
    name: "Slack",
    origin: "claude-ai",
    instanceId: ProviderInstanceId.make("claude"),
    catalogId: "slack",
    loaded: "needs-auth",
  },
  {
    ...detected,
    id: "cc-notion",
    name: "notion",
    origin: "claude-code",
    instanceId: ProviderInstanceId.make("claude"),
    scope: "project",
    projectPath: "/work/app",
    catalogId: "notion",
    loaded: "connected",
  },
];

const assistant = (handle: string, integrations: Assistant["integrations"], archived = false) =>
  ({
    handle,
    name: handle.toUpperCase(),
    integrations,
    archivedAt: archived ? "2026-01-01T00:00:00.000Z" : null,
  }) as Assistant;

const harness = (hostedAppUrl?: string) =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>();
    const deps = Layer.succeedContext(
      yield* Layer.build(
        Layer.mergeAll(
          IntegrationAuth.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              Layer.succeed(
                ServerSecretStore.ServerSecretStore,
                ServerSecretStore.ServerSecretStore.of({
                  get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
                  set: (name, value) => Effect.sync(() => void values.set(name, value)),
                  create: (name, value) => Effect.sync(() => void values.set(name, value)),
                  getOrCreateRandom: () => Effect.die("unused"),
                  remove: (name) => Effect.sync(() => void values.delete(name)),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                IntegrationDetector.IntegrationDetector,
                IntegrationDetector.IntegrationDetector.of({
                  detect: Effect.succeed({ detected: [detected, ...notLoaded], sources: [] }),
                  changes: Stream.empty,
                  recordClaudeSession: () => Effect.void,
                  nativeCatalogIds: () => Effect.succeed(new Set()),
                  makeAvailable: () => Effect.die("unused"),
                }),
              ),
            ),
            Layer.provide(
              Layer.succeed(
                IntegrationFetch.IntegrationFetch,
                IntegrationFetch.IntegrationFetch.of({
                  fetch: () => Promise.reject(new Error("no network")),
                }),
              ),
            ),
          ),
          Layer.mock(AssistantService.AssistantService)({
            list: Effect.succeed([
              assistant("jarvis", { mode: "all" }),
              assistant("scribe", { mode: "selected", names: ["linear"] }),
              assistant("solo", { mode: "selected", names: [] }),
              assistant("old", { mode: "all" }, true),
            ]),
          }),
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("env-1"),
            requestNamespace: "thread:test",
            thread: {
              threadId: ThreadId.make("thread-1"),
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client:
              hostedAppUrl === undefined
                ? undefined
                : { sessionId: "s", label: "Client", access: "full-access", hostedAppUrl },
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
        ),
      ),
    );
    const auth = yield* IntegrationAuth.IntegrationAuth.pipe(Effect.provide(deps));
    yield* auth.saveToken({ catalogId: "linear", token: SECRETS[0]! });
    yield* auth.saveOwnApp({ clientGroup: "google", clientId: "g-app", clientSecret: SECRETS[1]! });
    const toolkit = yield* IntegrationToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(IntegrationHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    return (input: IntegrationParameters) =>
      toolkit.handle("t3_integration", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result as Record<string, any>),
        Effect.provide(deps),
      );
  });

it.effect(
  "list names each integration's status, origins, providers and assistants, no secrets",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const call = yield* harness();
        const listed = yield* call({ action: "list" });
        // What is in use comes first, in catalog order.
        expect(listed.integrations.slice(0, 4).map((row: { id: string }) => row.id)).toEqual([
          "slack",
          "notion",
          "linear",
          "asana",
        ]);
        for (const row of [
          {
            id: "linear",
            name: "Linear",
            status: "connected",
            origins: ["t3"],
            providers: [
              "Antigravity",
              "Codex",
              "Claude",
              "Cursor",
              "Grok",
              "fx",
              "Kiro",
              "ACP Registry",
            ],
            assistants: [
              { handle: "jarvis", name: "JARVIS" },
              { handle: "scribe", name: "SCRIBE" },
            ],
          },
          {
            id: "asana",
            name: "Asana",
            status: "not-connected",
            origins: ["codex"],
            providers: ["Codex"],
            assistants: [],
          },
        ])
          expect(listed.integrations).toContainEqual(row);
        for (const [id, name, origin] of [
          ["slack", "Slack", "claude-ai"],
          ["notion", "Notion", "claude-code"],
        ] as const) {
          expect(listed.integrations).toContainEqual({
            id,
            name,
            status: "not-connected",
            origins: [origin],
            providers: [],
            assistants: [],
          });
          expect((yield* call({ action: "read", id })).next).toMatch(/^Ask the user to connect/);
        }
        expect(listed.integrations).toContainEqual({
          id: "gmail",
          name: "Gmail",
          status: "not-connected",
          origins: [],
          providers: [],
          assistants: [],
        });
        const serialized = JSON.stringify([
          listed,
          yield* call({ action: "read", id: "linear" }),
          yield* call({ action: "read", id: "asana" }),
          yield* call({ action: "read", id: "gmail" }),
        ]);
        for (const secret of [...SECRETS, "mcp.linear.app", "g-app", "mcp.asana.com"]) {
          expect(serialized).not.toContain(secret);
        }
      }),
    ),
);

it.effect("read links to the entry and tells the agent to ask the user to connect it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const call = yield* harness();
      expect(yield* call({ action: "read", id: "Gmail" })).toMatchObject({
        id: "gmail",
        link: "/settings/integrations?machine=env-1&entry=gmail",
        next: "Ask the user to connect Gmail from Integrations: /settings/integrations?machine=env-1&entry=gmail",
      });
      const linear = yield* call({ action: "read", id: "linear" });
      expect(linear.link).toBe("/settings/integrations?machine=env-1&entry=linear");
      expect(linear.next).toBeUndefined();
      expect((yield* call({ action: "read", id: "asana" })).next).toBeUndefined();
      expect(yield* call({ action: "read" })).toMatchObject({ code: "invalid_request" });
      expect(yield* call({ action: "read", id: "nope" })).toMatchObject({
        code: "invalid_request",
        message: 'No integration has the id "nope". Use list.',
      });
      const outside = yield* harness("https://app.t3.codes");
      expect((yield* outside({ action: "read", id: "slack" })).next).toBe(
        "Ask the user to connect Slack from Integrations: https://app.t3.codes/settings/integrations?machine=env-1&entry=slack",
      );
    }),
  ),
);
