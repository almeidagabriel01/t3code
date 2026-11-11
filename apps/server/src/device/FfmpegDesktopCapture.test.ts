// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - reads a binary fixture and a real loopback server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ffmpegDesktopArguments, startFfmpegDesktop } from "./FfmpegDesktopCapture.ts";

const fixture = new Uint8Array(
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", "desktop-320x180.h264")),
);

interface FakeFfmpeg {
  readonly stdout: ReadonlyArray<Uint8Array>;
  readonly stderr?: string;
  /** Omitted: ffmpeg keeps running after its output. */
  readonly exits?: boolean;
  readonly missing?: boolean;
}

const withFfmpeg = <A, E>(
  fake: FakeFfmpeg,
  use: (context: {
    readonly spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
    readonly killed: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const killed = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      fake.missing
        ? Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
              }),
            ),
          )
        : Effect.acquireRelease(
            Effect.sync(() => {
              if (command._tag === "StandardCommand")
                spawned.push({ command: command.command, args: command.args.map(String) });
              const stdout = Stream.fromIterable(fake.stdout);
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(777),
                stdout: fake.exits ? stdout : Stream.concat(stdout, Stream.never),
                stderr: Stream.make(new TextEncoder().encode(fake.stderr ?? "")),
                all: Stream.empty,
                exitCode: fake.exits
                  ? Effect.succeed(ChildProcessSpawner.ExitCode(1))
                  : Effect.never,
                isRunning: Effect.succeed(!fake.exits),
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
    return yield* use({ spawned, killed }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  });

const chunks = (bytes: Uint8Array, size: number) =>
  Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) =>
    bytes.subarray(index * size, (index + 1) * size),
  );

/** Reads a stream response until `count` envelopes have arrived, then hangs up. */
const readEnvelopes = (url: string, count: number) =>
  Effect.promise(async () => {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    let buffer = new Uint8Array(0);
    const tags: Array<number> = [];
    while (tags.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(buffer.length + value.length);
      joined.set(buffer);
      joined.set(value, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
        if (buffer.length < 4 + length) break;
        tags.push(buffer[4]!);
        buffer = buffer.slice(4 + length);
      }
    }
    controller.abort();
    return tags;
  });

describe("ffmpegDesktopArguments", () => {
  it("grabs the X11 display or the Windows desktop and encodes low-latency baseline H.264", () => {
    const linux = ffmpegDesktopArguments({
      platform: "linux",
      display: ":1",
      fps: 30,
      maxDimension: 1920,
    });
    expect(linux.slice(0, 12)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-framerate",
      "30",
      "-draw_mouse",
      "1",
      "-i",
      ":1",
      "-vf",
    ]);
    expect(linux).toContain(
      "scale='if(gte(iw,ih),trunc(min(1920,iw)/2)*2,-2)':'if(gte(ih,iw),trunc(min(1920,ih)/2)*2,-2)',format=yuv420p",
    );
    expect(linux.join(" ")).toContain("-profile:v baseline -g 60 -keyint_min 60");
    expect(linux.slice(-3)).toEqual(["-f", "h264", "pipe:1"]);
    const windows = ffmpegDesktopArguments({ platform: "win32", fps: 15, maxDimension: 1280 });
    expect(windows.slice(3, 11)).toEqual([
      "-f",
      "gdigrab",
      "-framerate",
      "15",
      "-draw_mouse",
      "1",
      "-i",
      "desktop",
    ]);
  });
});

describe("startFfmpegDesktop", () => {
  it.live("serves the framed stream, its size and health on loopback, and joins late viewers", () =>
    withFfmpeg({ stdout: chunks(fixture, 333) }, ({ spawned, killed }) =>
      Effect.gen(function* () {
        const session = yield* startFfmpegDesktop({
          deviceId: "desktop",
          ffmpeg: "/usr/bin/ffmpeg",
          args: ["-f", "x11grab"],
        });
        expect(spawned).toEqual([{ command: "/usr/bin/ffmpeg", args: ["-f", "x11grab"] }]);
        expect(session).toMatchObject({ pid: 777, width: 320, height: 180 });
        const routed = yield* session.upstream(
          "/vendor/serve-sim/helper/desktop/config",
          new URLSearchParams(),
        );
        expect(routed?.url).toBe(`${session.origin}/config`);
        expect(
          yield* session.upstream("/vendor/serve-sim/helper/phone/config", new URLSearchParams()),
        ).toBeNull();

        const config = yield* Effect.promise(() =>
          fetch(`${session.origin}/config`).then((response) => response.json()),
        );
        expect(config).toEqual({
          width: 320,
          height: 180,
          orientation: "landscape_left",
          inputUnavailable: true,
          keyboardUnavailable: true,
        });
        const health = yield* Effect.promise(() => fetch(`${session.origin}/health`));
        expect(health.status).toBe(200);
        const missing = yield* Effect.promise(() => fetch(`${session.origin}/api`));
        expect(missing.status).toBe(404);
        // The whole fixture is out, so a late viewer gets the description and the last GOP.
        expect(yield* readEnvelopes(`${session.origin}/stream.avcc`, 2)).toEqual([1, 2]);

        yield* session.stop;
        expect(yield* session.ended).toBe("stopped");
        yield* Deferred.await(killed);
      }),
    ),
  );

  it.live("reports ffmpeg's own words when it stops before the first frame", () =>
    withFfmpeg(
      { stdout: [], stderr: "[x11grab] Cannot open display :0, error 1.", exits: true },
      ({ killed }) =>
        Effect.gen(function* () {
          const error = yield* startFfmpegDesktop({
            deviceId: "desktop",
            ffmpeg: "ffmpeg",
            args: [],
          }).pipe(Effect.flip);
          expect(error).toMatchObject({
            reason: "capture_failed",
            detail:
              "ffmpeg stopped before the first frame: [x11grab] Cannot open display :0, error 1.",
          });
          yield* Deferred.await(killed);
        }),
    ),
  );

  it.live("says ffmpeg is missing when it cannot be started", () =>
    withFfmpeg({ stdout: [], missing: true }, () =>
      Effect.gen(function* () {
        const error = yield* startFfmpegDesktop({
          deviceId: "desktop",
          ffmpeg: "ffmpeg",
          args: [],
        }).pipe(Effect.flip);
        expect(error.reason).toBe("ffmpeg_missing");
      }),
    ),
  );
});
