import { expect, it } from "@effect/vitest";
import {
  AutonomyError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AutonomyWatch,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WatchHandlers from "./handlers.ts";
import { WatchToolkit, type WatchParameters } from "./tools.ts";

const providerInstanceId = ProviderInstanceId.make("codex");

const harness = (threadId: ThreadId, storageDown = false) =>
  Effect.gen(function* () {
    const watches: AutonomyWatch[] = [];
    const fake = AutonomyService.AutonomyService.of({
      handleEvent: () => Effect.void,
      handleKanban: () => Effect.void,
      sweep: Effect.void,
      notifyWaiting: Effect.void,
      notifyUser: () => Effect.die("unused"),
      start: () => Effect.void,
      listWatches: storageDown
        ? Effect.fail(new AutonomyError({ reason: "storage", message: "down" }))
        : Effect.sync(() => [...watches]),
      upsertWatch: (input) =>
        Effect.sync(() => {
          const watch = {
            ...input,
            id: `w${watches.length + 1}`,
            enabled: input.enabled ?? true,
            triggerCount: 0,
            lastTriggeredAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          } as unknown as AutonomyWatch;
          watches.push(watch);
          return watch;
        }),
      setWatchEnabled: (input) =>
        Effect.sync(() => {
          const index = watches.findIndex((watch) => watch.id === input.id);
          watches[index] = { ...watches[index]!, enabled: input.enabled };
          return watches[index]!;
        }),
      deleteWatch: (input) =>
        Effect.sync(() => {
          watches.splice(
            watches.findIndex((watch) => watch.id === input.id),
            1,
          );
          return { id: input.id };
        }),
    });
    const deps = Layer.succeedContext(
      yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(AutonomyService.AutonomyService, fake),
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment"),
            requestNamespace: "thread:test",
            thread: { threadId, providerSessionId: "session", providerInstanceId },
            client: undefined,
            issuedAt: 0,
            capabilities: new Set(["orchestration" as const]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                id,
                projectId: ProjectId.make("project-a"),
                title: "Chat",
                deletedAt: null,
                archivedAt: null,
                activeRunId: "run-1",
                providerInstanceId,
                runtimeMode: "full-access",
                interactionMode: "default",
              } as unknown as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    );
    const toolkit = yield* WatchToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(WatchHandlers.layer).pipe(Layer.provide(deps)),
      ),
    );
    const call = (input: WatchParameters) =>
      toolkit.handle("t3_watch", input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1) as { isFailure: boolean; result: any }),
        Effect.provide(deps),
      );
    return { call, watches };
  });

const create = {
  action: "create",
  title: "PR 42 green",
  event: "pr_checks_passed",
  prNumber: 42,
  instruction: "Say if it can merge.",
} satisfies WatchParameters;

it.effect(
  "an assistant creates, lists, pauses, resumes and deletes its watch; a repeat is the same watch",
  () =>
    Effect.gen(function* () {
      const { call, watches } = yield* harness(ThreadId.make("assistant:jarvis:1"));
      const first = (yield* call(create)).result;
      expect(first).toMatchObject({
        assistantId: "jarvis",
        event: "pr_checks_passed",
        prNumber: 42,
        oneShot: true,
      });
      expect((yield* call(create)).result.watchId).toBe(first.watchId);
      expect(watches).toHaveLength(1);
      // Once it fired and switched itself off, the same request makes a new live watch.
      watches[0] = { ...watches[0]!, enabled: false };
      const again = (yield* call(create)).result;
      expect(again.watchId).not.toBe(first.watchId);
      expect(again.enabled).toBe(true);
      watches.shift();
      expect((yield* call({ action: "list" })).result.watches).toHaveLength(1);
      expect((yield* call({ action: "pause", watchId: again.watchId })).result.enabled).toBe(false);
      expect((yield* call({ action: "resume", watchId: again.watchId })).result.enabled).toBe(true);
      expect((yield* call({ action: "delete", watchId: again.watchId })).result).toMatchObject({
        deleted: true,
      });
      expect(watches).toHaveLength(0);
    }),
);

it.effect("a plain thread's watch goes to the default assistant, with filters and an expiry", () =>
  Effect.gen(function* () {
    const { call } = yield* harness(ThreadId.make("thread-1"));
    const { result } = yield* call({
      action: "create",
      title: "Failures",
      event: "run_failed",
      projectId: ProjectId.make("project-a"),
      threadId: ThreadId.make("thread-9"),
      oneShot: false,
      expiresInMinutes: 60,
    });
    expect(result).toMatchObject({
      assistantId: "jarvis",
      projectId: "project-a",
      threadId: "thread-9",
      oneShot: false,
    });
    expect(typeof result.expiresAt).toBe("string");
  }),
);

it.effect("bad requests and a missing store come back as failures", () =>
  Effect.gen(function* () {
    const { call } = yield* harness(ThreadId.make("assistant:jarvis:1"));
    for (const input of [
      { action: "create", title: "no event" },
      { action: "create", event: "run_failed" },
      { action: "pause" },
      { action: "pause", watchId: "ghost" },
    ] satisfies WatchParameters[]) {
      expect((yield* call(input)).isFailure).toBe(true);
    }
    const down = yield* harness(ThreadId.make("assistant:jarvis:1"), true);
    expect((yield* down.call({ action: "list" })).isFailure).toBe(true);
  }),
);
