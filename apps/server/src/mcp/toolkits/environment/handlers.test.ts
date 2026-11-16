import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect(
  "problem detection is set globally and per project, keeping the project's other overrides",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-a");
      const stored = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { continueThreadsAfterServerUpdate: false } },
      });
      const patches: Array<ServerSettingsPatch> = [];
      const layerDependencies = Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:preferences",
          thread: {
            threadId,
            providerSessionId: "provider:preferences",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({
          getSettings: Ref.get(stored),
          updateSettings: (patch) => {
            patches.push(patch);
            return Ref.updateAndGet(stored, (current) => applyServerSettingsPatch(current, patch));
          },
        }),
      );
      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const update = (input: Record<string, unknown>) =>
          toolkit.handle("t3_environment_preferences_update", input as never).pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((results) => results.at(-1)?.result as Record<string, unknown>),
          );
        const rows: Array<{
          input: Record<string, unknown>;
          detectProblems: boolean;
          overrides: Record<string, unknown>;
          inProjects: Record<string, boolean>;
        }> = [
          {
            input: { detectProblems: false },
            detectProblems: false,
            overrides: { continueThreadsAfterServerUpdate: false },
            inProjects: {},
          },
          {
            input: { detectProblemsInProject: { projectId, enabled: true } },
            detectProblems: false,
            overrides: { continueThreadsAfterServerUpdate: false, detectProblems: true },
            inProjects: { [projectId]: true },
          },
          {
            input: { detectProblemsInProject: { projectId, enabled: null } },
            detectProblems: false,
            overrides: { continueThreadsAfterServerUpdate: false },
            inProjects: {},
          },
        ];
        for (const row of rows) {
          const result = yield* update(row.input);
          expect(result, JSON.stringify(row.input)).toMatchObject({
            detectProblems: row.detectProblems,
            detectProblemsInProjects: row.inProjects,
          });
          expect((yield* Ref.get(stored)).projectSettingsOverrides[projectId]).toEqual(
            row.overrides,
          );
        }
        // A project whose only override was detection loses its whole entry.
        yield* Ref.update(stored, (current) => ({ ...current, projectSettingsOverrides: {} }));
        yield* update({ detectProblemsInProject: { projectId, enabled: false } });
        yield* update({ detectProblemsInProject: { projectId, enabled: null } });
        expect(patches.at(-1)?.projectSettingsOverrides).toEqual({ [projectId]: null });
        expect(patches.every((patch) => !("detectProblemsInProject" in patch))).toBe(true);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(layerDependencies),
          ),
        ),
      );
    }),
);
