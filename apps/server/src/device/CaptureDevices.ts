import {
  DESKTOP_DEVICE_ID,
  type DeviceId,
  type DeviceIssue,
  DeviceNotReadyError,
  isAppleTeamId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { resolveServerEnvironmentLabel } from "../environment/ServerEnvironmentLabel.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { HostDevice } from "./DeviceHost.ts";
import {
  FfmpegCaptureError,
  ffmpegDesktopArguments,
  startFfmpegDesktop,
} from "./FfmpegDesktopCapture.ts";
import { listIphones, parseDevicectl } from "./iphoneListing.ts";
import {
  CAPTURE_ROUTE,
  MacVideoCapture,
  type MacVideoCaptureError,
  type MacVideoCaptureSession,
} from "./MacVideoCapture.ts";

/** How long a capture outlives its last viewer, so a reconnect or a tab switch does not restart it. */
export const CAPTURE_LINGER = Duration.seconds(20);
const DESKTOP_FPS = 30;
const MAX_DIMENSION = 1920;

/** A proxied request a running capture serves; `release` ends the viewer it counted. */
export interface CaptureRoute {
  readonly url: string;
  readonly release: Effect.Effect<void>;
}

export class CaptureDevices extends Context.Service<
  CaptureDevices,
  {
    /** This computer's screen and its USB iPhones and iPads. Never fails: problems are issues. */
    readonly list: Effect.Effect<ReadonlyArray<HostDevice>>;
    /** Starts the device's capture, or joins the running one, once its first frame is out. */
    readonly start: (device: HostDevice) => Effect.Effect<void, DeviceNotReadyError>;
    /**
     * Routes a proxied hub path to a capture: null when it is not a capture device's path,
     * `unavailable` when it is one that cannot stream now.
     */
    readonly route: (
      hubPath: string,
      search: URLSearchParams,
    ) => Effect.Effect<CaptureRoute | "unavailable" | null>;
    /** Stops the device's capture now, whoever watches it. */
    readonly stop: (deviceId: string) => Effect.Effect<void>;
    /** Device ids whose capture ended on its own, such as an unplugged phone. */
    readonly ended: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
  }
>()("t3/device/CaptureDevices") {}

export const macIssue = (error: MacVideoCaptureError): DeviceIssue => {
  switch (error.code) {
    case "permission_missing":
      return {
        reason:
          error.permission === "screen-recording"
            ? "screen_recording_permission"
            : "camera_permission",
      };
    case "device_not_trusted":
      return { reason: "not_trusted" };
    case "device_locked":
      return { reason: "locked" };
    case "helper_missing":
      return { reason: "capture_helper_missing" };
    default:
      return { reason: "capture_failed", detail: error.detail };
  }
};

const ffmpegIssue = (error: FfmpegCaptureError): DeviceIssue =>
  error.reason === "ffmpeg_missing"
    ? { reason: "ffmpeg_missing", detail: error.detail }
    : { reason: "capture_failed", detail: error.detail };

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const decodePathSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

interface Entry {
  readonly session: Deferred.Deferred<MacVideoCaptureSession, DeviceNotReadyError>;
  viewers: number;
  linger: Fiber.Fiber<void> | undefined;
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const mac = yield* MacVideoCapture;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const endedPubSub = yield* PubSub.unbounded<string>();

  const label = yield* Effect.cached(
    resolveServerEnvironmentLabel({ cwdBaseName: path.basename(config.cwd).trim() }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.orElseSucceed(() => "This computer"),
    ),
  );
  /** The devices of the last listing, so a stream request can start the one it names. */
  let known = new Map<string, HostDevice>();
  /** What the last failed start said, shown on the device until a start succeeds. */
  const failures = new Map<string, DeviceIssue>();
  const entries = new Map<string, Entry>();
  const running = new Set<MacVideoCaptureSession>();
  const ffmpeg = environment.SERVE_EMU_FFMPEG?.trim() || "ffmpeg";
  const wayland =
    platform === "linux" &&
    (environment.XDG_SESSION_TYPE === "wayland" ||
      (environment.WAYLAND_DISPLAY !== undefined && environment.DISPLAY === undefined));

  const ffmpegIssues = Effect.gen(function* () {
    if (wayland) return [{ reason: "wayland_unsupported" as const }];
    const encoders = yield* runner
      .run({
        command: ffmpeg,
        args: ["-hide_banner", "-encoders"],
        timeout: Duration.seconds(10),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    const output =
      encoders._tag === "Some" ? `${encoders.value.stdout}\n${encoders.value.stderr}` : "";
    return /^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(output)
      ? []
      : [{ reason: "ffmpeg_missing" as const }];
  });

  /** Null when devicectl cannot run at all, which means Xcode is missing. */
  const readDevicectl = Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.makeTempFileScoped({ prefix: "t3-devicectl-", suffix: ".json" });
      const result = yield* runner
        .run({
          command: "xcrun",
          args: [
            "devicectl",
            "list",
            "devices",
            "--quiet",
            "--timeout",
            "10",
            "--json-output",
            file,
          ],
          timeout: Duration.seconds(20),
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (
        result._tag === "None" ||
        /unable to find utility|not a developer tool/i.test(result.value.stderr)
      )
        return null;
      const json = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      return parseDevicectl(json) ?? [];
    }),
  ).pipe(Effect.orElseSucceed(() => []));

  const desktop = (issues: ReadonlyArray<DeviceIssue>) =>
    Effect.map(label, (name): HostDevice => ({
      id: DESKTOP_DEVICE_ID,
      platform: "desktop",
      name: `${name} (desktop)`,
      version: PLATFORM_NAMES[platform] ?? platform,
      booted: true,
      physical: true,
      ...(issues.length > 0 ? { issues } : {}),
    }));

  const list: CaptureDevices["Service"]["list"] = Effect.gen(function* () {
    const teamId = yield* settings.getSettings.pipe(
      Effect.map((value) => value.appleTeamId.trim()),
      Effect.orElseSucceed(() => ""),
    );
    let devices: ReadonlyArray<HostDevice> = [];
    if (platform === "darwin") {
      const [helper, devicectl] = yield* Effect.all([mac.list.pipe(Effect.result), readDevicectl], {
        concurrency: 2,
      });
      const helperIssue = helper._tag === "Failure" ? macIssue(helper.failure) : undefined;
      const listing = helper._tag === "Success" ? helper.success : null;
      devices = [
        yield* desktop([
          ...(helperIssue ? [helperIssue] : []),
          ...(listing?.permissions.screenRecording === "denied"
            ? [{ reason: "screen_recording_permission" as const }]
            : []),
          ...(listing && !listing.displayCaptureSupported
            ? [
                {
                  reason: "capture_failed" as const,
                  detail: "Desktop video needs macOS 14 or later.",
                },
              ]
            : []),
        ]),
        ...listIphones({
          devicectl,
          helper: listing,
          helperIssue,
          signingReady: isAppleTeamId(teamId),
        }),
      ];
    } else if (platform === "win32" || platform === "linux") {
      devices = [yield* desktop(yield* ffmpegIssues)];
    }
    const listed = devices.map((device) => {
      const failure = failures.get(device.id);
      return failure && !device.issues?.some((issue) => issue.reason === failure.reason)
        ? { ...device, issues: [...(device.issues ?? []), failure] }
        : device;
    });
    known = new Map(listed.map((device) => [device.id, device]));
    return listed;
  }).pipe(Effect.withSpan("CaptureDevices.list"));

  const capture = (device: HostDevice) => {
    const fail = (issue: DeviceIssue) =>
      new DeviceNotReadyError({
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: device.id as DeviceId,
        deviceName: device.name,
        ...issue,
      });
    if (device.platform === "ios")
      return mac
        .start({ deviceId: device.id, source: { kind: "iphone", udid: device.id } })
        .pipe(Effect.mapError((error) => fail(macIssue(error))));
    if (platform === "darwin")
      return mac
        .start({
          deviceId: device.id,
          source: { kind: "display" },
          fps: DESKTOP_FPS,
          maxDimension: MAX_DIMENSION,
        })
        .pipe(Effect.mapError((error) => fail(macIssue(error))));
    if (wayland || (platform !== "win32" && platform !== "linux"))
      return Effect.fail(fail({ reason: "wayland_unsupported" }));
    return startFfmpegDesktop({
      deviceId: device.id,
      ffmpeg,
      args: ffmpegDesktopArguments({
        platform,
        display: environment.DISPLAY,
        fps: DESKTOP_FPS,
        maxDimension: MAX_DIMENSION,
      }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((error) => fail(ffmpegIssue(error))),
    );
  };

  const stopSession = (entry: Entry) =>
    Deferred.await(entry.session).pipe(
      Effect.flatMap((session) => {
        running.delete(session);
        return session.stop;
      }),
      Effect.ignore,
    );

  const evict = (deviceId: string, entry: Entry) =>
    Effect.suspend(() => {
      if (entries.get(deviceId) !== entry) return Effect.void;
      entries.delete(deviceId);
      const linger = entry.linger;
      entry.linger = undefined;
      return (linger ? Fiber.interrupt(linger) : Effect.void).pipe(
        Effect.andThen(stopSession(entry)),
      );
    });

  const armLinger = (deviceId: string, entry: Entry) =>
    Effect.suspend(() => {
      if (entry.viewers > 0 || entry.linger) return Effect.void;
      return Effect.sleep(CAPTURE_LINGER).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            entry.linger = undefined;
            return entry.viewers === 0 ? evict(deviceId, entry) : Effect.void;
          }),
        ),
        Effect.forkIn(scope),
        Effect.map((fiber) => {
          entry.linger = fiber;
        }),
      );
    });

  const cancelLinger = (entry: Entry) =>
    Effect.suspend(() => {
      const linger = entry.linger;
      entry.linger = undefined;
      return linger ? Fiber.interrupt(linger) : Effect.void;
    });

  /** The device's entry, starting its capture when none runs. Concurrent callers share one start. */
  const acquire = (device: HostDevice) =>
    Effect.suspend(() => {
      const existing = entries.get(device.id);
      if (existing) return Effect.succeed(existing);
      const entry: Entry = { session: Deferred.makeUnsafe(), viewers: 0, linger: undefined };
      entries.set(device.id, entry);
      return capture(device).pipe(
        Effect.tap((session) =>
          Effect.suspend(() => {
            running.add(session);
            failures.delete(device.id);
            return session.ended.pipe(
              Effect.flatMap((reason) =>
                entries.get(device.id) === entry
                  ? Effect.sync(() => {
                      entries.delete(device.id);
                      running.delete(session);
                    }).pipe(
                      Effect.andThen(cancelLinger(entry)),
                      Effect.andThen(
                        reason === "stopped" ? Effect.void : PubSub.publish(endedPubSub, device.id),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.forkIn(scope),
            );
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (entries.get(device.id) === entry) entries.delete(device.id);
            failures.set(device.id, {
              reason: error.reason,
              ...(error.detail ? { detail: error.detail } : {}),
            });
          }),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(entry.session, exit)),
        Effect.forkIn(scope),
        Effect.as(entry),
      );
    });

  const start: CaptureDevices["Service"]["start"] = Effect.fn("CaptureDevices.start")(
    function* (device) {
      const entry = yield* acquire(device);
      yield* Deferred.await(entry.session);
      yield* armLinger(device.id, entry);
    },
  );

  // Runs for every proxied device request, so it adds no span of its own.
  const route: CaptureDevices["Service"]["route"] = Effect.fnUntraced(function* (hubPath, search) {
    const match = CAPTURE_ROUTE.exec(hubPath);
    const deviceId = match ? decodePathSegment(match[1]!) : null;
    if (!match || deviceId === null) return null;
    const device = known.get(deviceId);
    const current = entries.get(deviceId);
    if (!device && !current) return null;
    const streaming = match[2] === "stream.avcc";
    const entry = streaming && device ? yield* acquire(device) : current;
    if (!entry) return "unavailable" as const;
    const session = yield* Deferred.await(entry.session).pipe(Effect.option);
    if (session._tag === "None") return "unavailable" as const;
    const upstream = yield* session.value.upstream(hubPath, search);
    if (!upstream) return "unavailable" as const;
    if (!streaming) return { url: upstream.url, release: Effect.void };
    entry.viewers++;
    yield* cancelLinger(entry);
    return {
      url: upstream.url,
      release: Effect.suspend(() => {
        entry.viewers = Math.max(0, entry.viewers - 1);
        return armLinger(deviceId, entry);
      }),
    };
  });

  const stop: CaptureDevices["Service"]["stop"] = (deviceId) =>
    Effect.suspend(() => {
      const entry = entries.get(deviceId);
      return entry ? evict(deviceId, entry) : Effect.void;
    });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...running], (session) => session.stop, { discard: true }),
  );

  return CaptureDevices.of({
    list,
    start,
    route,
    stop,
    ended: PubSub.subscribe(endedPubSub),
  });
});

export const layer = Layer.effect(CaptureDevices, make);
