import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  defaultDeviceAccessPolicy,
  deviceAccessKey,
  deviceAccessPolicy,
  DeviceActionUnavailableError,
  DeviceBootError,
  DeviceError,
  DeviceHeldError,
  DeviceInUseError,
  deviceIssueBlocks,
  DeviceNotReadyError,
  DeviceServiceState,
  isCaptureDevice,
  findDeviceHold,
  storedDeviceAccessPolicy,
  EasDeviceHostConfig,
  SimlockDeviceHostConfig,
  EasDeviceHostConfigs,
  SshDeviceHostConfigs,
} from "./device.ts";
import {
  AppleBundleIdInput,
  AppleTeamIdInput,
  isAppleTeamId,
  secretSettingsFields,
  ServerSettings,
} from "./settings.ts";
import { ThreadId } from "./baseSchemas.ts";

const decodeSshHosts = Schema.decodeUnknownSync(SshDeviceHostConfigs);
const decodeEas = Schema.decodeUnknownSync(EasDeviceHostConfigs);
const encodeState = Schema.encodeSync(DeviceServiceState);
const encodeError = Schema.encodeSync(DeviceError);
const decodeState = Schema.decodeUnknownSync(DeviceServiceState);
// Devices and sessions as clients decoded them before desktops existed.
const decodeStateBeforeDesktops = Schema.decodeUnknownSync(
  Schema.Struct({
    devices: Schema.Array(
      Schema.Struct({ id: Schema.String, platform: Schema.Literals(["ios", "android"]) }),
    ),
    sessions: Schema.Array(
      Schema.Struct({ deviceId: Schema.String, platform: Schema.Literals(["ios", "android"]) }),
    ),
  }),
);
const decodeTeamId = Schema.decodeUnknownExit(AppleTeamIdInput);
const decodeBundleId = Schema.decodeUnknownExit(AppleBundleIdInput);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeError = Schema.decodeUnknownSync(DeviceError);
// The host summary as clients decoded it before EAS hosts existed.
const decodeOlderState = Schema.decodeUnknownSync(
  Schema.Struct({
    hosts: Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.Literals(["local", "ssh"]) }),
    ),
  }),
);

describe("configured device hosts", () => {
  it("reads SSH hosts saved before hosts had a kind, and bounds EAS sessions", () => {
    expect(decodeSshHosts([{ id: "mac", label: "Mac mini", target: "julius@mac" }])).toEqual([
      { kind: "ssh", id: "mac", label: "Mac mini", target: "julius@mac" },
    ]);
    expect(decodeEas([{ kind: "eas", id: "eas", label: "EAS Simulator" }])).toEqual([
      {
        kind: "eas",
        id: "eas",
        label: "EAS Simulator",
        accessToken: "",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ]);
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 600 }]),
    ).toThrow();
    // The default idle limit of 10 is not smaller than a session limit of 10.
    expect(() =>
      decodeEas([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 10 }]),
    ).toThrow();
  });

  it("marks the EAS access token as a secret setting", () => {
    expect(secretSettingsFields(EasDeviceHostConfig)).toEqual(["accessToken"]);
    expect(secretSettingsFields(SimlockDeviceHostConfig)).toEqual(["agentToken"]);
  });
});

describe("device state for clients from before EAS hosts", () => {
  const summary = {
    label: "Host",
    platforms: [],
    hubInstalled: true,
    agentDeviceInstalled: true,
  };
  const state = {
    hosts: [
      { ...summary, id: "local", kind: "local" as const },
      { ...summary, id: "eas", kind: "eas" as const },
      { ...summary, id: "pool", kind: "simlock" as const },
    ],
    hostStatus: "ready" as const,
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };

  it("sends EAS and Simlock hosts where an older client does not look, and reads them back", () => {
    const wire = encodeState(state);
    expect(decodeOlderState(wire).hosts.map((host) => host.id)).toEqual(["local"]);
    expect(decodeState(wire).hosts).toEqual(state.hosts);
  });
  it("sends desktops where a client from before them does not look, and reads them back", () => {
    const phone = {
      hostId: "local",
      id: "00008030-001C",
      platform: "ios" as const,
      name: "Ana's iPhone",
      version: "iOS 26.1",
      booted: true,
      physical: true,
      issues: [{ reason: "developer_mode_off" as const }],
    };
    const desktop = { ...phone, id: "desktop", platform: "desktop" as const, issues: [] };
    const session = (device: typeof phone | typeof desktop) => ({
      threadId: ThreadId.make("thread-a"),
      hostId: device.hostId,
      deviceId: device.id,
      platform: device.platform,
      openedAt: "2026-11-11T10:00:00.000Z",
    });
    const withDesktop = {
      ...state,
      devices: [phone, desktop],
      sessions: [session(phone), session(desktop)],
    };
    const wire = encodeState(withDesktop);
    const older = decodeStateBeforeDesktops(wire);
    expect(older.devices.map((device) => device.id)).toEqual([phone.id]);
    expect(older.sessions.map((entry) => entry.deviceId)).toEqual([phone.id]);
    const decoded = decodeState(wire);
    expect(decoded.devices).toEqual(withDesktop.devices);
    expect(decoded.sessions).toEqual(withDesktop.sessions);
  });
});

describe("device issues", () => {
  it.each([
    ["not_paired", true, true],
    ["not_trusted", true, true],
    ["locked", true, false],
    ["developer_mode_off", false, true],
    ["xcode_missing", false, true],
    ["signing_missing", false, true],
    ["camera_permission", true, false],
    ["screen_recording_permission", true, false],
    ["capture_helper_missing", true, false],
    ["ffmpeg_missing", true, false],
    ["wayland_unsupported", true, false],
    ["capture_failed", true, false],
  ] as const)("%s blocks watching: %s, driving: %s", (reason, view, control) => {
    const issues = [{ reason }];
    expect(deviceIssueBlocks(issues, "view") !== undefined).toBe(view);
    expect(deviceIssueBlocks(issues, "control") !== undefined).toBe(control);
  });

  it("tells capture devices apart from hub devices", () => {
    const device = { hostId: "local", platform: "ios" as const, physical: true };
    expect(isCaptureDevice(device)).toBe(true);
    expect(isCaptureDevice({ ...device, physical: false })).toBe(false);
    expect(isCaptureDevice({ ...device, platform: "android" })).toBe(false);
    expect(isCaptureDevice({ ...device, hostId: "mac-mini" })).toBe(false);
    expect(isCaptureDevice({ ...device, platform: "desktop" })).toBe(true);
  });

  it("tells the agent what the user must do and not to retry", () => {
    const error = new DeviceNotReadyError({
      hostId: "local",
      deviceId: "00008030-001C",
      deviceName: "Ana's iPhone",
      reason: "signing_missing",
    });
    expect(error.message).toBe(
      "Ana's iPhone is not ready: iPhone signing is not set up. Add your Apple Team ID in Settings > Devices > iPhone signing. Only the user can fix this: tell them exactly what to do, and do not retry until they say it is done. Do not drive it another way, such as adb, simctl, idb or ssh.",
    );
    expect(decodeError(encodeError(error))).toMatchObject({
      _tag: "DeviceNotReadyError",
      reason: "signing_missing",
    });
    expect(
      new DeviceHeldError({ hostId: "local", deviceId: "desktop", since: "now" }).message,
    ).toContain("computer_screenshot still works");
  });
});

describe("iPhone signing settings", () => {
  it.each([
    ["", true],
    ["ABCDE12345", true],
    [" ABCDE12345 ", true],
    ["abcde12345", false],
    ["ABCDE1234", false],
    ["ABCDE123456", false],
  ])("team id %j accepted: %s", (value, valid) => {
    expect(decodeTeamId(value)._tag).toBe(valid ? "Success" : "Failure");
  });

  it.each([
    ["", true],
    ["com.acme.runner", true],
    ["runner", false],
    ["com.acme runner", false],
  ])("runner bundle id %j accepted: %s", (value, valid) => {
    expect(decodeBundleId(value)._tag).toBe(valid ? "Success" : "Failure");
  });

  it("reads a hand-edited team id without failing the settings file", () => {
    const settings = decodeServerSettings({ appleTeamId: "not-a-team" });
    expect(settings.appleTeamId).toBe("not-a-team");
    expect(isAppleTeamId(settings.appleTeamId)).toBe(false);
  });
});

describe("device boot errors", () => {
  it("gives a next step instead of blaming the environment server when the host sent no details", () => {
    const message = new DeviceBootError({
      hostId: "mac",
      deviceId: "Pixel_10",
      reason: "launch_failed",
      cause: null,
    }).message;
    expect(message).not.toContain("environment server");
    expect(message).toContain("Try again or open another device");
  });

  it("keeps the host's diagnostics when it sent them", () => {
    const message = new DeviceBootError({
      hostId: "mac",
      deviceId: "Pixel_10",
      reason: "launch_failed",
      diagnostics: "emulator: PANIC: Missing emulator engine program for 'x86_64' CPU.",
      cause: null,
    }).message;
    expect(message).toContain("PANIC: Missing emulator engine program");
    expect(message).not.toContain("Try again");
  });
});

describe("device access policies", () => {
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const encodeSettings = Schema.encodeSync(ServerSettings);
  const simulator = { hostId: "local", id: "SIM-1", physical: false };
  const phone = { hostId: "mac-mini", id: "192.168.1.5:5555", physical: true };

  it.each([
    { stored: undefined, device: simulator, policy: "allow" },
    { stored: undefined, device: phone, policy: "ask" },
    { stored: {}, device: phone, policy: "ask" },
    { stored: { "local:SIM-1": "deny" }, device: simulator, policy: "deny" },
    // Host ids hold no colon, so a device id with one still has its own key.
    { stored: { "mac-mini:192.168.1.5:5555": "allow" }, device: phone, policy: "allow" },
    { stored: { "local:192.168.1.5:5555": "deny" }, device: phone, policy: "ask" },
    // A value this build cannot read, and a key from the object prototype, are no policy.
    { stored: { "local:SIM-1": "sometimes" }, device: simulator, policy: "allow" },
    { stored: { "local:SIM-1": { mode: "allow" } }, device: simulator, policy: "allow" },
    { stored: {}, device: { hostId: "constructor", id: "", physical: false }, policy: "allow" },
  ] as const)("$device.id with $stored is $policy", ({ stored, device, policy }) => {
    expect(deviceAccessPolicy(stored, device)).toBe(policy);
  });

  const avd = {
    hostId: "local",
    platform: "android" as const,
    physical: false,
    name: "Pixel_9_API_36",
    // The host names a booted emulator by its AVD.
    identity: "Pixel_9_API_36",
  };
  it.each([
    // An emulator's id is its AVD name until it boots and a serial after; the name is the key.
    { device: { ...avd, id: "Pixel_9_API_36", booted: false }, key: "local:Pixel_9_API_36" },
    { device: { ...avd, id: "emulator-5554", booted: true }, key: "local:Pixel_9_API_36" },
    // A USB phone and an iOS device keep their ids.
    {
      device: { hostId: "local", platform: "android", physical: true, name: "Pixel 9", id: "R5C1" },
      key: "local:R5C1",
    },
    {
      device: {
        hostId: "local",
        platform: "ios",
        physical: false,
        name: "iPhone 17",
        id: "UDID-1",
      },
      key: "local:UDID-1",
    },
    {
      device: { hostId: "local", platform: "ios", physical: true, name: "iPhone", id: "00008140" },
      key: "local:00008140",
    },
    // A Wi-Fi phone's address changes; the serial the server read does not.
    {
      device: {
        hostId: "mac",
        platform: "android",
        physical: true,
        name: "Pixel 7",
        id: "192.168.1.20:41233",
        identity: "R5CT900",
      },
      key: "mac:R5CT900",
    },
    {
      device: {
        hostId: "mac",
        platform: "android",
        physical: true,
        name: "Pixel 7",
        id: "192.168.1.31:37001",
        identity: "R5CT900",
      },
      key: "mac:R5CT900",
    },
    // Only the host decides an identity: two leased devices with one name stay apart.
    {
      device: { hostId: "pool", platform: "android", physical: false, name: "Pixel 9", id: "a1" },
      key: "pool:a1",
    },
    // A caller that knows only the id falls back to it.
    { device: { hostId: "local", id: "emulator-5554" }, key: "local:emulator-5554" },
  ] as const)("keys $device.id as $key", ({ device, key }) => {
    expect(deviceAccessKey(device)).toBe(key);
    expect(storedDeviceAccessPolicy({ [key]: "deny" }, device)).toBe("deny");
  });

  it("keeps honouring a policy stored under a device's id and prefers its stable key", () => {
    const booted = { ...avd, id: "emulator-5554" };
    expect(storedDeviceAccessPolicy({ "local:emulator-5554": "deny" }, booted)).toBe("deny");
    expect(
      storedDeviceAccessPolicy(
        { "local:emulator-5554": "deny", "local:Pixel_9_API_36": "allow" },
        booted,
      ),
    ).toBe("allow");
    // An unreadable value under the stable key does not hide the older entry.
    expect(
      storedDeviceAccessPolicy(
        { "local:Pixel_9_API_36": "soon", "local:emulator-5554": "ask" },
        booted,
      ),
    ).toBe("ask");
  });

  it("tells a stored policy from a default one, so a row can offer a reset", () => {
    const stored = { [deviceAccessKey(simulator)]: "allow", [deviceAccessKey(phone)]: "soon" };
    expect(storedDeviceAccessPolicy(stored, simulator)).toBe("allow");
    expect(storedDeviceAccessPolicy(stored, phone)).toBeUndefined();
    expect(defaultDeviceAccessPolicy(phone)).toBe("ask");
  });

  it("reads the stored map tolerantly and keeps what it cannot read", () => {
    expect(decodeSettings({}).deviceAccess).toEqual({});
    const stored = {
      "local:SIM-1": "deny",
      "local:future": "ask-every-time",
      "mac-mini:phone": { mode: "allow", until: "2027-01-01" },
    };
    const settings = decodeSettings({ deviceAccess: stored });
    expect(settings.deviceAccess).toEqual(stored);
    expect(encodeSettings(settings).deviceAccess).toEqual(stored);
  });

  it("finds a hold by host and device, and sends holds and policies with the state", () => {
    const holds = [{ hostId: "local", deviceId: "SIM-1", since: "2026-11-10T10:00:00.000Z" }];
    expect(findDeviceHold(holds, simulator)).toEqual(holds[0]);
    expect(findDeviceHold(holds, { hostId: "mac-mini", id: "SIM-1" })).toBeUndefined();
    expect(findDeviceHold(undefined, simulator)).toBeUndefined();
    const state = decodeState({
      hostStatus: "ready",
      hostStatuses: {},
      hosts: [],
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: true,
      hubBasePath: "/api/device-hub",
      revision: 1,
      supportsDeviceControl: true,
      holds,
      access: { "local:SIM-1": "deny", "local:future": 7 },
    });
    expect(state.holds).toEqual(holds);
    expect(state.access).toEqual({ "local:SIM-1": "deny", "local:future": 7 });
    // An older server sends neither, and the state still decodes.
    const {
      holds: _holds,
      access: _access,
      supportsDeviceControl: _supports,
      ...older
    } = encodeState(state);
    expect(decodeState(older).holds).toBeUndefined();
  });

  it("tells the agent to wait, not to work around a refusal", () => {
    const held = new DeviceHeldError({
      hostId: "local",
      deviceId: "SIM-1",
      deviceName: "iPhone 17",
      since: "2026-11-10T10:00:00.000Z",
    });
    expect(held.message).toContain("The user is holding this device");
    expect(held.message).toContain("do not retry in a loop");
    expect(held.message).toContain("adb, simctl, idb or ssh");
    expect(decodeError(encodeError(held))).toMatchObject({
      _tag: "DeviceHeldError",
    });
    expect(
      new DeviceInUseError({
        hostId: "local",
        deviceId: "SIM-1",
        threadId: ThreadId.make("thread-a"),
      }).message,
    ).toBe(
      "Device SIM-1 is in use by the agent in thread thread-a. Use another device, or wait until that thread closes it. Do not close or reuse that thread's session.",
    );
    expect(
      new DeviceActionUnavailableError({
        operation: "shutdown",
        platform: "android",
        reason: "physical_device",
      }).message,
    ).toBe("Device shutdown is not available for a physical device. Turn it on or off by hand.");
  });
});
