// @effect-diagnostics nodeBuiltinImport:off - the probe's fallback folder is the home folder.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  HEAVY_QUEUE_DEFAULTS,
  HeavyQueueError,
  type HeavyQueueEntry,
  type HeavyRunnerLinux,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HeavyCommands from "../../../heavyQueue/HeavyCommands.ts";
import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
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
  enabled: true,
  room: true,
  reasons: {},
  machine: null,
  hold: null,
  linux: null,
  routes: {},
  command: "t3 heavy --",
  commands: [],
  destination: null,
};

const linux = {
  host: "pc",
  online: true,
  slots: 2,
  running: 0,
  load1: null,
  cpuCount: null,
  availableMemoryBytes: null,
  totalMemoryBytes: null,
};
const command = {
  source: "agent" as const,
  pid: 12,
  startTimeMs: 1,
  threadId: "other",
  label: "/usr/bin/node vp test run",
  name: "Tests",
  startedAt: "2026-01-01T00:00:00.000Z",
  stoppable: true,
  cpu: 2.5,
  memory: 1024,
  peakCpu: 3,
  peakMemory: 2048,
};
const toLinux = { runsOn: "linux" as const, reason: null, startsNow: true, linuxFull: false };
const toMac = { runsOn: "mac" as const, reason: null, startsNow: true, linuxFull: false };

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
    {
      name: "queue off: load high, agents busy",
      change: { enabled: false, busyCores: 6 },
      askUser: false,
      high: true,
    },
    {
      name: "queue off: every slot busy, no room, another entry not started yet",
      change: {
        enabled: false,
        entries: [entry("a", null, "t"), entry("b", null, null)],
        maxRunning: 1,
        room: false,
      },
      askUser: false,
      high: false,
    },
  ])("$name", ({ change, askUser, high }) => {
    const status = heavyStatus({ ...base, ...change });
    expect(status.askUser).toBe(askUser);
    expect(status.mac.pressure.high).toBe(high);
    expect(status).not.toHaveProperty("runsOn");
  });

  it.each([
    {
      name: "Linux-bound with room: this Mac's pressure is no reason to ask",
      change: { busyCores: 6, availableMemoryBytes: 9, linux, destination: toLinux },
      askUser: false,
    },
    {
      name: "Linux-bound, Linux offline or full: ask, naming Linux",
      change: {
        linux: { ...linux, online: false },
        destination: {
          ...toLinux,
          reason: "Linux is unavailable: waiting for it",
          startsNow: false,
          linuxFull: true,
        },
      },
      askUser: true,
      reason: "Linux is unavailable: waiting for it",
    },
    {
      name: "Linux-bound, a short wait such as a first health check: no ask",
      change: { linux, destination: { ...toLinux, startsNow: false } },
      askUser: false,
    },
    {
      name: "Linux-bound with the queue off still asks when Linux is full",
      change: {
        enabled: false,
        linux,
        destination: { ...toLinux, startsNow: false, linuxFull: true },
      },
      askUser: true,
    },
    {
      name: "Linux offline, falls back to this Mac under pressure: ask, naming the Mac",
      change: {
        busyCores: 6,
        linux: { ...linux, online: false },
        destination: { ...toMac, reason: "Linux is unavailable: running here" },
      },
      askUser: true,
      reason: "Linux is unavailable: running here",
    },
    {
      name: "Mac-bound under pressure: ask",
      change: { busyCores: 6, linux, destination: { ...toMac, reason: "Needs git" } },
      askUser: true,
      reason: "Needs git",
    },
    {
      name: "Mac-bound, queue off: never ask",
      change: { enabled: false, busyCores: 6, destination: toMac },
      askUser: false,
    },
    {
      name: "Runner off, Mac under pressure: ask",
      change: { busyCores: 6, destination: toMac },
      askUser: true,
    },
    {
      name: "runs directly, as a commit with no hook: never ask",
      change: {
        busyCores: 6,
        destination: { ...toMac, runsOn: "direct" as const, reason: "No commit hook" },
      },
      askUser: false,
      reason: "No commit hook",
    },
    {
      name: "Mac-bound: Linux jobs never fill this Mac's slots",
      change: {
        maxRunning: 1,
        linux,
        entries: [{ ...entry("l", null, "t"), runner: "linux" as const }, entry("w", null, null)],
        routes: { w: "linux" as const },
        destination: toMac,
      },
      askUser: false,
    },
  ])("for a command: $name", ({ change, askUser, reason }) => {
    const status = heavyStatus({ ...base, ...change });
    expect(status.askUser).toBe(askUser);
    expect(status).toMatchObject({ runsOn: change.destination.runsOn });
    if (reason === undefined) expect(status).not.toHaveProperty("reason");
    else expect(status).toMatchObject({ reason });
  });

  it("splits running, waiting positions and usage by machine", () => {
    const status = heavyStatus({
      ...base,
      linux: { ...linux, running: 1 },
      entries: [
        { ...entry("on-linux", "other", "t"), runner: "linux" },
        entry("on-mac", "other", "t"),
        entry("w-linux", "me", null),
        entry("w-mac", "other", null),
        entry("w-mac-2", "me", null),
      ],
      routes: { "w-linux": "linux", "w-mac": "mac", "w-mac-2": "mac" },
      commands: [
        { ...command, entryId: "on-linux", pid: 1 },
        { ...command, entryId: "on-mac", pid: 2 },
        { ...command, source: "agent", pid: 3 },
      ],
    });
    expect(status.mac).toMatchObject({ running: 1, maxRunning: 3 });
    expect(status.running.map((r) => [r.id, r.runsOn])).toEqual([
      ["on-linux", "linux"],
      ["on-mac", "mac"],
    ]);
    expect(status.waiting.map((w) => [w.id, w.runsOn, w.position])).toEqual([
      ["w-linux", "linux", 1],
      ["w-mac", "mac", 1],
      ["w-mac-2", "mac", 2],
    ]);
    expect(status.yours).toEqual([
      { id: "w-linux", position: 1, runsOn: "linux" },
      { id: "w-mac-2", position: 2, runsOn: "mac" },
    ]);
    expect(status.commands.map((c) => [c.pid, c.runsOn, c.cpuCores, c.peakMemoryBytes])).toEqual([
      [1, "linux", null, null],
      [2, "mac", 2.5, 2048],
      [3, "mac", 2.5, 2048],
    ]);
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
    expect(status.running.map((r) => r.id)).toEqual(["run"]);
    expect(status.waiting.map((w) => [w.id, w.position])).toEqual([
      ["w1", 1],
      ["w2", 2],
      ["mine-running", 3],
    ]);
    expect(status.yours).toEqual([
      { id: "w2", position: 2 },
      { id: "mine-running", position: 3 },
    ]);
    expect(status.mac.pressure).toMatchObject({ loadPerCore: 0.25, availableMemoryPercent: 50 });
  });

  it("shows Linux and where each waiter runs only while the Runner is on", () => {
    const entries = [entry("w1", "me", null)];
    const off = heavyStatus({ ...base, entries, routes: { w1: "mac" } });
    expect(off).not.toHaveProperty("linux");
    expect(off.waiting[0]).not.toHaveProperty("runsOn");
    const on = heavyStatus({ ...base, entries, linux, routes: { w1: "linux" } });
    expect(on).toMatchObject({ linux });
    expect(on.waiting[0]).toMatchObject({ runsOn: "linux" });
  });

  it("reads zero total memory as no memory pressure", () => {
    expect(heavyStatus({ ...base, totalMemoryBytes: 0 }).mac.pressure.availableMemoryPercent).toBe(
      100,
    );
  });
});

const promoted: Array<readonly [string, string | undefined]> = [];

const probed: Array<readonly [string, string]> = [];

const movedAll: Array<"mac" | "linux"> = [];
let nextMoved: ReadonlyArray<string> = ["w"];
let queueLinux: HeavyRunnerLinux | null = null;

const callTool = (
  params: {
    action: "status" | "promote" | "move_all";
    id?: string;
    to?: "mac" | "linux";
    commandLine?: string;
  },
  access?: "read-only",
) =>
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
            enabled: true,
            paused: false,
            rules: [],
            maxRunning: 3,
            reasons: {},
            room: false,
            claudeHookInstalled: false,
            deviceIdleMinutes: 20,
            machine: null,
            hold: null,
            linux: queueLinux,
            routes: {},
            macOnly: [],
            ...HEAVY_QUEUE_DEFAULTS,
          }),
          command: Effect.succeed("t3 heavy --"),
          probe: (line, cwd) =>
            line === "broken"
              ? Effect.fail(new HeavyQueueError({ reason: "unavailable", message: "No queue." }))
              : Effect.sync(() => {
                  probed.push([line, cwd]);
                  return {
                    runsOn: "linux" as const,
                    reason: "Linux is unavailable: waiting for it",
                    startsNow: false,
                    linuxFull: true,
                  };
                }),
          promote: (id, note) =>
            id === "gone"
              ? Effect.fail(new HeavyQueueError({ reason: "not-found", message: "No such entry." }))
              : Effect.sync(() => void promoted.push([id, note])),
          routeAll: (runner) =>
            Effect.sync(() => {
              movedAll.push(runner);
              return nextMoved;
            }),
        }),
        Layer.mock(HeavyCommands.HeavyCommands)({
          list: Effect.succeed({
            cpuCount: 8,
            commands: [command],
          }),
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
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedNone,
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
        running: [{ id: "run" }],
        yours: [{ id: "w", position: 1 }],
        commands: [
          {
            name: "Tests",
            source: "agent",
            threadId: "other",
            pid: 12,
            startedAt: "2026-01-01T00:00:00.000Z",
            cpuCores: 2.5,
            memoryBytes: 1024,
            peakCpuCores: 3,
            peakMemoryBytes: 2048,
          },
        ],
      });
    }),
  );

  it.effect("answers for the machine a command line would run on, from the thread's folder", () =>
    Effect.gen(function* () {
      probed.length = 0;
      const chunk = yield* callTool({ action: "status", commandLine: "vp test run" });
      expect(probed).toEqual([["vp test run", NodeOS.homedir()]]);
      expect(chunk.at(-1)!.result).toMatchObject({
        askUser: true,
        runsOn: "linux",
        reason: "Linux is unavailable: waiting for it",
      });
      const failed = yield* callTool({ action: "status", commandLine: "broken" });
      expect(failed.at(-1)!.encodedResult).toMatchObject({
        code: "orchestration_error",
        message: "No queue.",
      });
      probed.length = 0;
      yield* callTool({ action: "status", commandLine: "  " });
      expect(probed).toEqual([]);
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

  it.effect("move_all sends the waiters to `to` and answers with the moved ids", () =>
    Effect.gen(function* () {
      movedAll.length = 0;
      nextMoved = ["w"];
      const chunk = yield* callTool({ action: "move_all", to: "linux" });
      expect(movedAll).toEqual(["linux"]);
      expect(chunk.at(-1)!.result).toMatchObject({ moved: ["w"], yours: [{ id: "w" }] });
      expect(chunk.at(-1)!.result).not.toHaveProperty("note");
      const noTarget = yield* callTool({ action: "move_all" });
      expect(noTarget.at(-1)!.encodedResult).toMatchObject({ code: "invalid_request" });
      yield* callTool({ action: "move_all", to: "mac" }, "read-only");
      expect(movedAll).toEqual(["linux"]);
      // Nothing movable says why: the Runner off, Linux not online, or no job that can go.
      nextMoved = [];
      const linux = { host: "pc", slots: 2, running: 0, load1: null, cpuCount: null };
      const memory = { availableMemoryBytes: null, totalMemoryBytes: null };
      for (const [to, state, note] of [
        ["linux", null, "Nothing moved: the Runner is off."],
        ["linux", { ...linux, ...memory, online: false }, "Nothing moved: Linux is unavailable."],
        ["linux", { ...linux, ...memory, online: null }, "Nothing moved: Linux is unavailable."],
        [
          "linux",
          { ...linux, ...memory, online: true },
          "Nothing moved: no waiting job can move to Linux.",
        ],
        ["mac", null, "Nothing moved: no waiting job can move to this Mac."],
      ] as const) {
        queueLinux = state;
        const none = yield* callTool({ action: "move_all", to });
        expect(none.at(-1)!.result).toMatchObject({ moved: [], note });
      }
      queueLinux = null;
      nextMoved = ["w"];
      // Status alone moves nothing and says nothing about moves.
      expect((yield* callTool({ action: "status" })).at(-1)!.result).not.toHaveProperty("moved");
    }),
  );
});
