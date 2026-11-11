import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DESKTOP_DEVICE_ID,
  DeviceId,
  DeviceNotReadyError,
  LOCAL_DEVICE_HOST_ID,
  ThreadId,
  type DeviceIssue,
  type DeviceSession,
  type DeviceSummary,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import * as CaptureDevices from "./CaptureDevices.ts";
import * as DeviceHost from "./DeviceHost.ts";
import type { HostDevice } from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

const thread = ThreadId.make("thread-1");
const IPHONE = DeviceId.make("iphone-1");
const iphone = (issues?: ReadonlyArray<DeviceIssue>): HostDevice => ({
  id: IPHONE,
  name: "Test iPhone",
  version: "iOS 26.3",
  platform: "ios",
  booted: true,
  physical: true,
  ...(issues ? { issues } : {}),
});
const desktop: HostDevice = {
  id: DESKTOP_DEVICE_ID,
  name: "This computer",
  version: "macOS",
  platform: "desktop",
  booted: true,
  physical: true,
};
const agent = { ask: () => Effect.succeed("allowed" as const) };
const VALID_TEAM = "ABCDE12345";

const harness = Effect.fn("harness")(function* (initial: ReadonlyArray<HostDevice>) {
  const settings = yield* Ref.make({ ...DEFAULT_SERVER_SETTINGS, enableDeviceSupport: true });
  const listing = yield* Ref.make(initial);
  const startFailure = yield* Ref.make<DeviceNotReadyError | undefined>(undefined);
  const calls: string[] = [];
  const listed = yield* Queue.unbounded<void>();
  const ended = yield* PubSub.unbounded<string>();
  const routes: string[] = [];
  const captures = CaptureDevices.CaptureDevices.of({
    list: Ref.get(listing).pipe(Effect.tap(() => Queue.offer(listed, undefined))),
    start: (device) =>
      Effect.gen(function* () {
        calls.push(`start:${device.id}`);
        const failure = yield* Ref.get(startFailure);
        if (failure) return yield* failure;
      }),
    route: (hubPath) =>
      Effect.sync(() => {
        routes.push(hubPath);
        return "unavailable" as const;
      }),
    stop: (id) =>
      Effect.sync(() => {
        calls.push(`stop:${id}`);
      }),
    ended: PubSub.subscribe(ended),
  });
  const hubDevices = yield* Ref.make<ReadonlyArray<HostDevice>>([]);
  const ready = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    devices: {
      list: Effect.gen(function* () {
        return {
          devices: yield* Ref.get(hubDevices),
          androidDiscoveryIncomplete: false,
          incompletePlatforms: [],
        };
      }),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
  } as unknown as DeviceHost.DeviceHostReady;
  const host: DeviceHost.DeviceHost["Service"] = {
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local" as const,
      label: "Test server",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.die("Capture devices never start the agent daemon"),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
  const service = yield* DeviceService.makeWithHosts(
    new Map([[host.id, host]]),
    undefined,
    undefined,
    undefined,
    undefined,
    captures,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(
          ServerSettings.ServerSettingsService,
          ServerSettings.ServerSettingsService.of({
            updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
            withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
            start: Effect.void,
            ready: Effect.void,
            getSettings: Ref.get(settings),
            updateSettings: (patch) =>
              Ref.updateAndGet(settings, (current) => ({
                ...current,
                enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
              })),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        ),
      ),
    ),
  );
  return { service, settings, listing, startFailure, calls, listed, ended, routes, hubDevices };
});

const open = (deviceId: DeviceId, platform: "ios" | "desktop") => ({
  threadId: thread,
  deviceId,
  platform,
});
const localDevices = (state: { readonly devices: ReadonlyArray<DeviceSummary> }) =>
  state.devices.map((device) => `${device.hostId}:${device.id}:${device.platform}`);

describe("DeviceService capture devices", () => {
  it.effect("lists capture devices as local and drops the hub's duplicates of them", () =>
    Effect.gen(function* () {
      const { service, hubDevices } = yield* harness([desktop, iphone()]);
      const simulator: HostDevice = { ...iphone(), id: DeviceId.make("sim-1"), physical: false };
      yield* Ref.set(hubDevices, [iphone(), { ...desktop }, simulator]);
      const state = yield* service.list;
      expect(localDevices(state).toSorted()).toEqual([
        "local:desktop:desktop",
        "local:iphone-1:ios",
        "local:sim-1:ios",
      ]);
    }),
  );

  it.effect("starts capture when the user opens, and stops it with the last session", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness([iphone()]);
      yield* service.list;
      const second = ThreadId.make("thread-2");
      const session: DeviceSession = yield* service.open(open(IPHONE, "ios"));
      yield* service.open({ ...open(IPHONE, "ios"), threadId: second });
      expect(session).toMatchObject({ hostId: LOCAL_DEVICE_HOST_ID, deviceId: IPHONE });
      expect(calls).toEqual(["start:iphone-1", "start:iphone-1"]);
      yield* service.close({ threadId: thread, deviceId: IPHONE });
      expect(calls).not.toContain("stop:iphone-1");
      yield* service.close({ threadId: second, deviceId: IPHONE });
      expect(calls.at(-1)).toBe("stop:iphone-1");
      expect((yield* service.state).sessions).toEqual([]);
    }),
  );

  it.effect("opens a capture device that was not listed yet by refreshing captures", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness([desktop]);
      const session = yield* service.open(open(DESKTOP_DEVICE_ID, "desktop"));
      expect(session.platform).toBe("desktop");
      expect(calls).toEqual(["start:desktop"]);
    }),
  );

  it.effect(
    "fails an unknown desktop and a failed start, refreshing captures after a failure",
    () =>
      Effect.gen(function* () {
        const { service, startFailure, listing, listed } = yield* harness([iphone()]);
        yield* service.list;
        yield* Queue.take(listed);
        const missing = yield* service.open(open(DESKTOP_DEVICE_ID, "desktop")).pipe(Effect.flip);
        expect(missing._tag).toBe("DeviceNotFoundError");
        yield* Queue.takeAll(listed);

        const failure = new DeviceNotReadyError({
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: IPHONE,
          reason: "locked",
        });
        yield* Ref.set(startFailure, failure);
        yield* Ref.set(listing, [iphone([{ reason: "locked" }])]);
        const error = yield* service.open(open(IPHONE, "ios")).pipe(Effect.flip);
        expect(error).toBe(failure);
        yield* Queue.take(listed);
        const state = yield* service.state;
        expect(state.devices[0]?.issues).toEqual([{ reason: "locked" }]);
        expect(state.sessions).toEqual([]);
      }),
  );

  it.effect("refuses a capture open when device support is off", () =>
    Effect.gen(function* () {
      const { service, settings, calls } = yield* harness([desktop, iphone()]);
      yield* service.list;
      yield* service.open(open(IPHONE, "ios"));
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: false }));
      const refused = yield* service.open(open(IPHONE, "ios")).pipe(Effect.flip);
      expect(refused._tag).toBe("DeviceHostUnavailableError");
      expect(calls).toEqual(["start:iphone-1"]);
    }),
  );

  describe("agents", () => {
    it.effect("never get the desktop through device tools", () =>
      Effect.gen(function* () {
        const { service, calls } = yield* harness([desktop]);
        yield* service.list;
        const error = yield* service
          .open(open(DESKTOP_DEVICE_ID, "desktop"), { agent })
          .pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "DeviceActionUnavailableError",
          platform: "desktop",
          reason: "capture_device",
        });
        expect(calls).toEqual([]);
      }),
    );

    it.effect("open an iPhone without starting video once signing is set", () =>
      Effect.gen(function* () {
        const { service, settings, calls } = yield* harness([iphone()]);
        yield* service.list;
        const blocked = yield* service.open(open(IPHONE, "ios"), { agent }).pipe(Effect.flip);
        expect(blocked).toMatchObject({ _tag: "DeviceNotReadyError", reason: "signing_missing" });
        yield* Ref.update(settings, (current) => ({ ...current, appleTeamId: ` ${VALID_TEAM} ` }));
        const session = yield* service.open(open(IPHONE, "ios"), { agent });
        expect(session.deviceId).toBe(IPHONE);
        expect(calls).toEqual([]);
      }),
    );

    const authorize = (issues: ReadonlyArray<DeviceIssue>, appleTeamId: string) =>
      Effect.gen(function* () {
        const { service, settings } = yield* harness([iphone(issues)]);
        yield* service.list;
        yield* Ref.update(settings, (current) => ({ ...current, appleTeamId }));
        return yield* service
          .authorizeAgent({
            threadId: thread,
            hostId: LOCAL_DEVICE_HOST_ID,
            deviceId: IPHONE,
            intent: "open",
            agent,
          })
          .pipe(Effect.result);
      });

    it.effect.each([
      { name: "a missing team id", issues: [], team: "", blocked: "signing_missing" },
      { name: "a lowercase team id", issues: [], team: "abcde12345", blocked: "signing_missing" },
      { name: "a short team id", issues: [], team: "ABCDE1234", blocked: "signing_missing" },
      { name: "a stale signing issue", issues: [{ reason: "signing_missing" }], team: VALID_TEAM },
      {
        name: "a locked phone",
        issues: [{ reason: "locked" }],
        team: VALID_TEAM,
        blocked: "locked",
      },
      {
        name: "developer mode off",
        issues: [{ reason: "developer_mode_off" }],
        team: VALID_TEAM,
        blocked: "developer_mode_off",
      },
      {
        name: "no Xcode",
        issues: [{ reason: "xcode_missing" }],
        team: VALID_TEAM,
        blocked: "xcode_missing",
      },
      {
        name: "an unpaired phone",
        issues: [{ reason: "not_paired" }],
        team: VALID_TEAM,
        blocked: "not_paired",
      },
      {
        name: "an untrusted computer",
        issues: [{ reason: "not_trusted" }],
        team: VALID_TEAM,
        blocked: "not_trusted",
      },
      {
        name: "a view-only camera permission issue",
        issues: [{ reason: "camera_permission" }],
        team: VALID_TEAM,
      },
    ] satisfies ReadonlyArray<{
      name: string;
      issues: ReadonlyArray<DeviceIssue>;
      team: string;
      blocked?: string;
    }>)("authorizes control with $name", ({ issues, team, blocked }) =>
      Effect.gen(function* () {
        const result = yield* authorize(issues, team);
        if (blocked) {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "DeviceNotReadyError", reason: blocked },
          });
        } else {
          expect(result._tag).toBe("Success");
        }
      }),
    );

    it.effect("ask before the desktop and respect a hold with device support off", () =>
      Effect.gen(function* () {
        const { service, settings } = yield* harness([desktop]);
        yield* service.list;
        yield* service.setHold({ deviceId: DESKTOP_DEVICE_ID, held: true });
        yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: false }));
        const authorizeDesktop = (caller?: typeof agent) =>
          service
            .authorizeAgent({
              threadId: thread,
              hostId: LOCAL_DEVICE_HOST_ID,
              deviceId: DESKTOP_DEVICE_ID,
              intent: "open",
              ...(caller ? { agent: caller } : {}),
            })
            .pipe(Effect.flip);
        expect((yield* authorizeDesktop())._tag).toBe("DeviceAccessPendingError");
        expect((yield* authorizeDesktop(agent))._tag).toBe("DeviceHeldError");
      }),
    );
  });

  it.effect("refuses screenshots and settings on capture devices", () =>
    Effect.gen(function* () {
      const { service } = yield* harness([desktop, iphone()]);
      yield* service.list;
      const results = yield* Effect.all([
        service.screenshot({ deviceId: IPHONE }).pipe(Effect.flip),
        service.detail({ deviceId: DESKTOP_DEVICE_ID }).pipe(Effect.flip),
        service
          .action({ deviceId: IPHONE, action: "appearance", value: "dark" } as never)
          .pipe(Effect.flip),
      ]);
      expect(results).toMatchObject([
        { _tag: "DeviceActionUnavailableError", operation: "screenshot", platform: "ios" },
        { _tag: "DeviceActionUnavailableError", operation: "settings", platform: "desktop" },
        { _tag: "DeviceActionUnavailableError", operation: "settings", reason: "capture_device" },
      ]);
    }),
  );

  it.effect("routes capture paths for the local host only", () =>
    Effect.gen(function* () {
      const { service, routes } = yield* harness([iphone()]);
      const search = new URLSearchParams();
      expect(yield* service.captureRoute(undefined, "/stream.mjpeg", search)).toBe("unavailable");
      expect(yield* service.captureRoute(LOCAL_DEVICE_HOST_ID, "/config", search)).toBe(
        "unavailable",
      );
      expect(yield* service.captureRoute("mac-mini" as never, "/config", search)).toBeNull();
      expect(routes).toEqual(["/stream.mjpeg", "/config"]);
    }),
  );

  it.effect("lists again when a capture ends on its own", () =>
    Effect.gen(function* () {
      const { service, listing, listed, ended } = yield* harness([iphone()]);
      yield* service.list;
      yield* Queue.take(listed);
      yield* Ref.set(listing, []);
      yield* PubSub.publish(ended, IPHONE);
      yield* Queue.take(listed);
      expect(localDevices(yield* service.state)).toEqual([]);
    }),
  );

  it.effect("stops running captures when device support is turned off", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness([desktop, iphone()]);
      yield* service.list;
      const state = yield* service.configure({ enabled: false });
      expect(calls.toSorted()).toEqual(["stop:desktop", "stop:iphone-1"]);
      expect(state.devices).toEqual([]);
    }),
  );
});
