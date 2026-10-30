import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import { ServerConfig } from "../../../config.ts";
import * as ProcessResourceMonitor from "../../../diagnostics/ProcessResourceMonitor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../../../resourceTelemetry/ResourceTelemetry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as HostHandlers from "./handlers.ts";
import { compactProcessHistory, countThreads, executableName } from "./model.ts";
import { HostToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-host");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-host"),
  requestNamespace: "session-host",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "session-host",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const shell = (id: string, extra: object = {}) => ({
  ...liveThreadShell(ThreadId.make(id)),
  ...extra,
});
const subagentLineage = {
  rootThreadId: THREAD_ID,
  parentThreadId: THREAD_ID,
  relationshipToParent: "subagent",
};

const processRow = (pid: number, avgCpuPercent: number, command: string) => ({
  processKey: `${pid}:1`,
  pid,
  ppid: 1,
  command,
  depth: 0,
  isServerRoot: pid === 1,
  firstSeenAt: 0,
  lastSeenAt: 0,
  currentCpuPercent: avgCpuPercent,
  avgCpuPercent,
  maxCpuPercent: avgCpuPercent + 1,
  cpuSecondsApprox: 3.4,
  currentRssBytes: 5 * 1_048_576,
  maxRssBytes: 6 * 1_048_576,
  sampleCount: 4,
});

const call = (params: Tool.Parameters<(typeof HostToolkit.tools)["t3_host"]>) =>
  Effect.gen(function* () {
    const toolkit = yield* HostToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(HostHandlers.layer)),
    );
    const chunk = yield* toolkit.handle("t3_host", params).pipe(Stream.unwrap, Stream.runCollect);
    return chunk.at(-1)!.result as Record<string, unknown>;
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(HostResources.HostResources)({
          read: Effect.succeed({
            sampledAt: 1,
            cpuUtilization: 0.25,
            cpuCount: 8,
            availableMemoryBytes: 2_000,
            totalMemoryBytes: 8_000,
          }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              enabled: true,
              installed: false,
              status: "error",
              availability: "unavailable",
              message: "x".repeat(500),
              models: [],
            },
          ] as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          listProjectThreads: () =>
            Effect.succeed([
              shell("running"),
              shell("idle", { activeRunId: null }),
              shell("child", { lineage: subagentLineage }),
              shell("archived", { archivedAt: "2026-01-01T00:00:00.000Z" }),
            ] as never),
        }),
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: () =>
            Effect.succeed({
              windowMs: 1,
              bucketMs: 1,
              sampleIntervalMs: 1,
              retainedSampleCount: 2,
              totalCpuSecondsApprox: 7.6,
              buckets: [],
              topProcesses: [
                processRow(1, 5, "/usr/bin/node --token=secret server.js"),
                processRow(2, 40, "git status"),
                processRow(3, 20, "rg foo"),
              ],
              error: Option.none(),
            } as never),
        }),
        Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-host-tool-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

describe("t3_host", () => {
  it.effect("reports this machine only: counts, memory, clipped provider messages, no fleet", () =>
    Effect.gen(function* () {
      const status = yield* call({ action: "status" });
      expect(Object.keys(status).toSorted()).toEqual(
        [
          "cpu",
          "disk",
          "loadAverage",
          "memory",
          "platform",
          "providers",
          "running",
          "serverVersion",
          "subagentsRunning",
          "threads",
          "uptimeSeconds",
          "waiting",
        ].toSorted(),
      );
      expect(status).toMatchObject({
        threads: 2,
        running: 1,
        waiting: 0,
        subagentsRunning: 1,
        cpu: { count: 8, utilization: 0.25 },
        memory: { totalBytes: 8_000, availableBytes: 2_000 },
      });
      expect((status.providers as ReadonlyArray<{ message: string }>)[0]?.message).toHaveLength(
        200,
      );
    }),
  );

  it.effect("lists the busiest server processes by name only, within the row limit", () =>
    Effect.gen(function* () {
      const result = yield* call({ action: "processes", limit: 2 });
      expect(result.truncated).toBe(true);
      expect(result.topProcesses).toMatchObject([{ name: "git" }, { name: "rg" }]);
      expect(JSON.stringify(result)).not.toContain("secret");
    }),
  );
});

describe("host model", () => {
  it("drops arguments and directories from a command", () => {
    expect(executableName("/usr/bin/node --token=secret server.js")).toBe("node");
    expect(executableName("C:\\Program Files\\git\\git.exe status")).toBe("git.exe");
    expect(executableName("")).toBe("unknown");
  });

  it("counts waiting before running, and leaves archived and subagent threads out of the totals", () => {
    expect(
      countThreads([
        {
          archivedAt: null,
          deletedAt: null,
          activeRunId: "r" as never,
          pendingRuntimeRequest: {} as never,
          lineage: { relationshipToParent: null } as never,
        },
        {
          archivedAt: "x" as never,
          deletedAt: null,
          activeRunId: "r" as never,
          pendingRuntimeRequest: null,
          lineage: { relationshipToParent: null } as never,
        },
      ]),
    ).toEqual({ threads: 1, running: 0, waiting: 1, subagentsRunning: 0 });
    expect(
      compactProcessHistory({ topProcesses: [], buckets: [], error: Option.none() } as never, 5)
        .truncated,
    ).toBe(false);
  });
});
