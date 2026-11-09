import { assert, describe, it } from "@effect/vitest";
import type { KeepAwakeMode, KeepAwakeStatus } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as KeepAwake from "./KeepAwake.ts";

const INHIBITOR = Option.some<KeepAwake.InhibitorCommand>({
  command: "fake-inhibit",
  args: ["-x"],
});

const harness = (input: {
  mode: KeepAwakeMode;
  inhibitor?: typeof INHIBITOR;
  spawnFails?: boolean;
  settingsFail?: boolean;
}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    const settingsChanges = yield* Queue.unbounded<{ keepAwake: KeepAwakeMode }>();
    const children: Array<{
      exit: Deferred.Deferred<number>;
      killed: boolean;
      args: ReadonlyArray<string>;
    }> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const { command: name, args } = command as unknown as { command: string; args: string[] };
      return Effect.gen(function* () {
        if (input.spawnFails) return yield* Effect.die("spawn failed");
        assert.strictEqual(name, "fake-inhibit");
        const child = { exit: yield* Deferred.make<number>(), killed: false, args };
        children.push(child);
        yield* Effect.addFinalizer(() => Effect.sync(() => void (child.killed = true)));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(children.length),
          exitCode: Deferred.await(child.exit).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      });
    });
    const layer = KeepAwake.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(KeepAwake.KeepAwakeHost, {
            inhibitor: Effect.succeed(input.inhibitor ?? INHIBITOR),
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events) as never,
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: input.settingsFail
              ? (Effect.fail("unreadable") as never)
              : Effect.succeed({ keepAwake: input.mode } as never),
            subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges) as never),
          }),
        ),
      ),
    );
    const service = Context.get(yield* Layer.build(layer), KeepAwake.KeepAwake);
    const until = (predicate: (status: KeepAwakeStatus) => boolean) =>
      service.streamStatus.pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain);
    const other = Queue.offer(events, { type: "thread.created", payload: {} });
    const run = (id: string, status: string) =>
      Queue.offer(events, { type: "run.updated", payload: { id, status } });
    const background = (
      id: string,
      pendingBackgroundTasks: ReadonlyArray<{ kind: string; awaited?: boolean }>,
    ) =>
      Queue.offer(events, {
        type: "provider-thread.updated",
        payload: { id, pendingBackgroundTasks },
      });
    return {
      children,
      other,
      until,
      run,
      background,
      setMode: (keepAwake: KeepAwakeMode) => Queue.offer(settingsChanges, { keepAwake }),
      status: service.streamStatus.pipe(Stream.take(1), Stream.runCollect),
    };
  });

describe("KeepAwake", () => {
  it.effect("always holds the host awake from the start and releases when set off", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always" });
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 1);
      yield* h.setMode("off");
      yield* h.until((s) => !s.active);
      assert.strictEqual(h.children[0]?.killed, true);
    }),
  );

  it.effect("off never spawns until the mode changes", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "off" });
      yield* h.run("run-1", "running");
      yield* h.setMode("always");
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 1);
    }),
  );

  it.effect("while-working follows runs, and waiting for approval does not count", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "while-working" });
      yield* h.run("a", "preparing");
      yield* h.until((s) => s.active);
      yield* h.run("b", "running");
      yield* h.run("a", "completed");
      yield* h.run("b", "waiting");
      yield* h.until((s) => !s.active);
      assert.strictEqual(h.children.length, 1);
      assert.strictEqual(h.children[0]?.killed, true);
      yield* h.run("b", "starting");
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 2);
      yield* h.run("b", "failed");
      yield* h.until((s) => !s.active);
    }),
  );

  it.effect("while-working holds for background work the agent waits on after its turn", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "while-working" });
      yield* h.background("pt", [{ kind: "subagent" }]);
      yield* h.until((s) => s.active);
      // A dev server left running is not work the agent waits on.
      yield* h.background("pt", [{ kind: "command" }]);
      yield* h.until((s) => !s.active);
      yield* h.background("pt", [{ kind: "command", awaited: true }]);
      yield* h.until((s) => s.active);
      yield* h.background("pt", []);
      yield* h.until((s) => !s.active);
    }),
  );

  it.effect("setting while-working at runtime starts holding for runs already going", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "off" });
      yield* h.run("a", "running");
      yield* h.setMode("while-working");
      yield* h.until((s) => s.active);
      yield* h.setMode("off");
      yield* h.until((s) => !s.active);
    }),
  );

  it.effect("an unexpected exit reports inactive and respawns with a growing delay", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always" });
      yield* h.until((s) => s.active);
      yield* Deferred.succeed(h.children[0]!.exit, 1);
      yield* h.until((s) => !s.active);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 2);
      yield* Deferred.succeed(h.children[1]!.exit, 1);
      yield* h.until((s) => !s.active);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.strictEqual(h.children.length, 2);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 3);
    }),
  );

  it.effect("a failed spawn stays inactive and keeps retrying", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always", spawnFails: true });
      yield* TestClock.adjust(Duration.seconds(10));
      const [status] = yield* h.status;
      assert.deepStrictEqual(status, { supported: true, active: false });
      assert.strictEqual(h.children.length, 0);
    }),
  );

  it.effect("an unsupported host reports it and never spawns", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always", inhibitor: Option.none() });
      yield* TestClock.adjust(Duration.minutes(1));
      const [status] = yield* h.status;
      assert.deepStrictEqual(status, { supported: false, active: false });
      assert.strictEqual(h.children.length, 0);
    }),
  );

  it.effect("ignores other events and falls back to off when settings cannot be read", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always", settingsFail: true });
      yield* h.other;
      yield* h.run("a", "running");
      yield* h.setMode("always");
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 1);
    }),
  );

  it.effect("a child that lived a while is replaced after the short delay again", () =>
    Effect.gen(function* () {
      const h = yield* harness({ mode: "always" });
      yield* h.until((s) => s.active);
      yield* Deferred.succeed(h.children[0]!.exit, 1);
      yield* h.until((s) => !s.active);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* h.until((s) => s.active);
      yield* TestClock.adjust(Duration.minutes(2));
      yield* Deferred.succeed(h.children[1]!.exit, 1);
      yield* h.until((s) => !s.active);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* h.until((s) => s.active);
      assert.strictEqual(h.children.length, 3);
    }),
  );

  describe("layerHost", () => {
    const inhibitorOn = (platform: NodeJS.Platform, pathDir: string) =>
      Effect.gen(function* () {
        const host = yield* KeepAwake.KeepAwakeHost;
        return yield* host.inhibitor;
      }).pipe(
        Effect.provide(KeepAwake.layerHost.pipe(Layer.provide(NodeServices.layer))),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(HostProcess.Environment, { PATH: `/nonexistent::${pathDir}` }),
      );

    it.effect("finds systemd-inhibit on PATH only on Linux", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const withTool = yield* fs.makeTempDirectoryScoped();
        const without = yield* fs.makeTempDirectoryScoped();
        const tool = `${withTool}/systemd-inhibit`;
        yield* fs.writeFileString(tool, "#!/bin/sh\n");
        yield* fs.chmod(tool, 0o755);
        assert.isTrue(Option.isSome(yield* inhibitorOn("linux", withTool)));
        assert.isTrue(Option.isNone(yield* inhibitorOn("linux", without)));
        assert.isTrue(Option.isSome(yield* inhibitorOn("darwin", without)));
        assert.isTrue(Option.isNone(yield* inhibitorOn("win32", withTool)));
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  describe("inhibitorFor", () => {
    const cases = [
      {
        platform: "darwin",
        systemd: false,
        expected: ["/usr/bin/caffeinate", "-i", "-s", "-w", "42"],
      },
      { platform: "linux", systemd: true, expected: ["systemd-inhibit", "--what=idle:sleep"] },
      { platform: "linux", systemd: false, expected: null },
      { platform: "win32", systemd: false, expected: null },
    ] as const;
    it.each(cases)("$platform systemd=$systemd", (row) => {
      const plan = KeepAwake.inhibitorFor({
        platform: row.platform,
        pid: 42,
        hasSystemdInhibit: row.systemd,
      });
      if (row.expected === null) return assert.isTrue(Option.isNone(plan));
      assert.isTrue(Option.isSome(plan));
      if (Option.isSome(plan)) {
        assert.deepStrictEqual(
          [plan.value.command, ...plan.value.args].slice(0, row.expected.length),
          [...row.expected],
        );
      }
    });
  });
});
