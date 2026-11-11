// @effect-diagnostics nodeBuiltinImport:off - the fake devicectl writes its JSON file like the real one.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { HostDevice } from "./DeviceHost.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CAPTURE_LINGER, CaptureDevices, layer, macIssue } from "./CaptureDevices.ts";
import {
  MacVideoCapture,
  MacVideoCaptureError,
  type MacVideoCaptureList,
  type MacVideoCaptureSession,
} from "./MacVideoCapture.ts";

const output = (stdout = "", stderr = "", code = 0): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const usbPhone = {
  hardwareProperties: { udid: "00008030-001C", platform: "iOS", reality: "physical" },
  deviceProperties: { name: "Ana's iPhone", osVersionNumber: "26.1" },
  connectionProperties: { pairingState: "paired", transportType: "wired" },
};

const helperList = (overrides: Partial<MacVideoCaptureList> = {}): MacVideoCaptureList => ({
  iphones: [],
  displays: [],
  permissions: { camera: "granted", screenRecording: "granted" },
  displayCaptureSupported: true,
  ...overrides,
});

interface FakeSession {
  readonly source: string;
  readonly ended: Deferred.Deferred<string>;
  stops: number;
}

interface Options {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly teamId?: string;
  readonly helper?: Effect.Effect<MacVideoCaptureList, MacVideoCaptureError>;
  /** Null: devicectl is missing, as without Xcode. */
  readonly devicectl?: ReadonlyArray<unknown> | null;
  readonly encoders?: string;
}

const harness = (options: Options = {}) => {
  const sessions: Array<FakeSession> = [];
  const startFailures: Array<MacVideoCaptureError> = [];
  const mac = MacVideoCapture.of({
    list: options.helper ?? Effect.succeed(helperList()),
    start: (input) =>
      Effect.suspend(() => {
        const failure = startFailures.shift();
        if (failure) return Effect.fail(failure);
        const ended = Deferred.makeUnsafe<string>();
        const fake: FakeSession = {
          source: input.source.kind === "iphone" ? input.source.udid : "display",
          ended,
          stops: 0,
        };
        sessions.push(fake);
        const session: MacVideoCaptureSession = {
          pid: 900 + sessions.length,
          origin: `http://127.0.0.1:${9000 + sessions.length}`,
          width: 1920,
          height: 1080,
          upstream: (hubPath) =>
            Effect.succeed(
              hubPath.includes(`/${input.deviceId}/`)
                ? {
                    url: `http://127.0.0.1:${9000 + sessions.indexOf(fake) + 1}/${hubPath.split("/").at(-1)}`,
                    headers: {},
                    protocols: [],
                  }
                : null,
            ),
          ended: Deferred.await(ended),
          stop: Effect.suspend(() => {
            fake.stops++;
            return Deferred.succeed(ended, "stopped");
          }),
        };
        return Effect.succeed(session);
      }),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        if (input.command === "scutil") return output("Ana's Mac\n");
        if (input.command === "xcrun") {
          if (options.devicectl === null) return output("", "xcrun: error: unable to find utility");
          const file = input.args[input.args.indexOf("--json-output") + 1]!;
          NodeFS.writeFileSync(
            file,
            JSON.stringify({ result: { devices: options.devicectl ?? [usbPhone] } }),
          );
          return output();
        }
        if (input.args.includes("-encoders")) return output(options.encoders ?? "");
        return output("", "", 1);
      }),
  });
  const spawner = ChildProcessSpawner.make(() =>
    Effect.fail(
      new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(MacVideoCapture, mac),
    Layer.succeed(ProcessRunner.ProcessRunner, runner),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ServerSettings.ServerSettingsService.layerTest({ appleTeamId: options.teamId ?? "ABCDE12345" }),
    ServerConfig.layerTest("/work/t3", { prefix: "t3-capture-devices-" }),
    Layer.succeed(HostProcess.Platform, options.platform ?? "darwin"),
    Layer.succeed(HostProcess.Environment, options.environment ?? {}),
    Layer.succeed(HostProcess.Hostname, "ana-mac"),
  );
  return {
    sessions,
    startFailures,
    layer: layer.pipe(Layer.provide(dependencies), Layer.provide(NodeServices.layer)),
  };
};

const issues = (device: HostDevice) => (device.issues ?? []).map((issue) => issue.reason);

const stream = (deviceId: string) => `/vendor/serve-sim/helper/${deviceId}/stream.avcc`;

describe("CaptureDevices.list", () => {
  it.effect("lists this Mac and its USB iPhones with the issues their sources prove", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.gen(function* () {
        return yield* (yield* CaptureDevices).list;
      }).pipe(Effect.provide(harness({ teamId: "" }).layer));
      expect(listed).toEqual([
        {
          id: "desktop",
          platform: "desktop",
          name: "Ana's Mac (desktop)",
          version: "macOS",
          booted: true,
          physical: true,
        },
        {
          id: "00008030-001C",
          platform: "ios",
          name: "Ana's iPhone",
          version: "iOS 26.1",
          booted: true,
          physical: true,
          connection: "usb",
          issues: [{ reason: "signing_missing" }],
        },
      ]);
    }),
  );

  it.effect.each([
    [
      "Screen Recording denied, an old macOS",
      {
        helper: Effect.succeed(
          helperList({
            permissions: { camera: "granted", screenRecording: "denied" },
            displayCaptureSupported: false,
          }),
        ),
        devicectl: [],
      },
      [["screen_recording_permission", "capture_failed"]],
    ],
    [
      "no helper and no Xcode",
      {
        helper: Effect.fail(
          new MacVideoCaptureError({ code: "helper_missing", detail: "Not built." }),
        ),
        devicectl: null,
      },
      [["capture_helper_missing"]],
    ],
    [
      "Xcode missing, phone seen by the helper",
      {
        helper: Effect.succeed(
          helperList({ iphones: [{ udid: "00008030001c", name: "iPhone", model: "iPhone17,1" }] }),
        ),
        devicectl: null,
      },
      [[], ["xcode_missing"]],
    ],
    ["Linux with libx264", { platform: "linux", encoders: " V....D libx264  H.264" }, [[]]],
    ["Windows without ffmpeg", { platform: "win32" }, [["ffmpeg_missing"]]],
    [
      "Linux on Wayland",
      { platform: "linux", environment: { XDG_SESSION_TYPE: "wayland" } },
      [["wayland_unsupported"]],
    ],
    ["another platform", { platform: "freebsd" }, []],
  ] as const)("%s", ([, options, expected]) =>
    Effect.gen(function* () {
      const listed = yield* (yield* CaptureDevices).list;
      expect(listed.map(issues)).toEqual(expected);
    }).pipe(Effect.provide(harness(options as Options).layer)),
  );
});

describe("CaptureDevices capture lifecycle", () => {
  it.effect("shares one capture between viewers and stops it a while after the last leaves", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      const captures = yield* CaptureDevices;
      const [desktop, phone] = yield* captures.list;
      yield* Effect.all([captures.start(desktop!), captures.start(desktop!)], {
        concurrency: 2,
      });
      expect(fixture.sessions.map((session) => session.source)).toEqual(["display"]);

      const viewer = yield* captures.route(stream("desktop"), new URLSearchParams());
      expect(viewer).toMatchObject({ url: "http://127.0.0.1:9001/stream.avcc" });
      const config = yield* captures.route(
        "/vendor/serve-sim/helper/desktop/config",
        new URLSearchParams(),
      );
      expect(config).toMatchObject({ url: "http://127.0.0.1:9001/config" });
      expect(yield* captures.route("/api/devices", new URLSearchParams())).toBeNull();
      expect(yield* captures.route(stream("emulator-5554"), new URLSearchParams())).toBeNull();
      expect(yield* captures.route(stream("%E0%A4%A"), new URLSearchParams())).toBeNull();

      // A viewer keeps it alive past the linger; leaving starts the countdown.
      yield* TestClock.adjust(Duration.sum(CAPTURE_LINGER, Duration.seconds(5)));
      expect(fixture.sessions[0]!.stops).toBe(0);
      if (viewer === null || viewer === "unavailable") return expect.unreachable();
      yield* viewer.release;
      yield* TestClock.adjust(Duration.subtract(CAPTURE_LINGER, Duration.seconds(1)));
      expect(fixture.sessions[0]!.stops).toBe(0);
      yield* TestClock.adjust(Duration.seconds(1));
      expect(fixture.sessions[0]!.stops).toBe(1);

      // A stream request starts a listed device on demand; stop ends it whoever watches.
      const phoneViewer = yield* captures.route(stream(phone!.id), new URLSearchParams());
      expect(phoneViewer).toMatchObject({ url: "http://127.0.0.1:9002/stream.avcc" });
      expect(fixture.sessions[1]!.source).toBe("00008030-001C");
      yield* captures.stop(phone!.id);
      yield* captures.stop(phone!.id);
      expect(fixture.sessions[1]!.stops).toBe(1);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("tells subscribers when a capture ends on its own, and starts afresh after", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      const captures = yield* CaptureDevices;
      const ended = yield* captures.ended;
      const [, phone] = yield* captures.list;
      yield* captures.start(phone!);
      yield* Deferred.succeed(fixture.sessions[0]!.ended, "device_disconnected");
      expect(yield* PubSub.take(ended)).toBe(phone!.id);
      yield* captures.start(phone!);
      expect(fixture.sessions).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(fixture.layer));
  });

  it.effect("shows a failed start on the device until a start succeeds, never caching it", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      const captures = yield* CaptureDevices;
      const [, phone] = yield* captures.list;
      fixture.startFailures.push(
        new MacVideoCaptureError({ code: "device_locked", detail: "Unlock the iPhone." }),
      );
      const error = yield* captures.start(phone!).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceNotReadyError",
        deviceId: "00008030-001C",
        deviceName: "Ana's iPhone",
        reason: "locked",
      });
      expect((yield* captures.list).map(issues)).toEqual([[], ["locked"]]);

      fixture.startFailures.push(
        new MacVideoCaptureError({ code: "device_locked", detail: "Unlock the iPhone." }),
      );
      expect(yield* captures.route(stream(phone!.id), new URLSearchParams())).toBe("unavailable");
      expect(
        yield* captures.route(
          `/vendor/serve-sim/helper/${phone!.id}/config`,
          new URLSearchParams(),
        ),
      ).toBe("unavailable");

      yield* captures.start(phone!);
      expect((yield* captures.list).map(issues)).toEqual([[], []]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("names ffmpeg's absence and Wayland when a Linux desktop cannot start", () =>
    Effect.gen(function* () {
      const linux = harness({ platform: "linux", encoders: " V....D libx264  H.264" });
      const missing = yield* Effect.gen(function* () {
        const captures = yield* CaptureDevices;
        const [desktop] = yield* captures.list;
        const error = yield* captures.start(desktop!).pipe(Effect.flip);
        return [error.reason, (yield* captures.list).map(issues)];
      }).pipe(Effect.provide(linux.layer));
      expect(missing).toEqual(["ffmpeg_missing", [["ffmpeg_missing"]]]);

      const wayland = harness({ platform: "linux", environment: { WAYLAND_DISPLAY: "wayland-0" } });
      const reason = yield* Effect.gen(function* () {
        const captures = yield* CaptureDevices;
        const [desktop] = yield* captures.list;
        return (yield* captures.start(desktop!).pipe(Effect.flip)).reason;
      }).pipe(Effect.provide(wayland.layer));
      expect(reason).toBe("wayland_unsupported");
    }),
  );

  it.effect("stops every running capture when the server shuts down", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(fixture.layer, scope);
      const captures = Context.get(context, CaptureDevices);
      for (const device of yield* captures.list) yield* captures.start(device);
      yield* Scope.close(scope, Exit.void);
      expect(fixture.sessions.map((session) => session.stops)).toEqual([1, 1]);
    });
  });
});

describe("macIssue", () => {
  it.each([
    [{ code: "permission_missing", permission: "camera" }, "camera_permission"],
    [{ code: "permission_missing", permission: "screen-recording" }, "screen_recording_permission"],
    [{ code: "device_not_trusted" }, "not_trusted"],
    [{ code: "device_locked" }, "locked"],
    [{ code: "helper_missing" }, "capture_helper_missing"],
    [{ code: "device_not_found" }, "capture_failed"],
  ] as const)("%j is %s", (fields, reason) => {
    expect(
      macIssue(new MacVideoCaptureError({ detail: "Said the helper.", ...fields })).reason,
    ).toBe(reason);
  });
});
