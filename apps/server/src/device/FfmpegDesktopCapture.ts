// @effect-diagnostics nodeBuiltinImport:off - a loopback server the proxy reads, like the Swift helper's.
import * as NodeHttp from "node:http";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { AnnexBFramer, AVCC_TAG, envelope } from "./avccFramer.ts";
import { captureUpstream, type MacVideoCaptureSession } from "./MacVideoCapture.ts";

export class FfmpegCaptureError extends Schema.TaggedError<FfmpegCaptureError>()(
  "FfmpegCaptureError",
  { reason: Schema.Literals(["ffmpeg_missing", "capture_failed"]), detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A viewer this far behind is dropped; it reconnects and starts again from the last keyframe. */
const MAX_VIEWER_BACKLOG = 8 * 1024 * 1024;
/** Frames kept since the last keyframe for viewers that join between keyframes. */
const MAX_GOP_FRAMES = 600;
const STDERR_TAIL = 2_000;

/** ffmpeg's arguments for this screen: grab, scale inside `maxDimension`, H.264 baseline to stdout. */
export const ffmpegDesktopArguments = (input: {
  readonly platform: "win32" | "linux";
  /** X11 display such as `:0`; Windows grabs the whole desktop. */
  readonly display?: string | undefined;
  readonly fps: number;
  readonly maxDimension: number;
}): ReadonlyArray<string> => {
  const { fps, maxDimension: max } = input;
  const grab =
    input.platform === "win32"
      ? ["-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", "1", "-i", "desktop"]
      : [
          "-f",
          "x11grab",
          "-framerate",
          String(fps),
          "-draw_mouse",
          "1",
          "-i",
          input.display ?? ":0",
        ];
  const fit = (edge: string, other: string) =>
    `if(gte(${edge},${other}),trunc(min(${max},${edge})/2)*2,-2)`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...grab,
    "-vf",
    `scale='${fit("iw", "ih")}':'${fit("ih", "iw")}',format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    // A keyframe every two seconds: viewers that join in between get the frames since it.
    "-g",
    String(fps * 2),
    "-keyint_min",
    String(fps * 2),
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-x264-params",
    "repeat-headers=1",
    "-b:v",
    "4000k",
    "-maxrate",
    "4000k",
    "-bufsize",
    "2000k",
    "-an",
    "-flush_packets",
    "1",
    "-f",
    "h264",
    "pipe:1",
  ];
};

/**
 * Captures this computer's screen with ffmpeg and serves it in serve-sim's AVCC format on loopback,
 * so the proxy and viewer treat it like `t3-device-capture`. Resolves once the first frame is out.
 */
export const startFfmpegDesktop = Effect.fn("FfmpegDesktopCapture.start")(function* (input: {
  readonly deviceId: string;
  readonly ffmpeg: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.make("sequential");
  const stop = Scope.close(scope, Exit.void).pipe(Effect.ignore);
  const ended = yield* Deferred.make<string>();
  yield* Scope.addFinalizer(scope, Deferred.succeed(ended, "stopped"));

  return yield* Effect.gen(function* () {
    const framer = new AnnexBFramer();
    let description: Uint8Array | null = null;
    let gop: Array<Uint8Array> = [];
    const viewers = new Set<NodeHttp.ServerResponse>();
    const send = (viewer: NodeHttp.ServerResponse, bytes: Uint8Array) => {
      // ponytail: a slow viewer is dropped rather than skipped to the next keyframe.
      if (viewer.writableLength > MAX_VIEWER_BACKLOG) viewer.destroy();
      else viewer.write(bytes);
    };

    const server = NodeHttp.createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0];
      const json = (status: number, body: object) =>
        response
          .writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-cache, no-store",
          })
          .end(JSON.stringify(body));
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      if (path === "/health") return json(200, { status: "ok" });
      if (path === "/config") {
        const size = framer.size;
        if (!size) return json(503, { error: "no_frame" });
        return json(200, {
          ...size,
          orientation: size.width > size.height ? "landscape_left" : "portrait",
          inputUnavailable: true,
          keyboardUnavailable: true,
        });
      }
      if (path !== "/stream.avcc") return json(404, { error: "not_found" });
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-cache, no-store",
      });
      if (description) for (const bytes of [description, ...gop]) response.write(bytes);
      viewers.add(response);
      response.on("close", () => viewers.delete(response));
    });
    const port = yield* Effect.callback<number, FfmpegCaptureError>((resume) => {
      server.once("error", (cause) =>
        resume(
          Effect.fail(
            new FfmpegCaptureError({
              reason: "capture_failed",
              detail: `Could not serve the desktop stream: ${cause.message}`,
            }),
          ),
        ),
      );
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0));
      });
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const viewer of viewers) viewer.destroy();
        server.close();
      }),
    );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(input.ffmpeg, input.args, {
          detached: false,
          shell: false,
          stdout: "pipe",
          stderr: "pipe",
          ...(input.env ? { env: input.env, extendEnv: false } : {}),
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new FfmpegCaptureError({
              reason: "ffmpeg_missing",
              detail: `Could not start ${input.ffmpeg}: ${cause.message}`,
            }),
        ),
      );

    let stderr = "";
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.sync(() => {
          stderr = (stderr + text).slice(-STDERR_TAIL);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const ready = yield* Deferred.make<void, FfmpegCaptureError>();
    const publish = (
      chunks: ReadonlyArray<{ readonly tag: number; readonly payload: Uint8Array }>,
    ) => {
      for (const chunk of chunks) {
        const bytes = envelope(chunk.tag, chunk.payload);
        if (chunk.tag === AVCC_TAG.description) {
          description = bytes;
          gop = [];
        } else if (chunk.tag === AVCC_TAG.keyframe) gop = [bytes];
        else if (gop.length < MAX_GOP_FRAMES) gop.push(bytes);
        else gop = [];
        for (const viewer of viewers) send(viewer, bytes);
        if (chunk.tag === AVCC_TAG.keyframe) Deferred.doneUnsafe(ready, Effect.void);
      }
    };
    yield* child.stdout.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => publish(framer.push(chunk)))),
      Effect.ignore,
      Effect.andThen(Effect.sync(() => publish(framer.flush()))),
      Effect.andThen(
        Effect.suspend(() =>
          Deferred.fail(
            ready,
            new FfmpegCaptureError({
              reason: "capture_failed",
              detail: `ffmpeg stopped before the first frame${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
            }),
          ),
        ),
      ),
      Effect.andThen(Deferred.succeed(ended, "exited")),
      Effect.forkIn(scope),
    );

    yield* Deferred.await(ready);
    const origin = `http://127.0.0.1:${port}`;
    const session: MacVideoCaptureSession = {
      pid: Number(child.pid),
      origin,
      width: framer.size?.width ?? 0,
      height: framer.size?.height ?? 0,
      upstream: captureUpstream(origin, input.deviceId),
      ended: Deferred.await(ended),
      stop,
    };
    return session;
  }).pipe(Effect.onError(() => stop));
});
