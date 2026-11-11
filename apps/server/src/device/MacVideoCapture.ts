import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { HubUpstream } from "./DeviceHost.ts";

const HELPER_NAME = "t3-device-capture";
const ROUTE = /^\/vendor\/serve-sim\/helper\/([^/]+)\/(stream\.avcc|config|health)$/;

const Permission = Schema.Literals(["camera", "screen-recording"]);

/** Codes the helper reports, then the ones this service adds for the helper process itself. */
const ErrorCode = Schema.Literals([
  "invalid_arguments",
  "permission_missing",
  "device_not_found",
  "device_not_trusted",
  "device_locked",
  "unsupported_macos",
  "port_unavailable",
  "capture_failed",
  "unsupported_platform",
  "helper_missing",
  "helper_failed",
]);

export class MacVideoCaptureError extends Schema.TaggedError<MacVideoCaptureError>()(
  "MacVideoCaptureError",
  {
    code: ErrorCode,
    detail: Schema.String,
    permission: Schema.optionalKey(Permission),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const HelperList = Schema.Struct({
  type: Schema.Literal("list"),
  iphones: Schema.Array(
    Schema.Struct({ udid: Schema.String, name: Schema.String, model: Schema.String }),
  ),
  displays: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
      main: Schema.Boolean,
    }),
  ),
  permissions: Schema.Struct({
    camera: Schema.Literals(["granted", "denied", "not_determined"]),
    screenRecording: Schema.Literals(["granted", "denied"]),
  }),
  displayCaptureSupported: Schema.Boolean,
});
export type MacVideoCaptureList = Omit<typeof HelperList.Type, "type">;

const HelperLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    pid: Schema.Number,
    port: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: ErrorCode,
    message: Schema.String,
    permission: Schema.optionalKey(Permission),
  }),
  Schema.Struct({ type: Schema.Literal("ended"), reason: Schema.String }),
  HelperList,
]);
// Lines that are not the helper's JSON (a framework's own logging) are skipped, not fatal.
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(HelperLine));

export type MacVideoCaptureSource =
  | { readonly kind: "iphone"; readonly udid: string }
  /** Omit `displayId` for the main display. */
  | { readonly kind: "display"; readonly displayId?: number };

export interface MacVideoCaptureSession {
  readonly pid: number;
  readonly origin: string;
  /** Encoded frame size, after scaling. */
  readonly width: number;
  readonly height: number;
  /** A `DeviceHostReady.upstream` that serves `deviceId`'s serve-sim stream, config and health. */
  readonly upstream: (
    hubPath: string,
    search: URLSearchParams,
  ) => Effect.Effect<HubUpstream | null>;
  /** Completes when the helper is gone: `device_disconnected`, `display_stopped`, `exited`, or `stopped`. */
  readonly ended: Effect.Effect<string>;
  /** Ends the helper this session spawned. Safe to repeat. */
  readonly stop: Effect.Effect<void>;
}

export class MacVideoCapture extends Context.Service<
  MacVideoCapture,
  {
    /** Connected iPhones and iPads, displays, and permission state. Never prompts. */
    readonly list: Effect.Effect<MacVideoCaptureList, MacVideoCaptureError>;
    /**
     * Starts live H.264 capture and resolves once the first frame is encoded. `deviceId` is
     * the id clients will request the stream by.
     */
    readonly start: (input: {
      readonly deviceId: string;
      readonly source: MacVideoCaptureSource;
      readonly fps?: number;
      readonly maxDimension?: number;
    }) => Effect.Effect<MacVideoCaptureSession, MacVideoCaptureError>;
  }
>()("t3/device/MacVideoCapture") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* Net.NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;

  const packaged = import.meta.dirname.indexOf(`${path.sep}app.asar${path.sep}`);
  // An explicit path is the only one tried: a wrong override fails instead of running another build.
  const candidates = environment.T3CODE_DEVICE_CAPTURE_PATH
    ? [environment.T3CODE_DEVICE_CAPTURE_PATH]
    : [
        // The desktop app ships the helper beside app.asar, in Contents/Resources.
        ...(packaged < 0
          ? []
          : [path.join(import.meta.dirname.slice(0, packaged), "device-capture", HELPER_NAME)]),
        ...["../../../..", "../../.."].map((root) =>
          path.resolve(
            import.meta.dirname,
            root,
            "native/device-capture/.build/release",
            HELPER_NAME,
          ),
        ),
      ];

  const resolveHelper = Effect.gen(function* () {
    if (platform !== "darwin") {
      return yield* new MacVideoCaptureError({
        code: "unsupported_platform",
        detail: "Live video capture needs a Mac.",
      });
    }
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
    return yield* new MacVideoCaptureError({
      code: "helper_missing",
      detail: `The video capture helper is not built. Run 'vp run build:device-capture'. Looked in: ${candidates.join(", ")}`,
    });
  });

  const helperFailed = (detail: string) =>
    new MacVideoCaptureError({ code: "helper_failed", detail });

  const spawn = (helper: string, args: ReadonlyArray<string>) =>
    spawner
      .spawn(
        ChildProcess.make(helper, args, {
          detached: false,
          shell: false,
          stdout: "pipe",
          // Nothing reads it, and a full pipe would stall the helper.
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.mapError((cause) => helperFailed(`Could not start the helper: ${cause.message}`)),
      );

  const lines = (child: ChildProcessSpawner.ChildProcessHandle) =>
    child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => decodeLine(line)),
      Stream.filter(Option.isSome),
      Stream.map((line) => line.value),
    );

  const list: MacVideoCapture["Service"]["list"] = Effect.gen(function* () {
    const helper = yield* resolveHelper;
    const child = yield* spawn(helper, ["--list"]);
    const line = yield* lines(child).pipe(
      Stream.runHead,
      Effect.mapError((cause) => helperFailed(`Could not read the helper: ${cause.message}`)),
    );
    if (Option.isSome(line) && line.value.type === "list") {
      const { type: _, ...listing } = line.value;
      return listing;
    }
    if (Option.isSome(line) && line.value.type === "error") {
      return yield* new MacVideoCaptureError({
        code: line.value.code,
        detail: line.value.message,
      });
    }
    return yield* helperFailed("The helper did not list capture sources.");
  }).pipe(Effect.scoped, Effect.withSpan("MacVideoCapture.list"));

  const start: MacVideoCapture["Service"]["start"] = Effect.fn("MacVideoCapture.start")(
    function* (input) {
      const helper = yield* resolveHelper;
      const port = yield* net
        .reserveLoopbackPort("127.0.0.1")
        .pipe(
          Effect.mapError((cause) => helperFailed(`Could not reserve a port: ${cause.message}`)),
        );
      const scope = yield* Scope.make("sequential");
      const stop = Scope.close(scope, Exit.void).pipe(Effect.ignore);
      const ended = yield* Deferred.make<string>();
      // Added first so it runs last, after the helper is gone.
      yield* Scope.addFinalizer(scope, Deferred.succeed(ended, "stopped"));
      return yield* Effect.gen(function* () {
        const child = yield* spawn(helper, [
          "--source",
          input.source.kind,
          ...(input.source.kind === "iphone"
            ? ["--udid", input.source.udid]
            : input.source.displayId === undefined
              ? []
              : ["--display-id", String(input.source.displayId)]),
          "--port",
          String(port),
          ...(input.fps === undefined ? [] : ["--fps", String(input.fps)]),
          ...(input.maxDimension === undefined
            ? []
            : ["--max-dimension", String(input.maxDimension)]),
        ]).pipe(Effect.provideService(Scope.Scope, scope));

        const ready = yield* Deferred.make<
          { readonly width: number; readonly height: number },
          MacVideoCaptureError
        >();
        let reason = "exited";
        yield* lines(child).pipe(
          Stream.runForEach((line) => {
            if (line.type === "ready") return Deferred.succeed(ready, line);
            if (line.type === "ended") reason = line.reason;
            if (line.type !== "error") return Effect.void;
            return Deferred.fail(
              ready,
              new MacVideoCaptureError({
                code: line.code,
                detail: line.message,
                ...(line.permission ? { permission: line.permission } : {}),
              }),
            );
          }),
          Effect.ignore,
          Effect.andThen(
            child.exitCode.pipe(
              Effect.map((code) => ` (exit code ${code})`),
              Effect.orElseSucceed(() => ""),
            ),
          ),
          Effect.andThen((exit) =>
            Deferred.fail(ready, helperFailed(`The helper exited before it was ready${exit}.`)),
          ),
          Effect.andThen(Effect.suspend(() => Deferred.succeed(ended, reason))),
          Effect.forkIn(scope),
        );

        const size = yield* Deferred.await(ready);
        const origin = `http://127.0.0.1:${port}`;
        const upstream: MacVideoCaptureSession["upstream"] = (hubPath) =>
          Effect.sync(() => {
            const route = ROUTE.exec(hubPath);
            if (!route) return null;
            try {
              if (decodeURIComponent(route[1]!) !== input.deviceId) return null;
            } catch {
              return null;
            }
            return { url: `${origin}/${route[2]}`, headers: {}, protocols: [] };
          });
        return {
          pid: Number(child.pid),
          origin,
          width: size.width,
          height: size.height,
          upstream,
          ended: Deferred.await(ended),
          stop,
        };
      }).pipe(Effect.onError(() => stop));
    },
  );

  return MacVideoCapture.of({ list, start });
});

export const layer = Layer.effect(MacVideoCapture, make);
