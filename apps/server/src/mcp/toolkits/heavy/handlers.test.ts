import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HeavyQueueError, type HeavyQueueEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as HeavyHandlers from "./handlers.ts";
import { heavyStatus } from "./model.ts";
import { HeavyToolkit } from "./tools.ts";

const entry = (id: string, threadId: string | null, startedAt: string | null) =>
  ({
    id,
    pid: 1,
    threadId,
    label: id,
    cwd: "/",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt,
  }) satisfies HeavyQueueEntry;

const base = {
  entries: [],
  threadId: "me",
  busyCores: 1,
  cpuCount: 4,
  availableMemoryBytes: 50,
  totalMemoryBytes: 100,
  workingAgents: 3,
  maxRunning: 3,
  room: true,
  reasons: {},
  machine: null,
  command: "t3 heavy --",
};

describe("heavyStatus", () => {
  it.each([
    { name: "calm machine, empty queue", change: {}, askUser: false, high: false },
    { name: "load high, agents busy", change: { busyCores: 6 }, askUser: true, high: true },
    {
      name: "memory low, agents busy",
      change: { availableMemoryBytes: 9 },
      askUser: true,
      high: true,
    },
    {
      name: "load high but one agent",
      change: { busyCores: 6, workingAgents: 1 },
      askUser: false,
      high: false,
    },
    {
      name: "calm, one running, a free slot",
      change: { entries: [entry("a", null, "t")] },
      askUser: false,
      high: false,
    },
    {
      name: "calm but every slot is busy and others wait",
      change: { entries: [entry("a", null, "t"), entry("b", null, null)], maxRunning: 1 },
      askUser: true,
      high: false,
    },
    {
      name: "calm, free slot, but the queue sees no room",
      change: { entries: [entry("a", null, "t"), entry("b", null, null)], room: false },
      askUser: true,
      high: false,
    },
  ])("$name", ({ change, askUser, high }) => {
    const status = heavyStatus({ ...base, ...change });
    expect(status.askUser).toBe(askUser);
    expect(status.pressure.high).toBe(high);
  });

  it("splits running from waiters and reports where this thread's entries stand", () => {
    const status = heavyStatus({
      ...base,
      entries: [
        entry("run", "other", "t"),
        entry("w1", "other", null),
        entry("w2", "me", null),
        entry("mine-running", "me", null),
      ],
    });
    expect(status.running?.id).toBe("run");
    expect(status.waiting.map((w) => [w.id, w.position])).toEqual([
      ["w1", 1],
      ["w2", 2],
      ["mine-running", 3],
    ]);
    expect(status.yours).toEqual([
      { id: "w2", position: 2 },
      { id: "mine-running", position: 3 },
    ]);
    expect(status.pressure).toMatchObject({ loadPerCore: 0.25, availableMemoryPercent: 50 });
  });

  it("reads zero total memory as no memory pressure", () => {
    expect(heavyStatus({ ...base, totalMemoryBytes: 0 }).pressure.availableMemoryPercent).toBe(100);
  });
});

const promoted: Array<readonly [string, string | undefined]> = [];

const callTool = (params: { action: "status" | "promote"; id?: string }, access?: "read-only") =>
  Effect.gen(function* () {
    const toolkit = yield* HeavyToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(HeavyHandlers.layer)),
    );
    return yield* toolkit
      .handle("t3_heavy", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-heavy"),
      requestNamespace: "session-heavy",
      thread: {
        threadId: ThreadId.make("me"),
        providerSessionId: "session-heavy",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: access === undefined ? undefined : ({ access } as never),
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(HeavyQueue.HeavyQueue)({
          state: Effect.succeed({
            entries: [entry("run", "other", "t"), entry("w", "me", null)],
            paused: false,
            rules: [],
            maxRunning: 3,
            reasons: {},
            room: false,
            machine: null,
          }),
          command: Effect.succeed("t3 heavy --"),
          promote: (id, note) =>
            id === "gone"
              ? Effect.fail(new HeavyQueueError({ reason: "not-found", message: "No such entry." }))
              : Effect.sync(() => void promoted.push([id, note])),
        }),
        Layer.mock(HostResources.HostResources)({
          read: Effect.succeed({
            sampledAt: 1,
            cpuUtilization: 0.1,
            cpuCount: 8,
            availableMemoryBytes: 5_000,
            totalMemoryBytes: 8_000,
          }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          listProjectThreads: () => Effect.succeed([liveThreadShell(ThreadId.make("me"))] as never),
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

describe("t3_heavy", () => {
  it.effect("answers for the calling thread from the live queue", () =>
    Effect.gen(function* () {
      const chunk = yield* callTool({ action: "status" });
      expect(chunk.at(-1)!.result).toMatchObject({
        askUser: true,
        command: "t3 heavy --",
        running: { id: "run" },
        yours: [{ id: "w", position: 1 }],
      });
    }),
  );

  it.effect("promote moves the entry and records which thread asked", () =>
    Effect.gen(function* () {
      promoted.length = 0;
      yield* callTool({ action: "promote", id: "w" });
      expect(promoted).toHaveLength(1);
      expect(promoted[0]![0]).toBe("w");
      expect(promoted[0]![1]).toContain("thread me");
    }),
  );

  it.effect("promote without an id, for a missing entry, or from a read-only client fails", () =>
    Effect.gen(function* () {
      promoted.length = 0;
      const failure = (chunk: Awaited<ReturnType<typeof Effect.runPromise>>) =>
        (chunk as ReadonlyArray<{ encodedResult: unknown }>).at(-1)!.encodedResult;
      const noId = failure(yield* callTool({ action: "promote" }));
      expect(noId).toMatchObject({ code: "invalid_request" });
      const gone = failure(yield* callTool({ action: "promote", id: "gone" }));
      expect(gone).toMatchObject({ code: "invalid_request", message: "No such entry." });
      yield* callTool({ action: "promote", id: "w" }, "read-only");
      expect(promoted).toEqual([]);
    }),
  );
});
