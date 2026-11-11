import {
  DeviceHostId,
  DeviceId,
  type DeviceServiceState,
  type DeviceSummary,
  type LinkedDeviceState,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceLinkedUse,
  groupDevicesBySource,
  isLinkedDevice,
  linkedDeviceSources,
  wifiPairingView,
} from "./device.ts";

const base: DeviceServiceState = {
  hosts: [],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "192.168.1.20:41233",
      name: "Pixel 7",
      platform: "android",
      version: "Android 16",
      booted: true,
      physical: true,
      connection: "wifi",
    },
  ],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const attempt = {
  attemptId: "ADB_WIFI_A",
  qrPayload: "WIFI:T:ADB;S:ADB_WIFI_A;P:X;;",
  revision: 1,
};
const live = (
  wifiPairing: Omit<NonNullable<DeviceServiceState["wifiPairing"]>, "hostId">,
): DeviceServiceState => ({ ...base, wifiPairing: { hostId: "local", ...wifiPairing } });

describe("wifiPairingView", () => {
  it.each([
    {
      name: "before the server answers",
      state: base,
      mine: null,
      error: null,
      view: { kind: "starting" },
    },
    // The state stream can lag the start answer.
    {
      name: "the start answer ahead of the state",
      state: { ...base, revision: 0 },
      mine: attempt,
      error: null,
      view: { kind: "waiting", qrPayload: attempt.qrPayload },
    },
    {
      name: "pairing",
      state: live({ attemptId: "ADB_WIFI_A", status: "pairing" }),
      mine: attempt,
      error: null,
      view: { kind: "pairing", label: "Pairing with your phone…" },
    },
    {
      name: "connected",
      state: live({
        attemptId: "ADB_WIFI_A",
        status: "connected",
        deviceId: DeviceId.make("192.168.1.20:41233"),
      }),
      mine: attempt,
      error: null,
      view: { kind: "connected", label: "Connected to Pixel 7." },
    },
    {
      name: "failed with a reason and adb's words",
      state: live({
        attemptId: "ADB_WIFI_A",
        status: "failed",
        reason: "pair_refused",
        detail: "Failed: Wrong password",
      }),
      mine: attempt,
      error: null,
      view: {
        kind: "failed",
        label: "The phone refused to pair. Scan a fresh code.",
        detail: "Failed: Wrong password",
      },
    },
    {
      name: "another client's attempt",
      state: live({ attemptId: "ADB_WIFI_B", status: "waiting" }),
      mine: null,
      error: "busy",
      view: { kind: "elsewhere", attemptId: "ADB_WIFI_B" },
    },
    // Busy, but that attempt has ended since: offer a retry, not a spinner.
    {
      name: "a busy answer for an attempt that already ended",
      state: live({ attemptId: "ADB_WIFI_B", status: "failed", reason: "timeout" }),
      mine: null,
      error: "busy",
      view: { kind: "failed", label: "The other pairing attempt ended. Try again." },
    },
    {
      name: "an attempt another client cancelled",
      state: { ...base, revision: 2 },
      mine: attempt,
      error: null,
      view: { kind: "failed", label: "Pairing was cancelled on another device." },
    },
    {
      name: "a start that failed",
      state: base,
      mine: null,
      error: "Device support is off.",
      view: { kind: "failed", label: "Device support is off." },
    },
  ] as const)("shows $name", ({ state, mine, error, view }) => {
    expect(wifiPairingView({ state, attempt: mine, startError: error })).toMatchObject(view);
  });
});

const hostFields = { platforms: [], hubInstalled: true, agentDeviceInstalled: true };
const linkedHost = (environmentId: string, label: string, linkState: LinkedDeviceState) => ({
  ...hostFields,
  id: DeviceHostId.make(`linked.${environmentId}`),
  kind: "linked" as const,
  label,
  environmentId,
  linkState,
  ...(linkState === "connected" ? {} : { linkDetail: `${label}: ${linkState}` }),
});
const device = (
  hostId: string,
  name: string,
  overrides: Partial<DeviceSummary> = {},
): DeviceSummary => ({
  hostId: DeviceHostId.make(hostId),
  id: DeviceId.make(`${hostId}/${name}`),
  name,
  platform: "ios",
  version: "iOS 26",
  booted: false,
  physical: false,
  ...overrides,
});
const sources: DeviceServiceState = {
  ...base,
  hosts: [
    { ...hostFields, id: DeviceHostId.make("local"), kind: "local", label: "This Mac" },
    linkedHost("env-studio", "Studio Mac", "connected"),
    linkedHost("env-attic", "Attic PC", "link_down"),
  ],
  devices: [
    device("local", "iPhone 17"),
    device("local", "Pixel 10", { platform: "android", physical: true, booted: true }),
    device("linked.env-studio", "iPad Air"),
    device("linked.env-studio", "Galaxy S26", { platform: "android", physical: true }),
    device("linked.env-studio", "iPhone 16", { booted: true }),
  ],
};

describe("groupDevicesBySource", () => {
  it.each([
    {
      name: "no links: this environment's devices only",
      state: { ...sources, hosts: sources.hosts.slice(0, 1), devices: sources.devices.slice(0, 2) },
      expected: [
        {
          key: "own",
          linked: null,
          kinds: [
            ["physical", ["Pixel 10"]],
            ["ios", ["iPhone 17"]],
          ],
        },
      ],
    },
    {
      name: "linked environments under their labels, a down link with no devices included",
      state: sources,
      expected: [
        {
          key: "own",
          linked: null,
          kinds: [
            ["physical", ["Pixel 10"]],
            ["ios", ["iPhone 17"]],
          ],
        },
        {
          key: "linked.env-attic",
          linked: { label: "Attic PC", state: "link_down", detail: "Attic PC: link_down" },
          kinds: [],
        },
        {
          key: "linked.env-studio",
          linked: { label: "Studio Mac", state: "connected", detail: undefined },
          kinds: [
            ["physical", ["Galaxy S26"]],
            ["ios", ["iPhone 16", "iPad Air"]],
          ],
        },
      ],
    },
    {
      name: "this computer first, before a USB iPhone",
      state: {
        ...sources,
        hosts: sources.hosts.slice(0, 1),
        devices: [
          device("local", "iPhone 17"),
          device("local", "Ana's iPhone", { physical: true, booted: true }),
          device("local", "Ana's Mac", { platform: "desktop", booted: true }),
        ],
      },
      expected: [
        {
          key: "own",
          linked: null,
          kinds: [
            ["desktop", ["Ana's Mac"]],
            ["physical", ["Ana's iPhone"]],
            ["ios", ["iPhone 17"]],
          ],
        },
      ],
    },
    {
      name: "only linked devices",
      state: { ...sources, devices: sources.devices.slice(2, 3) },
      expected: [
        {
          key: "linked.env-attic",
          linked: { label: "Attic PC", state: "link_down", detail: "Attic PC: link_down" },
          kinds: [],
        },
        {
          key: "linked.env-studio",
          linked: { label: "Studio Mac", state: "connected", detail: undefined },
          kinds: [["ios", ["iPad Air"]]],
        },
      ],
    },
  ])("$name", ({ state, expected }) => {
    expect(
      groupDevicesBySource(state).map((source) => ({
        key: source.key,
        linked: source.linked && {
          label: source.linked.label,
          state: source.linked.state,
          detail: source.linked.detail,
        },
        kinds: source.groups.map((group) => [group.kind, group.devices.map((entry) => entry.name)]),
      })),
    ).toEqual(expected);
  });

  it("tells linked devices from this environment's", () => {
    expect(sources.devices.map((entry) => isLinkedDevice(sources, entry))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("deviceLinkedUse", () => {
  const target = sources.devices[0]!;
  const session = {
    threadId: ThreadId.make("linked:link-1:thread-a"),
    hostId: target.hostId,
    deviceId: target.id,
    platform: "ios" as const,
    openedAt: "2026-11-11T00:00:00.000Z",
  };
  it.each([
    { name: "nobody", sessions: [], expected: null },
    {
      name: "a thread here",
      sessions: [{ ...session, threadId: ThreadId.make("thread-a") }],
      expected: null,
    },
    {
      name: "a linked thread",
      sessions: [{ ...session, linked: { label: "Laptop", threadTitle: "Fix login" } }],
      expected: "Used by “Fix login” on Laptop",
    },
    {
      name: "a link's user, no thread",
      sessions: [{ ...session, linked: { label: "Laptop" } }],
      expected: "Used from Laptop",
    },
    {
      name: "another device",
      sessions: [{ ...session, deviceId: DeviceId.make("other"), linked: { label: "Laptop" } }],
      expected: null,
    },
  ])("$name", ({ sessions, expected }) => {
    expect(deviceLinkedUse({ ...sources, sessions }, target)).toBe(expected);
  });
});

describe("linkedDeviceSources", () => {
  it("joins links with what this environment hides and what each answered", () => {
    expect(
      linkedDeviceSources({
        links: new Map([
          ["env-studio", "Studio Mac"],
          ["env-attic", "Attic PC"],
          ["env-hidden", "Basement"],
          ["env-new", "New Mac"],
        ]),
        hidden: ["env-hidden"],
        state: sources,
      }),
    ).toEqual([
      { environmentId: "env-attic", label: "Attic PC", hidden: false, status: "Link down" },
      { environmentId: "env-hidden", label: "Basement", hidden: true, status: null },
      { environmentId: "env-new", label: "New Mac", hidden: false, status: null },
      { environmentId: "env-studio", label: "Studio Mac", hidden: false, status: "3 devices" },
    ]);
  });
});
