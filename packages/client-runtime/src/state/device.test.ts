import { DeviceId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { wifiPairingView } from "./device.ts";

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
