// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProcessOwners } from "@t3tools/shared/ProcessOwners";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import * as HeavyCommands from "./HeavyCommands.ts";

const proc = (pid: number, ppid: number, name: string, cpuPercent = 0) =>
  ({
    identity: { pid, startTimeMs: pid },
    ppid,
    name,
    command: name,
    cpuPercent,
    residentBytes: 0,
    runTimeMs: 60_000,
  }) as ResourceTelemetryProcess;

const snapshot = (readAtMs: number, buildCpu: number | null): ResourceTelemetrySnapshot =>
  ({
    readAt: DateTime.makeUnsafe(readAtMs),
    cpuCount: 8,
    processes: [
      proc(10, 1, "claude"),
      proc(11, 10, "zsh"),
      ...(buildCpu === null ? [] : [proc(12, 11, "tsc", buildCpu), proc(13, 12, "node", 50)]),
    ],
  }) as never;

interface Setup {
  readonly snapshots: ReadonlyArray<ResourceTelemetrySnapshot>;
  readonly alive?: (pid: number, sent: ReadonlyArray<string>) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly signalError?: Error;
  /** Every process is gone by the time it is signalled. */
  readonly gone?: boolean;
}

const withService = <A, E>(
  setup: Setup,
  use: (
    service: HeavyCommands.HeavyCommands["Service"],
    sent: Array<string>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-heavy-commands-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const sent: Array<string> = [];
    let refreshes = 0;
    const next = () => setup.snapshots[Math.min(refreshes++, setup.snapshots.length - 1)]!;
    const context = yield* Layer.build(
      HeavyCommands.layer({
        dir,
        signal: (pid, signal) => {
          if (setup.signalError !== undefined) throw setup.signalError;
          if (signal === 0) return setup.alive?.(pid, sent) ?? false;
          if (setup.gone === true) return false;
          sent.push(`${signal}:${pid}`);
          return true;
        },
      }).pipe(
        Layer.provide(
          Layer.mock(ResourceTelemetry)({
            refresh: Effect.sync(next),
            latest: Effect.sync(next),
            subscribe: Effect.succeed({
              latest: setup.snapshots[0]!,
              changes: Stream.fromIterable(setup.snapshots.slice(1)),
            }),
          }),
        ),
      ),
    ).pipe(
      Effect.provideService(ProcessOwners, {
        register: () => Effect.void,
        retain: () => Effect.void,
        list: Effect.succeed([{ kind: "agent" as const, pid: 10, threadId: "t1" }]),
      }),
      Effect.provideService(HostProcess.Platform, setup.platform ?? "darwin"),
    );
    return yield* use(Context.get(context, HeavyCommands.HeavyCommands), sent);
  }).pipe(Effect.scoped);

describe("HeavyCommands", () => {
  it.effect("lists the heavy commands of a fresh sample, and nothing from a stale one", () =>
    Effect.gen(function* () {
      const listed = yield* withService(
        { snapshots: [snapshot(1_000, 200)] },
        (service) => service.list,
      );
      expect(listed).toMatchObject({ cpuCount: 8, commands: [{ pid: 12, cpu: 2.5 }] });
      yield* TestClock.adjust("1 minute");
      const stale = yield* withService(
        { snapshots: [snapshot(1_000, 200)] },
        (service) => service.list,
      );
      expect(stale).toEqual({ cpuCount: 8, commands: [] });
    }),
  );

  it.effect("streams at most one frame per two seconds and only when something changed", () =>
    withService(
      {
        snapshots: [
          snapshot(1_000, 200),
          snapshot(1_500, 300),
          snapshot(3_000, 200),
          snapshot(5_000, 300),
          snapshot(8_000, null),
        ],
      },
      (service) => Stream.runCollect(service.stream),
    ).pipe(
      Effect.map((frames) =>
        expect(frames.map((frame) => frame.commands.map((command) => command.cpu))).toEqual([
          [2.5],
          [3.5],
          [],
        ]),
      ),
    ),
  );

  it.effect.each([
    {
      name: "ends the tree with SIGTERM when it exits in time",
      alive: () => false,
      outcome: "terminated",
      sent: ["SIGTERM:12", "SIGTERM:13"],
    },
    {
      name: "kills what survives the grace period",
      alive: (pid: number) => pid === 13,
      outcome: "killed",
      sent: ["SIGTERM:12", "SIGTERM:13", "SIGKILL:13"],
    },
  ])("stop $name", ({ alive, outcome, sent: expected }) =>
    withService({ snapshots: [snapshot(1_000, 200)], alive }, (service, sent) =>
      Effect.gen(function* () {
        const fiber = yield* service.stop({ pid: 12, startTimeMs: 12 }).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(fiber)).toEqual({ outcome });
        expect(sent.toSorted()).toEqual(expected.toSorted());
      }),
    ),
  );

  it.effect.each([
    {
      name: "refuses a live process that is not a heavy command",
      input: { pid: 11, startTimeMs: 11 },
      setup: {},
      result: { reason: "not-found" },
    },
    {
      name: "treats a reused pid with another start time as exited",
      input: { pid: 12, startTimeMs: 99 },
      setup: {},
      result: { outcome: "already-exited" },
    },
    {
      name: "reports a command that already exited",
      input: { pid: 40, startTimeMs: 40 },
      setup: {},
      result: { outcome: "already-exited" },
    },
    {
      name: "reports a tree that exited before the signal",
      input: { pid: 12, startTimeMs: 12 },
      setup: { gone: true },
      result: { outcome: "already-exited" },
    },
    {
      name: "is unavailable on Windows",
      input: { pid: 12, startTimeMs: 12 },
      setup: { platform: "win32" as const },
      result: { reason: "unavailable" },
    },
    {
      name: "fails when the signal cannot be sent",
      input: { pid: 12, startTimeMs: 12 },
      setup: { signalError: new Error("EPERM") },
      result: { reason: "unavailable" },
    },
  ])("stop $name", ({ input, setup, result }) =>
    withService({ snapshots: [snapshot(1_000, 200)], ...setup }, (service, sent) =>
      Effect.gen(function* () {
        const exit = yield* service.stop(input).pipe(Effect.result);
        expect(exit._tag === "Success" ? exit.success : exit.failure).toMatchObject(result);
        if ("reason" in result && result.reason === "not-found") expect(sent).toEqual([]);
      }),
    ),
  );
});
