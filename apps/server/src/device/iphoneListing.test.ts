import { describe, expect, it } from "@effect/vitest";

import { listIphones, parseDevicectl, type DevicectlPhone } from "./iphoneListing.ts";
import type { MacVideoCaptureList } from "./MacVideoCapture.ts";

// Shaped like `xcrun devicectl list devices --json-output` from Xcode 26, identifiers replaced.
const devicectlDevice = (overrides: {
  readonly udid?: string;
  readonly reality?: string;
  readonly platform?: string;
  readonly transportType?: string;
  readonly state?: string;
  readonly pairingState?: string;
  readonly developerModeStatus?: string;
}) => ({
  capabilities: [],
  connectionProperties: {
    pairingState: overrides.pairingState ?? "paired",
    transportType: overrides.transportType ?? "wired",
    tunnelState: "disconnected",
  },
  deviceProperties: {
    name: "Ana's iPhone",
    osVersionNumber: "26.1",
    ...(overrides.developerModeStatus === undefined
      ? {}
      : { developerModeStatus: overrides.developerModeStatus }),
  },
  hardwareProperties: {
    marketingName: "iPhone 16 Pro",
    platform: overrides.platform ?? "iOS",
    reality: overrides.reality ?? "physical",
    udid: overrides.udid ?? "00008030-001C",
  },
  identifier: "6C1F5D7E-0000-4000-8000-000000000001",
  properties: {
    connection: {
      pairingState: overrides.pairingState ?? "paired",
      state: overrides.state ?? "connected",
      transportType: overrides.transportType ?? "wired",
    },
    hardware: {
      platform: overrides.platform ?? "iOS",
      reality: overrides.reality ?? "physical",
      udid: overrides.udid ?? "00008030-001C",
      futureField: { nested: true },
    },
    state: { name: "Ana's iPhone", bootState: "booted" },
  },
  visibilityClass: "default",
});
const devicectlJson = (...devices: ReadonlyArray<unknown>) =>
  JSON.stringify({ info: { outcome: "success" }, result: { devices } });

const helper = (overrides: Partial<MacVideoCaptureList> = {}): MacVideoCaptureList => ({
  iphones: [],
  displays: [],
  permissions: { camera: "granted", screenRecording: "granted" },
  displayCaptureSupported: true,
  ...overrides,
});

const phone = (overrides: Partial<DevicectlPhone> = {}): DevicectlPhone => ({
  udid: "00008030-001C",
  name: "Ana's iPhone",
  version: "26.1",
  usb: true,
  paired: true,
  developerMode: true,
  ...overrides,
});

describe("parseDevicectl", () => {
  it("keeps physical iOS devices and reads each one on its own", () => {
    expect(
      parseDevicectl(
        devicectlJson(
          devicectlDevice({}),
          devicectlDevice({ udid: "SIM-1", reality: "simulated" }),
          devicectlDevice({ udid: "WATCH-1", platform: "watchOS" }),
          devicectlDevice({
            udid: "00008110-AAAA",
            transportType: "localNetwork",
            state: "connected",
          }),
          devicectlDevice({ udid: "00008110-BBBB", pairingState: "unpaired" }),
          devicectlDevice({ udid: "00008110-CCCC", developerModeStatus: "disabled" }),
          { hardwareProperties: { udid: 42 } },
          "not a device",
        ),
      ),
    ).toEqual([
      phone({ developerMode: undefined }),
      phone({ udid: "00008110-AAAA", usb: false, developerMode: undefined }),
      phone({ udid: "00008110-BBBB", paired: false, developerMode: undefined }),
      phone({ udid: "00008110-CCCC", developerMode: false }),
    ]);
  });

  it("treats a cable that devicectl reports disconnected as unplugged", () => {
    expect(parseDevicectl(devicectlJson(devicectlDevice({ state: "disconnected" })))).toEqual([
      phone({ usb: false, developerMode: undefined }),
    ]);
  });

  it.each(["", "not json", JSON.stringify({ result: {} })])("rejects %j", (json) => {
    expect(parseDevicectl(json)).toBeNull();
  });
});

describe("listIphones", () => {
  const base = {
    devicectl: [phone()] as ReadonlyArray<DevicectlPhone> | null,
    helper: helper({ iphones: [{ udid: "00008030001c", name: "iPhone", model: "iPhone17,1" }] }),
    helperIssue: undefined,
    signingReady: true,
  };

  it.each([
    ["ready", {}, []],
    ["not paired", { devicectl: [phone({ paired: false })] }, ["not_paired"]],
    [
      "developer mode off",
      { devicectl: [phone({ developerMode: false })] },
      ["developer_mode_off"],
    ],
    ["developer mode unknown", { devicectl: [phone({ developerMode: undefined })] }, []],
    ["no signing", { signingReady: false }, ["signing_missing"]],
    [
      "camera denied",
      { helper: { ...base.helper, permissions: { camera: "denied", screenRecording: "granted" } } },
      ["camera_permission"],
    ],
    [
      "camera not asked yet",
      {
        helper: {
          ...base.helper,
          permissions: { camera: "not_determined", screenRecording: "granted" },
        },
      },
      [],
    ],
    ["Xcode missing", { devicectl: null }, ["xcode_missing"]],
    [
      "helper missing",
      { helper: null, helperIssue: { reason: "capture_helper_missing" } },
      ["capture_helper_missing"],
    ],
  ] as const)("%s", (_name, overrides, reasons) => {
    const listed = listIphones({ ...base, ...overrides });
    expect(listed).toHaveLength(1);
    expect((listed[0]!.issues ?? []).map((issue) => issue.reason)).toEqual(reasons);
  });

  it("joins devicectl and the helper by UDID whatever their hyphens and case", () => {
    expect(listIphones(base)).toEqual([
      {
        id: "00008030-001C",
        platform: "ios",
        name: "Ana's iPhone",
        version: "iOS 26.1",
        booted: true,
        physical: true,
        connection: "usb",
      },
    ]);
  });

  it("lists a phone only the helper sees, and leaves out one devicectl knows only over Wi-Fi", () => {
    const listed = listIphones({
      ...base,
      devicectl: [phone({ udid: "00008110-AAAA", usb: false })],
    });
    expect(listed.map((device) => [device.id, device.name, device.version])).toEqual([
      ["00008030001c", "iPhone", "iOS"],
    ]);
  });

  it("keeps a Wi-Fi phone the helper also sees on the cable", () => {
    expect(
      listIphones({ ...base, devicectl: [phone({ usb: false })] }).map((device) => device.id),
    ).toEqual(["00008030-001C"]);
  });
});
