import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as MacVideoCapture from "./MacVideoCapture.ts";

const READY = { type: "ready", pid: 4321, port: 1, source: "iphone", width: 886, height: 1920 };

interface FakeHelper {
  /** Lines the helper prints; a string is printed as is. */
  readonly output: ReadonlyArray<object | string>;
  /** Omitted: the helper keeps running. */
  readonly exitCode?: number;
  readonly platform?: NodeJS.Platform;
  readonly built?: boolean;
}

const withHelper = <A, E>(
  helper: FakeHelper,
  use: (context: {
    readonly capture: MacVideoCapture.MacVideoCapture["Service"];
    readonly spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
    readonly killed: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mac-video-capture-" });
    const helperPath = path.join(directory, "t3-device-capture");
    if (helper.built !== false) yield* fs.writeFileString(helperPath, "");
    const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const killed = yield* Deferred.make<void>();
    const encoder = new TextEncoder();
    const stdout = Stream.fromIterable(
      helper.output.map((line) =>
        encoder.encode(`${typeof line === "string" ? line : JSON.stringify(line)}\n`),
      ),
    );
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (command._tag === "StandardCommand") {
            spawned.push({ command: command.command, args: command.args.map(String) });
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4321),
            // An open pipe: the stream ends only when the helper exits.
            stdout: helper.exitCode === undefined ? Stream.concat(stdout, Stream.never) : stdout,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode:
              helper.exitCode === undefined
                ? Effect.never
                : Effect.succeed(ChildProcessSpawner.ExitCode(helper.exitCode)),
            isRunning: Effect.succeed(helper.exitCode === undefined),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
        () => Deferred.succeed(killed, undefined),
      ),
    );
    const capture = yield* MacVideoCapture.MacVideoCapture.pipe(
      Effect.provide(MacVideoCapture.layer.pipe(Layer.provide(NetService.layer))),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Platform, helper.platform ?? "darwin"),
      Effect.provideService(HostProcess.Environment, { T3CODE_DEVICE_CAPTURE_PATH: helperPath }),
    );
    return yield* use({ capture, spawned, killed });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const iphone = { deviceId: "phone 1", source: { kind: "iphone", udid: "00008030-001C" } } as const;

describe("MacVideoCapture", () => {
  it.effect("starts the helper and routes one device's serve-sim paths to it", () =>
    withHelper({ output: ["CoreMediaIO: not the helper's JSON", READY] }, (context) =>
      Effect.gen(function* () {
        const session = yield* context.capture.start({ ...iphone, fps: 30, maxDimension: 1280 });
        const port = new URL(session.origin).port;
        expect(context.spawned[0]!.args).toEqual([
          "--source",
          "iphone",
          "--udid",
          "00008030-001C",
          "--port",
          port,
          "--fps",
          "30",
          "--max-dimension",
          "1280",
        ]);
        expect(session).toMatchObject({ pid: 4321, width: 886, height: 1920 });
        expect(session.origin).toBe(`http://127.0.0.1:${port}`);

        const routed = { headers: {}, protocols: [] };
        const rows: ReadonlyArray<readonly [string, string | null]> = [
          ["/vendor/serve-sim/helper/phone%201/stream.avcc", "/stream.avcc"],
          ["/vendor/serve-sim/helper/phone%201/config", "/config"],
          ["/vendor/serve-sim/helper/phone%201/health", "/health"],
          ["/vendor/serve-sim/helper/other/stream.avcc", null],
          ["/vendor/serve-sim/helper/%E0%A4%A/stream.avcc", null],
          ["/vendor/serve-sim/helper/phone%201/stream.mjpeg", null],
          ["/vendor/serve-sim/helper/ws", null],
          ["/vendor/serve-sim/exec", null],
        ];
        for (const [hubPath, expected] of rows) {
          expect(yield* session.upstream(hubPath, new URLSearchParams()), hubPath).toEqual(
            expected === null ? null : { ...routed, url: `${session.origin}${expected}` },
          );
        }

        yield* session.stop;
        yield* Deferred.await(context.killed);
        expect(yield* session.ended).toBe("stopped");
        yield* session.stop;
      }),
    ),
  );

  it.effect("captures the main display when no display id is given", () =>
    withHelper({ output: [READY] }, (context) =>
      Effect.gen(function* () {
        const main = yield* context.capture.start({ deviceId: "mac", source: { kind: "display" } });
        const second = yield* context.capture.start({
          deviceId: "mac-2",
          source: { kind: "display", displayId: 3 },
        });
        expect(context.spawned.map((spawn) => spawn.args.slice(0, 4))).toEqual([
          ["--source", "display", "--port", new URL(main.origin).port],
          ["--source", "display", "--display-id", "3"],
        ]);
        yield* main.stop;
        yield* second.stop;
      }),
    ),
  );

  it.effect("reports each helper error by its code and stops the helper", () =>
    Effect.forEach(
      [
        { code: "permission_missing", permission: "screen-recording" },
        { code: "permission_missing", permission: "camera" },
        { code: "device_not_found" },
        { code: "device_not_trusted" },
        { code: "device_locked" },
        { code: "unsupported_macos" },
        { code: "port_unavailable" },
        { code: "capture_failed" },
      ] as const,
      (error) =>
        withHelper(
          {
            output: [{ type: "error", message: `Helper said ${error.code}.`, ...error }],
            exitCode: 1,
          },
          (context) =>
            Effect.gen(function* () {
              const failure = yield* Effect.flip(context.capture.start(iphone));
              expect(failure).toMatchObject({
                _tag: "MacVideoCaptureError",
                detail: `Helper said ${error.code}.`,
                ...error,
              });
              if (!("permission" in error)) expect(failure.permission).toBeUndefined();
              yield* Deferred.await(context.killed);
            }),
        ),
      { discard: true },
    ),
  );

  it.effect("fails when the helper exits without a ready line", () =>
    withHelper({ output: [], exitCode: 64 }, (context) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(context.capture.start(iphone));
        expect(failure).toMatchObject({
          code: "helper_failed",
          detail: "The helper exited before it was ready (exit code 64).",
        });
        yield* Deferred.await(context.killed);
      }),
    ),
  );

  it.effect("says why a running capture ended", () =>
    withHelper(
      { output: [READY, { type: "ended", reason: "device_disconnected" }], exitCode: 0 },
      (context) =>
        Effect.gen(function* () {
          const session = yield* context.capture.start(iphone);
          expect(yield* session.ended).toBe("device_disconnected");
        }),
    ),
  );

  it.effect("needs a Mac and a built helper", () =>
    Effect.gen(function* () {
      const offMac = yield* withHelper({ output: [READY], platform: "linux" }, (context) =>
        Effect.flip(context.capture.start(iphone)),
      );
      expect(offMac.code).toBe("unsupported_platform");
      const missing = yield* withHelper({ output: [READY], built: false }, (context) =>
        Effect.flip(context.capture.list),
      );
      expect(missing.code).toBe("helper_missing");
      expect(missing.detail).toContain("vp run build:device-capture");
    }),
  );

  it.effect("lists capture sources and permission state", () => {
    const listing = {
      iphones: [{ udid: "00008030001C", name: "Test iPhone", model: "iOS Device" }],
      displays: [{ id: 1, width: 3456, height: 2234, main: true }],
      permissions: { camera: "not_determined", screenRecording: "denied" },
      displayCaptureSupported: true,
    };
    return withHelper({ output: [{ type: "list", ...listing }], exitCode: 0 }, (context) =>
      Effect.gen(function* () {
        expect(yield* context.capture.list).toEqual(listing);
        expect(context.spawned[0]!.args).toEqual(["--list"]);
      }),
    );
  });
});
